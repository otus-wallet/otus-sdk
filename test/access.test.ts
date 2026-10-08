import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getAddressEncoder, getBase58Decoder, type Address } from '@solana/kit';

import { grantsOf, heldMints, type Waiting } from '../src/access/access.ts';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../src/programs/addresses.ts';
import { account, key, MINT, PAYER, SYSTEM, tokenAccountData } from './helpers.ts';

const OTHER = key(40);
const ISSUER = key(41);
const TOKEN = key(42);
const U64_MAX = 2n ** 64n - 1n;
const tokens = (o: Partial<Parameters<typeof tokenAccountData>[0]>, address = TOKEN) => account(address, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n, ...o }));

// A mint: its mint authority and freeze authority as COptions (at 0 and 46), initialized. Token-2022's with a permanent
// delegate: padded to 165, its type byte (1), then that extension (12), 32 bytes long.
function mint(o: { freezer?: Address; permanent?: Address } = {}, address = MINT) {
    const base = new Uint8Array(o.permanent ? 166 + 36 : 82);
    base[45] = 1;
    if (o.freezer) {
        base[46] = 1;
        base.set(getAddressEncoder().encode(o.freezer), 50);
    }
    if (!o.permanent) return account(address, TOKEN_PROGRAM_ADDRESS, 1_461_600n, base);
    base[165] = 1;
    base.set([12, 0, 32, 0], 166);
    base.set(getAddressEncoder().encode(o.permanent), 170);
    return account(address, TOKEN_2022_PROGRAM_ADDRESS, 2_000_000n, base);
}

// A nonce account: version 1, initialized, its authority, then the nonce.
function nonce(address: Address, authority: Address, value: Uint8Array) {
    const d = new Uint8Array(80);
    d.set([1, 0, 0, 0, 1, 0, 0, 0], 0);
    d.set(getAddressEncoder().encode(authority), 8);
    d.set(value, 40);
    return account(address, SYSTEM, 1_447_680n, d);
}

test('a delegate on a token account of yours: what it can move, and whether that is all of it', () => {
    assert.deepEqual(grantsOf(PAYER, [tokens({ delegate: OTHER, delegated: 100n })], [], []), [{ kind: 'delegate', account: TOKEN, mint: MINT, to: OTHER, allowance: 100n, all: false }]);
    assert.equal((grantsOf(PAYER, [tokens({ delegate: OTHER, delegated: 1000n })], [], [])[0] as { all: boolean }).all, true);
    assert.equal((grantsOf(PAYER, [tokens({ amount: 0n, delegate: OTHER, delegated: U64_MAX })], [], [])[0] as { all: boolean }).all, true); // empty, without end: all that comes
    assert.deepEqual(grantsOf(PAYER, [tokens({ delegate: OTHER, delegated: 0n })], [], []), []); // nothing allowed
});

test('a close authority that is not you; another owner’s account says nothing', () => {
    assert.deepEqual(grantsOf(PAYER, [tokens({ closer: OTHER })], [], []), [{ kind: 'closer', account: TOKEN, mint: MINT, to: OTHER }]);
    assert.deepEqual(grantsOf(PAYER, [tokens({ closer: PAYER })], [], []), []);
    assert.deepEqual(grantsOf(PAYER, [tokens({ owner: OTHER, delegate: ISSUER, delegated: 5n })], [], []), []);
});

test('what a token’s issuer can do, only for a token you hold', () => {
    const held = [tokens({})];
    assert.deepEqual(heldMints(PAYER, held), [MINT]);
    assert.deepEqual(grantsOf(PAYER, held, [mint({ freezer: ISSUER })], []), [{ kind: 'freeze', mint: MINT, to: ISSUER }]);
    assert.deepEqual(grantsOf(PAYER, held, [mint()], []), []);
    assert.deepEqual(grantsOf(PAYER, held, [mint({ permanent: ISSUER, freezer: ISSUER })], []), [
        { kind: 'permanent', mint: MINT, to: ISSUER },
        { kind: 'freeze', mint: MINT, to: ISSUER },
    ]);
    assert.deepEqual(heldMints(PAYER, [tokens({ amount: 0n })]), []);
    assert.deepEqual(grantsOf(PAYER, [tokens({ amount: 0n })], [mint({ freezer: ISSUER })], []), []); // none of it held
});

test('a transaction you signed on a nonce can run while its nonce account holds that nonce', () => {
    const value = new Uint8Array(32).fill(7);
    const waiting: Waiting = { account: key(43), nonce: getBase58Decoder().decode(value) };
    assert.deepEqual(grantsOf(PAYER, [], [], [{ waiting, account: nonce(key(43), OTHER, value) }]), [{ kind: 'nonce', account: key(43), nonce: waiting.nonce, authority: OTHER }]);
    assert.deepEqual(grantsOf(PAYER, [], [], [{ waiting, account: nonce(key(43), OTHER, new Uint8Array(32).fill(8)) }]), []); // advanced: it ran, or was cancelled
    assert.deepEqual(grantsOf(PAYER, [], [], [{ waiting, account: { exists: false, address: key(43) } }]), []);
});

test('grants come worst first', () => {
    const value = new Uint8Array(32).fill(7);
    const waiting: Waiting = { account: key(43), nonce: getBase58Decoder().decode(value) };
    const grants = grantsOf(PAYER, [tokens({ closer: OTHER, delegate: OTHER, delegated: 10n })], [mint({ freezer: ISSUER, permanent: ISSUER })], [{ waiting, account: nonce(key(43), PAYER, value) }]);
    assert.deepEqual(grants.map((g) => g.kind), ['delegate', 'permanent', 'nonce', 'closer', 'freeze']);
});

test('garbage in any account reads as nothing it does not hold, and never throws', () => {
    let seed = 1;
    const random = (n: number) => Uint8Array.from({ length: n }, () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed & 255));
    const programs = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, SYSTEM];
    const holds = tokens({ mint: key(50) }); // so a garbage mint at key(50) is read
    for (let i = 0; i < 600; i++) {
        const a = account(key(50), programs[i % 3], 1n, random([82, 165, 166 + (i % 97), 80, 355, i % 400][i % 6]));
        assert.doesNotThrow(() => grantsOf(PAYER, [holds, a], [a], [{ waiting: { account: key(50), nonce: 'x' }, account: a }]));
    }
    // A permanent delegate whose extension runs past the end of its account reads as none.
    const whole = mint({ permanent: ISSUER });
    const cut = account(MINT, TOKEN_2022_PROGRAM_ADDRESS, 2_000_000n, whole.exists ? whole.data.slice(0, 166 + 20) : new Uint8Array());
    assert.deepEqual(grantsOf(PAYER, [tokens({})], [cut], []), []);
});
