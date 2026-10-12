import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAddress, type Address } from '@solana/kit';

import { dust, harmless } from '../src/activity/dust.ts';
import type { Activity, Told } from '../src/activity/summary.ts';
import { key, MINT } from './helpers.ts';

const WALLET = key(31);
const REAL = key(60); // an address the wallet sent to
// A copy: the real address's first and last four characters around another's middle, as poisoners grind them.
const copyOf = (real: Address, from = 61) => Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(from + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
const COPY = copyOf(REAL);

// Dust as poisoners send it: a token's smallest unit, from the copy, unsigned by the wallet.
const poisoned = (over: Partial<Activity> = {}): Activity => ({
    signature: 's',
    signatures: {},
    slot: 1n,
    time: 1_791_236_675,
    error: null,
    kind: 'receive',
    moves: [{ mint: MINT, units: 1n, decimals: 6 }],
    fee: 5000n,
    payer: COPY,
    rent: { yours: 0n, theirs: 0n, opened: 0n },
    created: [],
    instructions: [],
    held: [],
    fresh: [],
    staked: 0n,
    signed: false,
    other: COPY,
    programs: [],
    main: null,
    squads: [],
    memo: null,
    ...over,
});
const ix = (name: string) => ({ name, program: key(5), source: 'plugin', args: [], accounts: [] }) as unknown as Told;
const known = [WALLET, REAL];

test('dust from a copy of an address the wallet knows, the wallet itself among them', () => {
    assert.deepEqual(dust(poisoned(), { known }), { copy: COPY, of: REAL });
    const self = copyOf(WALLET, 200);
    assert.deepEqual(dust(poisoned({ other: self, payer: self }), { known }), { copy: self, of: WALLET });
    // SOL too, a token account opened for it on the way, a memo: still dust.
    assert.deepEqual(dust(poisoned({ moves: [{ mint: null, units: 1n, decimals: 9 }], rent: { yours: 2_039_280n, theirs: 0n, opened: 0n }, memo: 'hi' }), { known }), { copy: COPY, of: REAL });
});

test('never dust: what the wallet signed, what left it or closed, a changed authority, a failure', () => {
    const cases: [string, Partial<Activity>][] = [
        ['signed', { signed: true }],
        ['failed', { error: 'custom 1' }],
        ['tokens out', { moves: [{ mint: MINT, units: -5n, decimals: 6 }, { mint: MINT, units: 1n, decimals: 6 }] }],
        ['SOL out', { moves: [{ mint: null, units: -1n, decimals: 9 }] }],
        ['an account of its closed', { rent: { yours: -2_039_280n, theirs: 0n, opened: 0n } }],
        ['stake moved', { staked: 1n }],
        ['a multisig', { squads: ['approve'] }],
        ...['Approve', 'ApproveChecked', 'Revoke', 'SetAuthority', 'CloseAccount', 'FreezeAccount', 'ThawAccount', 'Assign', 'AssignWithSeed', 'Authorize', 'AuthorizeChecked', 'AuthorizeNonceAccount', 'SetLockup', 'DelegateStake', 'Deactivate', 'Withdraw', 'Split', 'Merge', 'Upgrade'].map((n): [string, Partial<Activity>] => [n, { instructions: [ix('TransferChecked'), ix(n)] }]),
    ];
    for (const [why, over] of cases) {
        assert.equal(harmless(poisoned(over)), false, why);
        assert.equal(dust(poisoned(over), { known }), null, why);
    }
    assert.equal(harmless(poisoned({ instructions: [ix('TransferChecked'), ix('CreateIdempotent'), ix('AddMemo')] })), true);
});

test('not dust: the address itself known, alike nothing known, or no one it came from', () => {
    assert.equal(dust(poisoned(), { known: [WALLET, REAL, COPY] }), null); // a copy the wallet uses is its own business
    assert.equal(dust(poisoned(), { known: [WALLET] }), null);
    assert.equal(dust(poisoned(), { known: [] }), null);
    assert.equal(dust(poisoned({ other: null }), { known }), null);
    // Alike by a few characters only, as any two addresses may be by chance: not a copy.
    const near = `${REAL.slice(0, 2)}${key(90).slice(2, -2)}${REAL.slice(-2)}` as Address;
    assert.equal(dust(poisoned({ other: near }), { known }), null);
});
