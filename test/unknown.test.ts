import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getApproveInstruction, getCloseAccountInstruction, getSetAuthorityInstruction, getTransferInstruction, AuthorityType } from '@solana-program/token';
import { address, createNoopSigner, type Address, type Instruction } from '@solana/kit';

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
    assert.equal(text(row.title), 'Sent −0.05338176 SOL');
    assert.equal(text(row.sub), 'through an unknown program');
    // The line in its usual colours; only the words of the program Otus doesn't know are to take note of.
    assert.equal(row.tone, 'plain');
    assert.deepEqual(row.sub, [{ text: 'through an unknown program', tone: 'warn' }]);
    assert.deepEqual(row.title, [{ text: 'Sent ' }, { text: '−0.05338176 SOL', way: 'out' }]);
    assert.equal(row.address, null);
    assert.deepEqual(row.unknown, [MIXER]);
    const told = row.details.map((d) => [d.text, d.tone]);
    const at = told.findIndex(([t]) => t === `Unknown program ${MIXER}`);
    // The balance the line shows is not said again: the program comes first.
    assert.equal(at, 0, JSON.stringify(told));
    assert.equal(told[at]![1], 'warn');
    // Each line about it says so, for a page that shows only those.
    assert.deepEqual(row.details.slice(at, at + 4).map((d) => d.unknown), [MIXER, MIXER, MIXER, MIXER]);
    assert.ok(row.details.filter((d) => d.unknown).length === 4);
    assert.deepEqual(told.slice(at + 1, at + 4), [
        [`It sent 0.05 SOL to ${POOL}`, 'dim'],
        [`It sent 0.002 SOL to ${RELAYER}`, 'dim'],
        ['It put 0.00138176 SOL into 2 accounts it opened', 'dim'],
    ]);
    // Its programs, but the one it has a line of its own for.
    const programs = told.at(-1)![0] as string;
    assert.ok(!programs.includes(MIXER) && programs.includes('Compute Budget'), programs);
});

test('what the node did not say ran inside (no inner instructions), or what reads as nothing known, is left out: the warning stands', () => {
    for (const inner of [null, [], [{ index: 2, instructions: [{ program: shield.accounts[9]!, accounts: [WALLET], data: new Uint8Array([255, 1, 2]) }] }], [{ index: 99, instructions: [] }]]) {
        const a = summarize({ ...shield, inner } as Landed, WALLET);
        assert.deepEqual(a.unknown, [MIXER]);
        assert.deepEqual(a.through, []);
        const [row] = rows([a], naming);
        assert.equal(row.tone, 'plain');
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

// The shield again, its unknown program running `ixs` inside it instead, the wallet holding `before` (and `after`).
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const at = (i: number) => shield.accounts[i]!;
const A = 1; // a token account of the wallet's, in the shield's accounts
const B = 2; // another account
const inside = (ixs: Instruction[], tokens: { before: { account: number; owner: Address }[]; after?: { account: number; owner: Address }[] } = { before: [{ account: A, owner: WALLET }] }) =>
    summarize(
        {
            ...shield,
            inner: [{ index: 2, instructions: ixs.map((ix) => ({ program: ix.programAddress, accounts: (ix.accounts ?? []).map((a) => a.address), data: new Uint8Array(ix.data!) })) }],
            tokens: {
                before: tokens.before.map((b) => ({ account: b.account, mint: USDC, owner: b.owner, units: 5_000_000n, decimals: 6 })),
                after: (tokens.after ?? tokens.before).map((b) => ({ account: b.account, mint: USDC, owner: b.owner, units: 5_000_000n, decimals: 6 })),
            },
        } as Landed,
        WALLET,
    );
const me = createNoopSigner(WALLET);

test("a token account handed to the wallet on the way was not its own when it moved; one sent to itself moved nothing", () => {
    const send = getTransferInstruction({ source: at(A), destination: at(B), authority: createNoopSigner(at(B)), amount: 1_000_000n });
    // Listed as the wallet's only after: someone else's when it sent.
    assert.deepEqual(inside([send], { before: [{ account: A, owner: at(B) }], after: [{ account: A, owner: WALLET }] }).through, []);
    // Its own before: a send of the wallet's.
    assert.deepEqual(inside([send]).through.map((t) => [t.kind, t.to, t.units]), [['sent', at(B), 1_000_000n]]);
    // To itself: nothing went anywhere.
    assert.deepEqual(inside([getTransferInstruction({ source: at(A), destination: at(A), authority: me, amount: 1n })]).through, []);
});

test("what an unknown program hands over inside it is said: an account given away or the wallet assigned in red, a limited approval or an account closed in yellow", () => {
    const a = inside([
        getApproveInstruction({ source: at(A), delegate: at(B), owner: me, amount: 2_000_000n }),
        getSetAuthorityInstruction({ owned: at(A), owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: at(B) }),
        getCloseAccountInstruction({ account: at(A), destination: at(B), owner: me }),
        getAssignInstruction({ account: me, programAddress: MIXER }),
        // Not of the wallet's: none of these.
        getCloseAccountInstruction({ account: at(B), destination: at(A), owner: me }),
        getTransferSolInstruction({ source: createNoopSigner(at(B)), destination: WALLET, amount: 5n }),
    ]);
    assert.deepEqual(a.through.map((t) => t.kind), ['approved', 'authority', 'closed', 'assigned']);
    const [row] = rows([a], naming);
    assert.deepEqual(
        row.details.filter((d) => d.unknown && d.text.startsWith('It ')).map((d) => `${d.tone}: ${d.text}`),
        [`warn: It let ${at(B)} move up to 2 ${USDC} of yours`, `danger: It gave your ${USDC} account to ${at(B)}`, `warn: It closed your ${USDC} account, its SOL to ${at(B)}`, `danger: It gave your wallet to the program ${MIXER}`],
    );
    // A danger marks the line, as any other does.
    assert.equal(row.tone, 'danger');
});

test('sends told one by one up to eight; the rest counted', () => {
    const many = Array.from({ length: 20 }, () => getTransferSolInstruction({ source: me, destination: POOL, amount: 1n }));
    const [row] = rows([inside(many)], naming);
    const sends = row.details.filter((d) => d.unknown && /^It sent/.test(d.text)).map((d) => d.text);
    assert.equal(sends.length, 9);
    assert.equal(sends.at(-1), 'It sent 12 more');
});

test("a send through an unknown program never vouches for its other side: a lookalike of a known address there is still told as one", () => {
    const real = address('5cMKyZ58Z3nCMPenf1HiANGkbBfZE8GCtPD1kzZwo2jb');
    const twin = (['5cMK', ...'ABCDEFGHJKLMNPQRSTUVWXYZabcdefgh'.split('')].join('').slice(0, 40) + 'o2jb') as Address;
    const a = { ...summarize(shield, WALLET), other: twin, kind: 'send' as const };
    const [row] = rows([a], { ...naming, known: [real] });
    assert.deepEqual(row.sub, [{ text: 'through an unknown program', tone: 'warn' }]);
    assert.ok(row.details.some((d) => d.tone === 'warn' && d.text.includes(`looks like ${real}`)), JSON.stringify(row.details));
});

test('a transaction about nothing but an unknown program is one through it', () => {
    const a = { ...summarize(shield, WALLET), kind: 'other' as const, moves: [], other: null, rent: { yours: 0n, theirs: 0n, opened: 0n } };
    const [row] = rows([a], naming);
    assert.deepEqual([text(row.title), row.sub], ['Transaction', [{ text: 'through an unknown program', tone: 'warn' }]]);
});
