import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress, getI64Encoder, getU32Encoder, getU64Encoder, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import { review } from '../src/review/review.ts';
import { account, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const SOL = 1_000_000_000n;
const STAKE = address('Stake11111111111111111111111111111111111111');
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
const EVIL = key(22);
const STAKED = key(43);
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const context = { wallet: PAYER, signedBefore: 0, host: 'app.example.com' };
const { WRITABLE: W, READONLY_SIGNER: RS, WRITABLE_SIGNER: WS } = AccountRole;
// A plain System transfer of 4 SOL from you to this account.
const getTransferSolInstructionTo = (to: Address): Instruction => ({ programAddress: SYSTEM, accounts: [{ address: PAYER, role: WS }, { address: to, role: W }], data: new Uint8Array([2, 0, 0, 0, ...getU64Encoder().encode(4n * SOL)]) });

// A delegated stake account's data: staker and withdrawer, and a lockup (a time, an epoch, its custodian).
function staked(withdrawer: Address, lockup: { time?: bigint; epoch?: bigint; custodian?: Address } = {}, staker = withdrawer): Uint8Array {
    const d = new Uint8Array(200);
    d.set(getU32Encoder().encode(2));
    d.set(getU64Encoder().encode(2_282_880n), 4); // its rent reserve, as the Stake program sets it
    d.set(getAddressEncoder().encode(staker), 12);
    d.set(getAddressEncoder().encode(withdrawer), 44);
    d.set(getI64Encoder().encode(lockup.time ?? 0n), 76);
    d.set(getU64Encoder().encode(lockup.epoch ?? 0n), 84);
    d.set(getAddressEncoder().encode(lockup.custodian ?? SYSTEM), 92);
    return d;
}
const stakeAccount = (data: Uint8Array, lamports = 10n * SOL) => account(STAKED, STAKE, lamports, data);
const findings = async (ix: Instruction, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], codes: string[]) =>
    (await review(transaction([ix]), context, fakeChain(before, after))).assessment.findings.filter((f) => codes.includes(f.code)).map((f) => `${f.level}:${f.code}${f.note ? ` ${f.note}` : ''}`);

test('your stake under a lockup someone else keeps, new or changed, is critical; one you keep, or as it was, is not', async () => {
    const setLockup: Instruction = { programAddress: STAKE, accounts: [{ address: STAKED, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 0, 0, 0]) };
    const wallet = account(PAYER, SYSTEM, SOL);
    const locked = (before: Uint8Array, after: Uint8Array) => findings(setLockup, [wallet, stakeAccount(before)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(after)], ['stake-lockup']);
    const FUTURE = 2_000_000_000n; // 2033
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { time: FUTURE, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { epoch: 2000n })), ["danger:stake-lockup No one can lift it: you can't withdraw until it ends"]);
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { time: FUTURE, custodian: PAYER })), []);
    // Its custodian already someone else's, the lockup run out: made longer, it holds your stake again.
    assert.deepEqual(await locked(staked(PAYER, { time: 1n, custodian: THIEF }), staked(PAYER, { time: FUTURE, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await locked(staked(PAYER, { time: FUTURE, custodian: THIEF }), staked(PAYER, { time: FUTURE, custodian: THIEF })), []);
    // Someone else's stake is theirs to lock.
    assert.deepEqual(await locked(staked(THIEF), staked(THIEF, { time: FUTURE, custodian: EVIL })), []);
    // A new stake account of yours, made under someone else's lockup.
    const made = await findings(setLockup, [wallet], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(staked(PAYER, { time: FUTURE, custodian: THIEF }))], ['stake-lockup']);
    assert.deepEqual(made, [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
});

test('a stake account is whoever can withdraw it: your SOL into a thief’s goes to a wallet; into yours goes nowhere', async () => {
    const deposit: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: STAKED, role: W }] };
    const into = (data: Uint8Array) =>
        findings(deposit, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)], ['sends-to-wallet', 'check-balances']);
    assert.deepEqual(await into(staked(THIEF)), ['warn:sends-to-wallet Through an unknown program, which Otus cannot read']);
    assert.deepEqual(await into(staked(PAYER)), []);
    // Yours, though someone else's lockup holds it: still not someone else's.
    assert.deepEqual(await into(staked(PAYER, { time: 2_000_000_000n, custodian: THIEF })), []);
});

test('your SOL into stake someone else keeps locked, made for you beforehand, is critical; a lockup run out is none', async () => {
    const deposit = getTransferSolInstructionTo(STAKED);
    const into = (data: Uint8Array) =>
        findings(deposit, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)], ['stake-lockup']);
    assert.deepEqual(await into(staked(PAYER, { time: 2_000_000_000n, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await into(staked(PAYER, { time: 1_600_000_000n, custodian: THIEF })), []); // ran out in 2020
    assert.deepEqual(await into(staked(PAYER)), []);
});

test('your SOL into a stake another key withdraws is critical, whatever the site calls it; a program’s address is said; one you withdraw is not', async () => {
    const send = getTransferSolInstructionTo(STAKED);
    const codes = ['stake-withdrawer', 'stake-staker', 'no-authority-change'];
    // A new stake account, made with 1 SOL of yours (and its rent) and given to someone else to withdraw.
    const made = (data: Uint8Array) => findings(send, [account(PAYER, SYSTEM, 5n * SOL)], [account(PAYER, SYSTEM, 4n * SOL - 5000n), stakeAccount(data, SOL)], codes);
    assert.deepEqual(await made(staked(THIEF)), [`danger:stake-withdrawer ${THIEF} can take the SOL out`]);
    assert.deepEqual(await made(staked(THIEF, {}, PAYER)), [`danger:stake-withdrawer ${THIEF} can take the SOL out`]); // you its staker: still theirs
    assert.deepEqual(await made(staked(PAYER)), ['ok:no-authority-change Owners and authorities stay as they are']);
    // Yours to withdraw, someone else its staker: they can unstake it, not take it.
    assert.deepEqual(await made(staked(PAYER, {}, THIEF)), [`warn:stake-staker ${THIEF} can unstake it or change its validator`]);
    // Topped up the same way: an existing one of theirs, or of yours someone else manages.
    const topped = (data: Uint8Array) => findings(send, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)], codes);
    assert.deepEqual(await topped(staked(THIEF)), [`danger:stake-withdrawer ${THIEF} can take the SOL out`]);
    assert.deepEqual(await topped(staked(PAYER, {}, THIEF)), [`warn:stake-staker ${THIEF} can unstake it or change its validator`]);
    // A stake pool's reserve, proven: the pool's own account names it its reserve, and the pool's token comes to you,
    // whoever routes the deposit. Without that pool account, or with its token going elsewhere, it is critical.
    const [pool] = await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['withdraw'] });
    const SPOOL = address('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
    const [POOL, LST, MY_LST, THEIR_LST] = [key(64), key(65), key(66), key(67)];
    const poolData = new Uint8Array(611);
    poolData[0] = 1;
    poolData.set(getAddressEncoder().encode(STAKED), 130);
    poolData.set(getAddressEncoder().encode(LST), 162);
    const lst = (at: Address, owner: Address, amount: bigint) => account(at, TOKEN, 2_039_280n, tokenAccountData({ mint: LST, owner, amount }));
    const through = (program: Address): Instruction => ({ programAddress: program, accounts: [{ address: PAYER, role: WS }, { address: STAKED, role: W }, { address: POOL, role: W }, { address: MY_LST, role: W }, { address: THEIR_LST, role: W }], data: new Uint8Array([14]) });
    const deposited = (program: Address, o: { proven?: boolean; toMe?: boolean } = {}) =>
        findings(
            through(program),
            [account(PAYER, SYSTEM, 5n * SOL), ...(o.proven === false ? [] : [account(POOL, SPOOL, SOL, poolData)]), lst(MY_LST, PAYER, 0n), lst(THEIR_LST, THIEF, 0n)],
            [account(PAYER, SYSTEM, 4n * SOL - 5000n), stakeAccount(staked(pool), SOL), ...(o.proven === false ? [] : [account(POOL, SPOOL, SOL, poolData)]), lst(MY_LST, PAYER, o.toMe === false ? 0n : 900n), lst(THEIR_LST, THIEF, o.toMe === false ? 900n : 0n)],
            codes,
        );
    // An address no key holds, a pool's or any program's: said, to check what comes back, never critical.
    const told = [`warn:stake-withdrawer ${pool}, an address no key holds: check what you get back`];
    assert.deepEqual(await deposited(SPOOL), told);
    assert.deepEqual(await deposited(address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')), told); // routed by an aggregator
    assert.deepEqual(await deposited(SPOOL, { toMe: false }), told);
    assert.deepEqual(await deposited(EVIL, { proven: false }), told);
    assert.deepEqual(await made(staked(pool)), [`warn:stake-withdrawer ${pool}, an address no key holds: check what you get back`]);
});

test('SOL into someone else\'s stake that is not from you, as you only pay the fee, is not called yours', async () => {
    const touch: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: STAKED, role: W }] };
    const moved = await findings(touch, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(staked(THIEF), SOL)], [account(PAYER, SYSTEM, 5n * SOL - 5000n), stakeAccount(staked(THIEF), 3n * SOL)], ['stake-withdrawer']);
    assert.deepEqual(moved, []);
});

test('what goes to another of your wallets stays yours: said, never critical', async () => {
    const MINE = key(60); // another wallet of yours Otus signs for
    const ours = { ...context, wallets: [PAYER, MINE, key(62)], signers: [PAYER, MINE] }; // key(62): only watched
    const authorize: Instruction = { programAddress: STAKE, accounts: [{ address: STAKED, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([1, 0, 0, 0]) };
    const wallet = account(PAYER, SYSTEM, SOL);
    const moved = async (to: Address) =>
        (await review(transaction([authorize]), ours, fakeChain([wallet, stakeAccount(staked(PAYER, {}, THIEF))], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(staked(to, {}, THIEF))]))).assessment.findings
            .filter((f) => f.code === 'authority-change')
            .map((f) => `${f.level}:${f.text}`);
    assert.deepEqual(await moved(MINE), ['warn:Your withdraw authority goes to another of your wallets']);
    assert.deepEqual(await moved(THIEF), ['danger:You would lose your withdraw authority']); // someone's key
    assert.deepEqual(await moved((await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['deposit'] }))[0]), ["warn:Your withdraw authority goes to a program's address"]); // a program's address: said, to check
});

test('a stake split from one of yours under the same lockup is as locked as it was; a free stake of yours newly locked is critical', async () => {
    const split: Instruction = { programAddress: STAKE, accounts: [{ address: STAKED, role: W }, { address: key(61), role: W }, { address: PAYER, role: RS }], data: new Uint8Array([3, 0, 0, 0]) };
    const lockup = { time: 2_000_000_000n, custodian: THIEF };
    const RENT = 2_282_880n;
    // The new account's rent from your wallet, the rest moved from the locked stake.
    const before = [account(PAYER, SYSTEM, SOL), stakeAccount(staked(PAYER, lockup))];
    const after = [account(PAYER, SYSTEM, SOL - RENT - 5000n), stakeAccount(staked(PAYER, lockup), 6n * SOL), account(key(61), STAKE, 4n * SOL + RENT, staked(PAYER, lockup))];
    assert.deepEqual(await findings(split, before, after, ['stake-lockup']), []);
    // Your free stake put under that lockup, beside a stake made for you under it that shrinks: newly locked.
    const setLockup: Instruction = { programAddress: STAKE, accounts: [{ address: STAKED, role: W }, { address: key(61), role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 0, 0, 0]) };
    const tricked = await findings(setLockup, [account(PAYER, SYSTEM, SOL), stakeAccount(staked(PAYER), 500n * SOL), account(key(61), STAKE, SOL, staked(PAYER, lockup))], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(staked(PAYER, lockup), 500n * SOL), account(key(61), STAKE, SOL / 2n, staked(PAYER, lockup))], ['stake-lockup']);
    assert.deepEqual(tricked.map((f) => f.split(' ')[0]), ['danger:stake-lockup']);
});

test('a token account given to you is yours now: nothing lost, nothing critical', async () => {
    const { TOKEN_PROGRAM_ADDRESS, getSetAuthorityInstruction, AuthorityType } = await import('@solana-program/token');
    const { createNoopSigner } = await import('@solana/kit');
    const GIVEN = key(63);
    const giver = key(64);
    const give = getSetAuthorityInstruction({ owned: GIVEN, owner: createNoopSigner(giver), authorityType: AuthorityType.AccountOwner, newAuthority: PAYER });
    const held = (owner: Address) => account(GIVEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner, amount: 5n }));
    const r = await review(transaction([give]), context, fakeChain([account(PAYER, SYSTEM, SOL), held(giver)], [account(PAYER, SYSTEM, SOL - 10_000n), held(PAYER)]));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'token-owner-change'), []);
    assert.notEqual(r.assessment.verdict, 'danger');
});

// A program that runs what its members decided vouches for no account: what it carries is as any other's.
const SQUADS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const R = AccountRole.READONLY;
const exec = (target: Address, program: Address): Instruction => ({ programAddress: SQUADS, accounts: [{ address: key(70), role: R }, { address: key(71), role: W }, { address: key(72), role: R }, { address: PAYER, role: WS }, { address: target, role: W }, { address: program, role: R }], data: new Uint8Array([0xc2, 0x08, 0xa1, 0x57, 0x99, 0xa4, 0x19, 0xab]) });

test('R1 your 50 SOL into a new stake an attacker PDA withdraws, carried by Squads v4 execute', async () => {
    const [pda] = await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['vault'] });
    const S = key(43);
    const r = await review(transaction([exec(S, STAKE)]), { ...context, now: 1_800_000_000 }, fakeChain([account(PAYER, SYSTEM, 60n * SOL)], [account(PAYER, SYSTEM, 10n * SOL - 5000n), account(S, STAKE, 50n * SOL, staked(pda, {}, pda))]));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'stake-withdrawer').map((f) => f.level), ['warn']); // a program's address: said, to check
});
test('R2 unlimited delegate on your token account to an attacker PDA, carried by Squads v4 execute', async () => {
    const [pda] = await getProgramDerivedAddress({ programAddress: EVIL, seeds: ['vault'] });
    const TA = key(45);
    const r = await review(transaction([exec(TA, TOKEN)]), { ...context, now: 1_800_000_000 }, fakeChain([account(PAYER, SYSTEM, SOL), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000_000n }))], [account(PAYER, SYSTEM, SOL - 5000n), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000_000n, delegate: pda, delegated: 2n ** 64n - 1n }))]));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'delegate').map((f) => f.level), ['warn']); // a program's address: said, to check
});

test('your SOL into a stake another of your wallets withdraws is a warning, unless someone else’s lockup holds it', async () => {
    const MINE = key(68);
    const send = getTransferSolInstructionTo(STAKED);
    const into = async (data: Uint8Array) =>
        (await review(transaction([send]), { ...context, signers: [PAYER, MINE] }, fakeChain([account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)]))).assessment.findings
            .filter((f) => f.code === 'stake-withdrawer' || f.code === 'stake-lockup')
            .map((f) => f.level);
    assert.deepEqual(await into(staked(MINE)), ['warn']);
    assert.deepEqual(await into(staked(MINE, { time: 2_000_000_000n, custodian: THIEF })), ['danger']);
});
