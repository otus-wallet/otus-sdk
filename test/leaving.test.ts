import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getCreateAccountWithSeedInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
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
        .map((f) => `${f.level}:${f.code}`);
const tokens = (a: Address, owner: Address, amount: bigint, mint = MINT) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint, owner, amount }));

test('a program Otus doesn’t know taking your tokens into its own vault: a warning, critical when it takes nearly all', async () => {
    const [vaultOwner] = await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['vault'] }); // no key holds it
    const sweep = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: USER_TOKEN, role: W }, { address: VAULT, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), tokens(USER_TOKEN, PAYER, 1000n), tokens(VAULT, vaultOwner, 0n)];
    const after = (left: bigint) => [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, left), tokens(VAULT, vaultOwner, 1000n - left)];
    assert.deepEqual(await problems(sweep, before, after(200n)), ['warn:sends-to-wallet']);
    assert.deepEqual(await problems(sweep, before, after(0n)), ['danger:sends-to-wallet']);
});

test('your SOL into an account a program Otus doesn’t know keeps: the same', async () => {
    const take = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: POCKET, role: W }] };
    const before = [account(PAYER, SYSTEM, 5n * SOL), account(POCKET, EVIL, SOL, new Uint8Array(8))];
    assert.deepEqual(await problems(take, before, [account(PAYER, SYSTEM, 3n * SOL), account(POCKET, EVIL, 3n * SOL, new Uint8Array(8))]), ['warn:sends-to-wallet']);
    assert.deepEqual(await problems(take, before, [account(PAYER, SYSTEM, SOL / 100n), account(POCKET, EVIL, 6n * SOL - SOL / 100n, new Uint8Array(8))]), ['danger:sends-to-wallet']);
});

test('your assets to a wallet with nothing back: critical, by a program known or not, unless a small share', async () => {
    const pay = (program: Address) => ({ programAddress: program, accounts: [{ address: PAYER, role: WS }, { address: USER_TOKEN, role: W }, { address: THIEF_TOKEN, role: W }] });
    const before = [account(PAYER, SYSTEM, 5n * SOL), tokens(USER_TOKEN, PAYER, 1000n), tokens(THIEF_TOKEN, THIEF, 0n)];
    const after = (sent: bigint) => [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, 1000n - sent), tokens(THIEF_TOKEN, THIEF, sent)];
    assert.deepEqual(await problems(pay(EVIL), before, after(800n)), ['danger:sends-to-wallet']);
    assert.deepEqual(await problems(pay(ORDER_ENGINE), before, after(800n)), ['danger:sends-to-wallet']); // known, nothing back
    // Most of it into a pool's vault, a twentieth or less to a wallet: a fee, maybe.
    const [pool] = await getProgramDerivedAddress({ programAddress: ORDER_ENGINE, seeds: ['pool'] });
    const split = { ...pay(ORDER_ENGINE), accounts: [...pay(ORDER_ENGINE).accounts, { address: VAULT, role: W }] };
    const fee = await problems(split, [...before, tokens(VAULT, pool, 0n)], [account(PAYER, SYSTEM, 5n * SOL - 5000n), tokens(USER_TOKEN, PAYER, 200n), tokens(THIEF_TOKEN, THIEF, 30n), tokens(VAULT, pool, 770n)]);
    assert.deepEqual(fee, ['warn:sends-to-wallet']);
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
    const level = (r: Awaited<ReturnType<typeof review>>) => r.assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => f.level);
    assert.deepEqual([level(sol), level(swept)], [['danger'], ['danger']]);
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
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'sends-to-wallet').map((f) => f.level), ['danger']);
});
