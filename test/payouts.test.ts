import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, isAddress, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import type { Simulation } from '../src/chain.ts';
import type { Context } from '../src/review/assess.ts';
import { alike } from '../src/format.ts';
import { review } from '../src/review/review.ts';
import { account, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const MARGINFI = address('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
const [VAULT, DEST, YOURS] = [key(40), key(41), key(43)];
const SOL = 1_000_000_000n;
const USDC = 1_000_000n; // a token of 6 decimals
const { WRITABLE: W, WRITABLE_SIGNER: WS } = AccountRole;
const tokens = (a: Address, owner: Address, amount: bigint) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner, amount }));
const vaultOwner = async () => (await getProgramDerivedAddress({ programAddress: MARGINFI, seeds: ['vault'] }))[0]; // no key holds it

// What Otus says of a transaction you sign: what lands with someone else, and in what words.
async function said(ixs: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], context: Partial<Context> = {}) {
    const r = await review(transaction(ixs), { wallet: PAYER, signedBefore: 0, host: 'app.example.com', ...context }, fakeChain(before, after));
    return { payouts: r.assessment.payouts, findings: r.assessment.findings.filter((f) => f.code.startsWith('pays-')).map((f) => `${f.level}:${f.text}`) };
}

// A withdraw of 1,000 out of a lending pool's vault, signed by you, landing in a token account `to` holds.
async function withdraw(to: Address, context: Partial<Context> = {}) {
    const authority = await vaultOwner();
    const ix: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: DEST, role: W }] };
    const before = [account(PAYER, SYSTEM, SOL), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, to, 0n)];
    const after = [account(PAYER, SYSTEM, SOL - 5000n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, to, 1_000n * USDC)];
    return said([ix], before, after, context);
}

test('funds out of a program’s custody to someone else’s wallet are said exactly, for you to judge; to yours, nothing', async () => {
    const thief = await withdraw(THIEF);
    assert.deepEqual(thief.findings, ['warn:Funds go to someone else, not to you']);
    assert.deepEqual(thief.payouts, [{ holder: THIEF, known: null, program: false, amounts: [{ asset: MINT, amount: 1_000n * USDC }], programs: [MARGINFI] }]);
    assert.deepEqual((await withdraw(PAYER)).findings, []); // a token account of yours, an ATA or not
    assert.deepEqual((await withdraw(THIEF, { wallets: [THIEF], signers: [THIEF] })).findings, []); // another of your wallets Otus signs for
    assert.deepEqual((await withdraw(THIEF, { wallets: [THIEF] })).findings, ['warn:Funds go to someone else, not to you']); // one you only watch could be anyone's
    assert.deepEqual((await withdraw(THIEF, { contacts: new Map([[THIEF, 'Ana']]) })).findings, ['notice:Funds go to Ana']); // one you keep
});

test('a pool’s fee while you get the trade, a payment of yours, and rent given back are no payouts; a drain behind a payment is', async () => {
    const [pool] = await getProgramDerivedAddress({ programAddress: key(70), seeds: ['pool'] }); // its SOL, and its tokens' owner
    const fees = (await generateKeyPairSigner()).address; // the pool's fee wallet: a key someone holds
    // You sell 100 tokens into the pool: it pays you 0.98 SOL, and its fee wallet 0.02.
    const sell: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: VAULT, role: W }, { address: pool, role: W }, { address: fees, role: W }] };
    const sold = await said(
        [sell],
        [account(PAYER, SYSTEM, SOL), tokens(YOURS, PAYER, 100n * USDC), tokens(VAULT, pool, 0n), account(pool, SYSTEM, 10n * SOL), account(fees, SYSTEM, SOL)],
        [account(PAYER, SYSTEM, SOL + (98n * SOL) / 100n - 5000n), tokens(YOURS, PAYER, 0n), tokens(VAULT, pool, 100n * USDC), account(pool, SYSTEM, 9n * SOL), account(fees, SYSTEM, SOL + (2n * SOL) / 100n)],
    );
    assert.deepEqual(sold.findings, []);
    // You pay 1 SOL: your own payment, which the balances say.
    const pay = getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: THIEF, amount: SOL });
    assert.deepEqual((await said([pay], [account(PAYER, SYSTEM, 2n * SOL), account(THIEF, SYSTEM, 0n)], [account(PAYER, SYSTEM, SOL - 5000n), account(THIEF, SYSTEM, SOL)])).findings, []);
    // A program's account closed, its rent back to whoever paid it.
    const close: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: THIEF, role: W }] };
    assert.deepEqual((await said([close], [account(PAYER, SYSTEM, SOL), account(VAULT, key(70), 2_039_280n, new Uint8Array(8)), account(THIEF, SYSTEM, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), account(THIEF, SYSTEM, SOL + 2_039_280n)])).findings, []);
    // You pay the thief 10, and the vault pays it 1,000 more: those 1,000 are said.
    const authority = await vaultOwner();
    const both: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: VAULT, role: W }, { address: DEST, role: W }] };
    const hidden = await said(
        [both],
        [account(PAYER, SYSTEM, SOL), tokens(YOURS, PAYER, 10n * USDC), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, THIEF, 0n)],
        [account(PAYER, SYSTEM, SOL - 5000n), tokens(YOURS, PAYER, 0n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, THIEF, 1_010n * USDC)],
    );
    assert.deepEqual(hidden.payouts.map((p) => [p.holder, p.amounts[0].amount]), [[THIEF, 1_000n * USDC]]);
});

test('out of a program’s custody to an account no key holds, with nothing back to you: your position or what you buy goes elsewhere; a deposit does not', async () => {
    const [nobody] = await getProgramDerivedAddress({ programAddress: key(71), seeds: ['vault'] }); // a program's address: no key holds it
    assert.deepEqual((await withdraw(nobody)).findings, ["warn:Funds go to a program's account, not to you"]);
    // A unit of something sent back to you hides nothing.
    const authority = await vaultOwner();
    const mine = (amount: bigint) => account(YOURS, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: key(44), owner: PAYER, amount }));
    const out: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: DEST, role: W }, { address: YOURS, role: W }] };
    const dust = await said(
        [out],
        [account(PAYER, SYSTEM, SOL), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, nobody, 0n), mine(0n)],
        [account(PAYER, SYSTEM, SOL - 5000n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, nobody, 1_000n * USDC), mine(1n)],
    );
    assert.deepEqual(dust.findings, ["warn:Funds go to a program's account, not to you"]);

    // A swap through Jupiter: 100 of yours into the pool, and the 5 it buys to an account of that program's.
    const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    const [pool] = await getProgramDerivedAddress({ programAddress: key(70), seeds: ['pool'] });
    const OTHER = key(44); // the token bought
    const held = (a: Address, mint: Address, owner: Address, amount: bigint) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint, owner, amount }));
    const [poolIn, poolOut, theirs] = [key(45), key(46), key(47)];
    const swap: Instruction = { programAddress: JUPITER, accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: poolIn, role: W }, { address: poolOut, role: W }, { address: theirs, role: W }] };
    const before = [account(PAYER, SYSTEM, SOL), held(YOURS, MINT, PAYER, 100n * USDC), held(poolIn, MINT, pool, 0n), held(poolOut, OTHER, pool, 50n), held(theirs, OTHER, nobody, 0n)];
    const after = [account(PAYER, SYSTEM, SOL - 5000n), held(YOURS, MINT, PAYER, 0n), held(poolIn, MINT, pool, 100n * USDC), held(poolOut, OTHER, pool, 45n), held(theirs, OTHER, nobody, 5n)];
    const bought = await said([swap], before, after);
    assert.deepEqual(bought.findings, ["warn:Funds go to a program's account, not to you"]);
    assert.deepEqual(bought.payouts, [{ holder: nobody, known: null, program: true, amounts: [{ asset: OTHER, amount: 5n }], programs: [JUPITER] }]);

    // A deposit: your 100 into the pool, and its receipt minted to another account of the pool's: nothing leaves anyone.
    const receipt = key(48);
    const deposit = await said([{ ...swap, accounts: [...swap.accounts!.slice(0, 3), { address: receipt, role: W }] }], [...before.slice(0, 3), held(receipt, OTHER, pool, 0n)], [...after.slice(0, 3), held(receipt, OTHER, pool, 100n)]);
    assert.deepEqual(deposit.findings, []);
});

test('your funds, or a say over them, going to an address only like one you keep, one of your wallets or one you sent to: critical', async () => {
    const like = (a: string, from = 80) => Array.from({ length: 60 }, (_, i) => `${a.slice(0, 5)}${key(from + i).slice(5, -5)}${a.slice(-5)}`).find((x) => x !== a && isAddress(x)) as Address;
    const copy = like(THIEF);
    const lookalikes = async (ixs: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], context: Partial<Context>, simulation?: Partial<Simulation>) => {
        const r = await review(transaction(ixs), { wallet: PAYER, signedBefore: 0, host: 'app.example.com', ...context }, fakeChain(before, after, simulation));
        return r.assessment.findings.filter((f) => f.code === 'lookalike-address').map((f) => `${f.level}:${f.text}:${f.note}`);
    };
    const pay = (to: Address): [Instruction[], MaybeEncodedAccount[], MaybeEncodedAccount[]] => [[getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: to, amount: SOL })], [account(PAYER, SYSTEM, 2n * SOL), account(to, SYSTEM, 0n)], [account(PAYER, SYSTEM, SOL - 5000n), account(to, SYSTEM, SOL)]];
    const ana = { contacts: new Map([[THIEF, 'Ana']]) };
    const anas = [`danger:This address looks like Ana's:${copy} is not Ana's`];
    assert.deepEqual(await lookalikes(...pay(copy), ana), anas); // your SOL, to a copy of Ana's
    assert.deepEqual(await lookalikes(...pay(THIEF), ana), []); // to Ana's own
    assert.deepEqual(await lookalikes(...pay(copy), {}), []); // like no address you keep
    assert.deepEqual(await lookalikes(...pay(copy), { wallets: [THIEF] }), [`danger:This address looks like one of your wallets:${copy} is not one of them`]);
    assert.deepEqual(await lookalikes(...pay(copy), { sent: [THIEF] }), [`danger:This address looks like one you sent to:${copy} is not the one you sent to`]);
    assert.deepEqual(await lookalikes(...pay(THIEF), { sent: [THIEF] }), []); // the one you sent to itself
    assert.deepEqual(await lookalikes(...pay(copy), { ...ana, wallets: [THIEF] }), anas); // a contact, by your name for it, before "one of your wallets"
    assert.deepEqual(await lookalikes(...pay(like(PAYER)), {}), [`danger:This address looks like one of your wallets:${like(PAYER)} is not one of them`]); // a copy of the wallet in use
    assert.deepEqual(await lookalikes(...pay(copy), { wallets: [THIEF, copy] }), []); // two of your own, alike each other
    // Your name for it, without what moves or hides letters, kept short; none left, "a contact".
    assert.deepEqual(await lookalikes(...pay(copy), { contacts: new Map([[THIEF, 'A\u202ena\u0000']]) }), anas);
    assert.deepEqual(await lookalikes(...pay(copy), { contacts: new Map([[THIEF, '\u202e']]) }), [`danger:This address looks like a contact's:${copy} is not a contact's`]);
    assert.match((await lookalikes(...pay(copy), { contacts: new Map([[THIEF, 'x'.repeat(50)]]) }))[0], /looks like x{31}…'s/);
    // A simulation that fails shows no balances: the transfer's own words still name where it goes.
    const [ixs, before] = pay(copy);
    assert.deepEqual(await lookalikes(ixs, before, before, ana, { error: { InstructionError: [0, { Custom: 1 }] } }), anas);
    // Funds out of a program's custody, to a copy of Ana's: the same.
    assert.deepEqual((await withdraw(copy, ana)).findings, ['warn:Funds go to someone else, not to you']);
    const authority = await vaultOwner();
    const out = await review(transaction([{ programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: DEST, role: W }] }]), { wallet: PAYER, signedBefore: 0, host: 'app.example.com', ...ana }, fakeChain([account(PAYER, SYSTEM, SOL), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, copy, 0n)], [account(PAYER, SYSTEM, SOL - 5000n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, copy, 1_000n * USDC)]));
    assert.ok(out.assessment.findings.some((f) => f.code === 'lookalike-address' && f.subject === copy));
    // A token account of yours: a new delegate, a new close authority, a new owner, each a copy of Ana's; one already
    // there, unchanged, is not said again.
    const touch: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }] };
    const mine = (o: { delegate?: Address; closer?: Address; owner?: Address } = {}) => account(YOURS, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: o.owner ?? PAYER, amount: 5n * USDC, ...(o.delegate && { delegate: o.delegate, delegated: 5n * USDC }), ...(o.closer && { closer: o.closer }) }));
    const wallet = [account(PAYER, SYSTEM, SOL)];
    for (const change of [{ delegate: copy }, { closer: copy }, { owner: copy }]) assert.deepEqual(await lookalikes([touch], [...wallet, mine()], [...wallet, mine(change)], ana), anas, JSON.stringify(change));
    assert.deepEqual(await lookalikes([touch], [...wallet, mine({ delegate: copy })], [...wallet, mine({ delegate: copy })], ana), []);
    // Your mint authority handed to a copy of Ana's: who has it now is checked, as well as that yours is gone.
    const mintOf = (minter: Address) => {
        const d = new Uint8Array(82);
        d.set([1, 0, 0, 0, ...getAddressEncoder().encode(minter)], 0);
        d[44] = 6;
        d[45] = 1;
        return account(MINT, TOKEN_PROGRAM_ADDRESS, 1_461_600n, d);
    };
    const hand: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: MINT, role: W }] };
    assert.deepEqual(await lookalikes([hand], [...wallet, mintOf(PAYER)], [...wallet, mintOf(copy)], ana), anas);
    // Your own transfer in Otus, typed to a copy.
    assert.deepEqual(await lookalikes(...pay(copy), { ...ana, own: true, to: copy }), anas);
});

test('alike: as people check an address, by its ends', () => {
    const a = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const b = (head: number, tail: number) => `${a.slice(0, head)}${'z'.repeat(a.length - head - tail)}${a.slice(a.length - tail)}`;
    assert.equal(alike(a, b(3, 3)), true);
    assert.equal(alike(a, b(2, 4)), true);
    assert.equal(alike(a, b(2, 3)), false); // five alike: about one in 650 million random pairs, too many
    assert.equal(alike(a, b(5, 1)), false); // one end only
    assert.equal(alike(a, b(1, 5)), false);
    assert.equal(alike(a, a), false); // the very address is no copy of itself
});
