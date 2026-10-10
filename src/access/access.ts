// Who besides a wallet can move, burn, freeze or close what it holds, without asking it again: a delegate or a close
// authority on one of its token accounts, what the mint of a token it holds lets its authorities do, and a transaction it
// signed that waits on a durable nonce. What it keeps elsewhere (stake accounts, deposits a program holds) is not read.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { getAddressDecoder, getBase58Decoder, parseBase64RpcAccount, type Address, type MaybeEncodedAccount } from '@solana/kit';

import { rpcChain } from '../chain.ts';
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { read, type Changes } from '../review/changes.ts';
import { durable, type Message } from '../review/decode.ts';
import { mintTerms } from './mint.ts';
import type { OtusRpc } from '../rpc.ts';

/** What someone besides you can do with what you hold, each with whom. */
export type Grant =
    | { kind: 'taken'; program: Address } // the wallet itself belongs to a program now, which can move all it holds
    | { kind: 'delegate'; account: Address; program: Address; mint: Address; to: Address; allowance: bigint; all: boolean } // can move up to `allowance` out of the account (of this token program); `all`: everything it holds, or without end
    | { kind: 'closer'; account: Address; mint: Address; to: Address; sol: bigint } // can close the account and keep its rent: once it holds no tokens, or, wrapped SOL (`sol`: what it holds), at any time, taking that SOL
    | { kind: 'permanent'; mint: Address; to: Address } // the token's permanent delegate: can move or burn any of yours, at any time
    | { kind: 'freeze'; mint: Address; to: Address } // the token's freeze authority: can freeze your accounts of it
    | { kind: 'nonce'; account: Address; nonce: string; authority: Address }; // a transaction you signed waits on this nonce: it can still run

/** A transaction you signed on a durable nonce: the nonce account, and the nonce it held then. */
export type Waiting = { account: Address; nonce: string };

/** The grants, worst first; `unchecked`: tokens you hold whose mint was not read, past MAX_MINTS, or did not fit. */
export type Access = { grants: Grant[]; unchecked: number };

export const MAX_MINTS = 300; // mints read, 100 a request
const U64_MAX = 2n ** 64n - 1n; // an allowance without end
const ORDER: Record<Grant['kind'], number> = { taken: 0, delegate: 1, permanent: 2, nonce: 3, closer: 4, freeze: 5 };

/** Who can move, burn, freeze or close what `owner` holds: the wallet itself, its token accounts and their mints, read
 *  in base64, and the nonce accounts of the transactions it signed that may still wait. */
export async function access(rpc: OtusRpc, owner: Address, waiting: Waiting[] = []): Promise<Access> {
    const lists = await Promise.all(TOKEN_PROGRAMS.map((programId) => rpc.getTokenAccountsByOwner(owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }).send()));
    // Each read as an account that may be missing: the form the review reads.
    const tokens = lists.flatMap(({ value }) => value.map(({ pubkey, account }) => parseBase64RpcAccount(pubkey, account as typeof account | null)));
    const held = heldMints(owner, tokens);
    const asked = held.slice(0, MAX_MINTS);
    const { accounts } = await rpcChain(rpc).accounts([owner, ...asked, ...waiting.map((w) => w.account)]);
    const nonces = waiting.map((w, i) => ({ waiting: w, account: accounts[1 + asked.length + i] }));
    const mints = accounts.slice(1, 1 + asked.length);
    // Read, but not mints as their layout says, or with an extension newer than Otus reads (it might move yours): unchecked too.
    const misfits = mints.map(mintTerms).filter((t) => !t || t.unknown.length > 0).length;
    return { grants: grantsOf(owner, tokens, mints, nonces, accounts[0]), unchecked: held.length - asked.length + misfits };
}

/** The mints of the tokens `owner` holds some of, in its token accounts: Token-2022's first, as only they can give an
 *  issuer the power to move them (past MAX_MINTS, the rest go unread). */
export function heldMints(owner: Address, tokens: MaybeEncodedAccount[]): Address[] {
    const mints = tokens.flatMap((a) => {
        const s = read(a);
        const t = s?.token;
        return s && t && t.owner === owner && !t.native && t.amount > 0n ? [{ mint: t.mint, first: s.program === TOKEN_2022_PROGRAM_ADDRESS }] : [];
    });
    return [...new Set([...mints.filter((m) => m.first), ...mints.filter((m) => !m.first)].map((m) => m.mint))];
}

/** Owner's token accounts, the mints of what it holds, and the nonce accounts of transactions it signed → the grants,
 *  worst first. Pure. */
export function grantsOf(owner: Address, tokens: MaybeEncodedAccount[], mints: MaybeEncodedAccount[], nonces: { waiting: Waiting; account: MaybeEncodedAccount }[], wallet?: MaybeEncodedAccount): Grant[] {
    const grants: Grant[] = [];
    // A wallet is the System Program's; once another program owns it, that program decides what leaves it.
    if (wallet?.exists && wallet.programAddress !== SYSTEM_PROGRAM_ADDRESS) grants.push({ kind: 'taken', program: wallet.programAddress });
    for (const a of tokens) {
        const s = read(a);
        const t = s?.token;
        if (!s || !t || t.owner !== owner) continue; // another's: what it allows is not yours to know
        if (t.delegate && t.delegate !== owner && t.delegated > 0n) grants.push({ kind: 'delegate', account: a.address, program: s.program, mint: t.mint, to: t.delegate, allowance: t.delegated, all: t.delegated === U64_MAX || (t.amount > 0n && t.delegated >= t.amount) });
        if (t.closer && t.closer !== owner) grants.push({ kind: 'closer', account: a.address, mint: t.mint, to: t.closer, sol: t.native ? t.amount : 0n });
    }
    const held = new Set(heldMints(owner, tokens));
    for (const a of mints) {
        const terms = held.has(a.address) ? mintTerms(a) : null;
        if (!terms) continue;
        const permanent = terms.extensions.find((e) => e.kind === 'permanentDelegate')?.delegate;
        if (permanent && permanent !== owner) grants.push({ kind: 'permanent', mint: a.address, to: permanent });
        if (terms.freezeAuthority) grants.push({ kind: 'freeze', mint: a.address, to: terms.freezeAuthority });
    }
    for (const { waiting, account } of nonces) {
        const held = nonceOf(account);
        if (held && held.nonce === waiting.nonce) grants.push({ kind: 'nonce', account: waiting.account, nonce: waiting.nonce, authority: held.authority });
    }
    return grants.sort((x, y) => ORDER[x.kind] - ORDER[y.kind]);
}

/** What a signed copy of a transaction waits on, when it lives by a durable nonce rather than a blockhash: the nonce
 *  account its first instruction advances, and the nonce. */
export function waitingOn(m: Message): Waiting | null {
    if (!durable(m)) return null;
    const at = m.instructions[0].accountIndices[0];
    const account = at === undefined ? undefined : m.staticAccounts[at];
    return account ? { account, nonce: m.lifetimeToken } : null;
}

/** The delegates a transaction gives on accounts of yours, or lets move more: each token account, and to whom. */
export function delegatesGiven(yours: Changes): { account: Address; to: Address }[] {
    return yours.accounts.flatMap(({ address, before, after }) => {
        const [from, to] = [before?.token, after?.token];
        return to?.delegate && (to.delegate !== from?.delegate || to.delegated > (from?.delegated ?? 0n)) ? [{ account: address, to: to.delegate }] : [];
    });
}

/** A nonce account's authority and the nonce it holds: System's, 80 bytes, its version and state (4 bytes each, state
 *  1: initialized), its authority (32), then the nonce (32). Null for any other account. */
export function nonceOf(a: MaybeEncodedAccount): { authority: Address; nonce: string } | null {
    if (!a.exists || a.programAddress !== SYSTEM_PROGRAM_ADDRESS || a.data.length !== 80) return null;
    if (![1, 0, 0, 0].every((b, i) => a.data[4 + i] === b)) return null;
    return { authority: getAddressDecoder().decode(a.data, 8), nonce: getBase58Decoder().decode(a.data.subarray(40, 72)) };
}

