// Dust: what comes to a wallet only as noise, or to trick it, told apart so the caller may set it aside. Only what could
// never have hurt the wallet may be dust: it didn't sign it, nothing of its own left it or closed, its stake didn't
// move, nothing failed, and nothing ran but what is known to give and nothing else (a transfer, a mint, a token account
// opened, a note). Anything else is news, whatever it looks like.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address } from '@solana/kit';

import { alike } from '../format.ts';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../programs/addresses.ts';
import type { Activity, Move } from './summary.ts';

/**
 * Why a transaction is dust:
 * - `copy`: it came from an address made to look like `of`, one the wallet knows, so that the copy is taken from its
 *   history for the real one (address poisoning);
 * - `empty`: nothing came, and only Solana's own programs ran (a transfer of nothing, a note);
 * - `unverified`: what came is tokens no list the caller trusts vouches for (spam tokens, NFTs), with at most what is
 *   worth less than `under` beside them;
 * - `tiny`: what came is worth less than `under` dollars, all told.
 */
export type Dust = { copy: Address; of: Address } | { empty: true } | { unverified: Address[] } | { tiny: number };

/**
 * What the caller knows. `known`: the wallet itself, the addresses it sent to, its contacts, its other wallets.
 * `verified`: whether a list it trusts vouches for a token (undefined: no one can say, and it is never dust for it).
 * `usd`: what an amount of a token (SOL: null) is worth in dollars (null: unknown). `under`: the dollars below which
 * what came is dust. Without them, only copies and empty transactions are.
 */
export type DustContext = {
    known: readonly Address[];
    verified?: (mint: Address) => boolean | undefined;
    usd?: (mint: Address | null, units: bigint, decimals: number) => number | null;
    under?: number;
};

// What may run in dust, by program: what gives (a transfer, a mint), opens (an account, a token, a token account) or
// notes, and nothing that changes who may do what, freezes or closes. Anything else, a batch of instructions or another
// program's, could do it unseen.
const TOKEN = ['Transfer', 'TransferChecked', 'MintTo', 'MintToChecked', 'InitializeMint', 'InitializeMint2', 'InitializeAccount', 'InitializeAccount2', 'InitializeAccount3', 'InitializeImmutableOwner', 'SyncNative'];
const BUDGET = ['RequestUnits', 'RequestHeapFrame', 'SetComputeUnitLimit', 'SetComputeUnitPrice', 'SetLoadedAccountsDataSizeLimit'];
const OPENS = ['CreateAssociatedToken', 'CreateAssociatedTokenIdempotent'];
const GIVES: ReadonlyMap<Address, readonly string[]> = new Map<Address, readonly string[]>([
    [SYSTEM_PROGRAM_ADDRESS, ['TransferSol', 'CreateAccount']],
    [TOKEN_PROGRAM_ADDRESS, TOKEN],
    [TOKEN_2022_PROGRAM_ADDRESS, TOKEN],
    [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, OPENS],
    [COMPUTE_BUDGET_PROGRAM_ADDRESS, BUDGET],
    [MEMO_PROGRAM_ADDRESS, ['AddMemo']],
    [LEGACY_MEMO_PROGRAM_ADDRESS_V1, ['AddMemo']],
    [LEGACY_MEMO_PROGRAM_ADDRESS_V3, ['AddMemo']],
]);
// What opening a token account runs inside it: the System Program and the token programs, nothing else.
const OPENING_RUNS = new Set<Address>([SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);

/** Whether `a` could never have hurt the wallet it was summarized for: the only kind that may be dust. */
export function harmless(a: Activity): boolean {
    if (a.signed || a.error !== null || a.squads.length > 0) return false;
    if (a.moves.some((m) => m.units < 0n) || a.rent.yours < 0n || a.staked !== 0n) return false;
    if (!a.instructions.every((t) => t.source === 'plugin' && GIVES.get(t.program)?.includes(t.name))) return false;
    // What ran inside them: only what opening a token account runs, and only under it (a token's transfer hook, under
    // its transfer, is another program's doing). Unknown: anything may have.
    if (a.inner === null) return false;
    return a.inner.every(({ index, programs }) => OPENS.includes(a.instructions[index]?.name ?? '') && a.instructions[index]?.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && programs.every((p) => OPENING_RUNS.has(p)));
}

/** Why `a` is dust, or null: news. */
export function dust(a: Activity, context: DustContext): Dust | null {
    if (!harmless(a)) return null;
    const from = a.other;
    if (from !== null && !context.known.includes(from)) {
        const of = context.known.find((k) => alike(from, k));
        if (of) return { copy: from, of };
    }
    const ins = a.moves.filter((m) => m.units > 0n);
    // Nothing came: dust only when nothing but Solana's own programs ran, every one of them read.
    if (!ins.length) return a.instructions.length > 0 && a.instructions.every((t) => t.source === 'plugin') ? { empty: true } : null;
    return worthless(ins, context);
}

// Why what came is worth no news, or null: tokens no one vouches for, and what is worth less than `under` all told.
// Anything whose worth is unknown is news.
function worthless(ins: Move[], { verified, usd, under }: DustContext): Dust | null {
    const unverified: Address[] = [];
    let [priced, worth] = [false, 0];
    for (const m of ins) {
        if (m.mint !== null && verified?.(m.mint) === false) {
            unverified.push(m.mint);
            continue;
        }
        const dollars = usd?.(m.mint, m.units, m.decimals) ?? null;
        if (dollars === null || !Number.isFinite(dollars) || dollars < 0) return null;
        [priced, worth] = [true, worth + dollars];
    }
    if (priced && (under === undefined || !(worth < under))) return null;
    return unverified.length ? { unverified } : { tiny: worth };
}
