import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import {
    AuthorityType,
    getApproveInstruction,
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction,
    getSetAuthorityInstruction,
    getSyncNativeInstruction,
    getTransferCheckedInstruction,
    getTransferInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getProgramDerivedAddress, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import { holds } from '../src/prepare/guard.ts';
import type { Context } from '../src/review/assess.ts';
import { review, type Review } from '../src/review/review.ts';
import { LIGHTHOUSE } from '../src/programs/addresses.ts';
import { account, ATTACKER, EVIL_PROGRAM, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction, USER_TOKEN } from './helpers.ts';

const context: Context = { wallet: PAYER, signedBefore: 0 };
const signer = createNoopSigner(PAYER);
const USDC = 1_000_000n; // a token's units, at 6 decimals
const THEIRS = key(24); // the attacker's token account
const FEE = 5_000n;
const wallet = (lamports: bigint) => account(PAYER, SYSTEM, lamports);
const usdc = (at: Address, owner: Address, amount: bigint) => account(at, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner, amount }));
const mint = account(MINT, TOKEN_PROGRAM_ADDRESS, 1_461_600n, Object.assign(new Uint8Array(82), { 44: 6, 45: 1 }));
const codes = (r: Review) => r.assessment.findings.filter((f) => f.level !== 'ok').map((f) => `${f.level}:${f.code}`);
const drain = (amount: bigint) => getTransferCheckedInstruction({ source: USER_TOKEN, mint: MINT, destination: THEIRS, authority: signer, amount, decimals: 6 });
const reviewed = (ixs: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[]) => review(transaction(ixs), context, fakeChain(before, after));

test('a balance the RPC reads lower than it is, with the drain left out, is critical: the guard would let it go', async () => {
    // The account holds 1,000,000 USDC; the RPC says 100, and that nothing moves. 999,900 go.
    const before = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const after = [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const r = await reviewed([drain(999_900n * USDC)], before, after);
    assert.equal(r.assessment.verdict, 'danger');
    assert.deepEqual(codes(r), ['danger:untold']);
    assert.equal(r.assessment.findings.find((f) => f.code === 'untold')?.subject, USER_TOKEN);
    // Told as it is, it shows what goes, and nothing is untold.
    const told = await reviewed([drain(999_900n * USDC)], [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 999_900n * USDC), mint]);
    assert.ok(!codes(told).includes('danger:untold'));
    assert.ok(codes(told).includes('warn:large-outflow'));
});

test('an account the RPC says is someone else’s is yours when your wallet moves its tokens: shown, and guarded', async () => {
    const [vault] = await getProgramDerivedAddress({ programAddress: EVIL_PROGRAM, seeds: ['vault'] });
    // The RPC names a program's address as its owner, and shows the transfer: the tokens are yours to lose all the same.
    const r = await reviewed([drain(1_000_000n * USDC)], [wallet(5_000_000n), usdc(USER_TOKEN, vault, 1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), usdc(USER_TOKEN, vault, 0n), usdc(THEIRS, ATTACKER, 1_000_000n * USDC), mint]);
    assert.ok(r.assessment.mine.has(USER_TOKEN));
    assert.deepEqual(r.assessment.flows.find((f) => f.asset === MINT)?.change, -1_000_000n * USDC);
    assert.equal(r.assessment.verdict, 'warn'); // you send almost all of one of your tokens
    // Its guard holds the owner the RPC gave: a program's address, where the chain has yours, so it would not land.
    const guard = holds(r.assessment.yours, PAYER).find((h) => h.account === USER_TOKEN);
    assert.deepEqual(guard && guard.kind === 'token' && guard.owner, vault);
    // The RPC says it is someone's, and that nothing moves: untold.
    const hid = await reviewed([drain(1_000_000n * USDC)], [wallet(5_000_000n), usdc(USER_TOKEN, ATTACKER, 1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), usdc(USER_TOKEN, ATTACKER, 1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint]);
    assert.ok(codes(hid).includes('danger:untold'));
    // Or that it is no token account at all.
    const none = await reviewed([drain(1_000_000n * USDC)], [wallet(5_000_000n), account(USER_TOKEN, SYSTEM, 1n), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), account(USER_TOKEN, SYSTEM, 1n), usdc(THEIRS, ATTACKER, 0n), mint]);
    assert.ok(codes(none).includes('danger:untold'));
});

test('SOL your wallet sends, left out of the simulation, is critical; what only pays rent or asserts does not hide it', async () => {
    const send = getTransferSolInstruction({ source: signer, destination: ATTACKER, amount: 99_000_000_000n });
    // An account made beside it, paid by your wallet; a Lighthouse assertion on your wallet; neither brings SOL in.
    const made = getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: THEIRS, owner: ATTACKER, mint: MINT });
    const asserts: Instruction = { programAddress: LIGHTHOUSE, accounts: [{ address: PAYER, role: AccountRole.READONLY }], data: new Uint8Array([6, 0, 0]) };
    const before = [wallet(1_000_000_000n), account(ATTACKER, SYSTEM, 1n), mint];
    const after = [wallet(1_000_000_000n - FEE), account(ATTACKER, SYSTEM, 1n), mint];
    assert.ok(codes(await reviewed([send], before, after)).includes('danger:untold'));
    assert.ok(codes(await reviewed([made, send, asserts], before, [...after, usdc(THEIRS, ATTACKER, 0n)])).includes('danger:untold'));
    // Shown as it is, nothing untold.
    const shown = await reviewed([send], [wallet(100_000_000_000n), account(ATTACKER, SYSTEM, 1n)], [wallet(1_000_000_000n - FEE), account(ATTACKER, SYSTEM, 99_000_000_001n)]);
    assert.ok(!codes(shown).includes('danger:untold'));
});

test('what a program Otus can’t read to the unit could bring into an account is not judged here', async () => {
    // An unknown program given your token account: it could have paid it what the transfer took. Its own warning stands.
    const given: Instruction = { programAddress: EVIL_PROGRAM, accounts: [{ address: USER_TOKEN, role: AccountRole.WRITABLE }] };
    const before = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const after = [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const r = await reviewed([given, drain(50n * USDC)], before, after);
    assert.ok(!codes(r).includes('danger:untold'));
    assert.ok(codes(r).includes('warn:unknown-program'));
    // Wrapped SOL synced: its units count its SOL.
    const WSOL = address('So11111111111111111111111111111111111111112');
    const native = (lamports: bigint, amount: bigint) => account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, lamports, tokenAccountData({ mint: WSOL, owner: PAYER, amount, native: 2_039_280n }));
    const wrap = [getTransferSolInstruction({ source: signer, destination: USER_TOKEN, amount: 1_000_000_000n }), getSyncNativeInstruction({ account: USER_TOKEN })];
    const wrapped = await reviewed(wrap, [wallet(5_000_000_000n), native(2_039_280n, 0n)], [wallet(4_000_000_000n - FEE), native(1_002_039_280n, 1_000_000_000n)]);
    assert.ok(!codes(wrapped).includes('danger:untold'));
    // Moved between two wrapped SOL accounts, its SOL moves with it.
    const other = (lamports: bigint, amount: bigint) => account(THEIRS, TOKEN_PROGRAM_ADDRESS, lamports, tokenAccountData({ mint: WSOL, owner: ATTACKER, amount, native: 2_039_280n }));
    const moved = await reviewed([getTransferInstruction({ source: USER_TOKEN, destination: THEIRS, authority: signer, amount: 500_000_000n })], [wallet(5_000_000n), native(1_002_039_280n, 1_000_000_000n), other(2_039_280n, 0n)], [wallet(5_000_000n - FEE), native(502_039_280n, 500_000_000n), other(502_039_280n, 500_000_000n)]);
    assert.ok(!codes(moved).includes('danger:untold'));
});

test('a simulation that failed shows nothing moving, and is critical on its own: nothing is untold', async () => {
    const before = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const r = await review(transaction([drain(999_900n * USDC)]), context, fakeChain(before, before, { error: { InstructionError: [0, { Custom: 1 }] } }));
    assert.deepEqual(codes(r).filter((c) => c.includes('untold') || c.includes('simulation-failed')), ['danger:simulation-failed']);
});

test('tokens your wallet moves out of someone else’s account as its delegate: theirs, and worth a word', async () => {
    const lent = (amount: bigint) => account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount, delegate: PAYER, delegated: 1_000_000n * USDC }));
    const r = await reviewed([drain(1_000_000n * USDC)], [wallet(5_000_000n), lent(1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), lent(0n), usdc(THEIRS, ATTACKER, 1_000_000n * USDC), mint]);
    assert.ok(!r.assessment.mine.has(USER_TOKEN));
    assert.deepEqual(codes(r), ['warn:spends-allowance']);
    // The RPC saying it is someone's, and not the wallet's to move at all: then only its owner could, and it is yours.
    const theirs = await reviewed([drain(1_000_000n * USDC)], [wallet(5_000_000n), usdc(USER_TOKEN, ATTACKER, 1_000_000n * USDC), usdc(THEIRS, ATTACKER, 0n), mint], [wallet(5_000_000n - FEE), usdc(USER_TOKEN, ATTACKER, 0n), usdc(THEIRS, ATTACKER, 1_000_000n * USDC), mint]);
    assert.ok(theirs.assessment.mine.has(USER_TOKEN));
});

test('what an instruction leaves an account as must show: closed, its allowance, its new owner; and it must have been there', async () => {
    const WSOL = address('So11111111111111111111111111111111111111112');
    const native = (lamports: bigint, amount: bigint, owner: Address = PAYER, at: Address = USER_TOKEN) => account(at, TOKEN_PROGRAM_ADDRESS, lamports, tokenAccountData({ mint: WSOL, owner, amount, native: 2_039_280n }));
    const funded = [wallet(5_000_000n), native(100_002_039_280n, 100_000_000_000n), account(ATTACKER, SYSTEM, 1n)];

    // An idempotent create naming your token account, there already, does not take it out of the check.
    const ata = getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: USER_TOKEN, owner: PAYER, mint: MINT });
    const before = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    const hidden = [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 0n), mint];
    assert.ok(codes(await reviewed([ata, drain(99n * USDC)], before, hidden)).includes('danger:untold'));

    // Wrapped SOL synced, then sent: its units can't have come from nowhere.
    const sync = getSyncNativeInstruction({ account: USER_TOKEN });
    const out = getTransferInstruction({ source: USER_TOKEN, destination: THEIRS, authority: signer, amount: 99_000_000_000n });
    const theirs = account(THEIRS, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: WSOL, owner: ATTACKER, amount: 0n, native: 2_039_280n }));
    assert.ok(codes(await reviewed([sync, out], [...funded, theirs], [wallet(5_000_000n - FEE), native(100_002_039_280n, 100_000_000_000n), account(ATTACKER, SYSTEM, 1n), theirs])).includes('danger:untold'));

    // Closed to someone else: shown still there, untold; shown closed, told.
    const close = getCloseAccountInstruction({ account: USER_TOKEN, destination: ATTACKER, owner: signer });
    assert.ok(codes(await reviewed([close], funded, [wallet(5_000_000n - FEE), native(100_002_039_280n, 100_000_000_000n), account(ATTACKER, SYSTEM, 1n)])).includes('danger:untold'));
    const closed = await review(transaction([close]), context, fakeChain(funded, [wallet(5_000_000n - FEE), { exists: false, address: USER_TOKEN }, account(ATTACKER, SYSTEM, 100_002_039_281n)]));
    assert.ok(!codes(closed).includes('danger:untold'));
    // Closed though the RPC says it never was: untold. Made and closed in the same transaction: told.
    assert.ok(codes(await reviewed([close], [wallet(5_000_000n), account(ATTACKER, SYSTEM, 1n)], [wallet(5_000_000n - FEE), account(ATTACKER, SYSTEM, 1n)])).includes('danger:untold'));
    const wrapAndClose = [getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: USER_TOKEN, owner: PAYER, mint: WSOL }), getCloseAccountInstruction({ account: USER_TOKEN, destination: PAYER, owner: signer })];
    assert.ok(!codes(await reviewed(wrapAndClose, [wallet(5_000_000n)], [wallet(5_000_000n - FEE)])).includes('danger:untold'));

    // An allowance without end, or a new owner, left out of the simulation: untold.
    const approve = getApproveInstruction({ source: USER_TOKEN, delegate: ATTACKER, owner: signer, amount: 2n ** 64n - 1n });
    const usdcBefore = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), mint];
    const asBefore = [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), mint];
    assert.ok(codes(await reviewed([approve], usdcBefore, asBefore)).includes('danger:untold'));
    const allowed = account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 100n * USDC, delegate: ATTACKER, delegated: 2n ** 64n - 1n }));
    const told = await reviewed([approve], usdcBefore, [wallet(5_000_000n - FEE), allowed, mint]);
    assert.deepEqual(codes(told).filter((c) => c.endsWith('untold') || c.endsWith(':delegate')), ['danger:delegate']);
    const owner = getSetAuthorityInstruction({ owned: USER_TOKEN, owner: signer, authorityType: AuthorityType.AccountOwner, newAuthority: ATTACKER });
    assert.ok(codes(await reviewed([owner], usdcBefore, asBefore)).includes('danger:untold'));
});

test('an account only paid may grow by others meanwhile: busy tip and merchant accounts read as told', async () => {
    const tip = key(60);
    const send = getTransferSolInstruction({ source: signer, destination: tip, amount: 10_000n });
    // Others tipped the same account between the read and the simulation: it grew by more than this sends.
    const r = await reviewed([send], [wallet(5_000_000n), account(tip, SYSTEM, 1_000_000_000n)], [wallet(5_000_000n - 10_000n - FEE), account(tip, SYSTEM, 1_000_500_000n)]);
    assert.ok(!codes(r).includes('danger:untold'));
    const pay = await reviewed([drain(10n * USDC)], [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), usdc(THEIRS, ATTACKER, 7_000n * USDC), mint], [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 90n * USDC), usdc(THEIRS, ATTACKER, 7_500n * USDC), mint]);
    assert.ok(!codes(pay).includes('danger:untold'));
});

test('an assertion or an associated account made where one is already, after what an instruction leaves, hides nothing', async () => {
    const approve = getApproveInstruction({ source: USER_TOKEN, delegate: ATTACKER, owner: signer, amount: 2n ** 64n - 1n });
    const asserts: Instruction = { programAddress: LIGHTHOUSE, accounts: [{ address: USER_TOKEN, role: AccountRole.READONLY }], data: new Uint8Array([10, 0, 0]) };
    const again = getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: USER_TOKEN, owner: PAYER, mint: MINT });
    const before = [wallet(5_000_000n), usdc(USER_TOKEN, PAYER, 100n * USDC), mint];
    const asBefore = [wallet(5_000_000n - FEE), usdc(USER_TOKEN, PAYER, 100n * USDC), mint];
    for (const after of [asserts, again]) assert.ok(codes(await reviewed([approve, after], before, asBefore)).includes('danger:untold'));
});

test('a Token-2022 mint’s close authority given away is not read as a token account’s', async () => {
    const mint22 = account(MINT, address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), 2_000_000n, Object.assign(new Uint8Array(200), { 44: 6, 45: 1, 165: 1 }));
    const give: Instruction = getSetAuthorityInstruction({ owned: MINT, owner: signer, authorityType: AuthorityType.CloseAccount, newAuthority: ATTACKER }, { programAddress: address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') });
    const r = await reviewed([give], [wallet(5_000_000n), mint22], [wallet(5_000_000n - FEE), mint22]);
    assert.ok(!codes(r).includes('danger:untold'));
});
