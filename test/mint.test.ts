import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getAddressEncoder, getBase64Decoder, type Address, type MaybeEncodedAccount } from '@solana/kit';

import { METAPLEX_METADATA, metadataState, metaplexAddress, metaplexMetadata, mintTerms, tokensTerms } from '../src/access/mint.ts';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../src/programs/addresses.ts';
import { account, key, MINT } from './helpers.ts';

const MINTER = key(41);
const FREEZER = key(42);
const OTHER = key(43);
const bytes = (a: Address) => getAddressEncoder().encode(a);
const u16 = (n: number) => [n & 0xff, n >> 8];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const u64 = (n: bigint) => [...new Uint8Array(new BigUint64Array([n]).buffer)];
const f64 = (n: number) => [...new Uint8Array(new Float64Array([n]).buffer)];
const text = (s: string) => {
    const b = new TextEncoder().encode(s);
    return [...u32(b.length), ...b];
};

// A mint's 82 bytes: its mint authority and freeze authority as COptions (at 0 and 46), supply, decimals, initialized.
function base(o: { minter?: Address; freezer?: Address; supply?: bigint; decimals?: number } = {}) {
    const d = new Uint8Array(82);
    if (o.minter) d.set([1, 0, 0, 0, ...bytes(o.minter)], 0);
    d.set(u64(o.supply ?? 1_000_000n), 36);
    d[44] = o.decimals ?? 6;
    d[45] = 1;
    if (o.freezer) d.set([1, 0, 0, 0, ...bytes(o.freezer)], 46);
    return d;
}

// A Token-2022 mint: its base, padded to 165, its account type (1), then each extension as type, length and value.
function extended(extensions: [number, number[]][], b = base()) {
    const tlv = extensions.flatMap(([type, value]) => [...u16(type), ...u16(value.length), ...value]);
    const d = new Uint8Array(166 + tlv.length);
    d.set(b, 0);
    d[165] = 1;
    d.set(tlv, 166);
    return d;
}
const spl = (d: Uint8Array) => account(MINT, TOKEN_PROGRAM_ADDRESS, 1_461_600n, d);
const t22 = (d: Uint8Array) => account(MINT, TOKEN_2022_PROGRAM_ADDRESS, 3_000_000n, d);

const metadataValue = (authority: Address | null, mint: Address = MINT, extra: number[] = []) => [...(authority ? bytes(authority) : new Array(32).fill(0)), ...bytes(mint), ...text('Otus'), ...text('OTUS'), ...text('https://otus.sh/t.json'), ...u32(1), ...text('k'), ...text('v'), ...extra];
const fees = [...bytes(OTHER), ...bytes(OTHER), ...u64(7n), ...u64(800n), ...u64(5_000n), ...u16(50), ...u64(900n), ...u64(9_000n), ...u16(100)];

test('a mint: its supply and decimals, and who can mint more or freeze, or no one', () => {
    assert.deepEqual(mintTerms(spl(base({ minter: MINTER, freezer: FREEZER, supply: 5n, decimals: 9 }))), { program: TOKEN_PROGRAM_ADDRESS, supply: 5n, decimals: 9, mintAuthority: MINTER, freezeAuthority: FREEZER, extensions: [], unknown: [] });
    assert.deepEqual(mintTerms(spl(base())), { program: TOKEN_PROGRAM_ADDRESS, supply: 1_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [], unknown: [] });
    // Token-2022's without extensions is the same 82 bytes.
    assert.equal(mintTerms(t22(base({ freezer: FREEZER })))?.freezeAuthority, FREEZER);
});

test('Token-2022’s extensions on a mint, each as its layout says', () => {
    const terms = mintTerms(
        t22(
            extended([
                [1, fees],
                [3, [...bytes(OTHER)]],
                [6, [2]],
                [9, []],
                [12, [...bytes(OTHER)]],
                [14, [...new Array(32).fill(0), ...bytes(OTHER)]],
                [18, [...bytes(OTHER), ...bytes(MINT)]],
                [19, metadataValue(null)],
                [26, [...bytes(OTHER), 1]],
                [28, [...bytes(OTHER)]],
                [10, [...bytes(OTHER), ...new Array(18).fill(0), ...u16(500)]],
                [25, [...new Array(32).fill(0), ...f64(1.5), ...u64(1_800_000_000n), ...f64(2)]],
                [40, [1, 2, 3]],
            ]),
        ),
    );
    assert.deepEqual(terms?.extensions, [
        { kind: 'transferFee', authority: OTHER, older: { epoch: 800n, max: 5_000n, bps: 50 }, newer: { epoch: 900n, max: 9_000n, bps: 100 } },
        { kind: 'closeAuthority', authority: OTHER },
        { kind: 'defaultState', frozen: true },
        { kind: 'nonTransferable' },
        { kind: 'permanentDelegate', delegate: OTHER },
        { kind: 'transferHook', authority: null, program: OTHER },
        { kind: 'metadataPointer', authority: OTHER, metadata: MINT },
        { kind: 'metadata', updateAuthority: null, name: 'Otus', symbol: 'OTUS', uri: 'https://otus.sh/t.json' },
        { kind: 'pausable', authority: OTHER, paused: true },
        { kind: 'permissionedBurn', authority: OTHER },
        { kind: 'interestBearing', authority: OTHER, bps: 500 },
        { kind: 'scaledUiAmount', authority: null, multiplier: 1.5, next: 2, nextAt: 1_800_000_000n },
    ]);
    assert.deepEqual(terms?.unknown, [40]); // newer than Otus knows: said, not read
    // A type of 0 ends the list, as does a last byte alone; what follows is not read.
    assert.equal(mintTerms(t22(new Uint8Array([...extended([[9, []]]), 0, 0, 0xff, 0xff])))?.extensions.length, 1);
    assert.equal(mintTerms(t22(new Uint8Array([...extended([[9, []]]), 7])))?.extensions.length, 1);
});

test('a mint that does not fit its layout reads as none', () => {
    const fine = extended([[12, [...bytes(OTHER)]]]);
    const changed = (at: number, v: number, d = fine) => {
        const c = d.slice();
        c[at] = v;
        return c;
    };
    const bad: [string, ReturnType<typeof account>][] = [
        ['another program’s', account(MINT, OTHER, 1n, base())],
        ['a token account’s length', spl(new Uint8Array(165))],
        ['83 bytes', spl(new Uint8Array([...base(), 0]))],
        ['an SPL mint with extensions', spl(fine)],
        ['a multisig’s length', t22(new Uint8Array(355))],
        ['a tag of 2', spl(changed(0, 2, base()))],
        ['a freeze tag of 1 in its high byte', spl(changed(49, 1, base()))],
        ['not initialized', spl(changed(45, 0, base()))],
        ['padding that is not zeros', t22(changed(100, 1))],
        ['an account’s type', t22(changed(165, 2))],
        ['a length past the end', t22(new Uint8Array([...extended([]), ...u16(12), ...u16(40), ...bytes(OTHER)]))],
        ['a type without its length', t22(new Uint8Array([...extended([]), ...u16(12), 0]))],
        ['the same extension twice', t22(extended([[9, []], [9, []]]))],
        ['an account’s extension', t22(extended([[7, []]]))],
        ['a permanent delegate of 31 bytes', t22(extended([[12, new Array(31).fill(1)]]))],
        ['a transfer fee of 107 bytes', t22(extended([[1, fees.slice(1)]]))],
        ['a transfer fee over 100%', t22(extended([[1, [...fees.slice(0, 106), ...u16(10_001)]]]))],
        ['interest of 51 bytes', t22(extended([[10, new Array(51).fill(0)]]))],
        ['a multiplier that is not a number', t22(extended([[25, [...new Array(32).fill(0), ...f64(NaN), ...u64(0n), ...f64(1)]]]))],
        ['a default state of 0', t22(extended([[6, [0]]]))],
        ['a default state of 3', t22(extended([[6, [3]]]))],
        ['non-transferable with a value', t22(extended([[9, [0]]]))],
        ['paused as 2', t22(extended([[26, [...bytes(OTHER), 2]]]))],
        ['metadata for another mint', t22(extended([[19, metadataValue(null, OTHER)]]))],
        ['metadata with bytes after it', t22(extended([[19, metadataValue(null, MINT, [0])]]))],
        ['metadata cut short', t22(extended([[19, metadataValue(null).slice(0, -1)]]))],
        ['metadata that is not UTF-8', t22(extended([[19, [...new Array(32).fill(0), ...bytes(MINT), ...u32(1), 0xff, ...text(''), ...text(''), ...u32(0)]]]))],
        ['metadata naming 4 GB of name', t22(extended([[19, [...new Array(32).fill(0), ...bytes(MINT), 0xff, 0xff, 0xff, 0xff]]]))],
        ['a missing account', { exists: false, address: MINT } as never],
    ];
    for (const [what, a] of bad) assert.equal(mintTerms(a), null, what);
});

// Metaplex's metadata: its key (4), update authority, mint, name, symbol, URI, royalty, creators, first sale, mutable,
// then fields not read, zero-padded.
function metaplex(o: { mutable?: number; mint?: Address; key?: number; name?: string; creators?: number[] } = {}) {
    const creators = o.creators ?? [1, ...u32(2), ...bytes(OTHER), 1, 50, ...bytes(MINTER), 0, 50];
    const d = [o.key ?? 4, ...bytes(FREEZER), ...bytes(o.mint ?? MINT), ...text(o.name ?? 'Otus'.padEnd(32, '\0')), ...text('OTUS'.padEnd(10, '\0')), ...text('https://otus.sh'.padEnd(200, '\0')), ...u16(500), ...creators, 1, o.mutable ?? 1];
    return account(key(50), METAPLEX_METADATA, 5_616_720n, new Uint8Array([...d, ...new Array(679 - d.length).fill(0)]));
}

test('Metaplex metadata: whether it can change, and its update authority', () => {
    assert.deepEqual(metaplexMetadata(metaplex(), MINT), { mutable: true, updateAuthority: FREEZER });
    assert.deepEqual(metaplexMetadata(metaplex({ mutable: 0, creators: [0] }), MINT), { mutable: false, updateAuthority: FREEZER });
    const bad: [string, ReturnType<typeof account>][] = [
        ['another mint’s', metaplex({ mint: OTHER })],
        ['an edition’s key', metaplex({ key: 6 })],
        ['a name of 33 bytes', metaplex({ name: 'x'.repeat(33) })],
        ['six creators', metaplex({ creators: [1, ...u32(6), ...new Array(34 * 6).fill(0)] })],
        ['creators tagged 2', metaplex({ creators: [2] })],
        ['a creator verified as 2', metaplex({ creators: [1, ...u32(1), ...bytes(OTHER), 2, 100] })],
        ['mutable as 2', metaplex({ mutable: 2 })],
        ['another program’s', account(key(50), OTHER, 1n, metaplex().exists ? (metaplex() as { data: Uint8Array }).data : new Uint8Array())],
        ['cut short', account(key(50), METAPLEX_METADATA, 1n, (metaplex() as { data: Uint8Array }).data.slice(0, 300))],
        ['empty', account(key(50), METAPLEX_METADATA, 1n, new Uint8Array())],
    ];
    for (const [what, a] of bad) assert.equal(metaplexMetadata(a, MINT), null, what);
});

test('whether its metadata can change: mutable when any of it can, unreadable when some cannot be read, immutable only when all is', () => {
    const AT = key(50); // Metaplex's account for the mint
    const none = { exists: false, address: AT } as never;
    const pointer = (authority: Address | null, to: Address | null) => [18, [...(authority ? bytes(authority) : new Array(32).fill(0)), ...(to ? bytes(to) : new Array(32).fill(0))]] as [number, number[]];
    const state = (extensions: [number, number[]][], metaplexAccount: ReturnType<typeof account> = none, b = base()) => metadataState(mintTerms(t22(extended(extensions, b)))!, metaplexAccount, AT, MINT);
    const fixed = metaplex({ mutable: 0 });
    // Metaplex's alone, on a plain mint.
    assert.equal(metadataState(mintTerms(spl(base()))!, fixed, AT, MINT), 'immutable');
    assert.equal(metadataState(mintTerms(spl(base()))!, metaplex(), AT, MINT), 'mutable');
    assert.equal(metadataState(mintTerms(spl(base()))!, none, AT, MINT), null);
    // Lamports someone sent to that address make no metadata; Metaplex's that does not fit is unreadable.
    assert.equal(metadataState(mintTerms(spl(base()))!, account(AT, key(0), 1n), AT, MINT), null);
    assert.equal(metadataState(mintTerms(spl(base()))!, metaplex({ key: 6 }), AT, MINT), 'unreadable');
    // In the mint, fixed, with a locked pointer to it.
    assert.equal(state([pointer(null, MINT), [19, metadataValue(null)]]), 'immutable');
    // A pointer its authority can move: whatever it points at now can be swapped.
    assert.equal(state([pointer(OTHER, MINT), [19, metadataValue(null)]]), 'mutable');
    assert.equal(state([pointer(OTHER, AT)], fixed), 'mutable');
    // Pointing at an account Otus does not read: wallets show that one.
    assert.equal(state([pointer(null, OTHER), [19, metadataValue(null)]]), 'unreadable');
    assert.equal(state([pointer(null, AT)], fixed), 'immutable');
    // Fixed in the mint, but Metaplex's can change: some wallets show that one.
    assert.equal(state([pointer(null, MINT), [19, metadataValue(null)]], metaplex()), 'mutable');
    // Pointing at the mint with none there yet: the mint authority can still write it.
    assert.equal(state([pointer(null, MINT)], fixed, base({ minter: MINTER })), 'mutable');
    assert.equal(state([pointer(null, MINT)], fixed), 'immutable');
});

test('many tokens’ terms in one request, the epoch read once and only for a fee that is changing', async () => {
    const SECOND = key(44);
    const changing = [...fees.slice(0, 90), ...u64(900n), ...u64(9_000n), ...u16(200)]; // newer: 2%
    const accounts = new Map<string, MaybeEncodedAccount>([
        [MINT, spl(base({ freezer: FREEZER }))],
        [await metaplexAddress(MINT), metaplex({ mutable: 0 })],
        [SECOND, account(SECOND, TOKEN_2022_PROGRAM_ADDRESS, 1n, extended([[1, changing]]))],
    ]);
    const asked: string[][] = [];
    let epochs = 0;
    const wire = (a: MaybeEncodedAccount | undefined) => (a?.exists ? { data: [getBase64Decoder().decode(a.data), 'base64'], executable: false, lamports: a.lamports, owner: a.programAddress, space: a.space } : null);
    const rpc = {
        getMultipleAccounts: (addresses: string[]) => ({ send: async () => (asked.push(addresses), { context: { slot: 1n }, value: addresses.map((a) => wire(accounts.get(a))) }) }),
        getEpochInfo: () => ({ send: async () => (epochs++, { epoch: 850n }) }),
    } as never;
    const read = await tokensTerms(rpc, [MINT, SECOND]);
    assert.equal(asked.length, 1); // one request, the mints and their metadata accounts
    assert.equal(epochs, 1);
    assert.deepEqual([read.get(MINT)?.terms?.freezeAuthority, read.get(MINT)?.metadata, read.get(MINT)?.epoch], [FREEZER, 'immutable', null]);
    assert.deepEqual([read.get(SECOND)?.terms?.extensions[0]?.kind, read.get(SECOND)?.metadata, read.get(SECOND)?.epoch], ['transferFee', null, 850n]);
});

test('garbage of any length never throws, and is read as none or as what it says', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed / 2 ** 31);
    for (let i = 0; i < 3_000; i++) {
        const length = [82, 166, 170, 200, 400, 679, Math.floor(random() * 800)][i % 7];
        const d = new Uint8Array(length).map(() => Math.floor(random() * 256));
        if (i % 3 === 0 && length >= 166) {
            d.fill(0, 82, 165);
            d[165] = 1;
            d[45] = 1;
            d.fill(0, 1, 4);
            d.fill(0, 47, 50);
        }
        assert.doesNotThrow(() => mintTerms(t22(d)));
        assert.doesNotThrow(() => mintTerms(spl(d)));
        d[0] = 4;
        assert.doesNotThrow(() => metaplexMetadata(account(key(50), METAPLEX_METADATA, 1n, d), MINT));
    }
});
