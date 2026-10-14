import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getAddressEncoder } from '@solana/kit';

import { STAKE_PROGRAM } from '../src/programs/addresses.ts';

import { assertions, holds, roomBeside, type Beside, type Hold } from '../src/prepare/guard.ts';
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

test('a field another changes is not held, the rest still is: what it is then depends on their order', () => {
    const lends = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1000n, { delegate: key(41), delegated: 50n })));
    const owned = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1000n, { owner: key(42) })));
    const token = (h: Hold[]) => h.find((x) => x.account === USER_TOKEN);
    // Its delegate let go, its amount, owner and close authority held.
    assert.deepEqual(token(holds(a, PAYER, [], undefined, [beside(lends)])), { kind: 'token', account: USER_TOKEN, atLeast: least(holds(a, PAYER), USER_TOKEN), owner: PAYER, closer: null });
    assert.deepEqual(token(holds(a, PAYER, [], undefined, [beside(owned)])), { kind: 'token', account: USER_TOKEN, atLeast: least(holds(a, PAYER), USER_TOKEN), delegate: null, delegated: 0n, closer: null });
    // Made by another as this one finds it: held as alone.
    const opens = tx(5_000n, change(USER_TOKEN, null, tokens(0n)));
    assert.deepEqual(token(holds(a, PAYER, [], undefined, [beside(opens)])), token(holds(a, PAYER)));
    // Closed by another: all of it may be gone, and made again it has no delegate nor close authority.
    const closes = tx(5_000n, change(USER_TOKEN, tokens(1000n), null));
    assert.deepEqual(token(holds(a, PAYER, [], undefined, [beside(closes)])), { kind: 'token', account: USER_TOKEN, atLeast: 0n, owner: PAYER });
    // Of another mint, or kind: not held at all.
    const remade = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1000n, { mint: key(44) })));
    assert.equal(token(holds(a, PAYER, [], undefined, [beside(remade)])), undefined);
    // A wallet another assigns elsewhere: its lamports held, not its owner.
    const assigned = tx(5_000n, change(PAYER, wallet(10n * SOL), { ...wallet(10n * SOL)!, program: key(43) }));
    const w = holds(a, PAYER, [], undefined, [beside(assigned)]).find((x) => x.account === PAYER)!;
    assert.deepEqual(w, { kind: 'wallet', account: PAYER, atLeast: least(holds(a, PAYER), PAYER), space: 0 });
});

test('what others move between your own accounts is room its guards leave past its review, and said', () => {
    const WRAPPED = key(45);
    // B wraps 4 SOL into your own wrapped SOL account: you lose nothing, but A's wallet floor makes room for it.
    const native = (amount: bigint): State => ({ lamports: 2_039_280n + amount, program: TOKEN_PROGRAM_ADDRESS, space: 165, data: new Uint8Array(165), token: { mint: key(46), owner: PAYER, amount, delegate: null, delegated: 0n, closer: null, native: true } });
    const wraps = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(6n * SOL - 5_000n)), change(WRAPPED, native(0n), native(4n * SOL)));
    const room = roomBeside(a, PAYER, [beside(wraps)]);
    assert.ok(room.lamports >= 4n * SOL && room.lamports < 4n * SOL + SOL / 10n, String(room.lamports));
    // What another sends away is no room: it is in its own review.
    assert.deepEqual(roomBeside(a, PAYER, [beside(b)]), { lamports: 0n, units: 0n });
    // A token account's rent moved among yours is too little to say.
    const opensYours = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(10n * SOL - 2_039_280n - 5_000n)), change(WRAPPED, null, native(0n)));
    assert.deepEqual(roomBeside(a, PAYER, [beside(opensYours)]), { lamports: 0n, units: 0n });
});

test('a partial hold asserts only what it holds', () => {
    const partial: Hold = { kind: 'token', account: USER_TOKEN, atLeast: 5n, owner: PAYER, closer: null };
    const [data] = assertions(partial, PAYER);
    assert.deepEqual([...data.slice(0, 4)], [10, 0, 3, 2]); // token multi, silent, three assertions, amount first
    const bare: Hold = { kind: 'wallet', account: PAYER, atLeast: 7n };
    assert.deepEqual([...assertions(bare, PAYER)[0].slice(0, 4)], [6, 0, 1, 0]); // account info multi, one: lamports
});

test('several beside: what each takes adds up; a floor never goes below nothing', () => {
    const c = tx(0n, change(USER_TOKEN, tokens(1000n), tokens(600n))); // its fee paid by another
    const both = holds(a, PAYER, [], undefined, [beside(b), beside(c)]);
    assert.equal(least(holds(a, PAYER), USER_TOKEN)! - least(both, USER_TOKEN)!, 303n + 404n);
    const all = tx(0n, change(USER_TOKEN, tokens(1000n), tokens(0n)));
    assert.equal(least(holds(a, PAYER, [], undefined, [beside(all)]), USER_TOKEN), 0n);
});

test('a stake account another changes one term of keeps the others held, and your address where it stays', () => {
    const STAKE = key(47);
    const stakeData = (staker: Uint8Array, withdrawer: Uint8Array) => {
        const d = new Uint8Array(200);
        d[0] = 2; // delegated
        d.set(staker, 12);
        d.set(withdrawer, 44);
        return d;
    };
    const me = Uint8Array.from(getAddressEncoder().encode(PAYER));
    const other = Uint8Array.from(getAddressEncoder().encode(key(48)));
    const stake = (staker: Uint8Array, lamports: bigint): State => ({ lamports, program: STAKE_PROGRAM, space: 200, data: stakeData(staker, me), token: null });
    const a = tx(5_000n, change(STAKE, stake(me, 3n * SOL), stake(me, 3n * SOL)));
    const alone = holds(a, PAYER).find((h) => h.account === STAKE)!;
    assert.ok(alone.kind === 'account' && alone.stake && alone.keys.includes(44));
    // Another gives the stake authority away: the withdrawer, the lockup and your address at 44 still held.
    const gives = tx(5_000n, change(STAKE, stake(me, 3n * SOL), stake(other, 3n * SOL)));
    const held = holds(a, PAYER, [], undefined, [beside(gives)]).find((h) => h.account === STAKE)!;
    assert.ok(held.kind === 'account');
    assert.deepEqual(Object.keys(held.kind === 'account' ? held.stake ?? {} : {}).sort(), ['custodian', 'epoch', 'time', 'withdrawer']);
    assert.deepEqual(held.kind === 'account' && held.keys, [44]);
    assert.equal(assertions(held, PAYER).length, 2);
});

test('room is what each of the others moves out of your accounts past what it loses, asset by asset', () => {
    const [WRAPPED, STAKED] = [key(49), key(50)];
    const native = (amount: bigint): State => ({ lamports: 2_039_280n + amount, program: TOKEN_PROGRAM_ADDRESS, space: 165, data: new Uint8Array(165), token: { mint: key(46), owner: PAYER, amount, delegate: null, delegated: 0n, closer: null, native: true } });
    const staked = (lamports: bigint): State => ({ lamports, program: STAKE_PROGRAM, space: 200, data: new Uint8Array(200), token: null });
    // A holds the wallet and the stake account; B wraps 4 SOL (stays yours) and withdraws 4 SOL of the stake to someone else.
    const a = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(10n * SOL - 5_000n)), change(STAKED, staked(5n * SOL), staked(5n * SOL)));
    const b = tx(5_000n, change(PAYER, wallet(10n * SOL), wallet(6n * SOL - 5_000n)), change(WRAPPED, native(0n), native(4n * SOL)), change(STAKED, staked(5n * SOL), staked(SOL)));
    const room = roomBeside(a, PAYER, [beside(b)]);
    assert.equal(room.lamports, 4n * SOL); // 8 SOL out of A's accounts, 4 SOL lost: 4 SOL stays among yours
});

test('one that closes and another that opens the same account again land in either order', () => {
    // B moves 1,000 out and closes it; A makes it again (idempotent) and puts 50 in.
    const a = tx(5_000n, change(USER_TOKEN, tokens(1000n), tokens(1050n)));
    const closes = tx(5_000n, change(USER_TOKEN, tokens(1000n), null));
    const h = holds(a, PAYER, [], undefined, [beside(closes)]).find((x) => x.account === USER_TOKEN)!;
    assert.ok(h.atLeast <= 50n, String(h.atLeast)); // made again with only A's 50, it still passes
});
