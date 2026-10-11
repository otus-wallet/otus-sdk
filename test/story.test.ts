import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { AuthorityType, getSetAuthorityInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getAddressEncoder, getU32Encoder, getU64Encoder, type Address } from '@solana/kit';

import { CORE_PLUGINS } from '../src/programs/core.ts';
import { ago, assess, ranked, type Context } from '../src/review/assess.ts';
import { story, type Names } from '../src/review/effects.ts';
import type { Explained } from '../src/review/explain.ts';
import { deployments } from '../src/review/programs.ts';
import { resolve } from '../src/review/resolve.ts';
import { review } from '../src/review/review.ts';
import { decode } from '../src/review/decode.ts';
import { hostedOn, lookalike } from '../src/review/sites.ts';
import { account, ATTACKER, EVIL_PROGRAM, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction, USER_TOKEN } from './helpers.ts';

const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds: on the curve
const THIEF_TOKEN = key(24);
const context = (o: Partial<Context> = {}): Context => ({ wallet: PAYER, signedBefore: 0, ...o });

test('tells a site that imitates a known one', () => {
    const host = (name: string) => new URL(`https://${name}`).host; // as the browser reports it: "xn--" for other letters
    const cases: [string, string | null][] = [
        ['jup.ag', null], ['app.jup.ag', null], ['jup.ag:8443', null], ['jup-claim.app', 'jup.ag'], ['raydiurn.io', 'raydium.io'],
        // Sites that moved, or have more than one: each is known (kamino.finance goes to kamino.com).
        ['kamino.com', null], ['app.kamino.com', null], ['kamino.finance', null], ['backpack.exchange', null], ['kamino-claim.com', 'kamino.finance'],
        ['phantom-wallet.com', 'phantom.app'], ['pumpfun.lol', 'pump.fun'], ['example.com', null], ['localhost:8765', null],
        // Words glued on, letters that pass for others, free subdomains, two-level country domains.
        ['jupiterswap.com', 'jup.ag'], ['claimjup.io', 'jup.ag'], ['phantomwallet.app', 'phantom.app'], ['raydiumswap.io', 'raydium.io'],
        ['raydiurn-app.com', 'raydium.io'], ['raydlum.vercel.app', 'raydium.io'], ['raydiurn.pages.dev', 'raydium.io'], ['raydiun.co.uk', 'raydium.io'],
        ['jito-airdrop.com', 'jito.network'], ['zeta-claim.io', 'zeta.markets'], ['magic-eden.io', 'magiceden.io'], ['jup.ag.claim-now.com', 'jup.ag'],
        // Other alphabets, as the browser sends them.
        [host('jüp.ag'), 'jup.ag'], [host('раydium.io'), 'raydium.io'], [host('phаntom.app'), 'phantom.app'],
        // Plain words and other brands stay what they are.
        ['draft.com', null], ['parcel.com', null], ['jupyter.org', null], ['tensorflow.org', null], ['solanabeach.io', null], ['crypto-exchange.com', null],
    ];
    for (const [name, like] of cases) assert.equal(lookalike(name), like, name);
    assert.match(host('раydium.io'), /^xn--/);
});

test('tells a site put up where anyone can put one up, by the host it is under', () => {
    const cases: [string, string | null][] = [
        ['example.vercel.app', 'vercel.app'], ['Claim.Vercel.App', 'vercel.app'], ['claim.vercel.app.', 'vercel.app'], ['x.pages.dev:8443', 'pages.dev'],
        ['my-app.up.railway.app', 'railway.app'], ['a.b.c.netlify.app', 'netlify.app'], ['x.ngrok-free.app', 'ngrok-free.app'], ['abc.eth.limo', 'eth.limo'],
        ['bafybeigdyr.ipfs.dweb.link', 'dweb.link'], ['ipfs.io', 'ipfs.io'], ['storage.googleapis.com', 'storage.googleapis.com'], ['b.storage.googleapis.com', 'storage.googleapis.com'],
        ['sites.google.com', 'sites.google.com'], ['bucket.s3.us-east-1.amazonaws.com', 'amazonaws.com'], ['x.github.io', 'github.io'],
        // A domain of its own, or one that only has the host's name in it.
        ['jup.ag', null], ['app.squads.so', null], ['vercel.com', null], ['notvercel.app', null], ['vercel.app.claim.com', null], ['mysites.google.com', null],
        ['www.googleapis.com', null], ['localhost:8787', null], ['example.com', null], ['', null],
    ];
    for (const [name, on] of cases) assert.equal(hostedOn(name), on, name);
});

test('a notice is worth knowing and leaves the verdict as it was', () => {
    assert.equal(ranked([{ level: 'notice', code: 'x', text: '' }, { level: 'ok', code: 'y', text: '' }]).verdict, 'ok');
    assert.equal(ranked([{ level: 'notice', code: 'x', text: '' }, { level: 'warn', code: 'y', text: '' }]).verdict, 'warn');
    assert.deepEqual([ago(30), ago(7_200), ago(3 * 86_400)], ['1 minute ago', '2 hours ago', '3 days ago']);
});

// A drainer: an unknown program, deployed two hours ago, moves your tokens to a thief's token account.
const DRAIN = transaction([
    {
        programAddress: EVIL_PROGRAM,
        accounts: [
            { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
            { address: USER_TOKEN, role: AccountRole.WRITABLE },
            { address: THIEF_TOKEN, role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([7, 7]),
    },
]);
const BEFORE = [
    account(PAYER, SYSTEM, 5_000_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000n })),
    account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: THIEF, amount: 0n })),
];
const AFTER = [
    account(PAYER, SYSTEM, 4_995_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n })),
    account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: THIEF, amount: 1_000n })),
];

test('a drainer: where your tokens go, what each account is, and a program deployed hours ago', async () => {
    const now = 1_800_000_000;
    const deployed = new Map([[EVIL_PROGRAM, { slot: 123_456n, deployed: now - 7_200, upgradeable: true, builtin: false }]]);
    const chain = fakeChain(BEFORE, AFTER);
    const r = await review(DRAIN, context({ now }), { ...chain, heads: async () => [], blockTime: async () => null });
    const { flows, kinds, findings } = r.assessment;
    assert.deepEqual(flows, [{ asset: MINT, change: -1_000n, others: [{ address: THIEF_TOKEN, holder: THIEF, amount: 1_000n, wallet: true }] }]);
    assert.deepEqual([kinds.get(PAYER), kinds.get(USER_TOKEN), kinds.get(THIEF_TOKEN), kinds.get(EVIL_PROGRAM)], ['you', 'your-tokens', 'tokens', 'new']);
    const codes = findings.filter((f) => f.level !== 'ok').map((f) => `${f.level}:${f.code}`);
    assert.ok(codes.includes('danger:sends-to-wallet') && codes.includes('warn:unknown-program'), codes.join());
    // Deployed two hours ago, as the deployments step finds it, an unknown program that gets you is danger.
    const assessed = assess(r, r.changes, r.explained, context({ now, deployments: deployed }));
    assert.deepEqual(assessed.findings.find((f) => f.code === 'fresh-program'), { level: 'danger', code: 'fresh-program', text: 'An unknown program was deployed 2 hours ago', note: 'Its authority can still change it', subject: EVIL_PROGRAM });
});

test('reads when an upgradeable program was deployed, from its program data account', async () => {
    const programData = key(41);
    const program = account(EVIL_PROGRAM, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1_141_440n, new Uint8Array([...getU32Encoder().encode(2), ...getAddressEncoder().encode(programData)]));
    const head = new Uint8Array([...getU32Encoder().encode(3), ...getU64Encoder().encode(123_456n), 1, ...getAddressEncoder().encode(ATTACKER)]);
    const chain = {
        ...fakeChain([{ ...program, executable: true } as typeof program]),
        heads: async (addresses: readonly Address[]) => addresses.map((a) => ({ ...account(a, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1n, head) })),
        blockTime: async (slot: bigint) => (slot === 123_456n ? 1_700_000_000 : null),
    };
    const resolved = await resolve(await decode(DRAIN), chain);
    // Read at slot 1, below the deploy (a node behind, say): dated.
    assert.deepEqual(await deployments(resolved, chain), new Map([[EVIL_PROGRAM, { slot: 123_456n, deployed: 1_700_000_000, upgradeable: true, builtin: false }]]));
    // Further back than eight days at a slot every 100 ms: too old to be fresh, its time is not asked; dated up to there.
    const asked: bigint[] = [];
    const counting = { ...chain, blockTime: async (slot: bigint) => (asked.push(slot), chain.blockTime(slot)) };
    const DATED = 6_912_000n;
    assert.deepEqual(await deployments({ ...resolved, slot: 123_456n + DATED + 1n }, counting), new Map([[EVIL_PROGRAM, { slot: 123_456n, deployed: null, upgradeable: true, builtin: false }]]));
    assert.deepEqual((await deployments({ ...resolved, slot: 123_456n + DATED }, counting)).get(EVIL_PROGRAM)?.deployed, 1_700_000_000);
    assert.deepEqual(asked, [123_456n]);
    // A program Otus names, however recent: never called fresh, so not dated.
    const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    const named = { ...resolved, accounts: resolved.accounts.map((a) => (a.address === EVIL_PROGRAM ? { ...a, address: JUPITER } : a)) };
    assert.deepEqual(await deployments(named, counting), new Map([[JUPITER, { slot: 123_456n, deployed: null, upgradeable: true, builtin: false }]]));
    assert.deepEqual(asked, [123_456n]);
});

test('a loader v4 program is dated the same way: recent, asked; further back, not', async () => {
    const v4 = account(EVIL_PROGRAM, address('LoaderV411111111111111111111111111111111111'), 1n, new Uint8Array([...getU64Encoder().encode(123_456n), ...getAddressEncoder().encode(ATTACKER), ...getU64Encoder().encode(0n)]));
    const asked: bigint[] = [];
    const chain = { ...fakeChain([{ ...v4, executable: true } as typeof v4]), blockTime: async (slot: bigint) => (asked.push(slot), 1_700_000_000) };
    const resolved = await resolve(await decode(DRAIN), chain);
    assert.deepEqual(await deployments({ ...resolved, slot: 123_456n + 6_912_000n }, chain), new Map([[EVIL_PROGRAM, { slot: 123_456n, deployed: 1_700_000_000, upgradeable: true, builtin: false }]]));
    assert.deepEqual((await deployments({ ...resolved, slot: 123_456n + 6_912_001n }, chain)).get(EVIL_PROGRAM)?.deployed, null);
    assert.deepEqual(asked, [123_456n]);
});

test('end to end: an unknown program deployed two hours ago, as the chain tells it, is danger in the review', async () => {
    const programData = key(41);
    const program = account(EVIL_PROGRAM, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1_141_440n, new Uint8Array([...getU32Encoder().encode(2), ...getAddressEncoder().encode(programData)]));
    const head = new Uint8Array([...getU32Encoder().encode(3), ...getU64Encoder().encode(123_456n), 1, ...getAddressEncoder().encode(ATTACKER)]);
    const base = fakeChain([...BEFORE, { ...program, executable: true } as typeof program], AFTER);
    const chain = {
        ...base,
        accounts: async (addresses: readonly Address[]) => ({ ...(await base.accounts(addresses)), slot: 123_456n + 36_000n }), // two hours on, at 200 ms
        heads: async (addresses: readonly Address[]) => addresses.map((a) => account(a, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1n, head)),
        blockTime: async (slot: bigint) => (slot === 123_456n ? 1_700_000_000 : null),
    };
    const r = await review(DRAIN, context({ now: 1_700_007_200 }), chain);
    assert.deepEqual(r.assessment.findings.find((f) => f.code === 'fresh-program'), { level: 'danger', code: 'fresh-program', text: 'An unknown program was deployed 2 hours ago', note: 'Its authority can still change it', subject: EVIL_PROGRAM });
});

// What each instruction says, given how the transaction's accounts read.
const names: Names = {
    wallet: PAYER,
    who: (a) => (a === PAYER ? 'you' : a === USER_TOKEN ? 'your USDC account' : a === THIEF ? 'HAgk…Kpqk' : `acct ${a.slice(0, 4)}`),
    mine: (a) => a === PAYER || a === USER_TOKEN,
    existed: () => true,
    mintOf: () => MINT,
    token: () => ({ symbol: 'USDC', decimals: 6, verified: true }),
    program: (a) => a,
    priorityFee: 66_000n,
    payer: PAYER,
    changes: (a) => (a === USER_TOKEN ? ['−0.001 USDC from your USDC account'] : []),
};
const explained = async (ix: Parameters<typeof transaction>[0][number]): Promise<Explained> => {
    const plugin = CORE_PLUGINS.find((p) => p.program === ix.programAddress);
    const e = plugin?.explain({ ...ix, accounts: ix.accounts ?? [], data: ix.data ?? new Uint8Array() } as never);
    return { program: ix.programAddress, programName: plugin?.name ?? null, source: e ? 'plugin' : 'unknown', data: ix.data ?? new Uint8Array(), ...(e ?? { name: 'Unknown instruction', accounts: (ix.accounts ?? []).map((m, i) => ({ role: `account ${i + 1}`, address: m.address })), args: [] }) };
};

test('tells what an instruction does, in words', async () => {
    const me = createNoopSigner(PAYER);
    const sol = story(await explained(getTransferSolInstruction({ source: me, destination: THIEF, amount: 1_500_000_000n })), names);
    assert.deepEqual(sol, { args: '1.5 SOL → HAgk…Kpqk', effects: [{ text: '1.5 SOL from you to HAgk…Kpqk', tone: 'plain' }] });
    const usdc = story(await explained(getTransferCheckedInstruction({ source: USER_TOKEN, mint: MINT, destination: THIEF_TOKEN, authority: me, amount: 2_140_550_000n, decimals: 6 })), names);
    assert.equal(usdc.effects[0].text, `2,140.55 USDC from your USDC account to acct ${THIEF_TOKEN.slice(0, 4)}`);
    const owner = story(await explained(getSetAuthorityInstruction({ owned: USER_TOKEN, owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: THIEF })), names, true);
    assert.deepEqual(owner.effects, [{ text: 'The ownership of your USDC account goes to HAgk…Kpqk', tone: 'danger' }]);
    const blind = story({ program: EVIL_PROGRAM, programName: null, source: 'unknown', data: new Uint8Array([111, 42, 145, 0, 9]), name: 'Unknown instruction', accounts: [{ role: 'account 1', address: USER_TOKEN }], args: [] }, names, true);
    assert.deepEqual(blind, { args: 'No plugin reads it · data 0x6f2a9100… · 5 bytes', effects: [{ text: '−0.001 USDC from your USDC account', tone: 'danger' }] });
});

test('a compute limit says what the transaction used beside it, when that is known', async () => {
    const { getSetComputeUnitLimitInstruction } = await import('@solana-program/compute-budget');
    const limit = await explained(getSetComputeUnitLimitInstruction({ units: 1_400_000 }));
    assert.deepEqual(story(limit, { ...names, unitsUsed: 301_777n }), { args: '1,400,000 CU · 301,777 used', effects: [{ text: 'Caps compute at 1,400,000 units; it uses 301,777', tone: 'plain' }] });
    assert.deepEqual(story(limit, names), { args: '1,400,000 CU', effects: [{ text: 'Caps compute at 1,400,000 units', tone: 'plain' }] });
    assert.equal(story(limit, { ...names, unitsUsed: null }).args, '1,400,000 CU');
});

test('a nonce moved on leads a durable transaction; anywhere else it only takes back what was signed on it', () => {
    const e: Explained = { program: address('11111111111111111111111111111111'), programName: 'System Program', source: 'plugin', data: new Uint8Array([4, 0, 0, 0]), name: 'AdvanceNonceAccount', accounts: [{ role: 'nonceAccount', address: address('11111111111111111111111111111112') }], args: [] };
    const n = { who: (a: Address) => a.slice(0, 4) } as unknown as Names;
    assert.deepEqual(story(e, n, false, true).effects, [{ text: 'Uses a durable nonce: this transaction never expires', tone: 'danger' }]);
    assert.deepEqual(story(e, n, false, false).effects, [{ text: 'Moves the nonce of 1111 on: what was signed on it can no longer run', tone: 'plain' }]);
});

test('stake instructions in words: who withdraws, a validator, a withdraw authority handed over', () => {
    const STAKE = address('Stake11111111111111111111111111111111111111');
    const [me, account, stranger, vote] = ['4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR', '2RJDBUrb8WrDoLbnkd6uqmPbqVbXTUa3cE25yngrgzmr', '2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z'].map((a) => address(a));
    const ix = (name: string, accounts: Record<string, Address>, args: Record<string, string> = {}): Explained => ({ program: STAKE, programName: 'Stake Program', source: 'plugin', data: new Uint8Array(), name, accounts: Object.entries(accounts).map(([role, address]) => ({ role, address })), args: Object.entries(args).map(([name, value]) => ({ name, value })) });
    const n = { wallet: me, who: (a: Address) => (a === me ? 'you' : a.slice(0, 4)), mine: (a: Address) => a === me || a === account } as unknown as Names;
    assert.deepEqual(story(ix('Initialize', { stake: account }, { arg0: `{ staker: ${me}, withdrawer: ${stranger} }`, arg1: '{ unixTimestamp: 0, epoch: 0, custodian: 11111111111111111111111111111111 }' }), n).effects, [{ text: `Only 2RJD can withdraw from 8qbH`, tone: 'warn' }]);
    assert.deepEqual(story(ix('DelegateStake', { stake: account, vote, stakeAuthority: me }), n).effects, [{ text: 'Delegates 8qbH to validator 2VDW', tone: 'plain' }]);
    assert.deepEqual(story(ix('Authorize', { stake: account, authority: me }, { arg0: stranger, arg1: '1' }), n).effects, [{ text: 'The right to withdraw 8qbH goes to 2RJD', tone: 'danger' }]);
});

test('an approval without limit says so in words; one as large as the balance says it takes all', () => {
    const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const [me, account, delegate, mint] = ['4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR', '2RJDBUrb8WrDoLbnkd6uqmPbqVbXTUa3cE25yngrgzmr', '2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z'].map((a) => address(a));
    const approve = (amount: string): Explained => ({ program: TOKEN, programName: 'Token Program', source: 'plugin', data: new Uint8Array(), name: 'Approve', accounts: [{ role: 'source', address: account }, { role: 'delegate', address: delegate }, { role: 'owner', address: me }], args: [{ name: 'amount', value: amount }] });
    const n = { wallet: me, who: (a: Address) => (a === account ? 'your LAB account' : a.slice(0, 4)), mine: (a: Address) => a === me || a === account, mintOf: () => mint, token: () => ({ symbol: 'LAB', decimals: 0, verified: false }), holds: () => 1_000n } as unknown as Names;
    assert.deepEqual(story(approve('18446744073709551615'), n), { args: '2RJD · no limit', effects: [{ text: '2RJD may move all your LAB, with no limit and at any time', tone: 'warn' }] });
    assert.equal(story(approve('1000'), n).effects[0].text, '2RJD may move up to 1,000 LAB (all you hold) from your LAB account');
    assert.equal(story(approve('100'), n).effects[0].text, '2RJD may move up to 100 LAB from your LAB account');
});
