import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getCreateAccountWithSeedInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getProgramDerivedAddress, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import { review } from '../src/review/review.ts';
import { account, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const SOL = 1_000_000_000n;
const EVIL = key(22);
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
const ORDER_ENGINE = address('61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH');
const [USER_TOKEN, VAULT, THIEF_TOKEN, POCKET] = [key(23), key(24), key(26), key(25)];
const USDC_IN = key(27);
const { WRITABLE: W, WRITABLE_SIGNER: WS } = AccountRole;

const problems = async (ix: Instruction, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[]) =>
    (await review(transaction([ix]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after))).assessment.findings
        .filter((f) => ['sends-to-wallet', 'check-balances'].includes(f.code))
        .map((f) => `${f.level}:${f.code}${f.code === 'sends-to-wallet' && f.text.startsWith('A small part') ? ' (a fee, maybe)' : ''}`);
const tokens = (a: Address, owner: Address, amount: bigint, mint = MINT) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint, owner, amount }));

test('a program Otus doesn’t know taking your tokens into its own vault: a warning, however much it takes', async () => {
    const [vaultOwner] = await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['vault'] }); // no key holds it
    const sweep = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: USER_TOKEN, role: W }, { address: VAULT, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), tokens(USER_TOKEN, PAYER, 1000n), tokens(VAULT, vaultOwner, 0n)];
    const after = (left: bigint) => [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, left), tokens(VAULT, vaultOwner, 1000n - left)];
    assert.deepEqual(await problems(sweep, before, after(200n)), ['warn:sends-to-wallet']);
    assert.deepEqual(await problems(sweep, before, after(0n)), ['warn:sends-to-wallet']);
});

test('your SOL into an account a program Otus doesn’t know keeps: the same', async () => {
    const take = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: POCKET, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(POCKET, EVIL, SOL, new Uint8Array(8))];
    assert.deepEqual(await problems(take, before, [account(PAYER, SYSTEM, 3n * SOL), account(POCKET, EVIL, 3n * SOL, new Uint8Array(8))]), ['warn:sends-to-wallet']);
    assert.deepEqual(await problems(take, before, [account(PAYER, SYSTEM, SOL / 100n), account(POCKET, EVIL, 6n * SOL - SOL / 100n, new Uint8Array(8))]), ['warn:sends-to-wallet']);
});

test('your assets to a wallet with nothing back: told, by a program known or not; a small share as a fee, maybe', async () => {
    const pay = (program: Address) => ({ programAddress: program, accounts: [{ address: PAYER, role: WS }, { address: USER_TOKEN, role: W }, { address: THIEF_TOKEN, role: W }] });
    const before = [account(PAYER, SYSTEM, 5n * SOL), tokens(USER_TOKEN, PAYER, 1000n), tokens(THIEF_TOKEN, THIEF, 0n)];
    const after = (sent: bigint) => [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, 1000n - sent), tokens(THIEF_TOKEN, THIEF, sent)];
    assert.deepEqual(await problems(pay(EVIL), before, after(800n)), ['warn:sends-to-wallet']);
    assert.deepEqual(await problems(pay(ORDER_ENGINE), before, after(800n)), ['warn:sends-to-wallet']); // known, nothing back
    // Most of it into a pool's vault, a twentieth or less to a wallet: a fee, maybe.
    const [pool] = await getProgramDerivedAddress({ programAddress: ORDER_ENGINE, seeds: ['pool'] });
    const split = { ...pay(ORDER_ENGINE), accounts: [...pay(ORDER_ENGINE).accounts, { address: VAULT, role: W }] };
    const fee = await problems(split, [...before, tokens(VAULT, pool, 0n)], [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, 200n), tokens(THIEF_TOKEN, THIEF, 30n), tokens(VAULT, pool, 770n)]);
    assert.deepEqual(fee, ['warn:sends-to-wallet (a fee, maybe)']);
});

test('a trade, something coming back to you: nothing to say through a program Otus knows; worth checking otherwise', async () => {
    // An RFQ fill: your SOL to the maker's wallet, its USDC to yours.
    const USDC = key(28);
    const fill = (program: Address) => ({ programAddress: program, accounts: [{ address: PAYER, role: WS }, { address: THIEF, role: W }, { address: USDC_IN, role: W }, { address: THIEF_TOKEN, role: W }] });
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(THIEF, SYSTEM, SOL), tokens(USDC_IN, PAYER, 0n, USDC), tokens(THIEF_TOKEN, THIEF, 500_000_000n, USDC)];
    const after = [account(PAYER, SYSTEM, 4n * SOL - 5000n), account(THIEF, SYSTEM, 2n * SOL), tokens(USDC_IN, PAYER, 121_649_541n, USDC), tokens(THIEF_TOKEN, THIEF, 500_000_000n - 121_649_541n, USDC)];
    assert.deepEqual(await problems(fill(ORDER_ENGINE), before, after), []);
    assert.deepEqual(await problems(fill(EVIL), before, after), ['warn:check-balances']);
});

test('SOL a new account is made with, beside a program Otus doesn’t know, is said in words: not hidden', async () => {
    const touch: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }] };
    const made = getCreateAccountWithSeedInstruction({ payer: createNoopSigner(PAYER), newAccount: THIEF, baseAccount: createNoopSigner(PAYER), base: PAYER, seed: 'x', amount: 2n * SOL, space: 0, programAddress: SYSTEM });
    const r = await review(transaction([touch, made]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain([account(PAYER, SYSTEM, 5n * SOL)], [account(PAYER, SYSTEM, 3n * SOL - 5000n), account(THIEF, SYSTEM, 2n * SOL)]));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet'), []);
});

test('the rent of a token account made for a wallet, beside a program Otus doesn’t read, is said in words: not hidden', async () => {
    // A multisig's run, its vault's tokens to another wallet, with that wallet's token account made first, at your cost.
    const SQUADS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
    const [vault, proposal] = [key(30), key(31)];
    const run: Instruction = { programAddress: SQUADS, accounts: [{ address: PAYER, role: WS }, { address: proposal, role: W }, { address: VAULT, role: W }, { address: THIEF_TOKEN, role: W }] };
    const made = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(PAYER), ata: THIEF_TOKEN, owner: THIEF, mint: MINT });
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(proposal, SQUADS, SOL / 100n, new Uint8Array(64)), tokens(VAULT, vault, 1000n)];
    const after = [account(PAYER, SYSTEM, 5n * SOL - 5000n - 2_039_280n), account(proposal, SQUADS, SOL / 100n, new Uint8Array(64)), tokens(VAULT, vault, 0n), tokens(THIEF_TOKEN, THIEF, 1000n)];
    const r = await review(transaction([made, run]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet'), []);

    // More than a token account's rent into it, or your tokens to it, through a program Otus doesn't read: hidden still.
    const drain: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: USER_TOKEN, role: W }, { address: THIEF_TOKEN, role: W }] };
    const rich = { ...account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 2n * SOL, tokenAccountData({ mint: MINT, owner: THIEF, amount: 0n })) };
    const sol = await review(transaction([made, drain]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain([account(PAYER, SYSTEM, 5n * SOL)], [account(PAYER, SYSTEM, 3n * SOL - 5000n), rich]));
    const swept = await review(
        transaction([made, drain]),
        { wallet: PAYER, signedBefore: 0, host: 'app.example.com' },
        fakeChain([account(PAYER, SYSTEM, 5n * SOL), tokens(USER_TOKEN, PAYER, 1000n)], [account(PAYER, SYSTEM, 5n * SOL - 5000n - 2_039_280n), tokens(USER_TOKEN, PAYER, 0n), tokens(THIEF_TOKEN, THIEF, 1000n)]),
    );
    const level = (r: Awaited<ReturnType<typeof review>>) => r.assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => (f.text.startsWith('A small part') ? 'fee' : 'drain'));
    assert.deepEqual([level(sol), level(swept)], [['drain'], ['drain']]);
});

test('what others get from someone else is not yours: a vault opening an account inside a call, your tip said in words', async () => {
    // A multisig's run: you pay a tip in words; inside, its vault pays the rent of a token account it opens for a wallet
    // and sends it tokens. Nothing of yours goes unsaid.
    const SQUADS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
    const [vault, proposal, tip] = [key(32), key(33), key(34)];
    const run: Instruction = { programAddress: SQUADS, accounts: [{ address: PAYER, role: WS }, { address: proposal, role: W }, { address: vault, role: W }, { address: VAULT, role: W }, { address: THIEF_TOKEN, role: W }] };
    const tipped = getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: tip, amount: 100_000n });
    const before = [account(PAYER, SYSTEM, SOL), account(tip, SYSTEM, 690_880n), account(proposal, SQUADS, SOL / 100n, new Uint8Array(64)), account(vault, SYSTEM, 4n * SOL), tokens(VAULT, vault, 1_000_000n)];
    const after = [account(PAYER, SYSTEM, SOL - 100_000n - 5_000n), account(tip, SYSTEM, 790_880n), account(proposal, SQUADS, SOL / 100n, new Uint8Array(64)), account(vault, SYSTEM, 4n * SOL - 1_488_440n), tokens(VAULT, vault, 0n), account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 1_488_440n, tokenAccountData({ mint: MINT, owner: THIEF, amount: 1_000_000n }))];
    const r = await review(transaction([tipped, run]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet'), []);
});

test('SOL someone else sends a wallet in words does not cover yours going there unsaid', async () => {
    // Another signer sends the thief 1 SOL in words; a program Otus doesn't read takes 1 SOL of yours there too.
    const other = key(35);
    const decoy = getTransferSolInstruction({ source: createNoopSigner(other), destination: THIEF, amount: SOL });
    const drain: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: THIEF, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(other, SYSTEM, 2n * SOL), account(THIEF, SYSTEM, SOL)];
    const after = [account(PAYER, SYSTEM, 4n * SOL - 10_000n), account(other, SYSTEM, SOL), account(THIEF, SYSTEM, 3n * SOL)];
    const r = await review(transaction([decoy, drain]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => (f.text.startsWith('A small part') ? 'fee' : 'drain')), ['drain']);
});

test('what you send yourself in words does not cover yours leaving unsaid', async () => {
    // A transfer of 1 SOL to yourself, in words; a program Otus doesn't read takes 1 SOL of yours to a wallet.
    const self = getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: PAYER, amount: SOL });
    const drain: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: THIEF, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(THIEF, SYSTEM, SOL)];
    const after = [account(PAYER, SYSTEM, 4n * SOL - 5_000n), account(THIEF, SYSTEM, 2n * SOL)];
    const r = await review(transaction([self, drain]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => (f.text.startsWith('A small part') ? 'fee' : 'drain')), ['drain']);
});

// Words that would cover an unread drain if what they send counted whatever became of it.
const RENT = 2_039_280n;
const NATIVE = address('So11111111111111111111111111111111111111112');
const held = (a: Address, owner: Address, amount: bigint, o: { lamports?: bigint; closer?: Address; delegate?: Address; delegated?: bigint; mint?: Address; native?: bigint } = {}) =>
    account(a, TOKEN_PROGRAM_ADDRESS, o.lamports ?? RENT, tokenAccountData({ mint: o.mint ?? MINT, owner, amount, ...(o.closer && { closer: o.closer }), ...(o.delegate && { delegate: o.delegate, delegated: o.delegated ?? 0n }), ...(o.native !== undefined && { native: o.native }) }));
const unread = (...accounts: Address[]): Instruction => ({ programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, ...accounts.map((address) => ({ address, role: W }))] });
// How an unread drain is told: as your assets going to someone else ('drain'), or as a small part of them ('fee').
const drained = async (ixs: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[]) =>
    (await review(transaction(ixs), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, fakeChain(before, after))).assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => (f.text.startsWith('A small part') ? 'fee' : 'drain'));

test('what words send that comes back, or is passed on, never covers an unread drain', async () => {
    const me = createNoopSigner(PAYER);
    const [other, theirs, made, wrapped, theirsWrapped, closedTo] = [key(60), key(61), key(62), key(63), key(64), key(65)];
    // 1 SOL to someone who sends it back in words.
    const back = [getTransferSolInstruction({ source: me, destination: other, amount: SOL }), getTransferSolInstruction({ source: createNoopSigner(other), destination: PAYER, amount: SOL }), unread(THIEF)];
    assert.deepEqual(await drained(back, [account(PAYER, SYSTEM, 5n * SOL), account(other, SYSTEM, SOL)], [account(PAYER, SYSTEM, 4n * SOL - 5_000n), account(other, SYSTEM, SOL), account(THIEF, SYSTEM, SOL)]), ['drain']);
    // 3 SOL into the thief's token account that you may close, closed back to you in words.
    const closed = [getTransferSolInstruction({ source: me, destination: theirs, amount: 3n * SOL }), getCloseAccountInstruction({ account: theirs, destination: PAYER, owner: me }), unread(THIEF)];
    assert.deepEqual(await drained(closed, [account(PAYER, SYSTEM, 5n * SOL), held(theirs, THIEF, 0n, { closer: PAYER })], [account(PAYER, SYSTEM, 2n * SOL - 5_000n), account(THIEF, SYSTEM, 3n * SOL + RENT)]), ['drain']);
    // Tokens to the thief's account you are delegate of, and back as its delegate.
    const lent = [getTransferInstruction({ source: USER_TOKEN, destination: theirs, authority: me, amount: 1000n }), getTransferInstruction({ source: theirs, destination: USER_TOKEN, authority: me, amount: 1000n }), unread(USER_TOKEN, THIEF_TOKEN)];
    assert.deepEqual(
        await drained(lent, [account(PAYER, SYSTEM, 5n * SOL), held(USER_TOKEN, PAYER, 1000n), held(theirs, THIEF, 0n, { delegate: PAYER, delegated: 1000n }), held(THIEF_TOKEN, THIEF, 0n)], [account(PAYER, SYSTEM, 5n * SOL - 5_000n), held(USER_TOKEN, PAYER, 0n), held(theirs, THIEF, 0n), held(THIEF_TOKEN, THIEF, 1000n)]),
        ['drain'],
    );
    // An account made with 2 SOL of yours for the unread program, which passes them on.
    const seeded = [getCreateAccountWithSeedInstruction({ payer: me, newAccount: made, baseAccount: me, base: PAYER, seed: 'x', amount: 2n * SOL, space: 0, programAddress: EVIL }), unread(made, THIEF)];
    assert.deepEqual(await drained(seeded, [account(PAYER, SYSTEM, 5n * SOL)], [account(PAYER, SYSTEM, 3n * SOL - 5_000n), account(THIEF, SYSTEM, 2n * SOL)]), ['drain']);
    // Your wrapped SOL drained, then the empty account closed in words: its SOL from before is not what it sends.
    const wsol = (a: Address, owner: Address, amount: bigint) => held(a, owner, amount, { mint: NATIVE, lamports: RENT + amount, native: RENT });
    const stale = [unread(wrapped, theirsWrapped), getCloseAccountInstruction({ account: wrapped, destination: closedTo, owner: me })];
    assert.deepEqual(await drained(stale, [account(PAYER, SYSTEM, SOL), wsol(wrapped, PAYER, 10n * SOL), wsol(theirsWrapped, THIEF, 0n), account(closedTo, SYSTEM, SOL)], [account(PAYER, SYSTEM, SOL - 5_000n), wsol(theirsWrapped, THIEF, 10n * SOL), account(closedTo, SYSTEM, SOL + RENT)]), ['drain']);
    // The thief sending itself SOL in words.
    const selfSent = [getTransferSolInstruction({ source: createNoopSigner(THIEF), destination: THIEF, amount: SOL }), unread(THIEF)];
    assert.deepEqual(await drained(selfSent, [account(PAYER, SYSTEM, 5n * SOL), account(THIEF, SYSTEM, 2n * SOL)], [account(PAYER, SYSTEM, 4n * SOL - 5_000n), account(THIEF, SYSTEM, 3n * SOL)]), ['drain']);
    // The same token account made fifty times: its rent counts once.
    const make = getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: THIEF_TOKEN, owner: THIEF, mint: MINT });
    const many = [...Array.from({ length: 50 }, () => make), unread(THIEF_TOKEN)];
    assert.deepEqual(await drained(many, [account(PAYER, SYSTEM, 5n * SOL), held(THIEF_TOKEN, THIEF, 0n)], [account(PAYER, SYSTEM, 5n * SOL - SOL / 2n - 5_000n), held(THIEF_TOKEN, THIEF, 0n, { lamports: RENT + SOL / 2n })]), ['drain']);
});

test('a wrapped SOL payment in words beside an unread program is said: not critical', async () => {
    const [wrapped, theirs] = [key(66), key(67)];
    const wsol = (a: Address, owner: Address, amount: bigint) => held(a, owner, amount, { mint: NATIVE, lamports: RENT + amount, native: RENT });
    const pay = getTransferInstruction({ source: wrapped, destination: theirs, authority: createNoopSigner(PAYER), amount: SOL });
    const touch: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }] };
    assert.deepEqual(await drained([pay, touch], [account(PAYER, SYSTEM, SOL), wsol(wrapped, PAYER, 2n * SOL), wsol(theirs, THIEF, 0n)], [account(PAYER, SYSTEM, SOL - 5_000n), wsol(wrapped, PAYER, SOL), wsol(theirs, THIEF, SOL)]), []);
});

test('a drain split across many wallets is no fee: told as a drain, as one to a single wallet is', async () => {
    const many = Array.from({ length: 21 }, (_, i) => key(80 + i));
    const before = [account(PAYER, SYSTEM, 21n * SOL + 5_000n), ...many.map((w) => account(w, SYSTEM, SOL))];
    const after = [account(PAYER, SYSTEM, 0n), ...many.map((w) => account(w, SYSTEM, 2n * SOL))];
    assert.deepEqual(await drained([unread(...many)], before, after), ['drain']);
    // A twentieth or less of it in all, to several wallets, the rest into a known program's pool: a fee, maybe.
    const POOL_PROGRAM = address('61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH');
    const [pool] = await getProgramDerivedAddress({ programAddress: POOL_PROGRAM, seeds: ['pool'] });
    const two = many.slice(0, 2);
    const deposit = { programAddress: POOL_PROGRAM, accounts: [{ address: PAYER, role: WS }, ...[...two, pool].map((address) => ({ address, role: W }))] };
    const before2 = [account(PAYER, SYSTEM, 40n * SOL), ...two.map((w) => account(w, SYSTEM, SOL)), account(pool, POOL_PROGRAM, SOL, new Uint8Array(8))];
    const after2 = [account(PAYER, SYSTEM, 20n * SOL - 5_000n), ...two.map((w) => account(w, SYSTEM, SOL + SOL / 4n)), account(pool, POOL_PROGRAM, SOL + 20n * SOL - SOL / 2n, new Uint8Array(8))];
    assert.deepEqual(await drained([deposit], before2, after2), ['fee']);
});

test('a token account there already takes no rent: making it again says nothing of SOL put in it', async () => {
    const made = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(PAYER), ata: THIEF_TOKEN, owner: THIEF, mint: MINT });
    const before = [account(PAYER, SYSTEM, 5n * SOL), held(THIEF_TOKEN, THIEF, 0n)];
    const after = [account(PAYER, SYSTEM, 5n * SOL - 10_000_000n - 5_000n), held(THIEF_TOKEN, THIEF, 0n, { lamports: RENT + 10_000_000n })];
    assert.deepEqual(await drained([made, unread(THIEF_TOKEN)], before, after), ['drain']);
});

test('wrapped SOL paid in words from an account made here is said too: not critical', async () => {
    const [wrapped, theirs] = [key(102), key(103)];
    const wsol = (a: Address, owner: Address, amount: bigint) => held(a, owner, amount, { mint: NATIVE, lamports: RENT + amount, native: RENT });
    const pay = getTransferInstruction({ source: wrapped, destination: theirs, authority: createNoopSigner(PAYER), amount: SOL });
    const touch: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }] };
    // The wrapped SOL account is new: made, filled and paid from here.
    const before = [account(PAYER, SYSTEM, 3n * SOL), wsol(theirs, THIEF, 0n)];
    const after = [account(PAYER, SYSTEM, 2n * SOL - RENT - 5_000n), wsol(wrapped, PAYER, 0n), wsol(theirs, THIEF, SOL)];
    assert.deepEqual(await drained([pay, touch], before, after), []);
});

test('a token account made at an address only sent SOL before is made and paid for: said', async () => {
    const made = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(PAYER), ata: THIEF_TOKEN, owner: THIEF, mint: MINT });
    const touch: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(THIEF_TOKEN, SYSTEM, 1_000n)];
    const after = [account(PAYER, SYSTEM, 5n * SOL - RENT + 1_000n - 5_000n), held(THIEF_TOKEN, THIEF, 0n)];
    assert.deepEqual(await drained([made, touch], before, after), []);
});
