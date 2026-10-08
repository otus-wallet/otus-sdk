import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { getAdvanceNonceAccountInstruction, getAssignInstruction, getInitializeNonceAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
    AuthorityType,
    getApproveCheckedInstruction,
    getApproveInstruction,
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction,
    getRevokeInstruction,
    getSetAuthorityInstruction,
    getTransferCheckedInstruction,
} from '@solana-program/token';
import {
    AccountRole,
    appendTransactionMessageInstructions,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase58Decoder,
    getBase64Decoder,
    getTransactionDecoder,
    getTransactionEncoder,
    lamports,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    blockhash,
    createKeyPairFromPrivateKeyBytes,
    getAddressFromPublicKey,
    type Address,
    type Instruction,
} from '@solana/kit';

import { exactJson, NoHistory, readPage, type Landed } from '../src/activity/history.ts';
import { summarize } from '../src/activity/summary.ts';
import { SQUADS_V4 } from '../src/programs/squads.ts';
import { key, MINT } from './helpers.ts';

// The wallet: a key's address, on the curve, as a wallet that signs has; a program's address never signs.
const WALLET = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
const FRIEND = key(32);
const [MY_TOKENS, THEIR_TOKENS, OTHER_MINT, JUPITER] = [key(34), key(35), key(36), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address];
const SIGNATURE = new Uint8Array(64).fill(7);

type Side = { lamports?: Partial<Record<Address, [bigint, bigint]>>; tokens?: { address: Address; mint: Address; owner: Address; before: bigint | null; after: bigint | null; decimals?: number }[] };

// A transaction of these instructions, paid by `payer` and signed, as Helius gives it back: its meta built from the
// balances given, by address (every other account's unchanged at 1 SOL).
function item(instructions: Instruction[], payer: Address, side: Side = {}, extra: { err?: unknown; fee?: number } = {}) {
    const compiled = compileTransaction(
        pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
        ),
    );
    const signatures = Object.fromEntries(Object.keys(compiled.signatures).map((a) => [a, SIGNATURE]));
    const bytes = getTransactionEncoder().encode({ ...compiled, signatures } as never);
    const accounts = accountsOf(new Uint8Array(bytes));
    const fee = BigInt(extra.fee ?? 5000);
    const sol = (i: number) => side.lamports?.[accounts[i]] ?? [1_000_000_000n, 1_000_000_000n - (i === 0 ? fee : 0n)]; // the payer pays the fee
    const tokens = (when: 'before' | 'after') =>
        (side.tokens ?? []).filter((t) => t[when] !== null).map((t) => ({ accountIndex: accounts.indexOf(t.address), mint: t.mint, owner: t.owner, uiTokenAmount: { amount: String(t[when]), decimals: t.decimals ?? 6 } }));
    return {
        transaction: [getBase64Decoder().decode(bytes), 'base64'],
        slot: 400_000_000,
        blockTime: 1_791_236_675,
        meta: {
            err: extra.err ?? null,
            fee: extra.fee ?? 5000,
            preBalances: accounts.map((_, i) => Number(sol(i)[0])),
            postBalances: accounts.map((_, i) => Number(sol(i)[1])),
            preTokenBalances: tokens('before'),
            postTokenBalances: tokens('after'),
            loadedAddresses: { writable: [], readonly: [] },
        },
    };
}

// The accounts of a v0 transaction with no tables, in its order.
function accountsOf(bytes: Uint8Array): Address[] {
    const message = getTransactionDecoder().decode(bytes).messageBytes;
    // version byte, 3 header bytes, then a short-vec count (one byte here) and the addresses
    const count = message[4];
    return Array.from({ length: count }, (_, i) => getBase58Decoder().decode(message.slice(5 + 32 * i, 5 + 32 * (i + 1))) as Address);
}

async function landed(...items: unknown[]): Promise<Landed[]> {
    const page = await readPage({ result: { data: items, paginationToken: '1:2' } });
    return page.items.map((i) => {
        if ('unreadable' in i) throw new Error(i.unreadable);
        return i;
    });
}

const send = (from: Address, to: Address, sol: bigint) => getTransferSolInstruction({ source: createNoopSigner(from), destination: to, amount: lamports(sol) });
const sendTokens = (source: Address, destination: Address, authority: Address, units: bigint, mint = MINT) => getTransferCheckedInstruction({ source, mint, destination, authority: createNoopSigner(authority), amount: units, decimals: 6 });

test('a page: each transaction whole, its signature and accounts, exact lamports past 2^53, where the next starts', async () => {
    const big = 2n ** 60n + 1n;
    const text = JSON.stringify({ result: { data: [item([send(WALLET, FRIEND, 1n)], WALLET)], paginationToken: '449187227:567' } }).replace(/"postBalances":\[(\d+)/, `"postBalances":[${big}`);
    const page = await readPage(exactJson(text));
    const [t] = page.items as Landed[];
    assert.equal(t.signature, getBase58Decoder().decode(SIGNATURE));
    assert.deepEqual(t.accounts.slice(0, 2), [WALLET, FRIEND]);
    assert.equal(t.lamports.after[0], big);
    assert.equal(t.fee, 5000n);
    assert.equal(t.time, 1_791_236_675);
    assert.equal(page.next, '449187227:567');
    assert.equal((await readPage({ result: { data: [], paginationToken: '1:2' } })).next, null); // nothing after the last
    assert.deepEqual(exactJson('{"a":1e20,"b":12345678901234567890.0,"c":9007199254740993}'), { a: 1e20, b: 12345678901234567000, c: 9007199254740993n }); // only whole digits become exact
    assert.equal((await readPage({ result: { data: [item([send(WALLET, FRIEND, 1n)], WALLET)], paginationToken: 'x' } })).next, null);
});

test('an RPC without the method says so; what does not hold is unreadable, the rest read', async () => {
    await assert.rejects(readPage({ error: { code: -32601, message: 'Method not found' } }), NoHistory);
    await assert.rejects(readPage({ error: { code: -32005, message: 'rate limited' } }), /rate limited/);
    const good = item([send(WALLET, FRIEND, 1n)], WALLET);
    const short = { ...good, meta: { ...good.meta, postBalances: good.meta.postBalances.slice(1) } };
    const outOfRange = { ...good, meta: { ...good.meta, preTokenBalances: [{ accountIndex: 99, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '1', decimals: 6 } }] } };
    const tables = { ...good, meta: { ...good.meta, loadedAddresses: { writable: [FRIEND], readonly: [] } } };
    const garbled = { ...good, transaction: ['AAAA', 'base64'] };
    const unsigned = { ...good, transaction: [getBase64Decoder().decode(getTransactionEncoder().encode({ ...compileTransaction(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(WALLET, m), (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m), (m) => appendTransactionMessageInstructions([send(WALLET, FRIEND, 1n)], m))) })), 'base64'] };
    const page = await readPage({ result: { data: [short, outOfRange, tables, garbled, unsigned, good] } });
    assert.deepEqual(
        page.items.map((i) => ('unreadable' in i ? i.unreadable : 'read')),
        ['balances do not match the accounts', 'bad token account index', 'lookup accounts do not match the message', 'malformed transaction', 'unsigned', 'read'],
    );
});

test('SOL sent and received: the other side, and the fee apart from what moved', async () => {
    const [sent, got, failed] = await landed(
        item([send(WALLET, FRIEND, 1_000_000n)], WALLET, { lamports: { [WALLET]: [5_000_000n, 3_995_000n], [FRIEND]: [0n, 1_000_000n] } }),
        item([send(FRIEND, WALLET, 2_000_000n)], FRIEND, { lamports: { [FRIEND]: [5_000_000n, 2_995_000n], [WALLET]: [0n, 2_000_000n] } }),
        item([send(WALLET, FRIEND, 1_000_000n)], WALLET, { lamports: { [WALLET]: [5_000_000n, 4_995_000n] } }, { err: { InstructionError: [0, { Custom: 1 }] } }),
    );
    const s = summarize(sent, WALLET);
    assert.deepEqual([s.kind, s.other, s.moves, s.fee, s.payer], ['send', FRIEND, [{ mint: null, units: -1_000_000n, decimals: 9 }], 5000n, WALLET]);
    const g = summarize(got, WALLET);
    assert.deepEqual([g.kind, g.other, g.moves, g.payer], ['receive', FRIEND, [{ mint: null, units: 2_000_000n, decimals: 9 }], FRIEND]);
    const f = summarize(failed, WALLET);
    assert.deepEqual([f.kind, f.error, f.moves], ['other', 'instruction 1: error 1', []]);
});

test('tokens sent, opening their account: the rent set apart, the owner on the other side', async () => {
    const open = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(WALLET), ata: THEIR_TOKENS, owner: FRIEND, mint: MINT });
    const [t] = await landed(
        item([open, sendTokens(MY_TOKENS, THEIR_TOKENS, WALLET, 12_000_000n)], WALLET, {
            lamports: { [WALLET]: [10_000_000n, 7_955_720n], [THEIR_TOKENS]: [0n, 2_039_280n] },
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 50_000_000n, after: 38_000_000n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: null, after: 12_000_000n },
            ],
        }),
    );
    const s = summarize(t, WALLET);
    assert.deepEqual([s.kind, s.other, s.moves, s.rent], ['send', FRIEND, [{ mint: MINT, units: -12_000_000n, decimals: 6 }], { yours: 0n, theirs: 2_039_280n, opened: 0n }]); // their account, paid for
});

test('a swap through a program; an account of yours closed, its rent back; Squads steps; a memo', async () => {
    // The pool's vault pays out what the wallet gets: a swap takes from someone, as a mint does not.
    const POOL = key(44);
    const swap = { programAddress: JUPITER, accounts: [{ address: WALLET, role: AccountRole.WRITABLE_SIGNER }, { address: MY_TOKENS, role: AccountRole.WRITABLE }, { address: POOL, role: AccountRole.WRITABLE }], data: new Uint8Array([1]) };
    const close = getCloseAccountInstruction({ account: MY_TOKENS, destination: WALLET, owner: createNoopSigner(WALLET) });
    const discriminator = createHash('sha256').update('global:proposal_approve').digest().subarray(0, 8);
    const approve = { programAddress: SQUADS_V4, accounts: [{ address: key(40), role: AccountRole.READONLY }, { address: WALLET, role: AccountRole.WRITABLE_SIGNER }, { address: key(41), role: AccountRole.WRITABLE }], data: new Uint8Array([...discriminator, 0]) };
    const note = { programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address, accounts: [], data: new TextEncoder().encode('rent for June') };
    const [swapped, closed, voted] = await landed(
        item([swap], WALLET, {
            lamports: { [WALLET]: [3_000_000_000n, 1_997_955_720n], [MY_TOKENS]: [0n, 2_039_280n] },
            tokens: [
                { address: MY_TOKENS, mint: OTHER_MINT, owner: WALLET, before: null, after: 150_000_000n },
                { address: POOL, mint: OTHER_MINT, owner: key(45), before: 900_000_000n, after: 750_000_000n },
            ],
        }),
        item([close], WALLET, {
            lamports: { [WALLET]: [1_000_000n, 3_034_280n], [MY_TOKENS]: [2_039_280n, 0n] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        item([approve, note], WALLET),
    );
    const s = summarize(swapped, WALLET);
    assert.deepEqual([s.kind, s.main, s.rent, s.moves], ['swap', JUPITER, { yours: 2_039_280n, theirs: 0n, opened: 0n }, [{ mint: null, units: -1_000_000_000n, decimals: 9 }, { mint: OTHER_MINT, units: 150_000_000n, decimals: 6 }]]);
    const c = summarize(closed, WALLET);
    assert.deepEqual([c.kind, c.rent, c.moves], ['other', { yours: -2_039_280n, theirs: 0n, opened: 0n }, []]);
    const v = summarize(voted, WALLET);
    assert.deepEqual([v.kind, v.squads, v.main, v.memo], ['other', ['approve'], SQUADS_V4, 'rent for June']);
});

test('a token made and minted to the wallet is a mint, its rent apart; one burned is a burn; SOL to a new wallet is sent', async () => {
    const [NEW_MINT, NEWCOMER] = [key(46), key(47)];
    const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
    // The new mint signs, as System's CreateAccount wants; InitializeMint2 (20) makes it a mint.
    const init = { programAddress: TOKEN, accounts: [{ address: NEW_MINT, role: AccountRole.WRITABLE_SIGNER }, { address: MY_TOKENS, role: AccountRole.WRITABLE }], data: new Uint8Array([20, 6]) };
    const burn = { programAddress: TOKEN, accounts: [{ address: MY_TOKENS, role: AccountRole.WRITABLE }, { address: WALLET, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([8]) };
    const [minted, burned, paid] = await landed(
        item([init], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n - 10_000n - 1_461_600n - 2_039_280n], [NEW_MINT]: [0n, 1_461_600n], [MY_TOKENS]: [0n, 2_039_280n] },
            tokens: [{ address: MY_TOKENS, mint: NEW_MINT, owner: WALLET, before: null, after: 1_000_000_000n }],
        }, { fee: 10_000 }),
        item([burn], WALLET, { tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 50n, after: 20n }] }),
        item([getTransferSolInstruction({ source: createNoopSigner(WALLET), destination: NEWCOMER, amount: 100_000_000n })], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 899_995_000n], [NEWCOMER]: [0n, 100_000_000n] },
        }),
    );
    const m = summarize(minted, WALLET);
    assert.deepEqual([m.kind, m.moves, m.rent, m.created], ['mint', [{ mint: NEW_MINT, units: 1_000_000_000n, decimals: 6 }], { yours: 2_039_280n, theirs: 0n, opened: 1_461_600n }, [NEW_MINT]]);
    assert.deepEqual([summarize(burned, WALLET).kind, summarize(burned, WALLET).moves], ['burn', [{ mint: MINT, units: -30n, decimals: 6 }]]);
    const p = summarize(paid, WALLET);
    assert.deepEqual([p.kind, p.other, p.rent.opened], ['send', NEWCOMER, 0n]); // it signed nothing: a payment, not rent
});

test('every instruction is read by the review\'s decoders: a delegate given or revoked, an authority, a nonce, an assign', async () => {
    const me = createNoopSigner(WALLET);
    const [approved, checked, revoked, handed, removed, nonce, assigned, made] = await landed(
        item([getApproveInstruction({ source: MY_TOKENS, delegate: FRIEND, owner: me, amount: 100_000_000n })], WALLET, { tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 5n, after: 5n }] }),
        item([getApproveCheckedInstruction({ source: MY_TOKENS, mint: OTHER_MINT, delegate: FRIEND, owner: me, amount: 7n, decimals: 9 })], WALLET),
        item([getRevokeInstruction({ source: MY_TOKENS, owner: me })], WALLET),
        item([getSetAuthorityInstruction({ owned: MY_TOKENS, owner: me, authorityType: AuthorityType.CloseAccount, newAuthority: FRIEND })], WALLET),
        item([getSetAuthorityInstruction({ owned: OTHER_MINT, owner: me, authorityType: AuthorityType.FreezeAccount, newAuthority: null })], WALLET),
        item([getAdvanceNonceAccountInstruction({ nonceAccount: key(48), nonceAuthority: me })], WALLET),
        item([getAssignInstruction({ account: me, programAddress: key(49) })], WALLET),
        item([getInitializeNonceAccountInstruction({ nonceAccount: key(48), nonceAuthority: WALLET })], WALLET),
    );
    // Read by the review's own decoders: each instruction by its name, accounts by role, arguments.
    const told = (l: Landed) => summarize(l, WALLET).instructions.map((i) => ({ name: i.name, accounts: Object.fromEntries(i.accounts.map((a) => [a.role, a.address])), args: Object.fromEntries(i.args.map((a) => [a.name, a.value])) }));
    assert.deepEqual(told(approved), [{ name: 'Approve', accounts: { source: MY_TOKENS, delegate: FRIEND, owner: WALLET }, args: { amount: '100000000' } }]);
    assert.deepEqual(told(checked)[0].name, 'ApproveChecked');
    assert.deepEqual(told(revoked)[0].name, 'Revoke');
    assert.deepEqual([told(handed)[0].name, told(handed)[0].args.newAuthority], ['SetAuthority', FRIEND]);
    assert.deepEqual([told(removed)[0].name, told(removed)[0].args.newAuthority], ['SetAuthority', 'none']);
    assert.deepEqual(told(nonce)[0], { name: 'AdvanceNonceAccount', accounts: told(nonce)[0].accounts, args: {} });
    assert.equal(told(assigned)[0].name, 'Assign');
    assert.deepEqual([told(made)[0].name, told(made)[0].args.nonceAuthority], ['InitializeNonceAccount', WALLET]);
    // The token accounts it lists, with their mints, for the words.
    assert.deepEqual(summarize(approved, WALLET).held, [{ address: MY_TOKENS, mint: MINT, decimals: 6, owner: WALLET }]);
});

test("rent stays the wallet's own: wrapping SOL, closing while sending, rent sent elsewhere, rent others pay", async () => {
    const [MY_WSOL, ELSEWHERE, RELAYER] = [key(42), key(43), key(44)];
    const WSOL = 'So11111111111111111111111111111111111111112' as Address;
    const RENT = 2_039_280n;
    const open = (ata: Address, owner: Address, mint: Address, payer = WALLET) => getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner, mint });
    const close = (to: Address) => getCloseAccountInstruction({ account: MY_TOKENS, destination: to, owner: createNoopSigner(WALLET) });
    const [wrap, closeAndSend, closedAway, relayed, opened] = await landed(
        // 1 SOL wrapped into a wSOL account the wallet opens
        item([open(MY_WSOL, WALLET, WSOL), send(WALLET, MY_WSOL, 1_000_000_000n)], WALLET, {
            lamports: { [WALLET]: [3_000_000_000n, 3_000_000_000n - 1_000_000_000n - RENT - 5000n], [MY_WSOL]: [0n, 1_000_000_000n + RENT] },
            tokens: [{ address: MY_WSOL, mint: WSOL, owner: WALLET, before: null, after: 1_000_000_000n, decimals: 9 }],
        }),
        // an empty account closed, its rent back, and 0.1 SOL sent
        item([close(WALLET), send(WALLET, FRIEND, 100_000_000n)], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n + RENT - 100_000_000n - 5000n], [MY_TOKENS]: [RENT, 0n], [FRIEND]: [0n, 100_000_000n] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        // closed, its rent sent to another address
        item([close(ELSEWHERE)], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n - 5000n], [MY_TOKENS]: [RENT, 0n], [ELSEWHERE]: [0n, RENT] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        // a relayer pays the fee; the wallet opens its friend's account and sends 12
        item([open(THEIR_TOKENS, FRIEND, MINT), sendTokens(MY_TOKENS, THEIR_TOKENS, WALLET, 12_000_000n)], RELAYER, {
            lamports: { [RELAYER]: [1_000_000_000n, 1_000_000_000n - 5000n], [WALLET]: [1_000_000_000n, 1_000_000_000n - RENT], [THEIR_TOKENS]: [0n, RENT] },
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 50_000_000n, after: 38_000_000n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: null, after: 12_000_000n },
            ],
        }),
        // someone sends the wallet 12, opening its account themselves
        item([open(MY_TOKENS, WALLET, MINT, FRIEND), sendTokens(THEIR_TOKENS, MY_TOKENS, FRIEND, 12_000_000n)], FRIEND, {
            lamports: { [FRIEND]: [1_000_000_000n, 1_000_000_000n - RENT - 5000n], [MY_TOKENS]: [0n, RENT] },
            tokens: [
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: 50_000_000n, after: 38_000_000n },
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: null, after: 12_000_000n },
            ],
        }),
    );
    const sum = (t: Landed) => {
        const s = summarize(t, WALLET);
        return [s.kind, s.moves.map((m) => `${m.mint === null ? 'SOL' : m.mint === WSOL ? 'wSOL' : 'token'} ${m.units}`), s.rent.yours, s.rent.theirs];
    };
    assert.deepEqual(sum(wrap), ['swap', ['SOL -1000000000', 'wSOL 1000000000'], RENT, 0n]);
    assert.deepEqual(sum(closeAndSend), ['send', ['SOL -100000000'], -RENT, 0n]);
    assert.deepEqual(sum(closedAway), ['send', ['SOL -2039280'], -RENT, 0n]);
    assert.equal(summarize(closedAway, WALLET).other, ELSEWHERE);
    assert.deepEqual(sum(relayed), ['send', ['token -12000000'], 0n, RENT]);
    assert.deepEqual(sum(opened), ['receive', ['token 12000000'], RENT, 0n]);
});
