import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    getSetComputeUnitLimitInstructionDataEncoder,
    getSetComputeUnitPriceInstructionDataEncoder,
    getSetLoadedAccountsDataSizeLimitInstructionDataEncoder,
    MAX_COMPUTE_UNIT_LIMIT,
} from '@solana-program/compute-budget';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { getAddressEncoder, getProgramDerivedAddress, getTransactionEncoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

import type { Chain, Simulation } from '../chain.ts';
import { callsIn, HIGH_FEE, HUGE_FEE, type Finding } from '../review/assess.ts';
import { budgetIndex, dataLimit, defaultUnits, fee, lamportsFor, MAX_ROOM, priorityFee, SET_LOADED_DATA, SET_UNIT_LIMIT, SET_UNIT_PRICE, unitLimit, unitPrice } from '../review/budget.ts';
import { decode, durable, encode, type Message } from '../review/decode.ts';
import type { Review } from '../review/review.ts';
import { LIGHTHOUSE } from '../programs/addresses.ts';
import { CORE_PROGRAMS } from '../programs/core.ts';
import { PROGRAM_NAMES } from '../programs/known.ts';
import { assertions, byChange, compared, forgotten, holds, inflowsBeside, MEMORY_ID, roomBeside, snapshot, type Delta, type Hold } from './guard.ts';

/** The transaction to sign, as the user approves it, and what preparing it found. */
/** Where a priority fee Otus sets comes from: the price the RPC recommends (Helius), or what recent blocks took. */
export type Pricing = 'recommended' | 'recent';

export type Prepared = {
    bytes: Uint8Array;
    hash: string;
    fee: bigint; // what its fee payer pays
    holds: Hold[]; // the guards it carries
    unguarded: string | null; // why it carries none: words for the user, or one of the two that go without saying below
    findings: Finding[]; // added to the review's
    units: number | null; // the compute limit Otus set, when it changed the transaction
    priced: Pricing | null; // where the priority fee Otus set comes from, when it set one
    room: number | null; // the account data a v1 transaction may load, when Otus changed it
    priority: bigint | null; // lamports: the priority fee Otus set, when it set one
    loose: Address[]; // signed with others: your accounts its guards hold less than alone, as another changes them
    leeway: { lamports: bigint; units: bigint }; // signed with others, guarded by floors: what they let pass past its own review, for what the others move into or between your accounts
};

const GUARD_UNITS = 4_000; // compute units per assertion added to a site's own limit; Lighthouse uses about 2,000
const BUDGET_UNITS = 300; // what the Compute Budget instructions Otus adds use, 150 each
const SPARE = 1.1; // a fitted compute limit is what the transaction uses, guards and fee settings included, and a tenth
const PERCENTILE = 0.75; // of what recent blocks took to write the same accounts
const MAX_PRIORITY_FEE = 1_000_000n; // lamports: the most a priority fee set by the wallet costs
const FEE_ACCOUNTS = 128; // getRecentPrioritizationFees takes at most 128 addresses, getPriorityFeeEstimate 500
const ROOM_STEP = 32 * 1024; // bytes: a v1 data limit is rounded up to this, the step the network counts it by

/** Why a transaction carries no guards, when that goes without saying: nothing of yours to hold, or a simulation that
 *  failed (the review says so already). */
export const NOTHING_TO_HOLD = 'nothing of yours to hold';
export const SIMULATION_FAILED = 'the simulation failed';

/**
 * Review → the transaction to sign. When this wallet alone signs, it gets guards on your accounts, a compute limit fitted
 * to the simulation and, unless the site set one, a priority fee from recent fees; then it is simulated again. Otherwise,
 * or if that would fail, it stays as the site sent it, and says so. `own`: a transfer made in Otus, whose limits are
 * the most there is for its review, fitted here as if it set none. `bare`: why it gets no guards, only its limits and
 * fee. `trade`: a trade's slack in basis points, when the wallet holds its own swap to its slippage. `beside`: the
 * other transactions signed with it, landing in any order: its guards leave room for what they take. Never throws.
 */
export async function prepare(r: Review, wallet: Address, chain: Chain, own = false, bare?: string, trade?: bigint, beside: Review[] = []): Promise<Prepared> {
    // Signed with others: each may land first, its priority fee as Otus sets it too. What its guards hold less than
    // alone, and let pass more, is said.
    const others = beside.map((b) => ({ changes: b.changes, yours: b.assessment.yours, spare: b.signers[0] === wallet ? MAX_PRIORITY_FEE : 0n }));
    const gross = bare ? [] : holds(r.assessment.yours, wallet, r.assessment.keyed, trade, others);
    const alone = bare || others.length === 0 ? gross : holds(r.assessment.yours, wallet, r.assessment.keyed, trade);
    const loose = alone.filter((h) => weaker(h, gross.find((g) => g.account === h.account))).map((h) => h.account);
    // As the site sent it, without guards: why, for the review's Guards line; and what else was found on the way.
    const asIs = (reason: string, findings: Finding[] = []): Prepared => ({ bytes: r.bytes, hash: r.hash, fee: r.changes.fee, holds: [], unguarded: reason, findings, units: null, priced: null, room: null, priority: null, loose: [], leeway: { lamports: 0n, units: 0n } });
    // Without the guards it should have had: a warning too, when what it does to accounts of yours can come out otherwise.
    const unheld = (reason: string): Prepared => asIs(reason, exposed(r) ? [UNGUARDED] : []);
    // Changed, the transaction would need every signature again: one another account made, or will make over it as it is.
    if (r.signers.length > 1) return unheld(r.signed.some((a) => a !== wallet) ? "Otus can't add guards because the transaction is already signed by another account" : "Otus can't add guards because another account must sign the transaction too");
    if (r.simulation.error !== null) return asIs(SIMULATION_FAILED);
    const loaded = r.accounts.filter((a) => a.table).map((a) => a.address);
    if ([LIGHTHOUSE, COMPUTE_BUDGET_PROGRAM_ADDRESS].some((p) => loaded.includes(p))) return asIs("Otus can't add guards because its lookup tables load the programs they need", [TABLED]);

    const accounts = r.accounts.map((a) => a.address);
    const sitePrice = r.message.version === 1 ? r.message.config.priorityFeeLamports : unitPrice(r.message);
    // The price asked of the network while the limit is measured, which needs none.
    const pricingAsked = sitePrice == null ? pricing(r, chain) : Promise.resolve(null);
    pricingAsked.catch(() => {}); // awaited below; one that fails is the network not answering
    // Signed with others, landing in any order: each amount is held as this transaction's own change, against a
    // snapshot Lighthouse takes as it starts, so what the others do first changes nothing. Not for one that reads its
    // own instructions (the snapshots go first, and move them), nor when it can't take them: then floors that leave room
    // for the others, said with what they may let pass.
    const deltas = !bare && others.length > 0 && !accounts.includes(INSTRUCTIONS) ? byChange(gross, r.assessment.yours, r.assessment.keyed, wallet, trade) : [];
    if (deltas.length > 0) {
        const [memory, bump] = await getProgramDerivedAddress({ programAddress: LIGHTHOUSE, seeds: ['memory', getAddressEncoder().encode(wallet), Uint8Array.of(MEMORY_ID)] });
        const held = await guarded(deltas, { address: memory, bump });
        if (held) return held;
    }
    return (await guarded([], null)) ?? unheld("Otus can't add guards because the transaction has no room left for them");

    // Guarded with these amounts held as changes (none: as floors). Null when snapshots are what keep it from being
    // guarded: then it is guarded with floors instead.
    async function guarded(deltas: Delta[], memory: Memory | null): Promise<Prepared | null> {
        const retry = deltas.length > 0;
        const changed = new Set(deltas.map((d) => d.account));
        const asserted = gross.reduce((n, h) => n + assertions(h, wallet, changed.has(h.account)).length, 0);
        const added = asserted + (retry ? 2 * deltas.length + 2 : 0); // each snapshot and comparison, the memory made and closed
        const leeway = bare || retry ? { lamports: 0n, units: 0n } : plus(roomBeside(r.assessment.yours, wallet, others), inflowsBeside(gross, wallet, others));
        // A transaction loads no more account data than its limit, v1's or the one a Compute Budget instruction sets for
        // legacy and v0: Lighthouse's program comes with its guards. `room`: the limit as Otus sets it, null to leave the
        // site's.
        const v1 = r.message.version === 1;
        const siteRoom = own ? null : dataLimit(r.message);
        const roomed = v1 || siteRoom !== null;
        let room: number | null = null;
        const build = (h: Hold[], limit: number, price: bigint) => {
            const m = withRoom(withPrice(withLimit(withAssertions(r.message, h, wallet, accounts, deltas, memory), limit), price), room);
            return bare ? budgetFirst(m) : m; // where a Ledger reads the rest in clear
        };
        const siteLimit = own ? null : unitLimit(r.message);
        const noRoom = () => (retry ? null : unheld("Otus can't add guards because the transaction has no room left for them"));
        // Guarded, it fails. For what Otus adds (more accounts or account data than a transaction may take, the rent its
        // priority fee leaves the wallet without, units the guards could have used up), it goes as the site sent it;
        // otherwise it acts other than reviewed. With snapshots, either way it is tried with floors instead. `limit`: the
        // units it had.
        const failed = async (error: NonNullable<Simulation['error']>, limit: number) => {
            if (retry) return null;
            return ours(error, { used: r.simulation.unitsConsumed, limit, added }) ? noRoom() : asIs("Otus can't add guards because the transaction fails with them", [await whyFailed(r, chain)]);
        };
        let market: { price: bigint; from: Pricing } | null = null;
        try {
            // The transaction as it would be signed with this limit: priced under the cap, the wallet's floor net of what
            // it pays for it.
            const signable = (limit: number, priced = true) => {
                const price = !priced || market === null || market.price === 0n ? 0n : min(market.price, (MAX_PRIORITY_FEE * 1_000_000n) / BigInt(Math.max(limit, 1)));
                const paid = r.signers[0] === wallet ? fee(build(gross, limit, price)) : 0n;
                const held = gross.map((h) => (h.kind === 'wallet' ? { ...h, atLeast: h.atLeast > paid ? h.atLeast - paid : 0n } : h));
                return { message: build(held, limit, price), held, price };
            };
            // The site's own limit stays, with room for the guards. Otherwise the limit is what the transaction uses as it
            // will be signed, guards and fee settings included, measured with all the room a transaction may have, and a
            // tenth more. With guards, the account data a limited one loads is measured the same way. Measured with no
            // priority fee: it changes neither, and at the most units a fee could cost more than the wallet keeps.
            let limit = siteLimit !== null ? Math.min(MAX_COMPUTE_UNIT_LIMIT, siteLimit + added * GUARD_UNITS) : MAX_COMPUTE_UNIT_LIMIT;
            if (siteLimit === null || (roomed && added > 0)) {
                if (roomed) room = MAX_ROOM;
                const probe = await wired(unpriced(signable(MAX_COMPUTE_UNIT_LIMIT, false).message), r.signers);
                if (probe === null) return noRoom();
                const measured = await chain.simulate(probe.bytes, [], r.slot);
                if (measured.error !== null) return failed(measured.error, MAX_COMPUTE_UNIT_LIMIT);
                // An RPC that does not say what it used: the runtime's default for the site's instructions, and the guards'
                // room; v1 has no default, so the most there is.
                const unsaid = v1 ? MAX_COMPUTE_UNIT_LIMIT : defaultUnits(r.message) + added * GUARD_UNITS;
                const used = measured.unitsConsumed ? Number(measured.unitsConsumed) : null; // none at all is not said either
                if (siteLimit === null) limit = Math.min(MAX_COMPUTE_UNIT_LIMIT, used === null ? unsaid : Math.ceil(used * SPARE));
                if (roomed) room = roomFor(measured.loadedBytes ?? null, siteRoom);
            }
            market = await pricingAsked;
            if (signable(limit).message === r.message) return asIs(NOTHING_TO_HOLD);
            // As it will be signed, simulated once more. Short of units at the limit set (a run may use more than the last,
            // or a program act otherwise at another limit), it gets the most there is rather than losing its guards; left
            // without its rent by Otus's priority fee, it goes without that fee.
            const attempt = async (limit: number, priced: boolean) => {
                const { message, held, price } = signable(limit, priced);
                const prepared = await wired(message, r.signers);
                return prepared && { held, price, ...prepared, check: await chain.simulate(prepared.bytes, [], r.slot) };
            };
            let tried = await attempt(limit, true);
            if (tried?.check.error && spent(tried.check.error) && limit < MAX_COMPUTE_UNIT_LIMIT) tried = await attempt((limit = MAX_COMPUTE_UNIT_LIMIT), true);
            if (tried?.check.error && rentShort(tried.check.error) && tried.price > 0n) tried = await attempt(limit, false);
            if (tried === null) return noRoom();
            const { message, held, price, bytes, hash, check } = tried;
            if (check.error !== null) return failed(check.error, limit);
            const total = check.fee ?? fee(message);
            const beside = [...(loose.length ? [{ ...PARTIAL, subject: loose[0] }] : []), ...(leeway.lamports > 0n || leeway.units > 0n ? [LEEWAY] : [])];
            return {
                bytes,
                hash,
                fee: total,
                holds: shown(held, gross, deltas, r),
                unguarded: held.length > 0 ? null : (bare ?? NOTHING_TO_HOLD),
                findings: [...feeFindings(r, wallet, total), ...differs(r, message, check), ...beside],
                units: limit,
                priced: price > 0n && market ? market.from : null,
                room: room !== siteRoom ? room : null,
                priority: price > 0n && market ? priorityFee(message) : null,
                loose,
                leeway,
            };
        } catch (cause) {
            console.error('Otus: preparing', cause);
            return unheld("Otus couldn't add guards because the network didn't answer");
        }
    }
}

// Lighthouse's memory for this payer: where snapshots go.
type Memory = { address: Address; bump: number };

// What a hold whose amount is held as a change keeps as its floor, for what the user is told is guaranteed: as it was
// before, plus the least change; the wallet's net of the fee it pays, as a floor's is (`gross`: before that).
function shown(held: Hold[], gross: Hold[], deltas: Delta[], r: Review): Hold[] {
    if (deltas.length === 0) return held;
    const before = new Map([...r.assessment.yours.accounts, ...r.assessment.keyed].map((c) => [c.address, c.before]));
    return held.map((h, i) => {
        const d = deltas.find((x) => x.account === h.account);
        const was = before.get(h.account);
        if (!d || !was) return h;
        const paid = h.kind === 'wallet' ? gross[i].atLeast - h.atLeast : 0n;
        const floor = (d.tokens ? (was.token?.amount ?? 0n) : was.lamports) + d.atLeast - paid;
        return { ...h, atLeast: floor > 0n ? floor : 0n };
    });
}

const plus = (a: { lamports: bigint; units: bigint }, b: { lamports: bigint; units: bigint }) => ({ lamports: a.lamports + b.lamports, units: a.units + b.units });

// The sysvar a program reads to see the transaction's instructions: one that does may check where its own sit.
const INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111' as Address;

// A failure of what Otus adds rather than of what the site's transaction does: one of the whole transaction (too
// many accounts, too much account data: no program can raise these), the fee payer left without its rent, or units
// run out where the guards' own could have done it (`units`: what the site's transaction used, the limit it had and
// the guards added). A guard failing, or a program that fails, or burns its units, only when it sees guards, is not.
function ours(error: NonNullable<Simulation['error']>, units: { used: bigint | null; limit: number; added: number }): boolean {
    if (typeof error === 'string') return true;
    if (rentShort(error)) return true;
    if (!spent(error)) return false;
    return !units.used || Number(units.used) + units.added * GUARD_UNITS + BUDGET_UNITS >= units.limit; // 0 is not said either
}

const spent = (error: NonNullable<Simulation['error']>) => typeof error === 'object' && 'InstructionError' in error && error.InstructionError[1] === 'ComputationalBudgetExceeded';
const rentShort = (error: NonNullable<Simulation['error']>) => typeof error === 'object' && 'InsufficientFundsForRent' in error && error.InsufficientFundsForRent.account_index === 0; // the fee payer, the only account whose lamports Otus changes

// The fee as prepared, where it is more than the review saw: Otus's guards add units at the site's own price.
function feeFindings(r: Review, wallet: Address, total: bigint): Finding[] {
    if (r.signers[0] !== wallet) return [];
    const reviewed = r.assessment.yours.fee;
    if (total > HUGE_FEE && reviewed <= HUGE_FEE) return [{ level: 'danger', code: 'high-fee', text: 'A huge network fee', note: 'It goes to whoever makes the block' }];
    if (total > HIGH_FEE && reviewed <= HIGH_FEE) return [{ level: 'warn', code: 'high-fee', text: 'High network fee' }];
    return [];
}

// Signed with others: guards that hold less than they would alone, as another changes those accounts; and room they
// leave past this one's review, for what others move between your accounts (and the site may never send).
const PARTIAL: Finding = { level: 'warn', code: 'guards-partial', text: 'Some guards hold less', note: 'Another transaction here changes those accounts' };
const LEEWAY: Finding = { level: 'warn', code: 'guards-leeway', text: 'Its guards leave room for the others', note: 'Others here move funds into or between your accounts' };

// Whether a hold made beside others asserts less than `alone`, the one made without them: none at all, or a field less.
function weaker(alone: Hold, beside: Hold | undefined): boolean {
    if (!beside) return true;
    const fields = (h: Hold) => Object.keys(h).filter((k) => !['atLeast', 'keys', 'stake'].includes(k)).length + (h.kind === 'account' && h.stake ? Object.keys(h.stake).length : 0);
    const keys = (h: Hold) => (h.kind === 'account' ? h.keys.length : 0);
    return fields(beside) < fields(alone) || keys(beside) < keys(alone);
}

// Unguarded, what a program other than Solana's own does to accounts of yours (a swap, a protocol, one Otus doesn't
// know) depends on the chain as it lands: a pool moved meanwhile, a program that acts otherwise then.
const UNGUARDED: Finding = { level: 'warn', code: 'unguarded', text: 'Not guarded', note: 'What it does to your accounts can change before it lands' };
function exposed(r: Review): boolean {
    const yours = new Set(r.assessment.yours.accounts.map((c) => c.address));
    return r.message.instructions.some((ix) => !CORE_PROGRAMS.has(r.accounts[ix.programAddressIndex].address) && ix.accountIndices.some((j) => r.accounts[j].writable && yours.has(r.accounts[j].address)));
}

// No transaction needs Lighthouse or Compute Budget among the accounts it loads from a table: there they only keep
// Otus from adding its own, and so from guarding it.
const TABLED: Finding = { level: 'warn', code: 'blocks-guards', text: 'It keeps Otus from guarding it', note: 'It loads a program Otus adds from a lookup table' };

// The message with no priority fee: for legacy and v0, its price instruction at zero, in place or added.
function unpriced(m: Message): Message {
    if (m.version === 1) return m.config.priorityFeeLamports ? { ...m, config: { ...m.config, priorityFeeLamports: 0n } } : m;
    // A price instruction all the same, at zero: it uses the units the one set later will.
    return withBudget(m, SET_UNIT_PRICE, getSetComputeUnitPriceInstructionDataEncoder().encode({ microLamports: 0n }));
}

// Held to the simulated outcome it fails. If the site's own transaction still runs, it behaves differently when watched.
async function whyFailed(r: Review, chain: Chain): Promise<Finding> {
    const again = await chain.simulate(r.bytes, [], r.slot);
    return again.error === null
        ? { level: 'warn', code: 'guards-fail', text: 'It fails when held to what the simulation showed' }
        : { level: 'warn', code: 'simulation-failed', text: 'The transaction would fail now, so its effects cannot be seen' };
}

// The price of a unit, in micro-lamports: what the RPC recommends to write the same accounts, when it can (Helius, from
// the prices paid lately); otherwise what recent blocks took to write them, at the percentile. Both are asked at once,
// so an RPC without the recommendation costs no wait; what recent blocks took is needed only then.
async function pricing(r: Review, chain: Chain): Promise<{ price: bigint; from: Pricing }> {
    const writable = r.accounts.filter((a) => a.writable).map((a) => a.address).slice(0, FEE_ACCOUNTS);
    const [recommended, recent] = await Promise.allSettled([chain.recommended(writable), chain.fees(writable)]);
    if (recommended.status === 'fulfilled' && recommended.value !== null) return { price: recommended.value, from: 'recommended' };
    if (recent.status === 'rejected') throw recent.reason;
    const sorted = recent.value.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { price: sorted[Math.floor((sorted.length - 1) * PERCENTILE)] ?? 0n, from: 'recent' };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

// Guarded, it may act otherwise than as the review saw it: a program Otus doesn't know calling, or being called,
// where it was not is what one does that knows it is watched. Known programs calling known ones otherwise is the chain
// moving on, as a fill through another market. It takes both simulations listing their calls to tell.
function differs(r: Review, guarded: Message, check: Simulation): Finding[] {
    if (!r.simulation.innerListed || !check.innerListed) return [];
    // Keyed by instruction: Otus's own are added after the site's, which keep their places.
    const pair = (c: { index: number; caller: Address; program: Address }) => `${c.index} ${c.caller} ${c.program}`;
    const seen = new Set(callsIn(r.simulation.inner, r.message.instructions.map((ix) => r.accounts[ix.programAddressIndex].address)).map(pair));
    const fresh = callsIn(check.inner, guarded.instructions.map((ix) => guarded.staticAccounts[ix.programAddressIndex]))
        .filter((c) => !seen.has(pair(c)) && !(PROGRAM_NAMES.has(c.caller) && PROGRAM_NAMES.has(c.program)));
    const programs = [...new Set(fresh.map((c) => c.program))].map((q) => PROGRAM_NAMES.get(q) ?? q);
    return programs.length ? [{ level: 'warn', code: 'guards-differ', text: 'It acts differently once guarded', note: `It then calls ${programs.join(', ')}, which the review did not see` }] : [];
}

// A message as the transaction's bytes, unsigned, and the hash of what is signed; null when it is too large to send.
async function wired(message: Message, signers: Address[]): Promise<{ message: Message; bytes: Uint8Array; hash: string } | null> {
    const signatures = Object.fromEntries(signers.map((a) => [a, null]));
    const bytes = new Uint8Array(getTransactionEncoder().encode({ messageBytes: encode(message), signatures }));
    return decode(bytes).then((d) => ({ message, bytes, hash: d.hash }), () => null);
}

// Lighthouse's assertions at the end. With `deltas`, their snapshots go first (after a durable nonce's advance, which
// stays first), the first written the one furthest in, so the memory is made at its whole size before any lamports are
// read; their comparisons go last, and the memory is closed after them, its rent back to the wallet that paid it.
function withAssertions(m: Message, h: Hold[], wallet: Address, accounts: Address[], deltas: Delta[] = [], memory: Memory | null = null): Message {
    if (h.length === 0) return m;
    const changed = new Set(deltas.map((d) => d.account));
    const lighthouse = withProgram(m, LIGHTHOUSE);
    if (deltas.length === 0 || memory === null) {
        const added = h.flatMap((x) => assertions(x, wallet).map((data) => ({ programAddressIndex: lighthouse.at, accountIndices: [lighthouse.shift(accounts.indexOf(x.account))], data })));
        return { ...lighthouse.message, instructions: [...lighthouse.message.instructions, ...added] };
    }
    // The System program, where the transaction has it already (a table's included), else added; then the memory.
    const had = accounts.indexOf(SYSTEM_PROGRAM_ADDRESS);
    const system = had >= 0 ? { message: lighthouse.message, at: lighthouse.shift(had), shift: (i: number) => i } : withProgram(lighthouse.message, SYSTEM_PROGRAM_ADDRESS);
    const kept = withWritable(system.message, memory.address);
    const now = (i: number) => kept.shift(system.shift(i)); // an index after the System program was added
    const at = (a: Address) => now(lighthouse.shift(accounts.indexOf(a)));
    const [L, S, M] = [now(lighthouse.at), kept.shift(system.at), kept.at];
    const ix = (accountIndices: number[], data: Uint8Array) => ({ programAddressIndex: L, accountIndices, data });
    const writes = deltas.toSorted((a, b) => b.slot - a.slot).map((d) => ix([L, S, 0, M, at(d.account)], snapshot(d, memory.bump)));
    const asserts = h.flatMap((x) => assertions(x, wallet, changed.has(x.account)).map((data) => ix([at(x.account)], data)));
    const comparisons = deltas.map((d) => ix([M, at(d.account)], compared(d)));
    const lead = durable(kept.message) ? 1 : 0;
    const rest = kept.message.instructions;
    return { ...kept.message, instructions: [...rest.slice(0, lead), ...writes, ...rest.slice(lead), ...asserts, ...comparisons, ix([L, 0, M], forgotten(memory.bump))] };
}

// Adds an account as the last writable static account that signs nothing, before the read-only ones: they, and the
// accounts loaded from tables, move one place, in every instruction that names them, its program included.
function withWritable(m: Message, address: Address): { message: Message; at: number; shift: (i: number) => number } {
    const at = m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts;
    const shift = (i: number) => (i >= at ? i + 1 : i);
    const message = {
        ...m,
        staticAccounts: [...m.staticAccounts.slice(0, at), address, ...m.staticAccounts.slice(at)],
        instructions: m.instructions.map((ix) => ({ ...ix, programAddressIndex: shift(ix.programAddressIndex), accountIndices: ix.accountIndices.map(shift) })),
    };
    return { message, at, shift };
}

// v1 keeps its budget in config; legacy and v0 in Compute Budget instructions. The priority fee of v1 is a total.
function withLimit(m: Message, units: number): Message {
    if (units === unitLimit(m)) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, computeUnitLimit: units } };
    return withBudget(m, SET_UNIT_LIMIT, getSetComputeUnitLimitInstructionDataEncoder().encode({ units }));
}

function withPrice(m: Message, price: bigint): Message {
    if (price === 0n) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, priorityFeeLamports: lamportsFor(price, unitLimit(m) ?? defaultUnits(m)) } };
    return withBudget(m, SET_UNIT_PRICE, getSetComputeUnitPriceInstructionDataEncoder().encode({ microLamports: price }));
}

// The account data a v1 transaction may load: what it loaded, guards included, and a tenth more, rounded up to the
// network's step; never below what the site set. An RPC that does not say: the most there is.
function roomFor(loaded: number | null, site: number | null): number {
    if (!loaded) return MAX_ROOM; // none at all is not said either: Lighthouse's own program is loaded
    return Math.min(MAX_ROOM, Math.max(site ?? 0, Math.ceil((loaded * SPARE) / ROOM_STEP) * ROOM_STEP));
}

// The account data a transaction may load: v1's in the message, legacy and v0's in the Compute Budget instruction that
// sets it, when there is one (without one, they may load the most there is).
function withRoom(m: Message, room: number | null): Message {
    if (room === null || dataLimit(m) === room) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, loadedAccountsDataSizeLimit: room } };
    if (budgetIndex(m, SET_LOADED_DATA) < 0) return m;
    return withBudget(m, SET_LOADED_DATA, getSetLoadedAccountsDataSizeLimitInstructionDataEncoder().encode({ accountDataSizeLimit: room }));
}

// Its Compute Budget instructions first, after a durable nonce's advance, which stays first: a Ledger's Solana app reads
// a transaction in clear only so, and shows one with them last as a hash.
function budgetFirst(m: Message): Message {
    const budget = (ix: Message['instructions'][number]) => m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS;
    const lead = durable(m) ? 1 : 0;
    const rest = m.instructions.slice(lead);
    return { ...m, instructions: [...m.instructions.slice(0, lead), ...rest.filter(budget), ...rest.filter((ix) => !budget(ix))] };
}

// Replaces the Compute Budget instruction of this kind, or adds one at the end, where it keeps a durable nonce first.
function withBudget(m: Message, which: typeof SET_UNIT_LIMIT, data: ReadonlyUint8Array): Message {
    const i = budgetIndex(m, which);
    if (i >= 0) return { ...m, instructions: m.instructions.map((ix, j) => (j === i ? { ...ix, data } : ix)) };
    const { message, at } = withProgram(m, COMPUTE_BUDGET_PROGRAM_ADDRESS);
    return { ...message, instructions: [...message.instructions, { programAddressIndex: at, accountIndices: [], data }] };
}

// Adds a program as the last read-only static account, unless it is one already. Accounts loaded from tables move one place.
function withProgram(m: Message, program: Address): { message: Message; at: number; shift: (i: number) => number } {
    const found = m.staticAccounts.indexOf(program);
    if (found >= 0) return { message: m, at: found, shift: (i) => i };
    const at = m.staticAccounts.length;
    const shift = (i: number) => (i >= at ? i + 1 : i);
    const message = {
        ...m,
        header: { ...m.header, numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts + 1 },
        staticAccounts: [...m.staticAccounts, program],
        instructions: m.instructions.map((ix) => ({ ...ix, accountIndices: ix.accountIndices.map(shift) })),
    };
    return { message, at, shift };
}
