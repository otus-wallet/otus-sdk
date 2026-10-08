// What one landed transaction did for a wallet, read from the transaction alone: no account, table or name is asked
// for. What the wallet gained and lost comes from the balances the transaction itself lists, before and after, so it
// is what happened, not a guess; the fee and the rent of accounts it opened or closed are set apart. Its kind (a send, a
// receipt, a swap, a mint, a burn) comes from where what moved went: a token no one else lost was made by its mint, not
// received. The other side, the programs, Squads steps and a memo come from its own instructions.
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { isOffCurveAddress, type Address } from '@solana/kit';

import { told } from '../format.ts';
import { isTokenProgram, isWrappedSol, LIGHTHOUSE } from '../programs/addresses.ts';
import { CORE_PROGRAMS } from '../programs/core.ts';
import { readCall, SQUADS_V4, type Step } from '../programs/squads.ts';
import { explain, type Explained } from '../review/explain.ts';
import type { Landed, TokenBalance } from './history.ts';

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
 *  signed it, or is a program's address (a Squads vault), which never signs: its program moves it; what left a wallet
 *  that did not, a delegate of its tokens moved. `other`: who got what a send sent, or sent what a
 *  receipt got. `main`: its first program that is not one of Solana's own. */
export type Activity = {
    signature: string;
    time: number | null;
    error: string | null;
    kind: Kind;
    moves: Move[];
    fee: bigint;
    payer: Address;
    rent: { yours: bigint; theirs: bigint; opened: bigint };
    created: Address[];
    instructions: Told[];
    held: Held[];
    fresh: Address[]; // the accounts it brought into being
    signed: boolean;
    other: Address | null;
    programs: Address[];
    main: Address | null;
    squads: Step[];
    memo: string | null;
};

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
    const own = [...new Set([...tokens.before, ...tokens.after].filter((b) => yours(b.owner)).map((b) => b.account))];
    const rent = own.reduce((n, i) => n + rentIn('after', i) - rentIn('before', i), 0n);
    const at = accounts.indexOf(wallet);
    const spent = at < 0 ? 0n : change(at);
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
    const told = instructionsOf(t);
    const made = told.reduce((n, ix) => {
        if (ix.program !== SYSTEM_PROGRAM_ADDRESS || (ix.name !== 'CreateAccount' && ix.name !== 'CreateAccountWithSeed')) return n;
        const fresh = ix.accounts.find((a) => a.role === 'newAccount')?.address;
        const value = (name: string) => ix.args.find((a) => a.name === name)?.value ?? '';
        const at = fresh ? accounts.indexOf(fresh) : -1;
        if (at < 0 || fresh === wallet || lamports.before[at] !== 0n || listed('after', at).length || !/^\d{1,9}$/.test(value('space'))) return n;
        if (value('programAddress') === SYSTEM_PROGRAM_ADDRESS && value('space') === '0') return n;
        return n + min(lamports.after[at], rentFor(Number(value('space'))));
    }, 0n);
    const opened = sol < 0n ? min(made, -sol) : 0n;
    sol += opened;
    const moves: Move[] = [...(sol !== 0n ? [{ mint: null, units: sol, decimals: 9 }] : []), ...tokenMoves(t, (owner) => yours(owner))];
    const signed = isOffCurveAddress(wallet) || t.message.staticAccounts.slice(0, t.message.header.numSignerAccounts).includes(wallet);
    // A token gained that no other account lost, as its total grew as much, was minted; one lost that no other account
    // gained, burned. Wrapped SOL, which a closed account turns back into SOL, is neither.
    const total = (mint: Address) => sum(t.tokens.after, mint) - sum(t.tokens.before, mint);
    const elsewhere = (mint: Address, way: bigint) => othersMoved(t, wallet, mint, way);
    const madeOrBurned = (m: Move) => m.mint !== null && !isWrappedSol(m.mint) && (m.units > 0n ? !elsewhere(m.mint, -1n) && total(m.mint) >= m.units : !elsewhere(m.mint, 1n) && total(m.mint) <= m.units);
    const kind = kindOf(moves.filter(madeOrBurned), moves.filter((m) => !madeOrBurned(m)));
    const programs = [...new Set(t.message.instructions.map((ix) => accounts[ix.programAddressIndex]))];
    return {
        signature: t.signature,
        time: t.time,
        error: t.error,
        kind,
        moves,
        fee: t.fee,
        payer,
        rent: { yours: rent, theirs, opened },
        created: t.error ? [] : createdMints(t),
        instructions: told,
        fresh: accounts.filter((_, i) => lamports.before[i] === 0n && lamports.after[i] > 0n),
        held: heldIn(t),
        signed,
        other: kind === 'send' || kind === 'receive' ? otherSide(t, wallet, moves, kind === 'send' ? 1n : -1n, change) : null,
        programs,
        main: programs.find((p) => !CORE_PROGRAMS.has(p) && p !== LIGHTHOUSE) ?? null,
        squads: [...new Set(squadsSteps(t))],
        memo: memo(t),
    };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sum = (balances: TokenBalance[], mint: Address) => balances.reduce((n, b) => (b.mint === mint ? n + b.units : n), 0n);

// The most rent a new account of this many bytes needs: 128 bytes more, at 3,480 lamports a byte-year, for two years
// (mainnet's rate; a cluster may ask less, never more).
const rentFor = (space: number) => BigInt(128 + space) * 6_960n;

// Whether an account that is not the wallet's gained (way 1) or lost (−1) some of this token in the transaction.
function othersMoved(t: Landed, wallet: Address, mint: Address, way: bigint): boolean {
    const by = new Map<number, bigint>();
    for (const [side, sign] of [['before', -1n], ['after', 1n]] as const) {
        for (const b of t.tokens[side]) if (b.mint === mint && b.owner !== wallet) by.set(b.account, (by.get(b.account) ?? 0n) + sign * b.units);
    }
    return [...by.values()].some((d) => d * way > 0n);
}

// A mint when what came was made and nothing but SOL went (an NFT, a pool or stake token paid for); a burn when nothing
// else moved; then by what went to others and came from them.
function kindOf(made: Move[], real: Move[]): Kind {
    const [gains, losses] = [real.some((m) => m.units > 0n), real.some((m) => m.units < 0n)];
    if (made.some((m) => m.units > 0n) && !real.some((m) => m.units < 0n && m.mint !== null)) return 'mint';
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
