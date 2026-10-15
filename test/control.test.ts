// Control of something of yours handed away: to someone's key it is lost, critical; to a program's address, said, to
// check. What can't be dodged with a lamport more, an account no one set up, an authority given up to no one, or a
// holder read where the account moved.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    AccountRole,
    address,
    getAddressDecoder,
    getAddressEncoder,
    getI64Encoder,
    getProgramDerivedAddress,
    getU16Encoder,
    getU32Encoder,
    getU64Encoder,
    isOffCurveAddress,
    type Address,
    type Instruction,
} from '@solana/kit';

import { story, type Names } from '../src/review/effects.ts';
import type { Explained } from '../src/review/explain.ts';
import { review } from '../src/review/review.ts';
import { account, ATTACKER, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const SOL = 1_000_000_000n;
const RENT = 2_282_880n; // a stake account's rent reserve
const STAKE = address('Stake11111111111111111111111111111111111111');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const T22 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const INCINERATOR = address('1nc1nerator11111111111111111111111111111111');
const { WRITABLE: W, READONLY: R, READONLY_SIGNER: RS, WRITABLE_SIGNER: WS } = AccountRole;
const context = { wallet: PAYER, signedBefore: 0, host: 'app.example.com', now: 1_800_000_000 };
const said = async (ix: Instruction[], before: Parameters<typeof fakeChain>[0], after: Parameters<typeof fakeChain>[0], ctx: object = context) => {
    const r = await review(transaction(ix), { ...context, ...ctx }, fakeChain(before, after));
    return r.assessment.findings.filter((f) => f.level === 'danger' || f.level === 'warn').map((f) => `${f.level}:${f.code}`);
};

function staked(withdrawer: Address, o: { kind?: number; time?: bigint; custodian?: Address } = {}): Uint8Array {
    const d = new Uint8Array(200);
    d.set(getU32Encoder().encode(o.kind ?? 1));
    d.set(getU64Encoder().encode(RENT), 4);
    if (o.kind === 0) return d;
    d.set(getAddressEncoder().encode(withdrawer), 12);
    d.set(getAddressEncoder().encode(withdrawer), 44);
    d.set(getI64Encoder().encode(o.time ?? 0n), 76);
    d.set(getAddressEncoder().encode(o.custodian ?? SYSTEM), 92);
    return d;
}
function nonce(authority: Address, state = 1): Uint8Array {
    const d = new Uint8Array(80);
    d.set(getU32Encoder().encode(1));
    d.set(getU32Encoder().encode(state), 4);
    if (state) d.set(getAddressEncoder().encode(authority), 8);
    return d;
}
const send = (from: Address, to: Address, lamports: bigint): Instruction => ({ programAddress: SYSTEM, accounts: [{ address: from, role: WS }, { address: to, role: W }], data: new Uint8Array([2, 0, 0, 0, ...getU64Encoder().encode(lamports)]) });

test('your SOL into a stake someone else’s key withdraws is critical, with a lamport more beside it or SOL back to you', async () => {
    const S = key(43);
    const before = [account(PAYER, SYSTEM, 1000n * SOL), account(S, STAKE, RENT, staked(ATTACKER)), account(ATTACKER, SYSTEM, SOL)];
    assert.deepEqual(await said([send(PAYER, S, 100n * SOL)], before, [account(PAYER, SYSTEM, 900n * SOL - 5000n), account(S, STAKE, RENT + 100n * SOL, staked(ATTACKER)), account(ATTACKER, SYSTEM, SOL)]), ['danger:stake-withdrawer']);
    // A lamport of theirs beside yours: the stake gains more than you send. What can be yours is still yours.
    const more = [account(PAYER, SYSTEM, 900n * SOL - 5000n), account(S, STAKE, RENT + 100n * SOL + 1n, staked(ATTACKER)), account(ATTACKER, SYSTEM, SOL - 1n)];
    assert.deepEqual(await said([send(PAYER, S, 100n * SOL), send(ATTACKER, S, 1n)], before, more), ['danger:stake-withdrawer']);
    // Rent's worth is no one's to take: dust in is not called a loss.
    const dust = [account(PAYER, SYSTEM, 1000n * SOL - 1000n - 5000n), account(S, STAKE, RENT + 1000n, staked(ATTACKER)), account(ATTACKER, SYSTEM, SOL)];
    assert.deepEqual(await said([send(PAYER, S, 1000n)], before, dust), []);
});

test('your SOL into a stake or nonce account no one set up, or a nonce account someone else’s key holds, is critical', async () => {
    const S = key(43);
    const into = (owner: Address, rent: bigint, data: Uint8Array) =>
        said([send(PAYER, S, 100n * SOL)], [account(PAYER, SYSTEM, 1000n * SOL), account(S, owner, rent, data)], [account(PAYER, SYSTEM, 900n * SOL - 5000n), account(S, owner, rent + 100n * SOL, data)]);
    assert.deepEqual(await into(STAKE, RENT, staked(ATTACKER, { kind: 0 })), ['danger:stake-withdrawer']);
    assert.deepEqual(await into(SYSTEM, 1_447_680n, nonce(ATTACKER, 0)), ['danger:stake-withdrawer']);
    assert.deepEqual(await into(SYSTEM, 1_447_680n, nonce(ATTACKER)), ['danger:stake-withdrawer']);
    // A nonce account a program's address holds: said, to check. Yours: nothing to say.
    const [pda] = await getProgramDerivedAddress({ programAddress: key(90), seeds: ['nonce'] });
    assert.deepEqual(await into(SYSTEM, 1_447_680n, nonce(pda)), ['warn:stake-withdrawer']);
    assert.deepEqual(await into(SYSTEM, 1_447_680n, nonce(PAYER)), []);
    // Garbage where a stake or nonce account would be: not taken for one.
    assert.deepEqual(await into(STAKE, RENT, new Uint8Array(3)), []);
    assert.deepEqual(await into(SYSTEM, 1_447_680n, new Uint8Array(79)), []);
});

test('an allowance as good as without end is all of it, even on an empty account; to your own wallet it is yours', async () => {
    const TA = key(45);
    const approve = (delegate: Address, amount: bigint): Instruction => ({ programAddress: TOKEN, accounts: [{ address: TA, role: W }, { address: delegate, role: R }, { address: PAYER, role: RS }], data: new Uint8Array([4, ...getU64Encoder().encode(amount)]) });
    const allowed = (delegate: Address, amount: bigint) =>
        said([approve(delegate, amount)], [account(PAYER, SYSTEM, SOL), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n }))], [account(PAYER, SYSTEM, SOL - 5000n), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n, delegate, delegated: amount }))]);
    assert.deepEqual(await allowed(ATTACKER, 2n ** 64n - 2n), ['danger:delegate']);
    assert.deepEqual(await allowed(ATTACKER, 2n ** 63n), ['danger:delegate']);
    assert.deepEqual(await allowed(ATTACKER, 2n ** 63n - 1n), ['warn:delegate']); // a set amount, on an empty account
    assert.deepEqual(await allowed(PAYER, 2n ** 64n - 1n), ['warn:delegate']);
});

// A wallet whose key's bytes all differ, so where it sits in an account is never in doubt.
const me = getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const touch = (target: Address, program: Address): Instruction => ({ programAddress: program, accounts: [{ address: target, role: W }, { address: me, role: WS }] });

test('an authority of yours given up to no one is said, as it can’t be undone: its tag cleared, your key left in the bytes', async () => {
    const M = key(60);
    const mint = (tag: number) => {
        const d = new Uint8Array(82);
        d[0] = tag;
        d.set(getAddressEncoder().encode(me), 4);
        d[45] = 1; // initialized
        return d;
    };
    const ctx = { wallet: me };
    assert.deepEqual(await said([touch(M, TOKEN)], [account(me, SYSTEM, SOL), account(M, TOKEN, 1_461_600n, mint(1))], [account(me, SYSTEM, SOL - 5000n), account(M, TOKEN, 1_461_600n, mint(0))], ctx), ['warn:authority-change']);
    assert.deepEqual(await said([touch(M, TOKEN)], [account(me, SYSTEM, SOL), account(M, TOKEN, 1_461_600n, mint(1))], [account(me, SYSTEM, SOL - 5000n), account(M, TOKEN, 1_461_600n, mint(1))], ctx), []);
    const P = key(61);
    const data = (some: number) => {
        const d = new Uint8Array(53);
        d.set(getU32Encoder().encode(3)); // program data
        d[12] = some;
        d.set(getAddressEncoder().encode(me), 13);
        return d;
    };
    assert.deepEqual(await said([touch(P, LOADER)], [account(me, SYSTEM, SOL), account(P, LOADER, SOL, data(1))], [account(me, SYSTEM, SOL - 5000n), account(P, LOADER, SOL, data(0))], ctx), ['warn:authority-change']);
    // Truncated, it is not read as one.
    assert.deepEqual(await said([touch(P, LOADER)], [account(me, SYSTEM, SOL), account(P, LOADER, SOL, data(1).slice(0, 20))], [account(me, SYSTEM, SOL - 5000n), account(P, LOADER, SOL, data(0).slice(0, 20))], ctx), []);
});

test('who holds a role is read where yours was only while the account keeps its size', async () => {
    const M = key(62);
    const enc = getAddressEncoder();
    const ascii = (t: string) => new TextEncoder().encode(t);
    const str = (b: Uint8Array) => [...getU32Encoder().encode(b.length), ...b];
    // 32 printable bytes off the curve, as a uri could carry.
    let filler = ascii('https://x.example/' + 'a'.repeat(14));
    for (let i = 0; !isOffCurveAddress(getAddressDecoder().decode(filler)); i++) filler = ascii('https://x.example/' + String(i).padStart(14, 'a'));
    const mint = (uri: Uint8Array, groupAuthority: Address) => {
        const meta = [...enc.encode(me), ...enc.encode(M), ...str(ascii('Name')), ...str(ascii('SYM')), ...str(uri), ...getU32Encoder().encode(0)];
        const group = [...enc.encode(groupAuthority), ...enc.encode(M), ...getU64Encoder().encode(1n), ...getU64Encoder().encode(10n)];
        const tlv = [...getU16Encoder().encode(19), ...getU16Encoder().encode(meta.length), ...meta, ...getU16Encoder().encode(21), ...getU16Encoder().encode(group.length), ...group];
        const d = new Uint8Array(166 + tlv.length);
        d[45] = 1;
        d[165] = 1; // a mint
        d.set(tlv, 166);
        return d;
    };
    const before = mint(ascii('u'), me);
    const groupAt = before.length - 80;
    // The uri grows: where the group's authority was now holds the uri's bytes, off the curve.
    const uri = new Uint8Array([...ascii('u'.repeat(groupAt - (166 + 4 + 32 + 32 + 8 + 7 + 4))), ...filler]);
    const shifted = mint(uri, ATTACKER);
    assert.ok(isOffCurveAddress(getAddressDecoder().decode(shifted.slice(groupAt, groupAt + 32))));
    const handed = (after: Uint8Array) => said([touch(M, T22)], [account(me, SYSTEM, SOL), account(M, T22, 5n * SOL, before)], [account(me, SYSTEM, SOL - 5000n), account(M, T22, 5n * SOL, after)], { wallet: me });
    assert.deepEqual(await handed(shifted), ['danger:authority-change']);
    assert.deepEqual(await handed(mint(ascii('u'), ATTACKER)), ['danger:authority-change']);
});

test('a lockup no one can lift is critical and says so; one a program’s address can lift is said', async () => {
    const S = key(43);
    const MINE = ATTACKER; // here, another wallet of yours Otus signs for
    const ctx = { signers: [PAYER, MINE] };
    const into = (custodian: Address) =>
        said([send(PAYER, S, 4n * SOL)], [account(PAYER, SYSTEM, 5n * SOL), account(S, STAKE, RENT, staked(MINE, { time: 4_000_000_000n, custodian }))], [account(PAYER, SYSTEM, SOL - 5000n), account(S, STAKE, RENT + 4n * SOL, staked(MINE, { time: 4_000_000_000n, custodian }))], ctx);
    assert.deepEqual(await into(SYSTEM), ['danger:stake-lockup']);
    assert.deepEqual(await into(INCINERATOR), ['danger:stake-lockup']);
    const [vesting] = await getProgramDerivedAddress({ programAddress: key(91), seeds: ['vesting'] });
    assert.deepEqual(await into(vesting), ['warn:stake-lockup']);
    const r = await review(transaction([send(PAYER, S, 4n * SOL)]), { ...context, ...ctx }, fakeChain([account(PAYER, SYSTEM, 5n * SOL), account(S, STAKE, RENT, staked(MINE, { time: 4_000_000_000n, custodian: INCINERATOR }))], [account(PAYER, SYSTEM, SOL - 5000n), account(S, STAKE, RENT + 4n * SOL, staked(MINE, { time: 4_000_000_000n, custodian: INCINERATOR }))]));
    assert.match(r.assessment.findings.find((f) => f.code === 'stake-lockup')!.note ?? '', /^No one can lift/);
});

test('the details tone a right handed to a program’s address yellow, to a key red, and wrapped SOL’s close red', async () => {
    const [mine, me2] = [key(70), address('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')];
    const [pda] = await getProgramDerivedAddress({ programAddress: address('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'), seeds: ['withdraw'] });
    const names = (mint: Address | null): Names => ({ wallet: me2, who: (a) => a, mine: (a) => a === me2 || a === mine, existed: () => true, mintOf: () => mint, token: () => ({ symbol: 'X', decimals: 0, verified: false }), program: (a) => a, priorityFee: null, payer: me2, changes: () => [] });
    const ix = (program: Address, name: string, accounts: Record<string, Address>, args: Record<string, string> = {}): Explained =>
        ({ program, programName: null, source: 'plugin', data: new Uint8Array(), name, accounts: Object.entries(accounts).map(([role, address]) => ({ role, address })), args: Object.entries(args).map(([name, value]) => ({ name, value })) }) as unknown as Explained;
    const tone = (e: Explained, mint: Address | null = null) => story(e, names(mint)).effects[0]!.tone;
    assert.equal(tone(ix(STAKE, 'Authorize', { stake: mine, authority: me2 }, { arg0: pda, arg1: '1' })), 'warn');
    assert.equal(tone(ix(STAKE, 'Authorize', { stake: mine, authority: me2 }, { arg0: ATTACKER, arg1: '1' })), 'danger');
    assert.equal(tone(ix(TOKEN, 'SetAuthority', { owned: mine, owner: me2 }, { newAuthority: pda, authorityType: '2' })), 'warn');
    assert.equal(tone(ix(TOKEN, 'SetAuthority', { owned: mine, owner: me2 }, { newAuthority: ATTACKER, authorityType: '2' })), 'danger');
    assert.equal(tone(ix(TOKEN, 'SetAuthority', { owned: mine, owner: me2 }, { newAuthority: ATTACKER, authorityType: '3' })), 'warn');
    assert.equal(tone(ix(TOKEN, 'SetAuthority', { owned: mine, owner: me2 }, { newAuthority: ATTACKER, authorityType: '3' }), address('So11111111111111111111111111111111111111112')), 'danger');
    assert.equal(tone(ix(LOADER, 'SetAuthority', { bufferOrProgramDataAccount: mine, currentAuthority: me2, newAuthority: pda })), 'warn');
});

test('an account made yours on the way and handed on is shown as theirs: what goes into it goes to them', async () => {
    const enc = getAddressEncoder();
    const u64 = (n: bigint) => [...getU64Encoder().encode(n)];
    // Stake: your 100 SOL into an account set up with you withdrawing, a lamport out by you, then its withdrawer to a key.
    const S = key(43);
    const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
    const HISTORY = address('SysvarStakeHistory1111111111111111111111111');
    const withdraw: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: PAYER, role: W }, { address: CLOCK, role: R }, { address: HISTORY, role: R }, { address: PAYER, role: RS }], data: new Uint8Array([4, 0, 0, 0, ...u64(1n)]) };
    const authorize: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: CLOCK, role: R }, { address: PAYER, role: RS }], data: new Uint8Array([1, 0, 0, 0, ...enc.encode(ATTACKER), 1, 0, 0, 0]) };
    const r = await review(transaction([send(PAYER, S, 100n * SOL), withdraw, authorize]), context, fakeChain([account(PAYER, SYSTEM, 101n * SOL), account(S, STAKE, RENT, staked(ATTACKER, { kind: 0 }))], [account(PAYER, SYSTEM, SOL + 1n - 5000n), account(S, STAKE, RENT + 100n * SOL - 1n, staked(ATTACKER))]));
    assert.ok(!r.assessment.mine.has(S));
    assert.ok(r.assessment.findings.some((f) => f.level === 'danger' && f.code === 'stake-withdrawer' && f.subject === S));
    assert.ok(r.assessment.yours.accounts.some((c) => c.address === S)); // what it loses counts as yours, and it is guarded
    // Tokens: 1000 of yours into a token account made yours, 0 out by you, then its owner to a key: sent, as to them.
    const [MY, T] = [key(45), key(46)];
    const transfer = (from: Address, to: Address, amount: bigint): Instruction => ({ programAddress: TOKEN, accounts: [{ address: from, role: W }, { address: to, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([3, ...u64(amount)]) });
    const hand: Instruction = { programAddress: TOKEN, accounts: [{ address: T, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 2, 1, ...enc.encode(ATTACKER)]) };
    const before = [account(PAYER, SYSTEM, SOL), account(MY, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n })), account(T, TOKEN, 2_039_280n, new Uint8Array(165))];
    const after = [account(PAYER, SYSTEM, SOL - 5000n), account(MY, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n })), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 1000n }))];
    const t = await review(transaction([transfer(MY, T, 1000n), transfer(T, MY, 0n), hand]), context, fakeChain(before, after));
    assert.ok(!t.assessment.mine.has(T));
    assert.equal(t.assessment.flows.find((f) => f.asset === MINT)?.change, -1000n);
    // One that loses: what leaves it counts as yours, whoever the RPC says holds it, as it may be.
    const lost = await review(transaction([transfer(T, MY, 1000n)]), context, fakeChain([account(PAYER, SYSTEM, SOL), account(MY, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n })), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 1000n }))], [account(PAYER, SYSTEM, SOL - 5000n), account(MY, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n })), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 0n }))]));
    assert.equal(lost.assessment.flows.find((f) => f.asset === MINT), undefined); // 1000 out of it, 1000 into yours
    assert.ok(lost.assessment.yours.accounts.some((c) => c.address === T));
});

test('SOL coming to you beside it hides none of what the words say you send into someone else’s stake', async () => {
    const [S, VAULT, CLAIMS] = [key(43), key(50), key(51)];
    const claim: Instruction = { programAddress: CLAIMS, accounts: [{ address: VAULT, role: W }, { address: PAYER, role: WS }], data: new Uint8Array(8) };
    const before = [account(PAYER, SYSTEM, SOL), account(VAULT, CLAIMS, 500n * SOL, new Uint8Array(8)), account(S, STAKE, RENT, staked(ATTACKER))];
    const after = [account(PAYER, SYSTEM, 101n * SOL - 5000n), account(VAULT, CLAIMS, 300n * SOL, new Uint8Array(8)), account(S, STAKE, RENT + 100n * SOL, staked(ATTACKER))];
    assert.ok((await said([claim, send(PAYER, S, 100n * SOL)], before, after)).includes('danger:stake-withdrawer'));
});

test('a mint’s extension field is read where its extension is: a metadata edit leaves your group authority yours', async () => {
    const M = key(62);
    const enc = getAddressEncoder();
    const str = (t: string) => {
        const b = new TextEncoder().encode(t);
        return [...getU32Encoder().encode(b.length), ...b];
    };
    const mint = (uri: string, group = me) => {
        const meta = [...enc.encode(me), ...enc.encode(M), ...str('Name'), ...str('SYM'), ...str(uri), ...getU32Encoder().encode(0)];
        const fields = [...enc.encode(group), ...enc.encode(M), ...getU64Encoder().encode(1n), ...getU64Encoder().encode(10n)];
        const tlv = [...getU16Encoder().encode(19), ...getU16Encoder().encode(meta.length), ...meta, ...getU16Encoder().encode(21), ...getU16Encoder().encode(fields.length), ...fields];
        const d = new Uint8Array(166 + tlv.length);
        d[45] = 1;
        d[165] = 1;
        d.set(tlv, 166);
        return d;
    };
    const edited = (after: Uint8Array) => said([touch(M, T22)], [account(me, SYSTEM, SOL), account(M, T22, 5n * SOL, mint('https://a'))], [account(me, SYSTEM, SOL - 5000n), account(M, T22, 5n * SOL, after)], { wallet: me });
    assert.deepEqual(await edited(mint('https://a-much-longer-uri.example/metadata.json')), []);
    assert.deepEqual(await edited(mint('https://a-much-longer-uri.example/metadata.json', ATTACKER)), ['danger:authority-change']);
    // Extensions that don't read (a length past the end): unknown, as gone.
    const broken = mint('https://a-much-longer-uri.example/metadata.json');
    broken[168] = 0xff;
    broken[169] = 0xff;
    assert.deepEqual(await edited(broken), ['danger:authority-change', 'danger:authority-change']);
});

test('an upgrade authority to a program’s address is said, though the program grows', async () => {
    const P = key(61);
    const [vault] = await getProgramDerivedAddress({ programAddress: key(92), seeds: ['vault'] });
    const data = (authority: Address, size: number) => {
        const d = new Uint8Array(size);
        d.set(getU32Encoder().encode(3));
        d[12] = 1;
        d.set(getAddressEncoder().encode(authority), 13);
        return d;
    };
    assert.deepEqual(await said([touch(P, LOADER)], [account(me, SYSTEM, SOL), account(P, LOADER, SOL, data(me, 1000))], [account(me, SYSTEM, SOL - 5000n), account(P, LOADER, 2n * SOL, data(vault, 2000))], { wallet: me }), ['warn:authority-change']);
});

test('an allowance of nine tenths of an account or more, to someone’s key, is all but all of it', async () => {
    const TA = key(45);
    const approve = (amount: bigint): Instruction => ({ programAddress: TOKEN, accounts: [{ address: TA, role: W }, { address: ATTACKER, role: R }, { address: PAYER, role: RS }], data: new Uint8Array([4, ...getU64Encoder().encode(amount)]) });
    const allowed = (amount: bigint) =>
        said([approve(amount)], [account(PAYER, SYSTEM, SOL), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000_000n }))], [account(PAYER, SYSTEM, SOL - 5000n), account(TA, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000_000n, delegate: ATTACKER, delegated: amount }))]);
    assert.deepEqual(await allowed(999_999n), ['danger:delegate']);
    assert.deepEqual(await allowed(900_000n), ['danger:delegate']);
    assert.deepEqual(await allowed(899_999n), ['warn:delegate']);
});

test('a lockup a named program’s key could lift names it; a vote account’s oldest layout keeps no withdrawer at 36', async () => {
    const S = key(43);
    const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'); // on the curve: a key may hold it
    const set: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 0, 0, 0]) };
    const r = await review(transaction([set]), context, fakeChain([account(PAYER, SYSTEM, SOL), account(S, STAKE, 10n * SOL, staked(PAYER))], [account(PAYER, SYSTEM, SOL - 5000n), account(S, STAKE, 10n * SOL, staked(PAYER, { time: 4_000_000_000n, custodian: JUPITER }))]));
    assert.equal(r.assessment.findings.find((f) => f.code === 'stake-lockup')?.note, `${JUPITER} can lift it: until then you can't withdraw`);
    const V = key(64);
    const VOTE = address('Vote111111111111111111111111111111111111111');
    const vote = (version: number, at36: Address) => {
        const d = new Uint8Array(3762);
        d.set(getU32Encoder().encode(version));
        d.set(getAddressEncoder().encode(at36), 36);
        return d;
    };
    const withdrawer = (version: number) => said([touch(V, VOTE)], [account(me, SYSTEM, SOL), account(V, VOTE, SOL, vote(version, me))], [account(me, SYSTEM, SOL - 5000n), account(V, VOTE, SOL, vote(version, ATTACKER))], { wallet: me });
    assert.deepEqual(await withdrawer(2), ['danger:authority-change']);
    assert.deepEqual(await withdrawer(0), ['warn:authority-change']); // its voter: told only as your address leaving
});

test('the details: a right given up to no one yellow, the close of an account back to its owner plain, a mint’s authority yours', () => {
    const [mine, me2] = [key(70), address('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')];
    const names = (mint: Address | null): Names => ({ wallet: me2, who: (a) => a, mine: (a) => a === me2 || a === mine, existed: () => true, mintOf: () => mint, token: () => ({ symbol: 'X', decimals: 0, verified: false }), program: (a) => a, priorityFee: null, payer: me2, changes: () => [] });
    const ix = (name: string, accounts: Record<string, Address>, args: Record<string, string>): Explained =>
        ({ program: TOKEN, programName: null, source: 'plugin', data: new Uint8Array(), name, accounts: Object.entries(accounts).map(([role, address]) => ({ role, address })), args: Object.entries(args).map(([name, value]) => ({ name, value })) }) as unknown as Explained;
    const effect = (e: Explained, mint: Address | null = null) => story(e, names(mint)).effects[0]!;
    const WSOL = address('So11111111111111111111111111111111111111112');
    const WSOL_2022 = address('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP');
    assert.deepEqual(effect(ix('SetAuthority', { owned: mine, owner: me2 }, { newAuthority: 'none', authorityType: '3' }), WSOL), { text: `The right to close of ${mine} goes to its owner`, tone: 'plain' });
    assert.equal(effect(ix('SetAuthority', { owned: mine, owner: me2 }, { newAuthority: ATTACKER, authorityType: '3' }), WSOL_2022).tone, 'danger');
    // A mint is no account of yours; its authority, held by your wallet, is.
    const MINT2 = key(71);
    assert.equal(effect(ix('SetAuthority', { owned: MINT2, owner: me2 }, { newAuthority: ATTACKER, authorityType: '0' })).tone, 'danger');
    assert.equal(effect(ix('SetAuthority', { owned: MINT2, owner: me2 }, { newAuthority: 'none', authorityType: '0' })).tone, 'warn');
});

test('what you send into an account handed on shows as sent, though your wallet moves a sliver out of it as delegate', async () => {
    const [M, T] = [key(30), key(32)];
    // A mint whose permanent delegate is your wallet: you burn 1 of the attacker's tokens in T, and your 100 SOL go in.
    const burn: Instruction = { programAddress: T22, accounts: [{ address: T, role: W }, { address: M, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([15, ...getU64Encoder().encode(1n), 0]) };
    const mint = Object.assign(new Uint8Array(82), { 45: 1 });
    const before = [account(PAYER, SYSTEM, 1000n * SOL), account(M, T22, 1_461_600n, mint), account(T, T22, 2_039_280n, tokenAccountData({ mint: M, owner: ATTACKER, amount: 5n }))];
    const after = [account(PAYER, SYSTEM, 900n * SOL - 5000n), account(M, T22, 1_461_600n, mint), account(T, T22, 2_039_280n + 100n * SOL, tokenAccountData({ mint: M, owner: ATTACKER, amount: 4n }))];
    const r = await review(transaction([burn, send(PAYER, T, 100n * SOL)]), context, fakeChain(before, after));
    assert.ok(!r.assessment.mine.has(T));
    assert.equal(r.assessment.flows.find((f) => f.asset === 'SOL')?.change, -100n * SOL);
    assert.deepEqual(r.assessment.flows.find((f) => f.asset === 'SOL')?.others.map((o) => o.address), [T]);
});

test('your SOL into a stake that ends yours to withdraw, under a lockup someone else keeps, is critical', async () => {
    const S = key(43);
    const lockup = { time: 4_102_444_800n, custodian: ATTACKER }; // 2100
    const authorize: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: address('SysvarC1ock11111111111111111111111111111111'), role: R }, { address: ATTACKER, role: RS }], data: new Uint8Array([1, 0, 0, 0, ...getAddressEncoder().encode(PAYER), 1, 0, 0, 0]) };
    const before = [account(PAYER, SYSTEM, 1000n * SOL), account(S, STAKE, RENT, staked(ATTACKER, lockup))];
    const after = [account(PAYER, SYSTEM, 900n * SOL - 5000n), account(S, STAKE, RENT + 100n * SOL, staked(PAYER, lockup))];
    assert.ok((await said([authorize, send(PAYER, S, 100n * SOL)], before, after)).includes('danger:stake-lockup'));
    // Handed to you locked, with nothing of yours going in: no loss.
    assert.deepEqual((await said([authorize], before, [account(PAYER, SYSTEM, 1000n * SOL - 5000n), account(S, STAKE, RENT, staked(PAYER, lockup))])).filter((p) => p.startsWith('danger')), []);
});

test('a Token-2022 extension’s authority set to no one (zeros) is given up, said as such', async () => {
    const M = key(62);
    const enc = getAddressEncoder();
    const str = (t: string) => {
        const b = new TextEncoder().encode(t);
        return [...getU32Encoder().encode(b.length), ...b];
    };
    const mint = (authority: Uint8Array) => {
        const meta = [...authority, ...enc.encode(M), ...str('Name'), ...str('SYM'), ...str('https://a'), ...getU32Encoder().encode(0)];
        const tlv = [...getU16Encoder().encode(19), ...getU16Encoder().encode(meta.length), ...meta];
        const d = new Uint8Array(166 + tlv.length);
        d[45] = 1;
        d[165] = 1;
        d.set(tlv, 166);
        return d;
    };
    const r = await review(transaction([touch(M, T22)]), { ...context, wallet: me }, fakeChain([account(me, SYSTEM, SOL), account(M, T22, 5n * SOL, mint(new Uint8Array(enc.encode(me))))], [account(me, SYSTEM, SOL - 5000n), account(M, T22, 5n * SOL, mint(new Uint8Array(32)))]));
    assert.deepEqual(r.assessment.findings.filter((f) => f.code === 'authority-change').map((f) => `${f.level}:${f.note}`), ["warn:It can't be undone"]);
});

test('an account handed on counts only by what it loses: its balance never pads yours, nor gives you another mint', async () => {
    const [M, T, B] = [key(30), key(32), key(31)];
    const mint = Object.assign(new Uint8Array(82), { 45: 1 });
    const burn = (amount: bigint, of = M): Instruction => ({ programAddress: T22, accounts: [{ address: T, role: W }, { address: of, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([15, ...getU64Encoder().encode(amount), 0]) });
    // All 100 of your SOL out, beside a burn of 0 from the attacker's account holding 12 SOL: still almost all of yours.
    const held = account(T, T22, 12n * SOL, tokenAccountData({ mint: M, owner: ATTACKER, amount: 5n }));
    const drained = await said([burn(0n), send(PAYER, ATTACKER, 100n * SOL - 1_005_000n)], [account(PAYER, SYSTEM, 100n * SOL), account(ATTACKER, SYSTEM, SOL), account(M, T22, 1_461_600n, mint), held], [account(PAYER, SYSTEM, 1_000_000n), account(ATTACKER, SYSTEM, 101n * SOL - 1_005_000n), account(M, T22, 1_461_600n, mint), held]);
    assert.ok(drained.includes('warn:large-outflow'));
    // Made again with another mint: what it began with is lost, the other mint's tokens are not yours.
    const r = await review(transaction([burn(1000n)]), context, fakeChain([account(PAYER, SYSTEM, 10n * SOL), account(M, T22, 1_461_600n, mint), account(T, T22, 2_039_280n, tokenAccountData({ mint: M, owner: ATTACKER, amount: 1000n }))], [account(PAYER, SYSTEM, 10n * SOL - 5000n), account(M, T22, 1_461_600n, mint), account(T, T22, 2_039_280n, tokenAccountData({ mint: B, owner: ATTACKER, amount: 1000n }))]));
    assert.deepEqual(r.assessment.flows.map((f) => `${f.asset}:${f.change}`), [`${M}:-1000`]);
});

test('a lockup someone else keeps on stake another of your wallets will withdraw is checked as yours', async () => {
    const S = key(43);
    const MINE = ATTACKER; // here, another wallet of yours Otus signs for
    const THEIRS = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    const lockup = { time: 4_102_444_800n, custodian: THEIRS };
    const set: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 0, 0, 0]) };
    const found = await said([set, send(PAYER, S, SOL)], [account(PAYER, SYSTEM, 5n * SOL), account(S, STAKE, 10n * SOL, staked(PAYER))], [account(PAYER, SYSTEM, 4n * SOL - 5000n), account(S, STAKE, 11n * SOL, staked(MINE, lockup))], { signers: [PAYER, MINE] });
    assert.ok(found.includes('danger:stake-lockup'));
});

test('closing an account as its close authority is only rent when it is no wrapped SOL and holds no more', async () => {
    const [WA, OTHER] = [key(45), key(50)];
    const RES = 2_039_280n;
    const close: Instruction = { programAddress: TOKEN, accounts: [{ address: WA, role: W }, { address: ATTACKER, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([9]) };
    const wsol = address('So11111111111111111111111111111111111111112');
    // The RPC naming someone else its owner and you its closer, with 100 wrapped SOL in it: what leaves it counts as yours.
    const lie = account(WA, TOKEN, RES + 100n * SOL, tokenAccountData({ mint: wsol, owner: OTHER, amount: 100n * SOL, native: RES, closer: PAYER }));
    const r = await review(transaction([close]), context, fakeChain([account(PAYER, SYSTEM, SOL), account(ATTACKER, SYSTEM, SOL), lie], [account(PAYER, SYSTEM, SOL - 5000n), account(ATTACKER, SYSTEM, 101n * SOL + RES), account(WA, SYSTEM, 0n)]));
    assert.ok(r.assessment.mine.has(WA));
    assert.equal(r.assessment.flows.find((f) => f.asset === 'SOL')?.change, -100n * SOL - RES); // the fee apart
});

test('a stake of yours left set up by no one is no longer yours: SOL sent into it is SOL lost to whoever sets it up', async () => {
    const S = key(43);
    const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
    const HISTORY = address('SysvarStakeHistory1111111111111111111111111');
    // Withdrawn in full (the Stake program leaves it set up by no one, your key still in its bytes), then 100 SOL in.
    const withdraw: Instruction = { programAddress: STAKE, accounts: [{ address: S, role: W }, { address: PAYER, role: W }, { address: CLOCK, role: R }, { address: HISTORY, role: R }, { address: PAYER, role: RS }], data: new Uint8Array([4, 0, 0, 0, ...getU64Encoder().encode(2n * SOL)]) };
    const left = staked(PAYER);
    left.set(getU32Encoder().encode(0)); // its tag only
    const r = await review(transaction([withdraw, send(PAYER, S, 100n * SOL)]), context, fakeChain([account(PAYER, SYSTEM, 1000n * SOL), account(S, STAKE, 2n * SOL, staked(PAYER))], [account(PAYER, SYSTEM, 902n * SOL - 5000n), account(S, STAKE, 100n * SOL, left)]));
    assert.equal(r.assessment.flows.find((f) => f.asset === 'SOL')?.change, -100n * SOL);
    assert.ok(r.assessment.findings.some((f) => f.level === 'danger' && f.code === 'stake-withdrawer' && f.subject === S));
});

test('SOL in a token account is whoever can close it: sent into yours that someone else closes, it leaves you', async () => {
    const T = key(46);
    const held = (closer?: Address, extra = 0n) => account(T, TOKEN, 2_039_280n + extra, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n, ...(closer && { closer }) }));
    const sent = await review(transaction([send(PAYER, T, 100n * SOL)]), context, fakeChain([account(PAYER, SYSTEM, 1000n * SOL), held(ATTACKER)], [account(PAYER, SYSTEM, 900n * SOL - 5000n), held(ATTACKER, 100n * SOL)]));
    assert.equal(sent.assessment.flows.find((f) => f.asset === 'SOL')?.change, -100n * SOL);
    assert.deepEqual(sent.assessment.flows.find((f) => f.asset === 'SOL')?.others.map((o) => o.holder), [ATTACKER]);
    assert.ok(sent.assessment.findings.some((f) => f.level === 'danger' && f.code === 'close-authority' && f.subject === T));
    // Closed by you alone: your SOL stays yours.
    const kept = await review(transaction([send(PAYER, T, 100n * SOL)]), context, fakeChain([account(PAYER, SYSTEM, 1000n * SOL), held()], [account(PAYER, SYSTEM, 900n * SOL - 5000n), held(undefined, 100n * SOL)]));
    assert.equal(kept.assessment.flows.find((f) => f.asset === 'SOL'), undefined);
});

test('who controls, when it ends, each part of yours that leaves you: an address, the program it now belongs to, or no one', async () => {
    const [S, T, EVIL] = [key(43), key(46), key(22)];
    const left = staked(PAYER);
    left.set(getU32Encoder().encode(0));
    const handOver: Instruction = { programAddress: TOKEN, accounts: [{ address: T, role: W }, { address: PAYER, role: RS }] };
    const r = await review(transaction([send(PAYER, S, SOL), handOver]), context, fakeChain(
        [account(PAYER, SYSTEM, 10n * SOL), account(S, STAKE, 2n * SOL, staked(PAYER)), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 5n }))],
        [account(PAYER, EVIL, 9n * SOL - 5000n), account(S, STAKE, 3n * SOL, left), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 5n, closer: key(47) }))],
    ));
    assert.deepEqual(r.assessment.leaves.get(PAYER), { sol: EVIL });
    assert.deepEqual(r.assessment.leaves.get(S), { sol: null });
    assert.deepEqual(r.assessment.leaves.get(T), { sol: key(47), tokens: ATTACKER });
});

test('an account is named yours by what it is for: someone’s token account you can close is not; one your wallet empties and closes is', async () => {
    const [T, W2] = [key(46), key(48)];
    // Their tokens, you its close authority: only its rent could ever be yours.
    const theirs = account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 900n, closer: PAYER }));
    const moved: Instruction = { programAddress: key(90), accounts: [{ address: T, role: W }, { address: PAYER, role: WS }] };
    const r = await review(transaction([moved]), context, fakeChain([account(PAYER, SYSTEM, SOL), theirs], [account(PAYER, SYSTEM, SOL - 5000n), account(T, TOKEN, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 0n, closer: PAYER }))]));
    assert.ok(!r.assessment.mine.has(T));
    // A token account your wallet closes, made in the same transaction (there neither before nor after): yours all along.
    const close: Instruction = { programAddress: TOKEN, accounts: [{ address: W2, role: W }, { address: PAYER, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([9]) };
    const c = await review(transaction([close]), context, fakeChain([account(PAYER, SYSTEM, SOL)], [account(PAYER, SYSTEM, SOL - 5000n)]));
    assert.deepEqual(c.changes.accounts.filter((x) => x.address === W2).map((x) => [x.before, x.after]), [[null, null]]);
    assert.ok(c.assessment.mine.has(W2));
});

test('a part of yours that leaves goes, in the flows, to whoever controls it then: a wallet handed to a program, to that program', async () => {
    const EVIL = key(22);
    const r = await review(transaction([send(PAYER, key(2), SOL)]), context, fakeChain([account(PAYER, SYSTEM, 10n * SOL)], [account(PAYER, EVIL, 9n * SOL - 5000n), account(key(2), SYSTEM, SOL)]));
    const holders = r.assessment.flows.find((f) => f.asset === 'SOL')?.others.map((o) => o.holder);
    assert.ok(holders?.includes(EVIL), String(holders));
});
