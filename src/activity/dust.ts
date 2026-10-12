// Dust: what comes to a wallet only as noise, or to trick it, told apart so the caller may set it aside. Only what could
// never have hurt the wallet may be dust: it didn't sign it, nothing of its own left it or closed, no authority,
// delegate, lock or stake of it changed, and nothing failed. Anything else is news, whatever it looks like.
import type { Address } from '@solana/kit';

import { alike } from '../format.ts';
import { WEIGHTY, type Activity, type Move } from './summary.ts';

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

/** Whether `a` could never have hurt the wallet it was summarized for: the only kind that may be dust. */
export function harmless(a: Activity): boolean {
    if (a.signed || a.error !== null || a.squads.length > 0) return false;
    if (a.moves.some((m) => m.units < 0n) || a.rent.yours < 0n || a.staked !== 0n) return false;
    // Who may do what changed: news even when the wallet didn't sign (a token's freeze authority freezes its account;
    // anyone may name it an authority of their own).
    return !a.instructions.some((t) => WEIGHTY.test(t.name));
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
