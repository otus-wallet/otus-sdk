import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { address, type Address } from '@solana/kit';

import { exactJson, readPage, type Landed } from '../src/activity/history.ts';
import { summarize } from '../src/activity/summary.ts';
import { rows, text, type Naming } from '../src/activity/words.ts';
import { PROGRAM_NAMES } from '../src/programs/known.ts';

// A wallet shielding SOL through a program Otus doesn't know, recorded on mainnet (the wallet masked, the signature
// replaced): the program opened two accounts of its own with the wallet's SOL and sent SOL on to two others, all inside.
const WALLET = address('HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2');
const MIXER = address('mixpxDk31h3jFV8t42vfmRqwq7sESDMrtsKQeyrjRmL');
const POOL = address('5cMKyZ58Z3nCMPenf1HiANGkbBfZE8GCtPD1kzZwo2jb');
const RELAYER = address('repSRDEbPE3pVrfmTjR3k2hUxcABYqVkSMCHy8zSiYQ');
const page = await readPage(exactJson(readFileSync(new URL('./fixtures/unknown-program-shield.json', import.meta.url), 'utf8')), 10);
const shield = page.items[0] as Landed;
const naming: Naming = { wallet: WALLET, symbol: (m) => m, who: (a) => a, program: (a) => PROGRAM_NAMES.get(a) ?? a, known: [] };

test('a program Otus neither reads nor names is unknown; what it moved of the wallet inside it, read by the same decoders', () => {
    const a = summarize(shield, WALLET);
    assert.deepEqual(a.unknown, [MIXER]); // Compute Budget and Lighthouse are known
    assert.deepEqual(
        a.through.map((t) => [t.kind, t.to === POOL ? 'pool' : t.to === RELAYER ? 'relayer' : 'its own', t.units]),
        [
            ['opened', 'its own', 690_880n],
            ['opened', 'its own', 690_880n],
            ['sent', 'pool', 50_000_000n],
            ['sent', 'relayer', 2_000_000n],
        ],
    );
    assert.ok(a.through.every((t) => t.program === MIXER && t.mint === null));
});

test("its line says it went through an unknown program, never to whom: its details name the program, whole, and where the SOL went", () => {
    const [row] = rows([summarize(shield, WALLET)], naming);
    assert.equal(text(row.title), 'Sent 0.05338176 SOL');
    assert.equal(text(row.sub), 'through an unknown program');
    assert.equal(row.tone, 'warn');
    assert.equal(row.address, null);
    assert.deepEqual(row.unknown, [MIXER]);
    const told = row.details.map((d) => [d.text, d.tone]);
    const at = told.findIndex(([t]) => t === `Unknown program ${MIXER}`);
    assert.ok(at > 0, JSON.stringify(told));
    assert.equal(told[at]![1], 'warn');
    // Each line about it says so, for a page that shows only those.
    assert.deepEqual(row.details.slice(at, at + 4).map((d) => d.unknown), [MIXER, MIXER, MIXER, MIXER]);
    assert.ok(row.details.filter((d) => d.unknown).length === 4);
    assert.deepEqual(told.slice(at + 1, at + 4), [
        [`It sent 0.05 SOL to ${POOL}`, 'dim'],
        [`It sent 0.002 SOL to ${RELAYER}`, 'dim'],
        ['It put 0.00138176 SOL into 2 accounts it opened', 'dim'],
    ]);
});

test('what the node did not say ran inside (no inner instructions), or what reads as nothing known, is left out: the warning stands', () => {
    for (const inner of [null, [], [{ index: 2, instructions: [{ program: shield.accounts[9]!, accounts: [WALLET], data: new Uint8Array([255, 1, 2]) }] }], [{ index: 99, instructions: [] }]]) {
        const a = summarize({ ...shield, inner } as Landed, WALLET);
        assert.deepEqual(a.unknown, [MIXER]);
        assert.deepEqual(a.through, []);
        const [row] = rows([a], naming);
        assert.equal(row.tone, 'warn');
        assert.ok(row.details.some((d) => d.text === `Unknown program ${MIXER}` && d.tone === 'warn'));
    }
});

test("an inner send from someone else's account, or by a program Otus knows, is no move of the wallet's through an unknown one", () => {
    const a = summarize(shield, address('5u1ZLFozKaujfjhdV4vMKwqrovRBASucmKtk41C5kwW') as Address);
    assert.deepEqual(a.through, []);
    // The same inner instructions under a known program: none of them are told as an unknown one's.
    const known = summarize({ ...shield, inner: shield.inner!.map((g) => ({ ...g, index: 0 })) } as Landed, WALLET);
    assert.deepEqual(known.through, []);
    assert.deepEqual(known.unknown, [MIXER]);
});

test('a failed transaction moved nothing through anyone: no breakdown, the program still told', () => {
    const a = summarize({ ...shield, error: 'custom program error: 0x1' } as Landed, WALLET);
    assert.deepEqual(a.through, []);
    assert.deepEqual(a.unknown, [MIXER]);
});
