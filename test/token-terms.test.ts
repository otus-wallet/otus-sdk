// What a token's mint lets others do with tokens of yours, read in the review: a permanent delegate over the tokens you
// get, and an account of yours left frozen.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getFreezeAccountInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { address, AccountRole, createNoopSigner, getAddressEncoder, type Address, type Instruction } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../src/programs/core.ts';
import { review } from '../src/review/review.ts';
import { account, ATTACKER, fakeChain, key, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL = 1_000_000_000n;
const FEE = 5_000n;
const RENT = 2_039_280n;
const bytes = (a: Address) => [...getAddressEncoder().encode(a)];

// A mint's 82 bytes, its freeze authority set or not; Token-2022's with its extensions after them.
function base(freezer?: Address) {
    const d = new Uint8Array(82);
    d[44] = 6;
    d[45] = 1;
    if (freezer) d.set([1, 0, 0, 0, ...bytes(freezer)], 46);
    return d;
}
function extended(extensions: [number, number[]][]) {
    const tlv = extensions.flatMap(([type, value]) => [type & 0xff, type >> 8, value.length & 0xff, value.length >> 8, ...value]);
    const d = new Uint8Array(166 + tlv.length);
    d.set(base(), 0);
    d[165] = 1;
    d.set(tlv, 166);
    return d;
}

const [mint22, sender, mine] = [key(70), key(71), key(72)];
const mintOf = (delegate: Address | null) => account(mint22, TOKEN_2022_PROGRAM_ADDRESS, RENT, extended(delegate ? [[12, bytes(delegate)]] : []));
const holding = (a: Address, owner: Address, amount: bigint) => account(a, TOKEN_2022_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: mint22, owner, amount }));

// 5 tokens come to an account opened for you, from someone else's; the mint in the transaction, or only on chain.
async function received(delegate: Address | null, inTransaction = true) {
    const ix: Instruction = inTransaction
        ? getTransferCheckedInstruction({ source: sender, mint: mint22, destination: mine, authority: createNoopSigner(ATTACKER), amount: 5n, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })
        : { programAddress: key(75), accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }, { address: mine, role: AccountRole.WRITABLE }], data: new Uint8Array([1]) };
    const before = [account(PAYER, SYSTEM, SOL), holding(sender, ATTACKER, 10n), mintOf(delegate)];
    const after = [account(PAYER, SYSTEM, SOL - FEE), holding(sender, ATTACKER, 5n), holding(mine, PAYER, 5n), mintOf(delegate)];
    const r = await review(transaction([ix]), { wallet: PAYER, signedBefore: 0 }, fakeChain(before, after));
    return r.assessment.findings;
}

test("tokens you get whose mint has a permanent delegate: someone else can take them, said with who", async () => {
    const found = await received(ATTACKER);
    const lent = found.find((f) => f.code === 'permanent-delegate');
    assert.deepEqual([lent?.level, lent?.subject], ['warn', mine]);
    assert.match(lent?.note ?? '', new RegExp(`^${ATTACKER}, this token's permanent delegate`));
    assert.ok(!found.some((f) => f.code === 'no-authority-change'), 'no "No owner or authority changes" beside it');
    // Read from the chain when the transaction doesn't load the mint.
    assert.ok((await received(ATTACKER, false)).some((f) => f.code === 'permanent-delegate'));
    // None, or you: nothing to say.
    for (const delegate of [null, PAYER]) {
        const quiet = await received(delegate);
        assert.ok(!quiet.some((f) => f.code === 'permanent-delegate'), String(delegate));
        assert.ok(quiet.some((f) => f.code === 'no-authority-change'), String(delegate));
    }
});

test('an account of yours left frozen: said, naming who can thaw it; one frozen already is not news', async () => {
    const [mint, held] = [key(73), key(74)];
    const freeze = getFreezeAccountInstruction({ account: held, mint, owner: createNoopSigner(ATTACKER) });
    const frozen = (was: boolean) =>
        review(
            transaction([freeze]),
            { wallet: PAYER, signedBefore: 0 },
            fakeChain(
                [account(PAYER, SYSTEM, SOL), account(mint, TOKEN, RENT, base(ATTACKER)), account(held, TOKEN, RENT, tokenAccountData({ mint, owner: PAYER, amount: 100n, frozen: was }))],
                [account(PAYER, SYSTEM, SOL - FEE), account(mint, TOKEN, RENT, base(ATTACKER)), account(held, TOKEN, RENT, tokenAccountData({ mint, owner: PAYER, amount: 100n, frozen: true }))],
            ),
        ).then((r) => r.assessment.findings);
    const found = await frozen(false);
    const f = found.find((x) => x.code === 'frozen');
    assert.deepEqual([f?.level, f?.subject, f?.note], ['warn', held, `Its tokens can't move until ${ATTACKER} thaws it`]);
    assert.ok(!found.some((x) => x.code === 'no-authority-change'));
    assert.ok(!(await frozen(true)).some((x) => x.code === 'frozen'));
});
