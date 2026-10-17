// What one landed transaction did for a wallet, read from the transaction alone: no account, table or name is asked
// for. What the wallet gained and lost comes from the balances the transaction itself lists, before and after, so it
// is what happened, not a guess; the fee and the rent of accounts it opened or closed are set apart. Its kind (a send, a
// receipt, a swap, a mint, a burn) comes from where what moved went: a token no one else lost was made by its mint, not
// received. The other side, the programs, Squads steps and a memo come from its own instructions.
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { STAKE_PROGRAM_ADDRESS } from '@solana-program/stake';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { isOffCurveAddress, type Address } from '@solana/kit';

import { told } from '../format.ts';
import { isTokenProgram, isWrappedSol, LIGHTHOUSE, SENDER_TIPS } from '../programs/addresses.ts';
import { CORE_PROGRAMS } from '../programs/core.ts';
import { PROGRAM_NAMES } from '../programs/known.ts';
import { readCall, SQUADS_V4, type Step } from '../programs/squads.ts';
import { explain, type Explained } from '../review/explain.ts';
import { givesOnly } from './dust.ts';
import type { Inner, Landed, TokenBalance } from './history.ts';

/** What a program Otus doesn't know did with the wallet's by what it ran inside (its inner instructions), read by the
 *  same decoders: SOL or a token `sent` to `to` (a token account's owner when the transaction lists it); SOL put in an
 *  account it `opened` (`to`); a token account of the wallet's `approved` to a delegate (`to`, up to `units`), given to
 *  another owner (`authority`, `to`), or `closed` with its SOL to `to`; the wallet itself `assigned` to a program (`to`).
 *  `units` and `decimals` are 0 where nothing is counted. */
export type Through = { program: Address; kind: 'sent' | 'opened' | 'approved' | 'authority' | 'closed' | 'assigned'; to: Address; mint: Address | null; units: bigint; decimals: number };

/** A change in one of the wallet's balances: SOL (mint null) or a token, in its base units, gained (+) or lost (−). */
export type Move = { mint: Address | null; units: bigint; decimals: number };

/** `swap`: something of yours went to others and something came back from others; `mint` and `burn`: a token you got
 *  that no one else lost, or lost that no one else got. */
export type Kind = 'send' | 'receive' | 'swap' | 'mint' | 'burn' | 'other';

/** A top-level instruction as the review's decoders read it (Solana's own programs, by their official clients): its
 *  name, accounts by role and arguments; an instruction of any other program is 'unknown'. */
export type Told = Omit<Explained, 'data'>;

/** A token account the transaction lists, with what it holds and who owns it. */
export type Held = { address: Address; mint: Address; decimals: number; owner: Address | null };

/** A transaction for the wallet, in short. `moves`: SOL first, then each token; SOL without the fee the wallet paid
 *  and rent. `rent.yours`: the rent its own token accounts gained (+, opened) or lost (−, closed); `rent.theirs`: what
 *  it put in others' token accounts it opened for them; `rent.opened`: what it put in other accounts the transaction
 *  made (a mint, a nonce account). `created`: the mints it made. `signed`: whether the wallet
 *  signed it, or is a program's address (a Squads vault), which never signs, and something that could act for it ran:
 *  its program moves it; what left a wallet that did not, a delegate of its tokens moved. `other`: who got what a send
 *  sent, or sent what a receipt got. `main`: its first program that is not one of Solana's own. */
export type Activity = {
    signature: string;
    signatures: Readonly<Record<Address, string>>; // each signer's, by its address
    slot: bigint;
    time: number | null;
    error: string | null;
    kind: Kind;
    moves: Move[];
    fee: bigint;
    tip: bigint; // what the wallet paid to land it (a tip to Helius Sender), apart from what it sent
    payer: Address;
    rent: { yours: bigint; theirs: bigint; opened: bigint };
    created: Address[];
    instructions: Told[];
    held: Held[];
    fresh: Address[]; // the accounts it brought into being
    staked: bigint; // SOL it put in stake accounts of the wallet's own (it withdraws from them), or took out of them
    signed: boolean;
    other: Address | null;
    programs: Address[];
    unknown: Address[]; // the programs it calls that Otus doesn't know: neither reads nor names them
    through: Through[];
    main: Address | null;
    squads: Step[];
    memo: string | null;
    inner: Inner[] | null; // what its instructions ran inside them (CPI), by their place; null when unknown
};

/** The instructions that change who may do what with an account, or close, lock, freeze or unstake it: what a
 *  transaction is about before anything else it does, and never dust. */
export const WEIGHTY = /Approve|Revoke|Authori|Close|Freeze|Thaw|Assign|Lockup|Nonce|Delegate|Deactivate|Withdraw|Split|Merge|Upgrade/;

const MEMOS: readonly Address[] = [MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3];

/** A landed transaction → what it did for `wallet`. Pure. */
export function summarize(t: Landed, wallet: Address): Activity {
    const { accounts, lamports, tokens } = t;
    const payer = accounts[0];
    const change = (i: number) => lamports.after[i] - lamports.before[i] + (i === 0 ? t.fee : 0n); // as if no fee
    const yours = (owner: Address | null) => owner === wallet;
    const listed = (side: 'before' | 'after', i: number) => tokens[side].filter((b) => b.account === i);
    // The wallet's SOL counts the rent in its own token accounts as still its own: rent put in one it opens is not
    // spent, rent back from one it closes is not received, rent that one sends elsewhere is. Wrapped SOL in them is a
    // token, apart from their rent.
    const rentIn = (side: 'before' | 'after', i: number) => lamports[side][i] - listed(side, i).reduce((n, b) => n + (isWrappedSol(b.mint) ? b.units : 0n), 0n);
    const told = instructionsOf(t);
    // A token account's SOL is the wallet's only while it alone can close it, as the review reads it: one closed by
    // someone else's authority (a close authority set by whoever opened it for the wallet, say) held SOL that was
    // theirs to take, and what leaves with it is none of the wallet's.
    const closers = closersIn(t, told);
    const theirsToClose = (i: number) => {
        const by = closers.get(accounts[i]!);
        return by !== undefined && by !== wallet;
    };
    const own = [...new Set([...tokens.before, ...tokens.after].filter((b) => yours(b.owner)).map((b) => b.account))].filter((i) => !theirsToClose(i));
    const rent = own.reduce((n, i) => n + rentIn('after', i) - rentIn('before', i), 0n);
    const at = accounts.indexOf(wallet);
    // Stake accounts it sets up for the wallet to withdraw from: the SOL put in them stays the wallet's own, staked.
    const staking = stakesFor(told, wallet).map((a) => accounts.indexOf(a)).filter((i) => i >= 0);
    const staked = staking.reduce((n, i) => n + change(i), 0n);
    const spent = (at < 0 ? 0n : change(at)) + staked;
    // Rent others put in a token account of the wallet's is no SOL of its own: only what the wallet paid counts.
    let sol = spent + (rent > 0n ? min(rent, spent < 0n ? -spent : 0n) : rent);
    // What it paid to open others' token accounts is rent of theirs, not SOL sent: up to what the wallet lost. Wrapped
    // SOL put in one is SOL sent.
    const given = accounts.reduce((n, _, i) => {
        const [before, after] = [listed('before', i), listed('after', i)];
        return lamports.before[i] === 0n && after.length && !before.length && !after.every((b) => yours(b.owner)) ? n + rentIn('after', i) : n;
    }, 0n);
    const theirs = sol < 0n ? min(given, -sol) : 0n;
    sol += theirs;
    // Other accounts its own CreateAccount made (a mint, a nonce account): what the wallet put in them is rent, as much as
    // the space each declares needs, and no more; past that it is SOL sent, as to a stake account. A plain account holds
    // SOL, not rent.
    const made = told.reduce((n, ix) => {
        if (ix.program !== SYSTEM_PROGRAM_ADDRESS || (ix.name !== 'CreateAccount' && ix.name !== 'CreateAccountWithSeed')) return n;
        const fresh = ix.accounts.find((a) => a.role === 'newAccount')?.address;
        const value = (name: string) => ix.args.find((a) => a.name === name)?.value ?? '';
        const at = fresh ? accounts.indexOf(fresh) : -1;
        if (at < 0 || fresh === wallet || staking.includes(at) || lamports.before[at] !== 0n || listed('after', at).length || !/^\d{1,9}$/.test(value('space'))) return n;
        if (value('programAddress') === SYSTEM_PROGRAM_ADDRESS && value('space') === '0') return n;
        return n + min(lamports.after[at], rentFor(Number(value('space'))));
    }, 0n);
    const opened = sol < 0n ? min(made, -sol) : 0n;
    sol += opened;
    // A tip it paid for landing it (to Helius Sender): what it cost, as the fee, not SOL sent. One transfer, of what a
    // tip costs at most: more is SOL sent, whoever it went to. Up to what it lost.
    const tipping = t.error ? null : tipOf(told, wallet);
    const tip = tipping && sol < 0n ? min(tipping.amount, -sol) : 0n;
    sol += tip;
    const moves: Move[] = [...(sol !== 0n ? [{ mint: null, units: sol, decimals: 9 }] : []), ...tokenMoves(t, (owner) => yours(owner))];
    // A program's address (a Squads vault) never signs: its program moves it, so it counts as signed whenever something
    // that could act for it ran. Only what gives ran (a transfer to it, a token account opened): its program didn't.
    const signed = t.message.staticAccounts.slice(0, t.message.header.numSignerAccounts).includes(wallet) || (isOffCurveAddress(wallet) && !givesOnly(told, t.inner));
    // A token gained that no other account lost, as its total grew as much, was minted; one lost that no other account
    // gained, burned. Wrapped SOL, which a closed account turns back into SOL, is neither.
    const total = (mint: Address) => sum(t.tokens.after, mint) - sum(t.tokens.before, mint);
    const elsewhere = (mint: Address, way: bigint) => othersMoved(t, wallet, mint, way);
    const madeOrBurned = (m: Move) => m.mint !== null && !isWrappedSol(m.mint) && (m.units > 0n ? !elsewhere(m.mint, -1n) && total(m.mint) >= m.units : !elsewhere(m.mint, 1n) && total(m.mint) <= m.units);
    // Tokens of the wallet's that went to a person (an owner on the curve: a key's, not a program's pool): a junk token
    // minted back is no exchange for them.
    const toPeople = moves.some((m) => m.units < 0n && m.mint !== null && !madeOrBurned(m) && gainers(t, wallet, m.mint).some((o) => !isOffCurveAddress(o)));
    const kind = kindOf(moves.filter(madeOrBurned), moves.filter((m) => !madeOrBurned(m)), toPeople);
    const programs = [...new Set(t.message.instructions.map((ix) => accounts[ix.programAddressIndex]))];
    const unknown = programs.filter((p) => !PROGRAM_NAMES.has(p));
    const held = heldIn(t);
    return {
        signature: t.signature,
        signatures: t.signatures,
        slot: t.slot,
        time: t.time,
        error: t.error,
        kind,
        moves,
        fee: t.fee,
        tip,
        payer,
        rent: { yours: rent, theirs, opened },
        created: t.error ? [] : createdMints(t),
        instructions: told,
        fresh: accounts.filter((_, i) => lamports.before[i] === 0n && lamports.after[i] > 0n),
        staked,
        held,
        signed,
        // The tip apart from what the tip account got: never the other side of a send for it.
        other: kind === 'send' || kind === 'receive' ? otherSide(t, wallet, moves, kind === 'send' ? 1n : -1n, (i) => change(i) - (tip && t.accounts[i] === tipping?.to ? tip : 0n)) : null,
        programs,
        unknown,
        through: t.error ? [] : throughUnknown(t, wallet, new Set(unknown), held),
        main: programs.find((p) => !CORE_PROGRAMS.has(p) && p !== LIGHTHOUSE) ?? null,
        squads: [...new Set(squadsSteps(t))],
        memo: memo(t),
        inner: t.inner,
    };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sum = (balances: TokenBalance[], mint: Address) => balances.reduce((n, b) => (b.mint === mint ? n + b.units : n), 0n);

// The stake accounts it sets up with the wallet as the one who withdraws: Initialize's withdrawer, InitializeChecked's
// withdraw authority.
function stakesFor(told: Told[], wallet: Address): Address[] {
    return told.flatMap((ix) => {
        if (ix.program !== STAKE_PROGRAM_ADDRESS || (ix.name !== 'Initialize' && ix.name !== 'InitializeChecked')) return [];
        const stake = ix.accounts.find((a) => a.role === 'stake')?.address;
        const withdrawer = ix.accounts.find((a) => a.role === 'withdrawAuthority')?.address ?? /withdrawer: ([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(ix.args.find((a) => a.name === 'arg0')?.value ?? '')?.[1];
        return stake && withdrawer === wallet ? [stake] : [];
    });
}

// The most rent a new account of this many bytes needs: 128 bytes more, at 3,480 lamports a byte-year, for two years
// (mainnet's rate; a cluster may ask less, never more).
const rentFor = (space: number) => BigInt(128 + space) * 6_960n;

// Whether an account that is not the wallet's gained (way 1) or lost (−1) some of this token in the transaction.
// The owners of others' accounts that gained `mint`.
function gainers(t: Landed, wallet: Address, mint: Address): Address[] {
    const by = new Map<number, { owner: Address | null; units: bigint }>();
    for (const [side, sign] of [['before', -1n], ['after', 1n]] as const) {
        for (const b of t.tokens[side]) if (b.mint === mint && b.owner !== wallet) by.set(b.account, { owner: b.owner, units: (by.get(b.account)?.units ?? 0n) + sign * b.units });
    }
    return [...by.values()].flatMap((g) => (g.units > 0n && g.owner ? [g.owner] : []));
}

// The tip a transaction's instructions pay from `wallet`, and to which of Sender's accounts: one transfer, of no more than
// a tip costs; null for none.
function tipOf(told: Told[], wallet: Address): { amount: bigint; to: Address } | null {
    const tips = told.flatMap((ix) => {
        if (ix.program !== SYSTEM_PROGRAM_ADDRESS || ix.name !== 'TransferSol') return [];
        const at = (role: string) => ix.accounts.find((a) => a.role === role)?.address;
        const amount = ix.args.find((a) => a.name === 'amount')?.value ?? '';
        const to = at('destination');
        return at('source') === wallet && to && SENDER_TIPS.includes(to) && /^\d{1,19}$/.test(amount) ? [{ amount: BigInt(amount), to }] : [];
    });
    return tips.length === 1 && tips[0]!.amount <= MOST_TIP ? tips[0]! : null;
}

// What a tip to land a transaction costs at most: Otus pays 0.00001 SOL; more than 0.001 is no tip but SOL sent.
const MOST_TIP = 1_000_000n;

function othersMoved(t: Landed, wallet: Address, mint: Address, way: bigint): boolean {
    const by = new Map<number, bigint>();
    for (const [side, sign] of [['before', -1n], ['after', 1n]] as const) {
        for (const b of t.tokens[side]) if (b.mint === mint && b.owner !== wallet) by.set(b.account, (by.get(b.account) ?? 0n) + sign * b.units);
    }
    return [...by.values()].some((d) => d * way > 0n);
}

// A mint when what came was made and nothing but SOL went (an NFT, a pool or stake token paid for); a burn when nothing
// else moved; then by what went to others and came from them.
function kindOf(made: Move[], real: Move[], toPeople = false): Kind {
    const [gains, losses] = [real.some((m) => m.units > 0n), real.some((m) => m.units < 0n)];
    const [minted, burned] = [made.filter((m) => m.units > 0n), made.some((m) => m.units < 0n)];
    const tokensGone = real.some((m) => m.units < 0n && m.mint !== null);
    // Something given for something else is a swap, as people see it: whether what came was minted for it (a deposit's
    // receipt, a staked token) or what left was burned (redeemed). Only an NFT minted for SOL is a mint. Tokens of yours
    // gone to a person for something minted are a send: a junk token back buys nothing.
    const nftForSol = !gains && !burned && !tokensGone && minted.every((m) => m.units === 1n && m.decimals === 0);
    if ((gains || minted.length) && (losses || burned) && !(!gains && toPeople)) return nftForSol ? 'mint' : 'swap';
    if (minted.length && !tokensGone) return 'mint';
    if (made.length && !gains && !losses) return 'burn';
    if (gains && losses) return 'swap';
    if (losses) return 'send';
    if (gains) return 'receive';
    return made.length ? 'burn' : 'other';
}

// Its top-level instructions, read by the same decoders as a review: each account's place in the message gives its
// role (signers first, writable before read-only; loaded ones after, writable first).
function instructionsOf(t: Landed): Told[] {
    const { header: h, staticAccounts, lookups } = t.message;
    const statics = staticAccounts.length;
    const loadedWritable = lookups.reduce((n, l) => n + l.writableIndexes.length, 0);
    const accounts = t.accounts.map((address, i) => ({
        address,
        signer: i < h.numSignerAccounts,
        writable: i < statics ? (i < h.numSignerAccounts ? i < h.numSignerAccounts - h.numReadonlySignerAccounts : i < statics - h.numReadonlyNonSignerAccounts) : i < statics + loadedWritable,
    }));
    return explain({ message: t.message, accounts }).map(({ data: _, ...rest }) => rest);
}

// Token accounts the transaction closes, each with the authority that closed it (its owner, or its close authority):
// in its own instructions and, read the same way, in the instructions they make.
function closersIn(t: Landed, told: Told[]): Map<Address, Address> {
    const out = new Map<Address, Address>();
    const read = (e: Pick<Told, 'program' | 'name' | 'accounts'>) => {
        if (!isTokenProgram(e.program) || e.name !== 'CloseAccount') return;
        const at = (role: string) => e.accounts.find((a) => a.role === role)?.address;
        const [account, by] = [at('account'), at('owner')];
        if (account && by) out.set(account, by);
    };
    told.forEach(read);
    for (const group of t.inner ?? []) {
        for (const ix of group.instructions) {
            const accounts = [ix.program, ...ix.accounts].map((address) => ({ address, signer: false, writable: true }));
            const [e] = explain({ message: { instructions: [{ programAddressIndex: 0, accountIndices: ix.accounts.map((_, i) => i + 1), data: ix.data }] }, accounts });
            if (e && e.source === 'plugin') read(e);
        }
    }
    return out;
}

// What the programs Otus doesn't know did with the wallet's inside them: each inner instruction of theirs read as the
// review reads Solana's own (one at a time, its accounts in place), kept when it sends the wallet's SOL or tokens, puts
// its SOL in an account it opens, or hands over, closes or approves a token account of the wallet's, or the wallet
// itself. A token account is the wallet's only as the transaction found it, before: one handed to it on the way was not
// its own when it moved. Anything it can't read is left out: the warning stands for it.
function throughUnknown(t: Landed, wallet: Address, unknown: Set<Address>, held: Held[]): Through[] {
    if (!t.inner || unknown.size === 0) return [];
    const holdings = new Map(held.map((h) => [h.address, h]));
    const yours = new Map(t.tokens.before.filter((b) => b.owner === wallet && t.accounts[b.account]).map((b) => [t.accounts[b.account]!, b]));
    const out: Through[] = [];
    for (const group of t.inner) {
        const top = t.message.instructions[group.index];
        const program = top && t.accounts[top.programAddressIndex];
        if (!program || !unknown.has(program)) continue;
        for (const ix of group.instructions) {
            const accounts = [ix.program, ...ix.accounts].map((address) => ({ address, signer: false, writable: true }));
            const [e] = explain({ message: { instructions: [{ programAddressIndex: 0, accountIndices: ix.accounts.map((_, i) => i + 1), data: ix.data }] }, accounts });
            if (!e || e.source !== 'plugin') continue;
            const at = (role: string) => e.accounts.find((a) => a.role === role)?.address;
            const arg = (name: string) => e.args.find((a) => a.name === name)?.value ?? '';
            const found = didWith(e, wallet, yours, holdings, at, arg);
            if (found) out.push({ program, ...found });
        }
    }
    return out;
}

// One inner instruction, read, as what it did with the wallet's; null for anything else.
function didWith(e: Explained, wallet: Address, yours: Map<Address, TokenBalance>, holdings: Map<Address, Held>, at: (role: string) => Address | undefined, arg: (name: string) => string): Omit<Through, 'program'> | null {
    const number = (v: string) => (/^\d{1,20}$/.test(v) ? BigInt(v) : null);
    if (e.program === SYSTEM_PROGRAM_ADDRESS) {
        const units = number(arg(e.name === 'CreateAccount' ? 'lamports' : 'amount'));
        if (e.name === 'TransferSol' && at('source') === wallet && at('destination') && at('destination') !== wallet && units) return { kind: 'sent', to: at('destination')!, mint: null, units, decimals: 9 };
        if (e.name === 'CreateAccount' && at('payer') === wallet && at('newAccount') && units) return { kind: 'opened', to: at('newAccount')!, mint: null, units, decimals: 9 };
        if (e.name === 'Assign' && at('account') === wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(arg('programAddress'))) return { kind: 'assigned', to: arg('programAddress') as Address, mint: null, units: 0n, decimals: 0 };
        return null;
    }
    if (!isTokenProgram(e.program)) return null;
    const own = (role: string) => yours.get(at(role) ?? ('' as Address));
    const units = number(arg('amount'));
    switch (e.name) {
        case 'Transfer':
        case 'TransferChecked': {
            const from = own('source');
            const to = at('destination');
            if (!from || !to || to === at('source') || !units) return null;
            return { kind: 'sent', to: holdings.get(to)?.owner ?? to, mint: from.mint, units, decimals: from.decimals };
        }
        case 'Approve':
        case 'ApproveChecked': {
            const from = own('source');
            return from && at('delegate') && units ? { kind: 'approved', to: at('delegate')!, mint: from.mint, units, decimals: from.decimals } : null;
        }
        case 'SetAuthority': {
            const owned = own('owned');
            const to = arg('newAuthority');
            return owned && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) && to !== wallet ? { kind: 'authority', to: to as Address, mint: owned.mint, units: 0n, decimals: owned.decimals } : null;
        }
        case 'CloseAccount': {
            const closed = own('account');
            return closed && at('destination') && at('destination') !== wallet ? { kind: 'closed', to: at('destination')!, mint: closed.mint, units: 0n, decimals: closed.decimals } : null;
        }
    }
    return null;
}

// Every token account it lists, once, with its mint, decimals and owner.
function heldIn(t: Landed): Held[] {
    const seen = new Map<number, Held>();
    for (const b of [...t.tokens.before, ...t.tokens.after]) if (!seen.has(b.account) && t.accounts[b.account]) seen.set(b.account, { address: t.accounts[b.account], mint: b.mint, decimals: b.decimals, owner: b.owner });
    return [...seen.values()];
}

// The mints the transaction made itself: a token program's InitializeMint (0) or InitializeMint2 (20), the mint first.
function createdMints(t: Landed): Address[] {
    return t.message.instructions.flatMap((ix) => (isTokenProgram(t.accounts[ix.programAddressIndex]) && (ix.data[0] === 0 || ix.data[0] === 20) && ix.accountIndices.length ? [t.accounts[ix.accountIndices[0]]] : []));
}

// What an owner gained or lost of each token, by mint, as the token balances show: those it changed.
function tokenMoves(t: Landed, ownerIs: (owner: Address | null) => boolean): Move[] {
    const by = new Map<Address, Move>();
    for (const [side, sign] of [['before', -1n], ['after', 1n]] as const) {
        for (const b of t.tokens[side]) {
            if (!ownerIs(b.owner)) continue;
            const m = by.get(b.mint) ?? { mint: b.mint, units: 0n, decimals: b.decimals };
            by.set(b.mint, { ...m, units: m.units + sign * b.units });
        }
    }
    return [...by.values()].filter((m) => m.units !== 0n);
}

// The other side of a send (what it lost went to them: `sign` 1) or a receipt (−1): for the first token moved, the
// owner whose balance of it moved most the other way; for SOL alone, the account whose lamports did.
function otherSide(t: Landed, wallet: Address, moves: Move[], sign: bigint, change: (i: number) => bigint): Address | null {
    const token = moves.find((m) => m.mint !== null);
    let best: { who: Address; by: bigint } | null = null;
    const consider = (who: Address | null, by: bigint) => void (who && who !== wallet && by * sign > 0n && (!best || by * sign > best.by * sign) && (best = { who, by }));
    if (token) {
        const owners = new Set(t.tokens.after.concat(t.tokens.before).map((b) => b.owner));
        for (const owner of owners) consider(owner, tokenMoves(t, (o) => o === owner).find((m) => m.mint === token.mint)?.units ?? 0n);
    } else {
        t.accounts.forEach((a, i) => consider(a, change(i)));
    }
    return (best as { who: Address } | null)?.who ?? null;
}

function squadsSteps(t: Landed): Step[] {
    return t.message.instructions.flatMap((ix) => {
        if (t.accounts[ix.programAddressIndex] !== SQUADS_V4) return [];
        try {
            const call = readCall(ix.data, ix.accountIndices.map((i) => t.accounts[i]));
            return call ? [call.step] : [];
        } catch {
            return [];
        }
    });
}

// The first memo it carries, as text.
function memo(t: Landed): string | null {
    const ix = t.message.instructions.find((i) => MEMOS.includes(t.accounts[i.programAddressIndex]));
    if (!ix || !ix.data.length) return null;
    return told(new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(ix.data)), 160) || null;
}
