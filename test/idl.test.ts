import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';

import { getAddressEncoder, type Address, type MaybeEncodedAccount } from '@solana/kit';


import type { Chain } from '../src/chain.ts';
import { tellWith } from '../src/idl/explain.ts';
import { toldByIdl } from '../src/idl/idl.ts';
import { idlAddresses, MAX_INSTRUCTIONS, MAX_STORED, MAX_TYPES, PROGRAM_METADATA, readIdl, type Idl, type Source } from '../src/idl/read.ts';
import type { Review } from '../src/review/review.ts';
import { key, PAYER, SYSTEM } from './helpers.ts';

const DIR = new URL('./idl/', import.meta.url);
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as Address;
const MOONSHOT = 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG' as Address;
const SOME = key(30);
const ANCHOR_IDL = [24, 70, 98, 191, 58, 144, 123, 158];

type Fixture = { address: Address; owner: Address; data: string };
const fixture = (program: Address, from: Source): Fixture => JSON.parse(readFileSync(new URL(`${program}.${from}.json`, DIR), 'utf8'));
const samples: { program: Address; data: string; accounts: Address[] }[] = JSON.parse(readFileSync(new URL('instructions.json', DIR), 'utf8'));
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const stored = (owner: Address, data: Uint8Array): MaybeEncodedAccount => ({ exists: true, address: key(99), programAddress: owner, data, executable: false, lamports: 1n as never, space: BigInt(data.length) });
const idlOf = async (program: Address, from: Source) => readIdl(stored(fixture(program, from).owner, bytes(fixture(program, from).data)), from, program);
const sample = (program: Address, n = 0) => samples.filter((s) => s.program === program)[n];
const told = (idls: Idl[], s: { data: string; accounts: Address[] }) => tellWith(idls, bytes(s.data), s.accounts);

// Anchor's IDL account around an IDL's text, as `anchor idl init` writes it.
function anchorAccount(program: Address, text: string | Uint8Array, compress = (b: Uint8Array) => deflateSync(b)): MaybeEncodedAccount {
    const zipped = compress(typeof text === 'string' ? new TextEncoder().encode(text) : text);
    const data = new Uint8Array(44 + zipped.length);
    data.set(ANCHOR_IDL, 0);
    new DataView(data.buffer).setUint32(40, zipped.length, true);
    data.set(zipped, 44);
    return stored(program, data);
}

// An Anchor IDL (spec 0.1.0) of one instruction, discriminator 1..8, with these arguments and defined types.
const anchorIdl = (args: unknown[], types: unknown[] = [], name = 'boom') =>
    JSON.stringify({ address: SOME, metadata: { name: 'evil', version: '0.1.0', spec: '0.1.0' }, instructions: [{ name, discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: 'user', writable: true, signer: true }], args }], types });
const data = (...rest: number[]) => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...rest]);

test('finds where a program publishes its IDL, both places, as mainnet has them', async () => {
    for (const [program, from] of [[JUPITER, 'anchor'], [CLMM, 'metadata'], [MOONSHOT, 'anchor']] as const) assert.equal((await idlAddresses(program))[from], fixture(program, from).address);
});

test('reads IDLs as programs publish them: Anchor’s account (either spec) and the canonical metadata', async () => {
    const read = async (program: Address, from: Source) => {
        const idl = await idlOf(program, from);
        return idl && [idl.root.program.name, idl.root.program.instructions?.length, idl.from];
    };
    assert.deepEqual(await read(JUPITER, 'anchor'), ['jupiter', 19, 'anchor']);
    assert.deepEqual(await read(CLMM, 'metadata'), ['raydiumClmm', 39, 'metadata']);
    assert.deepEqual(await read(MOONSHOT, 'anchor'), ['tokenLaunchpad', 6, 'anchor']); // the spec before 0.30
});

test('tells real instructions with their IDL: name, arguments, and what each account is', async () => {
    const jupiter = told([(await idlOf(JUPITER, 'anchor'))!], sample(JUPITER))!;
    assert.equal(jupiter.name, 'RouteV2');
    assert.match(jupiter.args, /^inAmount 6,133,904 · quotedOutAmount 7,191,875,603 · slippageBps 10,000 · /);
    assert.deepEqual(jupiter.accounts.slice(0, 3).map((a) => a.role), ['userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount']);
    assert.deepEqual(jupiter.accounts.map((a) => a.address), sample(JUPITER).accounts);
    assert.deepEqual([jupiter.program, jupiter.from], ['jupiter', 'anchor']);

    const clmm = told([(await idlOf(CLMM, 'metadata'))!], sample(CLMM))!;
    assert.deepEqual([clmm.name, clmm.args, clmm.accounts[0].role], ['SwapV2', 'amount 1,104,166,991 · otherAmountThreshold 301,374 · sqrtPriceLimitX64 0 · isBaseInput true', 'payer']);

    const moon = told([(await idlOf(MOONSHOT, 'anchor'))!], sample(MOONSHOT))!;
    assert.deepEqual([moon.name, moon.accounts[0].role], ['Buy', 'sender']);
    assert.match(moon.args, /^data \{tokenAmount 350,430,294,744,340, collateralAmount 10,000,000, /);
});

test('an instruction its first IDL does not know is told by the next: a partial one in the metadata, Anchor’s whole', async () => {
    const whole = (await idlOf(JUPITER, 'anchor'))!;
    const partial: Idl = { from: 'metadata', root: { ...whole.root, program: { ...whole.root.program, instructions: whole.root.program.instructions?.slice(0, 2) } } };
    assert.equal(told([partial], sample(JUPITER)), null);
    assert.equal(told([partial, whole], sample(JUPITER))?.from, 'anchor');
    assert.equal(told([whole], { data: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]).toString('base64'), accounts: [] }), null); // no discriminator of it
});

test('reads nothing but an IDL: of another owner or program, not canonical, held elsewhere, cut short, or a bomb', async () => {
    const meta = fixture(CLMM, 'metadata');
    const raw = bytes(meta.data);
    const changed = (at: number, value: number) => Object.assign(new Uint8Array(raw), { [at]: value });
    assert.equal(await readIdl(stored(SYSTEM, raw), 'metadata', CLMM), null); // not the Program Metadata Program's
    assert.equal(await readIdl(stored(PROGRAM_METADATA, raw), 'metadata', JUPITER), null); // another program's
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(66, 0)), 'metadata', CLMM), null); // not canonical
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(86, 1)), 'metadata', CLMM), null); // a URL, never fetched
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(83, 2)), 'metadata', CLMM), null); // base58
    assert.equal(await readIdl(stored(PROGRAM_METADATA, raw.slice(0, 500)), 'metadata', CLMM), null);
    const anchor = fixture(JUPITER, 'anchor');
    assert.equal(await readIdl(stored(SYSTEM, bytes(anchor.data)), 'anchor', JUPITER), null); // Anchor's is the program's own
    assert.equal(await readIdl({ exists: false, address: anchor.address }, 'anchor', JUPITER), null);
    // 3 MB of spaces in a few kilobytes: given up past 2 MB, compressed either way.
    const bomb = new Uint8Array(3 * 1024 * 1024).fill(32);
    assert.equal(await readIdl(anchorAccount(SOME, bomb), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, bomb, (b) => gzipSync(b)), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, 'not json'), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, '{"name":"x"}'), 'anchor', SOME), null);
});

test('refuses types that would take forever to build or to read, and tells the rest', async () => {
    const idl = async (args: unknown[], types: unknown[] = []) => (await readIdl(anchorAccount(SOME, anchorIdl(args, types)), 'anchor', SOME))!;
    const time = (f: () => unknown) => {
        const t = performance.now();
        f();
        return performance.now() - t;
    };
    // Each type twice the next: 2^30 nodes to build.
    const doubling = Array.from({ length: 30 }, (_, i) => ({ name: `T${i}`, type: { kind: 'struct', fields: ['a', 'b'].map((f) => ({ name: f, type: i === 29 ? 'u8' : { defined: { name: `T${i + 1}` } } })) } }));
    const exponential = await idl([{ name: 'x', type: { defined: { name: 'T0' } } }], doubling);
    assert.ok(time(() => assert.equal(tellWith([exponential], data(0), [PAYER]), null)) < 500);
    // A type within itself.
    const recursive = await idl([{ name: 'x', type: { defined: { name: 'Node' } } }], [{ name: 'Node', type: { kind: 'struct', fields: [{ name: 'next', type: { vec: { defined: { name: 'Node' } } } }] } }]);
    assert.equal(tellWith([recursive], data(0, 0, 0, 0), [PAYER]), null);
    // A list of things that take no bytes, four billion of them; such things in fixed lists within fixed lists; and
    // types that double down to nothing, whose emptiness alone would take 2^30 steps to work out.
    const nothing = { name: 'Nothing', type: { kind: 'struct', fields: [] } };
    const empties = await idl([{ name: 'x', type: { vec: { defined: { name: 'Nothing' } } } }], [nothing]);
    assert.ok(time(() => assert.equal(tellWith([empties], data(255, 255, 255, 255), [PAYER]), null)) < 500);
    const cubed = await idl([{ name: 'x', type: { array: [{ array: [{ array: [{ defined: { name: 'Nothing' } }, 1024] }, 1024] }, 1024] } }], [nothing]);
    assert.ok(time(() => assert.equal(tellWith([cubed], data(0), [PAYER]), null)) < 500);
    const hollow = doubling.map((t, i) => (i === 29 ? { name: 'T29', type: { kind: 'struct', fields: [] } } : t));
    const doublingToNothing = await idl([{ name: 'x', type: { vec: { defined: { name: 'T0' } } } }], hollow);
    assert.ok(time(() => assert.equal(tellWith([doublingToNothing], data(255, 255, 255, 255), [PAYER]), null)) < 500);
    // Generic types nesting, which Codama writes out at each use: a few hundred bytes, millions of nodes. Refused before
    // they are converted.
    const generic = Array.from({ length: 24 }, (_, i) => ({ name: `G${i}`, generics: [{ kind: 'type', name: 'T' }], type: { kind: 'struct', fields: ['a', 'b'].map((f) => ({ name: f, type: i === 23 ? 'u8' : { defined: { name: `G${i + 1}`, generics: [{ kind: 'type', type: 'u8' }] } } })) } }));
    const start = performance.now();
    assert.equal(await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'x', type: { defined: { name: 'G0', generics: [{ kind: 'type', type: 'u8' }] } } }], generic)), 'anchor', SOME), null);
    assert.ok(performance.now() - start < 500);
    // What is fine is told.
    const fine = await idl([{ name: 'amount', type: 'u64' }, { name: 'memo', type: 'string' }, { name: 'to', type: 'pubkey' }, { name: 'list', type: { vec: 'u8' } }, { name: 'maybe', type: { option: 'u16' } }]);
    const args = [...new Uint8Array(new BigUint64Array([1_000_000n]).buffer), 2, 0, 0, 0, 104, 105, ...getAddressEncoder().encode(PAYER), 2, 0, 0, 0, 7, 8, 1, 5, 0];
    assert.deepEqual(tellWith([fine], data(...args), [PAYER]), { name: 'Boom', args: `amount 1,000,000 · memo "hi" · to ${PAYER} · maybe 5 · list [7, 8]`, accounts: [{ role: 'user', address: PAYER }], program: 'evil', from: 'anchor' });
});

test('names from an IDL are shown without characters that move or hide others, and kept short', async () => {
    const idl = (await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'a‮b', type: 'u8' }], [], `send‮evil${'x'.repeat(80)}`)), 'anchor', SOME))!;
    const t = tellWith([idl], data(1), [PAYER, key(31)])!;
    assert.equal(t.name.includes('‮'), false);
    assert.ok(t.name.startsWith('SendEvil') && t.name.length <= 48);
    assert.equal(t.args, 'aB 1'); // the override gone; Codama takes it as a break between words
    assert.deepEqual(t.accounts.map((a) => a.role), ['user', 'account 2']); // past the IDL's list, by number
});

test('a program’s name from its own IDL: plain letters, folded and kept short; with a letter of another script, none', async () => {
    const idl = (await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'x', type: 'u8' }])), 'anchor', SOME))!;
    const named = (name: string) => tellWith([{ ...idl, root: { ...idl.root, program: { ...idl.root.program, name: name as typeof idl.root.program.name } } }], data(1), [PAYER])!.program;
    assert.equal(named('Ｊｕｐｉｔｅｒ'), 'Jupiter'); // fullwidth
    assert.equal(named('Jupit\u0435r'), ''); // a Cyrillic е
    assert.equal(named('raydium\u202Eclmm'), '');
    assert.equal(named(`long${'x'.repeat(80)}`).length, 48);
});

test('a hostile IDL costs little: refused past what programs describe, and matched by its discriminators’ bytes', async () => {
    // An Anchor IDL of `count` instructions, each told apart by its own 8 bytes, with this argument and these types.
    const many = (count: number, type: unknown, types: unknown[] = []) =>
        JSON.stringify({ address: SOME, metadata: { name: 'evil', version: '0.1.0', spec: '0.1.0' }, instructions: Array.from({ length: count }, (_, n) => ({ name: `ix${n}`, discriminator: [9, 9, 9, 9, ...new Uint8Array(new Uint32Array([n]).buffer)], accounts: [], args: [{ name: 'arg', type }] })), types });
    const read = (json: string) => readIdl(anchorAccount(SOME, json), 'anchor', SOME);
    const chain = Array.from({ length: 30 }, (_, i) => ({ name: `T${i}`, type: { kind: 'struct', fields: ['a', 'b'].map((f) => ({ name: f, type: i === 29 ? 'u8' : { defined: { name: `T${i + 1}` } } })) } }));
    const empties = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `D${i}`, type: { kind: 'struct', fields: [] } }));
    // More instructions or types than any program has: no IDL.
    assert.equal(await read(many(MAX_INSTRUCTIONS + 1, 'u8')), null);
    assert.equal(await read(many(1, 'u8', empties(MAX_TYPES + 1))), null);
    // As many as an IDL may have, every type deep or many: 64 instructions it doesn't know, told in a moment.
    const time = (f: () => unknown) => {
        const t = performance.now();
        f();
        return performance.now() - t;
    };
    for (const idl of [(await read(many(MAX_INSTRUCTIONS, { defined: { name: 'T0' } }, chain)))!, (await read(many(MAX_INSTRUCTIONS, 'u8', empties(MAX_TYPES))))!]) {
        tellWith([idl], new Uint8Array([0]), [PAYER]); // its marks, worked out once
        assert.ok(time(() => {
            for (let i = 0; i < 64; i++) assert.equal(tellWith([idl], new Uint8Array([i]), [PAYER]), null);
        }) < 300);
    }
    // One it knows is told; one whose types are too deep for a reader, matched, is not.
    const fine = (await read(many(MAX_INSTRUCTIONS, 'u8', empties(MAX_TYPES))))!;
    assert.equal(tellWith([fine], new Uint8Array([9, 9, 9, 9, 7, 0, 0, 0, 5]), [PAYER])?.name, 'Ix7');
    const deep = (await read(many(MAX_INSTRUCTIONS, { defined: { name: 'T0' } }, chain)))!;
    assert.equal(tellWith([deep], new Uint8Array([9, 9, 9, 9, 7, 0, 0, 0, 5]), [PAYER]), null);
});

test('reads only as much of an IDL’s account as an IDL can take', async () => {
    const asked: number[] = [];
    const chain = { heads: async (addresses: readonly Address[], length: number) => (asked.push(length), addresses.map((address) => ({ exists: false as const, address }))), accounts: async () => assert.fail('read whole') } as unknown as Chain;
    const r = { explained: [{ source: 'unknown', program: SOME, data: new Uint8Array([1]), accounts: [] }] } as unknown as Review;
    assert.equal((await toldByIdl(r, chain)).size, 0);
    assert.deepEqual(asked, [96 + MAX_STORED]);
});
