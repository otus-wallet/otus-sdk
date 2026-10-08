// Who besides a wallet can move, burn, freeze or close what it holds, without asking it again: a delegate or a close
// authority on one of its token accounts, what the mint of a token it holds lets the issuer do, and a transaction it
// signed that waits on a durable nonce. What it keeps elsewhere (stake accounts, deposits a program holds) is not read.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { getAddressDecoder, getBase58Decoder, parseBase64RpcAccount, type Address, type MaybeEncodedAccount, type ReadonlyUint8Array } from '@solana/kit';

import { rpcChain } from '../chain.ts';
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { isMint } from '../review/assess.ts';
import { read } from '../review/changes.ts';
import type { OtusRpc } from '../rpc.ts';

/** What someone besides you can do with what you hold, each with whom. */
export type Grant =
    | { kind: 'delegate'; account: Address; mint: Address; to: Address; allowance: bigint; all: boolean } // can move up to `allowance` out of the account; `all`: everything it holds, or without end
    | { kind: 'closer'; account: Address; mint: Address; to: Address } // can close the account once it is empty, and keep its rent
    | { kind: 'permanent'; mint: Address; to: Address } // the token's permanent delegate: can move or burn any of yours, at any time
    | { kind: 'freeze'; mint: Address; to: Address } // the token's freeze authority: can freeze your accounts of it
    | { kind: 'nonce'; account: Address; nonce: string; authority: Address }; // a transaction you signed waits on this nonce: it can still run

/** A transaction you signed on a durable nonce: the nonce account, and the nonce it held then. */
export type Waiting = { account: Address; nonce: string };

/** The grants, worst first; `unchecked`: tokens you hold whose mint was not read, past MAX_MINTS. */
export type Access = { grants: Grant[]; unchecked: number };

export const MAX_MINTS = 300; // mints read, 100 a request
const U64_MAX = 2n ** 64n - 1n; // an allowance without end
const ORDER: Record<Grant['kind'], number> = { delegate: 0, permanent: 1, nonce: 2, closer: 3, freeze: 4 };

/** Who can move, burn, freeze or close what `owner` holds: its token accounts and their mints, read in base64, and the
 *  nonce accounts of the transactions it signed that may still wait. */
export async function access(rpc: OtusRpc, owner: Address, waiting: Waiting[] = []): Promise<Access> {
    const lists = await Promise.all(TOKEN_PROGRAMS.map((programId) => rpc.getTokenAccountsByOwner(owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }).send()));
    // Each read as an account that may be missing: the form the review reads.
    const tokens = lists.flatMap(({ value }) => value.map(({ pubkey, account }) => parseBase64RpcAccount(pubkey, account as typeof account | null)));
    const held = heldMints(owner, tokens);
    const asked = held.slice(0, MAX_MINTS);
    const { accounts } = await rpcChain(rpc).accounts([...asked, ...waiting.map((w) => w.account)]);
    const nonces = waiting.map((w, i) => ({ waiting: w, account: accounts[asked.length + i] }));
    return { grants: grantsOf(owner, tokens, accounts.slice(0, asked.length), nonces), unchecked: held.length - asked.length };
}

/** The mints of the tokens `owner` holds some of, in its token accounts. */
export function heldMints(owner: Address, tokens: MaybeEncodedAccount[]): Address[] {
    const mints = tokens.flatMap((a) => {
        const t = read(a)?.token;
        return t && t.owner === owner && !t.native && t.amount > 0n ? [t.mint] : [];
    });
    return [...new Set(mints)];
}

/** Owner's token accounts, the mints of what it holds, and the nonce accounts of transactions it signed → the grants,
 *  worst first. Pure. */
export function grantsOf(owner: Address, tokens: MaybeEncodedAccount[], mints: MaybeEncodedAccount[], nonces: { waiting: Waiting; account: MaybeEncodedAccount }[]): Grant[] {
    const grants: Grant[] = [];
    for (const a of tokens) {
        const t = read(a)?.token;
        if (!t || t.owner !== owner) continue; // another's: what it allows is not yours to know
        if (t.delegate && t.delegated > 0n) grants.push({ kind: 'delegate', account: a.address, mint: t.mint, to: t.delegate, allowance: t.delegated, all: t.delegated === U64_MAX || (t.amount > 0n && t.delegated >= t.amount) });
        if (t.closer && t.closer !== owner) grants.push({ kind: 'closer', account: a.address, mint: t.mint, to: t.closer });
    }
    const held = new Set(heldMints(owner, tokens));
    for (const a of mints) {
        const s = read(a);
        if (!s || !isMint(s) || !held.has(a.address)) continue;
        const permanent = s.program === TOKEN_2022_PROGRAM_ADDRESS ? permanentDelegate(s.data) : null;
        if (permanent) grants.push({ kind: 'permanent', mint: a.address, to: permanent });
        const freezer = optionalAddress(s.data, 46);
        if (freezer) grants.push({ kind: 'freeze', mint: a.address, to: freezer });
    }
    for (const { waiting, account } of nonces) {
        const held = nonceOf(account);
        if (held && held.nonce === waiting.nonce) grants.push({ kind: 'nonce', account: waiting.account, nonce: waiting.nonce, authority: held.authority });
    }
    return grants.sort((x, y) => ORDER[x.kind] - ORDER[y.kind]);
}

/** A nonce account's authority and the nonce it holds: System's, 80 bytes, its version and state (4 bytes each, state
 *  1: initialized), its authority (32), then the nonce (32). Null for any other account. */
export function nonceOf(a: MaybeEncodedAccount): { authority: Address; nonce: string } | null {
    if (!a.exists || a.programAddress !== SYSTEM_PROGRAM_ADDRESS || a.data.length !== 80) return null;
    if (![1, 0, 0, 0].every((b, i) => a.data[4 + i] === b)) return null;
    return { authority: getAddressDecoder().decode(a.data, 8), nonce: getBase58Decoder().decode(a.data.subarray(40, 72)) };
}

// An address kept as a COption: a 4-byte tag, 1 when there is one, then the address.
function optionalAddress(d: ReadonlyUint8Array, at: number): Address | null {
    if (d.length < at + 36 || d[at] !== 1 || d[at + 1] !== 0 || d[at + 2] !== 0 || d[at + 3] !== 0) return null;
    return getAddressDecoder().decode(d, at + 4);
}

const PERMANENT_DELEGATE = 12; // Token-2022's extension type

// A Token-2022 mint's permanent delegate: its extensions follow the account type byte at 165, each a type (u16), a
// length (u16) and its data; the permanent delegate's data is an address, all zeros for none. A list that does not fit
// its account reads as none.
function permanentDelegate(d: ReadonlyUint8Array): Address | null {
    for (let at = 166; at + 4 <= d.length; ) {
        const type = d[at] | (d[at + 1] << 8);
        const length = d[at + 2] | (d[at + 3] << 8);
        if (at + 4 + length > d.length) return null;
        if (type === PERMANENT_DELEGATE) return length === 32 && d.subarray(at + 4, at + 36).some((b) => b !== 0) ? getAddressDecoder().decode(d, at + 4) : null;
        at += 4 + length;
    }
    return null;
}
