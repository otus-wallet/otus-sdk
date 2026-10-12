// Dust: what comes to a wallet only as noise, or to trick it, told apart so the caller may set it aside. Only what could
// never have hurt the wallet may be dust: it didn't sign it, nothing of its own left it or closed, no authority,
// delegate, lock or stake of it changed, and nothing failed. Anything else is news, whatever it looks like.
import type { Address } from '@solana/kit';

import { alike } from '../format.ts';
import type { Activity } from './summary.ts';

/** Why a transaction is dust. `copy`: it came from an address made to look like `of`, one the wallet knows, so that
 *  the copy is taken from its history for the real one (address poisoning). */
export type Dust = { copy: Address; of: Address };

/** What the caller knows of the wallet: the wallet itself, the addresses it sent to, its contacts, its other wallets. */
export type DustContext = { known: readonly Address[] };

// Instructions that change who may do what with an account, or close, lock or freeze it: news even when the wallet
// didn't sign (a token's freeze authority freezes its account; anyone may name it an authority of their own).
const NEVER = /Approve|Revoke|Authori|Close|Freeze|Thaw|Assign|Lockup|Nonce|Delegate|Deactivate|Withdraw|Split|Merge|Upgrade/;

/** Whether `a` could never have hurt the wallet it was summarized for: the only kind that may be dust. */
export function harmless(a: Activity): boolean {
    if (a.signed || a.error !== null || a.squads.length > 0) return false;
    if (a.moves.some((m) => m.units < 0n) || a.rent.yours < 0n || a.staked !== 0n) return false;
    return !a.instructions.some((t) => NEVER.test(t.name));
}

/** Why `a` is dust, or null: news. */
export function dust(a: Activity, context: DustContext): Dust | null {
    if (!harmless(a) || a.other === null) return null;
    const from = a.other;
    if (context.known.includes(from)) return null;
    const of = context.known.find((k) => alike(from, k));
    return of ? { copy: from, of } : null;
}
