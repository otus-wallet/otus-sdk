import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
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
    isAddress,
    type Address,
    type Instruction,
} from '@solana/kit';

import { exactJson, NoHistory, readPage, type Landed } from '../src/activity/history.ts';
import { dust, harmless } from '../src/activity/dust.ts';
import { summarize, type Activity, type Told } from '../src/activity/summary.ts';
import { rows, text, type Naming } from '../src/activity/words.ts';
import { short } from '../src/format.ts';
import { SQUADS_V4 } from '../src/programs/squads.ts';
import { SENDER_TIPS } from '../src/programs/addresses.ts';
import { key, MINT } from './helpers.ts';

// The wallet: a key's address, on the curve, as a wallet that signs has; a program's address never signs.
const WALLET = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
const [FRIEND, PAYER] = [key(32), key(33)];
const [MY_TOKENS, THEIR_TOKENS, OTHER_MINT, JUPITER] = [key(34), key(35), key(36), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address];
const SIGNATURE = new Uint8Array(64).fill(7);

type Side = { lamports?: Partial<Record<Address, [bigint, bigint]>>; tokens?: { address: Address; mint: Address; owner: Address; before: bigint | null; after: bigint | null; decimals?: number }[] };

// A transaction of these instructions, paid by `payer` and signed, as Helius gives it back: its meta built from the
// balances given, by address (every other account's unchanged at 1 SOL).
function item(instructions: Instruction[], payer: Address, side: Side = {}, extra: { err?: unknown; fee?: number; inner?: unknown[] } = {}) {
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
            ...(extra.inner && { innerInstructions: extra.inner }),
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

test('address poisoning: dust from a copy is caught against an address you know, or one that paid you on the page', async () => {
    // A copy: the real address's first and last four characters around another's middle, as poisoners grind them.
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const [t] = await landed(
        item([sendTokens(THEIR_TOKENS, MY_TOKENS, copy, 100n)], copy, {
            tokens: [
                { address: THEIR_TOKENS, mint: MINT, owner: copy, before: 1_000n, after: 900n },
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 5n, after: 105n },
            ],
        }),
    );
    const dust = summarize(t, WALLET);
    assert.deepEqual([dust.kind, dust.other], ['receive', copy]);
    const naming = (known: Address[]): Naming => ({ wallet: WALLET, symbol: () => 'USDT', who: (a) => a, program: (a) => a, known });
    const flagged = (list: Activity[], known: Address[]) => rows(list, naming(known)).map((r) => r.address?.copy);
    assert.deepEqual(flagged([dust], [FRIEND, real]), [true]); // a known address it copies
    const [caught] = rows([dust], naming([FRIEND, real]));
    // The line says it copies, so the details don't again.
    assert.deepEqual([caught.address?.copies, text(caught.sub), caught.details.filter((d) => d.copy)], [real, `from ${copy} · copies ${real}`, []]);
    assert.deepEqual(flagged([dust], [FRIEND, copy]), [false]); // the very address, known: not a copy
    assert.deepEqual(flagged([dust], []), [false]); // nothing to copy
    // Not known: 30,000 from the real one, then dust from its copy, as the user's history shows.
    const paid: Activity = { ...dust, signature: 'paid', other: real, payer: real, moves: [{ mint: MINT, units: 30_000_000_000n, decimals: 6 }] };
    assert.deepEqual(flagged([dust, paid], []), [true, false]);
    assert.equal(text(rows([dust, paid], naming([]))[0].sub), `from ${copy} · copies ${real}`); // whole: the caller cuts them
});

test('rows: each in a line, opened for all it told; a copy of an address you sent to on the page caught', () => {
    const base = { signatures: {}, slot: 1n, time: 1_791_236_675, error: null, fee: 5000n, tip: 0n, payer: WALLET, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], instructions: [] as Told[], held: [], fresh: [] as Address[], staked: 0n, signed: true, programs: [] as Address[], unknown: [] as Address[], through: [], main: null, squads: [], memo: null, inner: [] };
    const naming: Naming = { wallet: WALLET, symbol: (m) => (m === MINT ? 'USDC' : m), who: (a) => (a === WALLET ? `${a} (you)` : a === FRIEND ? 'Fio' : a), program: (a) => (a === JUPITER ? 'Jupiter v6' : a), known: [] };
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const [swap, sent, dust, failed, unread] = rows(
        [
            { ...base, signature: 's1', kind: 'swap', other: null, main: JUPITER, programs: [JUPITER], moves: [{ mint: null, units: -1_000_000_000n, decimals: 9 }, { mint: MINT, units: 120_580_000n, decimals: 6 }] },
            { ...base, signature: 's2', kind: 'send', other: real, moves: [{ mint: MINT, units: -12_000_000n, decimals: 6 }], rent: { yours: 0n, theirs: 2_039_280n, opened: 0n } },
            { ...base, signature: 's3', kind: 'receive', other: copy, payer: copy, signed: false, moves: [{ mint: MINT, units: 100n, decimals: 6 }] },
            { ...base, signature: 's4', kind: 'other', error: 'instruction 2: error 6001', main: JUPITER, programs: [JUPITER], other: null, moves: [] },
            { unreadable: 'no meta' },
        ],
        naming,
    );
    assert.deepEqual([swap.icon, text(swap.title), text(swap.sub)], ['swap', 'Swap 1 SOL → 120.58 USDC', 'Jupiter v6']);
    assert.deepEqual(swap.title.filter((p) => p.way), [{ text: '1 SOL', way: 'out' }, { text: '120.58 USDC', way: 'in' }]); // coloured apart
    assert.deepEqual([text(sent.title), text(sent.sub), sent.address], ['Sent 12 USDC', `to ${real}`, { label: 'To', address: real, name: null, copy: false, copies: null }]);
    assert.deepEqual(sent.details.map((d) => d.text), ['0.00203928 SOL to open their token account', `Fee 0.000005 SOL, paid by ${WALLET} (you)`]); // your address, tagged; the 12 USDC the line says, not again
    assert.ok(!swap.details.some((d) => d.way)); // both its balances in the line: not again
    assert.deepEqual([dust.tone, text(dust.title), text(dust.sub)], ['warn', 'Received 0.0001 USDC', `from ${copy} · copies ${real}`]);
    assert.ok(!dust.details.some((d) => d.copy)); // the line says it copies
    // Through a program Otus doesn't know, the line can't say whom: the details say what it copies, and that it is no
    // dust, as it came with something that could hurt.
    const STRANGE = key(80);
    const [unknownCopy] = rows([{ ...base, signature: 's6', kind: 'receive', other: copy, payer: copy, signed: false, programs: [STRANGE], unknown: [STRANGE], instructions: [{ program: STRANGE, name: 'Unknown', source: 'unknown', args: [], accounts: [] }] as unknown as Told[], moves: [{ mint: MINT, units: 100n, decimals: 6 }] }, { ...base, signature: 's7', kind: 'send', other: real, moves: [{ mint: MINT, units: -1n, decimals: 6 }] }], naming);
    assert.deepEqual(unknownCopy.details.filter((d) => d.copy).map((d) => d.text), [`From ${copy}, made to look like ${real}: never send to it`]);
    assert.equal(dust.details.find((d) => d.text.startsWith('Fee'))?.text, `Fee 0.000005 SOL, paid by ${copy}`);
    assert.equal(dust.address?.copy, true);
    assert.deepEqual([failed.icon, failed.tone, text(failed.title), failed.details[0].text], ['cross', 'danger', 'Failed · Jupiter v6', 'Failed: instruction 2: error 6001']);
    assert.deepEqual([text(unread.title), unread.signature], ["Otus couldn't read this one", null]);
    assert.deepEqual([swap.subject, failed.subject, unread.subject], [null, null, null]); // told by its balances, its failure, or not at all
    // A swap of tokens with a tip in SOL: led by the token.
    const [tipped] = rows([{ ...base, signature: 's5', kind: 'swap', other: null, moves: [{ mint: null, units: -1000n, decimals: 9 }, { mint: OTHER_MINT, units: -5n, decimals: 0 }, { mint: MINT, units: 2_000_000n, decimals: 6 }] }], naming);
    assert.equal(text(tipped.title), `Swap 5 ${OTHER_MINT} → 2 USDC`); // what else moved is in the details, not counted
    // The +1 the line left out; and the token the line shows only by its address, again, for a page to show it whole.
    assert.deepEqual(tipped.details.filter((d) => d.way).map((d) => [d.text, d.again ?? false]), [['−0.000001 SOL', false], [`−5 ${OTHER_MINT}`, true]]);
});

test('a token made and minted, one burned, an account opened: said as such, rent apart', () => {
    const base = { signatures: {}, slot: 1n, time: 1_791_236_675, error: null, fee: 5000n, tip: 0n, payer: WALLET, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], instructions: [] as Told[], held: [], fresh: [] as Address[], staked: 0n, signed: true, programs: [] as Address[], unknown: [] as Address[], through: [], main: null, squads: [], memo: null, inner: [], other: null };
    const naming: Naming = { wallet: WALLET, symbol: (m) => (m === MINT ? 'USDC' : 'LAB'), who: (a) => short(a), program: (a) => short(a), known: [] };
    const made = key(62);
    const [minted, burned, opened] = rows(
        [
            { ...base, signature: 'm1', kind: 'mint', created: [made], moves: [{ mint: made, units: 1_000_000_000n, decimals: 6 }], rent: { yours: 2_039_280n, theirs: 0n, opened: 1_461_600n } },
            { ...base, signature: 'm2', kind: 'burn', moves: [{ mint: MINT, units: -30_000_000n, decimals: 6 }] },
            { ...base, signature: 'm3', kind: 'other', moves: [], rent: { yours: 0n, theirs: 0n, opened: 1_447_680n } },
        ],
        naming,
    );
    assert.deepEqual([minted.icon, text(minted.title), text(minted.sub)], ['plus', 'Minted 1,000 LAB', 'New token']);
    assert.ok(minted.details.some((d) => d.text === '0.0014616 SOL of rent in the accounts it opened'));
    assert.deepEqual([burned.icon, text(burned.title)], ['trash', 'Burned 30 USDC']);
    assert.deepEqual([text(opened.title), text(opened.sub)], ['Opened an account', '0.00144768 SOL of rent']);
});

test('what moved no balance: told by the review\'s decoders and words; never named by limits or guards', () => {
    const [SYSTEM, TOKEN, BUDGET, GUARD] = ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ComputeBudget111111111111111111111111111111', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'] as Address[];
    const ix = (program: Address, name: string, accounts: Record<string, Address>, args: Record<string, string> = {}): Told => ({ program, programName: null, source: 'plugin', name, accounts: Object.entries(accounts).map(([role, address]) => ({ role, address })), args: Object.entries(args).map(([name, value]) => ({ name, value })) });
    const limit = ix(BUDGET, 'SetComputeUnitLimit', {}, { units: '200000' });
    const guard: Told = { program: GUARD, programName: null, source: 'unknown', name: 'Unknown instruction', accounts: [], args: [] };
    const mine = key(70);
    const base = { signatures: {}, slot: 1n, time: 1_791_236_675, error: null, fee: 5000n, tip: 0n, payer: WALLET, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], held: [{ address: mine, mint: MINT, decimals: 6, owner: WALLET }], fresh: [] as Address[], staked: 0n, signed: true, programs: [] as Address[], unknown: [] as Address[], through: [], main: null, squads: [], memo: null, inner: [], other: null, kind: 'other' as const, moves: [] };
    const naming: Naming = { wallet: WALLET, symbol: (m) => (m === MINT ? 'USDC' : short(m)), who: (a) => (a === FRIEND ? 'Fio' : short(a)), program: (a) => short(a), known: [] };
    const [approved, closer, cancelled, nonceAccount] = rows(
        [
            { ...base, signature: 'a1', instructions: [limit, ix(TOKEN, 'Approve', { source: mine, delegate: FRIEND, owner: WALLET }, { amount: '100000000' }), guard] },
            { ...base, signature: 'a2', instructions: [ix(TOKEN, 'SetAuthority', { owned: mine, owner: WALLET }, { authorityType: '3', newAuthority: FRIEND })] },
            { ...base, signature: 'a3', instructions: [limit, ix(SYSTEM, 'AdvanceNonceAccount', { nonceAccount: key(71) })] },
            { ...base, signature: 'a4', instructions: [ix(SYSTEM, 'CreateAccount', { payer: WALLET, newAccount: key(71) }, { lamports: '1447680', space: '80', programAddress: SYSTEM }), ix(SYSTEM, 'InitializeNonceAccount', { nonceAccount: key(71) }, { nonceAuthority: WALLET })] },
        ],
        naming,
    );
    assert.deepEqual([approved.icon, text(approved.title), text(approved.sub)], ['key', 'Approved a delegate', 'Fio, up to 100 USDC']);
    assert.deepEqual([approved.subject, nonceAccount.subject], [{ program: TOKEN, name: 'Approve' }, { program: SYSTEM, name: 'InitializeNonceAccount' }]); // what the line is about: not the limits or guards around it
    assert.equal(approved.details[0].text, 'Fio may move up to 100 USDC from your USDC account'); // the review's own words
    assert.deepEqual([text(closer.title), text(closer.sub)], ['Changed an authority', 'Right to close → Fio']);
    assert.deepEqual([cancelled.icon, text(cancelled.title)], ['refresh', 'Moved a nonce on']);
    assert.equal(cancelled.details[0].text, `Moves the nonce of ${short(key(71))} on: what was signed on it can no longer run`); // not first: no durable nonce
    // An approval made on the way of a send: still told, and the row marked; one made in a failed transaction: none of it
    // happened. The approval before the wrapped SOL it syncs is what the line is about.
    const unlimited = ix(TOKEN, 'Approve', { source: mine, delegate: FRIEND, owner: WALLET }, { amount: '18446744073709551615' });
    const [sentAndApproved, failedApproval, synced] = rows(
        [
            { ...base, signature: 'a5', kind: 'send', other: FRIEND, moves: [{ mint: null, units: -1000n, decimals: 9 }], instructions: [ix(SYSTEM, 'TransferSol', { source: WALLET, destination: FRIEND }, { amount: '1000' }), unlimited] },
            { ...base, signature: 'a6', error: 'instruction 0: error 4', instructions: [unlimited] },
            { ...base, signature: 'a7', instructions: [ix(TOKEN, 'Approve', { source: mine, delegate: FRIEND, owner: WALLET }, { amount: '100000000' }), ix(TOKEN, 'SyncNative', { account: mine })] },
        ],
        naming,
    );
    const approval = sentAndApproved.details.find((d) => /Fio may move/.test(d.text));
    assert.ok(approval && approval.tone, JSON.stringify(sentAndApproved.details));
    assert.ok(!sentAndApproved.details.some((d) => /SOL from/.test(d.text) && !d.way)); // the transfer itself: its balance line only
    assert.deepEqual([approval.text, approval.tone, sentAndApproved.tone], ['Fio may move all your USDC, with no limit and at any time', 'warn', 'warn']);
    assert.deepEqual([text(failedApproval.title), failedApproval.details.filter((d) => /Fio/.test(d.text))], ['Failed', []]);
    assert.equal(text(synced.title), 'Approved a delegate');
    assert.deepEqual([text(nonceAccount.title), text(nonceAccount.sub), nonceAccount.details[0].text, nonceAccount.details[1].text], ['Opened a nonce account', `Nonce ${short(key(71))}, used by ${short(WALLET)}`, `Nonce ${short(key(71))} owned by ${short(SYSTEM)}`, `Only ${short(WALLET)} can use it`]);
});

test('what left the wallet unsigned, a delegate moved: told apart, and never taken as an address you know', async () => {
    const [DELEGATE, copy] = [key(45), key(46)];
    const [taken] = await landed(
        item([sendTokens(MY_TOKENS, THEIR_TOKENS, DELEGATE, 1n)], DELEGATE, {
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 5n, after: 4n },
                { address: THEIR_TOKENS, mint: MINT, owner: copy, before: 0n, after: 1n },
            ],
        }),
    );
    const a = summarize(taken, WALLET);
    assert.deepEqual([a.kind, a.signed, a.other], ['send', false, copy]);
    // A program's address (a Squads vault) never signs: its program moves it, no delegate.
    const vault = (await import('@solana/kit')).getProgramDerivedAddress;
    const [VAULT] = await vault({ programAddress: SQUADS_V4, seeds: ['vault'] });
    const [byProgram] = await landed(
        item([{ programAddress: SQUADS_V4, accounts: [{ address: VAULT, role: AccountRole.WRITABLE }, { address: key(47), role: AccountRole.WRITABLE }, { address: THEIR_TOKENS, role: AccountRole.WRITABLE }], data: new Uint8Array(8) }], PAYER, {
            tokens: [
                { address: key(47), mint: MINT, owner: VAULT, before: 5n, after: 4n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: 0n, after: 1n },
            ],
        }, { inner: [] }),
    );
    assert.deepEqual([summarize(byProgram, VAULT).kind, summarize(byProgram, VAULT).signed], ['send', true]);
    const naming: Naming = { wallet: WALLET, symbol: () => 'USDC', who: short, program: short, known: [] };
    const [row] = rows([a], naming);
    assert.deepEqual([row.tone, text(row.title)], ['warn', 'Moved 0.000001 USDC']);
    assert.equal(row.details.find((d) => d.tone === 'warn')?.text, "You didn't sign it: a delegate of your tokens moved them");
});

test("a vault's own is what its program ran: a stranger's transfer to it is not, and may be dust", async () => {
    const [VAULT] = await (await import('@solana/kit')).getProgramDerivedAddress({ programAddress: SQUADS_V4, seeds: ['vault'] });
    // The vault's real neighbour, and a copy of it a poisoner ground.
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const tiny: Side = { lamports: { [VAULT]: [4_000_000_000n, 4_000_001_000n], [copy]: [1_000_000_000n, 999_994_000n] } };
    // Only the System Program ran, nothing inside it: the vault's program didn't, so the vault didn't sign.
    const [deposit] = await landed(item([send(copy, VAULT, 1000n)], copy, tiny, { inner: [] }));
    const a = summarize(deposit, VAULT);
    assert.deepEqual([a.kind, a.signed, harmless(a)], ['receive', false, true]);
    assert.deepEqual(dust(a, { known: [VAULT, real] }), { copy, of: real });
    // What ran inside it unknown: anything may have acted for the vault, so it stays its own.
    const [unknownInside] = await landed(item([send(copy, VAULT, 1000n)], copy, tiny));
    assert.deepEqual([summarize(unknownInside, VAULT).signed, harmless(summarize(unknownInside, VAULT))], [true, false]);
    // Its tokens moved by the Token Program alone: a delegate did, as for any wallet that didn't sign.
    const DELEGATE = key(45);
    const [taken] = await landed(
        item([sendTokens(key(47), THEIR_TOKENS, DELEGATE, 1n)], DELEGATE, {
            tokens: [
                { address: key(47), mint: MINT, owner: VAULT, before: 5n, after: 4n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: 0n, after: 1n },
            ],
        }, { inner: [] }),
    );
    const t = summarize(taken, VAULT);
    assert.deepEqual([t.kind, t.signed], ['send', false]);
    const [row] = rows([t], { wallet: VAULT, symbol: () => 'USDC', who: short, program: short, known: [] });
    assert.equal(row.details.find((d) => d.tone === 'warn')?.text, "You didn't sign it: a delegate of your tokens moved them");
});

test("a tip paid to land it is told apart, as the fee: never a balance, nor a send", async () => {
    const LEND = key(48);
    const [MY_LEND, POOL, POOL_LEND, POOL_USDC] = [key(49), key(50), key(51), key(52)];
    const swap = (to: Address, err?: unknown) =>
        item(
            [sendTokens(MY_LEND, POOL_LEND, WALLET, 973_158n, LEND), sendTokens(POOL_USDC, MY_TOKENS, POOL, 1_035_447n), send(WALLET, to, 10_000n)],
            WALLET,
            {
                lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n - 10_000n - 5000n] },
                tokens: [
                    { address: MY_LEND, mint: LEND, owner: WALLET, before: 973_158n, after: 0n },
                    { address: POOL_LEND, mint: LEND, owner: POOL, before: 0n, after: 973_158n },
                    { address: POOL_USDC, mint: MINT, owner: POOL, before: 5_000_000n, after: 3_964_553n },
                    { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: 1_035_447n },
                ],
            },
            { inner: [], ...(err !== undefined && { err }) },
        );
    const [tipped, other] = await landed(swap(SENDER_TIPS[3]!), swap(FRIEND));
    const a = summarize(tipped, WALLET);
    assert.deepEqual([a.kind, a.tip, a.moves.map((m) => m.mint)], ['swap', 10_000n, [LEND, MINT]]);
    const naming: Naming = { wallet: WALLET, symbol: (m) => (m === MINT ? 'USDC' : 'jlUSDC'), who: short, program: short, known: [] };
    const [row] = rows([a], naming);
    assert.equal(text(row.title), 'Swap 0.973158 jlUSDC → 1.035447 USDC');
    assert.ok(row.details.some((d) => d.text === 'Tip 0.00001 SOL to land it') && !row.details.some((d) => d.way), JSON.stringify(row.details));
    // The same SOL to anyone else is SOL sent.
    const b = summarize(other, WALLET);
    assert.deepEqual([b.tip, b.moves[0]], [0n, { mint: null, units: -10_000n, decimals: 9 }]);
});

test("a token no list vouches for goes by its maker's name, and the details say which one it is, whole", () => {
    const base = { signatures: {}, slot: 1n, time: 1_791_236_675, error: null, fee: 5000n, tip: 0n, payer: FRIEND, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], instructions: [] as Told[], held: [], fresh: [] as Address[], staked: 0n, signed: false, programs: [] as Address[], unknown: [] as Address[], through: [], main: null, squads: [], memo: null, inner: [], other: FRIEND };
    const got: Activity = { ...base, signature: 'u1', kind: 'receive', moves: [{ mint: OTHER_MINT, units: 5n, decimals: 0 }] };
    const naming = (symbol: string): Naming => ({ wallet: WALLET, symbol: (m) => (m === OTHER_MINT ? symbol : m), verified: (m) => m !== OTHER_MINT, who: short, program: short, known: [] });
    const [named] = rows([got], naming('PEPE2'));
    assert.equal(text(named.title), 'Received 5 PEPE2');
    assert.deepEqual(named.details.filter((d) => /verified|PEPE2/.test(d.text)).map((d) => d.text), [`PEPE2 is not verified: ${OTHER_MINT}`]);
    // With no name at all, its balance again, for the address whole: no line of its own.
    const [bare] = rows([got], naming(OTHER_MINT));
    assert.deepEqual(bare.details.filter((d) => d.text.includes(OTHER_MINT)).map((d) => [d.text, d.again]), [[`+5 ${OTHER_MINT}`, true]]);
    // A verified one: nothing more to say of it.
    const [verified] = rows([{ ...got, moves: [{ mint: MINT, units: 5n, decimals: 6 }] }], { ...naming('PEPE2'), symbol: (m) => (m === MINT ? 'USDC' : m) });
    assert.ok(!verified.details.some((d) => /verified/.test(d.text)));
});

