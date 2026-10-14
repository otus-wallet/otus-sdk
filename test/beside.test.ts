import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { holds, type Beside, type Hold } from '../src/prepare/guard.ts';
import type { Change, Changes, State, Token } from '../src/review/changes.ts';
import { key, MINT, PAYER, SYSTEM } from './helpers.ts';

// Transactions signed together, each reviewed against the same accounts as they are: one may land before another, in
// any order, so each holds your accounts to what all of them may take.
const USER_TOKEN = key(40);
const wallet = (lamports: bigint): State => ({ lamports, program: SYSTEM, space: 0, data: new Uint8Array(), token: null });
const tokens = (amount: bigint, o: Partial<Token> = {}): State => ({ lamports: 2_039_280n, program: TOKEN_PROGRAM_ADDRESS, space: 165, data: new Uint8Array(165), token: { mint: MINT, owner: PAYER, amount, delegate: null, delegated: 0n, closer: null, native: false, ...o } });
const change = (address: typeof PAYER, before: State, after: State): Change => ({ address, before, after });
const tx = (fee: bigint, ...accounts: Change[]): Changes => ({ fee, accounts });
const beside = (c: Changes, spare?: bigint): Beside => ({ changes: c, yours: c, ...(spare !== undefined && { spare }) });
const least = (h: Hold[], account: typeof PAYER) => h.find((x) => x.account === account)?.atLeast ?? null;

const SOL = 1_000_000_000n;
// A pays 0.002 SOL and sends 100 tokens; B pays 0.003 SOL and sends 300 tokens. Both from 10 SOL and 1,000 tokens.
const a = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(10n * SOL - 2_005_000n)), change(USER_TOKEN, tokens(1000n), tokens(900n)));
const b = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(10n * SOL - 3_005_000n)), change(USER_TOKEN, tokens(1000n), tokens(700n)));

test('alone, the floors are as before; beside another, they leave room for what it takes, its slack too', () => {
    const alone = holds(a, PAYER);
    const together = holds(a, PAYER, [], undefined, [beside(b)]);
    // B takes 3,005,000 lamports and 300 tokens, each with a hundredth of its move as slack (rounded up).
    assert.equal(least(alone, PAYER)! - least(together, PAYER)!, 3_005_000n + 30_050n);
    assert.equal(least(alone, USER_TOKEN)! - least(together, USER_TOKEN)!, 300n + 3n);
    // Its priority fee too, when Otus may set one.
    assert.equal(least(together, PAYER)! - least(holds(a, PAYER, [], undefined, [beside(b, 1_000_000n)]), PAYER)!, 1_000_000n);
    assert.equal(least(holds(a, PAYER, [], undefined, [beside(b, 1_000_000n)]), USER_TOKEN), least(together, USER_TOKEN)); // a fee is SOL alone
});

test('what another only adds, or an account it does not touch, changes nothing', () => {
    const gives = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1500n)));
    assert.deepEqual(holds(a, PAYER, [], undefined, [beside(gives)]), holds(a, PAYER));
    assert.deepEqual(holds(a, PAYER, [], undefined, [beside(tx(0n))]), holds(a, PAYER));
});

test('an account another changes past its amount is not held: what it is depends on their order', () => {
    const lends = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1000n, { delegate: key(41), delegated: 50n })));
    const closes = tx(5_000n, change(USER_TOKEN, tokens(1000n), null));
    const opens = tx(5_000n, change(USER_TOKEN, null, tokens(0n)));
    const owned = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1000n, { owner: key(42) })));
    for (const other of [lends, closes, opens, owned]) {
        const h = holds(a, PAYER, [], undefined, [beside(other)]);
        assert.equal(least(h, USER_TOKEN), null);
        assert.ok(least(h, PAYER) !== null); // the wallet still held
    }
    // A wallet another assigns elsewhere, or whose data another writes: not held either.
    const assigned = tx(5_000n, change(PAYER, wallet(10n * SOL), { ...wallet(10n * SOL)!, program: key(43) }));
    assert.equal(least(holds(a, PAYER, [], undefined, [beside(assigned)]), PAYER), null);
});

test('several beside: what each takes adds up; a floor never goes below nothing', () => {
    const c = tx(0n, change(USER_TOKEN, tokens(1000n), tokens(600n))); // its fee paid by another
    const both = holds(a, PAYER, [], undefined, [beside(b), beside(c)]);
    assert.equal(least(holds(a, PAYER), USER_TOKEN)! - least(both, USER_TOKEN)!, 303n + 404n);
    const all = tx(0n, change(USER_TOKEN, tokens(1000n), tokens(0n)));
    assert.equal(least(holds(a, PAYER, [], undefined, [beside(all)]), USER_TOKEN), 0n);
});
