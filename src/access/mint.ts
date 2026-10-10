// A token's terms as its mint sets them onchain: its supply, who can mint more or freeze accounts of it, Token-2022's
// extensions (a permanent delegate, a transfer fee, a hook, a pause…), and whether its name and logo can still change.
// Read by the layouts Token-2022 (interface/src/extension) and Metaplex Token Metadata (state/metadata.rs) declare;
// a mint that does not fit them reads as none, and an extension newer than these as one Otus cannot read.
import { getMintDecoder } from '@solana-program/token';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isSome, type Address, type MaybeEncodedAccount, type ReadonlyUint8Array } from '@solana/kit';

import { rpcChain } from '../chain.ts';
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import type { OtusRpc } from '../rpc.ts';

export const METAPLEX_METADATA = address('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/** A Token-2022 extension on a mint, as it reads; `other`: one whose content Otus does not read, by name. Authorities
 *  are null when none is set. */
export type Extension =
    | { kind: 'transferFee'; authority: Address | null; older: Fee; newer: Fee } // each transfer pays a fee, which `authority` may change
    | { kind: 'closeAuthority'; authority: Address | null } // can close the mint once its supply is 0
    | { kind: 'defaultState'; frozen: boolean } // the state new accounts of it start in
    | { kind: 'nonTransferable' } // held where it was minted to, for good
    | { kind: 'permanentDelegate'; delegate: Address | null } // can move or burn anyone's, at any time
    | { kind: 'transferHook'; authority: Address | null; program: Address | null } // every transfer calls this program
    | { kind: 'metadataPointer'; authority: Address | null; metadata: Address | null } // where its name and logo live
    | { kind: 'metadata'; updateAuthority: Address | null; name: string; symbol: string; uri: string } // its name and logo, in the mint
    | { kind: 'pausable'; authority: Address | null; paused: boolean } // `authority` can stop every transfer, mint and burn
    | { kind: 'permissionedBurn'; authority: Address | null } // burning it needs `authority` too
    | { kind: 'other'; name: string };

/** A transfer fee, from `epoch` on: basis points, and at most `max` units a transfer. */
export type Fee = { epoch: bigint; max: bigint; bps: number };

/** What a mint says. `unknown`: extension types newer than Otus knows, by number. */
export type MintTerms = { program: Address; supply: bigint; decimals: number; mintAuthority: Address | null; freezeAuthority: Address | null; extensions: Extension[]; unknown: number[] };

/** Whether a token's name and logo can still change: by whom, when they can; where they live. */
export type Metadata = { mutable: boolean; updateAuthority: Address | null; where: 'mint' | 'metaplex' };

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165; // where Token-2022 puts the account type, past a token account's room
const MULTISIG_SIZE = 355; // no account with extensions is this long: it would read as a multisig

// Token-2022's mint extensions whose content Otus does not read: by name only.
const NAMED: Record<number, string> = {
    4: 'Confidential transfers',
    10: 'Interest-bearing',
    16: 'Confidential transfer fees',
    20: 'Group pointer',
    21: 'Token group',
    22: 'Group member pointer',
    23: 'Group member',
    24: 'Confidential mint and burn',
    25: 'Scaled UI amount',
};
// Extensions only token accounts carry: in a mint, it does not fit.
const ACCOUNT_ONLY = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
const NEWEST = 28; // PermissionedBurn

/** A mint account → its terms; null when it is not a mint of a token program, or does not fit its layout. The metadata
 *  it carries must name this mint. */
export function mintTerms(a: MaybeEncodedAccount): MintTerms | null {
    if (!a.exists || !TOKEN_PROGRAMS.includes(a.programAddress)) return null;
    const d = a.data;
    const t2022 = a.programAddress === TOKEN_2022_PROGRAM_ADDRESS;
    const extended = t2022 && d.length > ACCOUNT_SIZE && d.length !== MULTISIG_SIZE;
    if (d.length !== MINT_SIZE && !extended) return null;
    // Two COptions (a u32 tag, 0 or 1, then an address), and the initialized flag, 1.
    if (!tag(d, 0) || !tag(d, 46) || d[45] !== 1) return null;
    const base = getMintDecoder().decode(d.subarray(0, MINT_SIZE));
    const terms: MintTerms = {
        program: a.programAddress,
        supply: base.supply,
        decimals: base.decimals,
        mintAuthority: isSome(base.mintAuthority) ? base.mintAuthority.value : null,
        freezeAuthority: isSome(base.freezeAuthority) ? base.freezeAuthority.value : null,
        extensions: [],
        unknown: [],
    };
    if (!extended) return terms;
    // Padding to a token account's length, then the account type: 1, a mint.
    if (d.subarray(MINT_SIZE, ACCOUNT_SIZE).some((b) => b !== 0) || d[ACCOUNT_SIZE] !== 1) return null;
    const seen = new Set<number>();
    // Each extension: its type (u16), its length (u16), then its value. A type of 0, or fewer than two bytes left, ends
    // them, as Token-2022 reads them.
    for (let at = ACCOUNT_SIZE + 1; d.length - at >= 2; ) {
        const type = u16(d, at);
        if (type === 0) break;
        if (d.length - at < 4) return null;
        const length = u16(d, at + 2);
        const value = d.subarray(at + 4, at + 4 + length);
        if (value.length !== length || seen.has(type) || ACCOUNT_ONLY.has(type)) return null;
        seen.add(type);
        at += 4 + length;
        if (type > NEWEST) {
            terms.unknown.push(type);
            continue;
        }
        const read = extension(type, value, a.address);
        if (!read) return null;
        terms.extensions.push(read);
    }
    return terms;
}

// One extension's value, by its type → what it says; null when it does not fit.
function extension(type: number, v: ReadonlyUint8Array, mint: Address): Extension | null {
    const named = NAMED[type];
    if (named) return { kind: 'other', name: named };
    switch (type) {
        case 1: // TransferFeeConfig: its authority and the withdraw authority, what is withheld, the older fee, the newer
            return v.length === 108 ? { kind: 'transferFee', authority: maybe(v, 0), older: fee(v, 72), newer: fee(v, 90) } : null;
        case 3: // MintCloseAuthority
            return v.length === 32 ? { kind: 'closeAuthority', authority: maybe(v, 0) } : null;
        case 6: // DefaultAccountState: 1 initialized, 2 frozen
            return v.length === 1 && (v[0] === 1 || v[0] === 2) ? { kind: 'defaultState', frozen: v[0] === 2 } : null;
        case 9: // NonTransferable
            return v.length === 0 ? { kind: 'nonTransferable' } : null;
        case 12: // PermanentDelegate
            return v.length === 32 ? { kind: 'permanentDelegate', delegate: maybe(v, 0) } : null;
        case 14: // TransferHook: its authority, then the program
            return v.length === 64 ? { kind: 'transferHook', authority: maybe(v, 0), program: maybe(v, 32) } : null;
        case 18: // MetadataPointer: its authority, then the metadata's address
            return v.length === 64 ? { kind: 'metadataPointer', authority: maybe(v, 0), metadata: maybe(v, 32) } : null;
        case 19:
            return tokenMetadata(v, mint);
        case 26: // PausableConfig: its authority, then whether it is paused
            return v.length === 33 && v[32] <= 1 ? { kind: 'pausable', authority: maybe(v, 0), paused: v[32] === 1 } : null;
        case 28: // PermissionedBurnConfig
            return v.length === 32 ? { kind: 'permissionedBurn', authority: maybe(v, 0) } : null;
    }
    return null;
}

// TokenMetadata (spl-token-metadata-interface), in borsh: its update authority (all zeros for none), the mint, the
// name, symbol and URI, then other fields as pairs of strings; nothing after them.
function tokenMetadata(v: ReadonlyUint8Array, mint: Address): Extension | null {
    if (v.length < 64 || getAddressDecoder().decode(v, 32) !== mint) return null;
    const r = reader(v, 64);
    const [name, symbol, uri] = [r.string(), r.string(), r.string()];
    const pairs = r.u32();
    for (let i = 0; pairs !== null && i < pairs && r.ok(); i++) {
        r.string();
        r.string();
    }
    if (name === null || symbol === null || uri === null || pairs === null || !r.ok() || r.at() !== v.length) return null;
    return { kind: 'metadata', updateAuthority: maybe(v, 0), name, symbol, uri };
}

/** Where Metaplex keeps a mint's metadata: its program's address for "metadata", the program and the mint. */
export async function metaplexAddress(mint: Address): Promise<Address> {
    const encode = getAddressEncoder().encode;
    const [at] = await getProgramDerivedAddress({ programAddress: METAPLEX_METADATA, seeds: ['metadata', encode(METAPLEX_METADATA), encode(mint)] });
    return at;
}

/** A Metaplex metadata account → whether it can change, and by whom; null when it is not this mint's metadata, or does
 *  not fit. Its key (4, MetadataV1), update authority, mint, name (up to 32 bytes), symbol (10), URI (200), royalty
 *  (u16), creators (an option of up to 5, 34 bytes each), whether its first sale happened, then whether it is mutable;
 *  what follows is not read. */
export function metaplexMetadata(a: MaybeEncodedAccount, mint: Address): Metadata | null {
    if (!a.exists || a.programAddress !== METAPLEX_METADATA || a.data.length < 65 || a.data[0] !== 4) return null;
    const d = a.data;
    if (getAddressDecoder().decode(d, 33) !== mint) return null;
    const r = reader(d, 65);
    const strings = [r.string(32), r.string(10), r.string(200)];
    r.skip(2);
    const creators = r.byte();
    if (creators === 1) {
        const n = r.u32();
        if (n === null || n > 5) return null;
        for (let i = 0; i < n; i++) {
            r.skip(32);
            if ((r.byte() ?? 2) > 1) return null; // verified: a bool
            r.skip(1);
        }
    } else if (creators !== 0) return null;
    const [sold, mutable] = [r.byte(), r.byte()];
    if (strings.includes(null) || sold === null || sold > 1 || mutable === null || mutable > 1 || !r.ok()) return null;
    return { mutable: mutable === 1, updateAuthority: getAddressDecoder().decode(d, 1), where: 'metaplex' };
}

/** A token's terms and its metadata, read onchain in one request: its mint and Metaplex's account for it. `metadata`:
 *  null when it has none Otus reads (Token-2022's in the mint come first). Throws when the RPC does not answer; `terms`
 *  null when the mint is no mint. */
export async function tokenTerms(rpc: OtusRpc, mint: Address): Promise<{ terms: MintTerms | null; metadata: Metadata | null }> {
    const { accounts } = await rpcChain(rpc).accounts([mint, await metaplexAddress(mint)]);
    const terms = mintTerms(accounts[0]);
    const inMint = terms?.extensions.find((e) => e.kind === 'metadata');
    if (inMint) return { terms, metadata: { mutable: inMint.updateAuthority !== null, updateAuthority: inMint.updateAuthority, where: 'mint' } };
    return { terms, metadata: terms ? metaplexMetadata(accounts[1], mint) : null };
}

// A COption's tag at `at`: 0 or 1, as a u32.
const tag = (d: ReadonlyUint8Array, at: number) => d[at] <= 1 && d[at + 1] === 0 && d[at + 2] === 0 && d[at + 3] === 0;

const u16 = (d: ReadonlyUint8Array, at: number) => d[at] | (d[at + 1] << 8);

// An address that is all zeros for none.
const maybe = (d: ReadonlyUint8Array, at: number): Address | null => (d.subarray(at, at + 32).some((b) => b !== 0) ? getAddressDecoder().decode(d, at) : null);

const fee = (d: ReadonlyUint8Array, at: number): Fee => {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { epoch: view.getBigUint64(at, true), max: view.getBigUint64(at + 8, true), bps: view.getUint16(at + 16, true) };
};

// Reads borsh from `start` on; once anything does not fit, every read after gives null and ok() says false.
function reader(d: ReadonlyUint8Array, start: number) {
    let at = start;
    let ok = true;
    const take = (n: number) => {
        if (!ok || n > d.length - at) return (ok = false), null;
        const from = at;
        at += n;
        return from;
    };
    const u32 = () => {
        const from = take(4);
        return from === null ? null : (d[from] | (d[from + 1] << 8) | (d[from + 2] << 16)) + d[from + 3] * 2 ** 24;
    };
    return {
        u32,
        byte: () => {
            const from = take(1);
            return from === null ? null : d[from];
        },
        skip: (n: number) => void take(n),
        // A string: its length (u32), then UTF-8; longer than `most`, or not UTF-8, it does not fit.
        string: (most = Infinity): string | null => {
            const n = u32();
            if (n === null || n > most) return (ok = false), null;
            const from = take(n);
            if (from === null) return null;
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(d.subarray(from, from + n));
            } catch {
                return (ok = false), null;
            }
        },
        ok: () => ok,
        at: () => at,
    };
}
