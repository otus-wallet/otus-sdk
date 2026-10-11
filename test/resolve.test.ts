import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import type { Chain } from '../src/chain.ts';
import { Refused } from '../src/errors.ts';
import { decode } from '../src/review/decode.ts';
import { LOOKUP_TABLE_PROGRAM, resolve, type Resolved } from '../src/review/resolve.ts';
import { account, fakeChain, key, lookupTable, PAYER, RECIPIENT, SYSTEM, TABLE, transfer, transferWithTable } from './helpers.ts';

const roles = (r: Resolved) => r.accounts.map((a) => [a.address, a.signer, a.writable, a.table]);
const table = (entries: Address[], owner: Address = LOOKUP_TABLE_PROGRAM) => account(TABLE, owner, 1n, lookupTable(entries));

test('static accounts take their roles from the header and their state from the chain', async () => {
    const r = await resolve(await decode(transfer()), fakeChain([account(PAYER, SYSTEM, 5_000_000n)]));
    assert.deepEqual(roles(r), [
        [PAYER, true, true, null],
        [RECIPIENT, false, true, null],
        [SYSTEM, false, false, null],
    ]);
    assert.equal(r.slot, 1n);
    assert.equal(r.accounts[0].state.exists, true);
    assert.equal(r.accounts[1].state.exists, false);
});

test('accounts from a lookup table follow the static ones', async () => {
    const r = await resolve(await decode(transferWithTable()), fakeChain([table([RECIPIENT])]));
    assert.deepEqual(roles(r), [
        [PAYER, true, true, null],
        [SYSTEM, false, false, null],
        [RECIPIENT, false, true, TABLE],
    ]);
});

test('refuses missing tables, missing entries and accounts loaded twice', async () => {
    const tx = await decode(transferWithTable());
    const cases: [Chain, RegExp][] = [
        [fakeChain([]), /not found/],
        [fakeChain([table([RECIPIENT], SYSTEM)]), /not found/],
        [fakeChain([table([])]), /no entry 0/],
        [fakeChain([table([PAYER])]), /appears twice/],
    ];
    for (const [chain, reason] of cases) {
        await assert.rejects(resolve(tx, chain), (e) => e instanceof Refused && reason.test(e.message), String(reason));
    }
});

test('a lookup table the chain keeps is read once; again only when an entry past what it kept is asked', async () => {
    const kept = new Map<Address, readonly Address[]>();
    const tables = { get: async (t: Address) => kept.get(t), set: (t: Address, e: readonly Address[]) => void kept.set(t, e) };
    const asked: Address[][] = [];
    const counting = (entries: Address[]): Chain => {
        const chain = fakeChain([table(entries)]);
        return { ...chain, tables, accounts: (addresses) => (asked.push([...addresses]), chain.accounts(addresses)) };
    };
    const tx = await decode(transferWithTable()); // entry 0 of TABLE
    await resolve(tx, counting([RECIPIENT]));
    assert.deepEqual(kept.get(TABLE), [RECIPIENT]);
    // Kept: only the transaction's own accounts are read; the table, even changed onchain, is not.
    const again = await resolve(tx, counting([key(40)]));
    assert.deepEqual([asked.length, asked[2].includes(TABLE), again.accounts.at(-1)?.address], [3, false, RECIPIENT]);
    // An entry past what was kept: the table is read again, and kept as it is now.
    kept.set(TABLE, []);
    await resolve(tx, counting([RECIPIENT, key(41)]));
    assert.deepEqual([asked.at(-2), kept.get(TABLE)], [[TABLE], [RECIPIENT, key(41)]]);
    // Not a table: refused, and nothing kept of it; a table kept that fails to give itself back is read.
    kept.clear();
    await assert.rejects(resolve(tx, { ...counting([RECIPIENT]), accounts: async (a) => ({ slot: 1n, accounts: a.map((address) => ({ exists: false as const, address })) }) }), /not found/);
    assert.equal(kept.size, 0);
    const broken = { ...counting([RECIPIENT]), tables: { get: () => Promise.reject(new Error('storage')), set: () => {} } };
    assert.equal((await resolve(tx, broken)).accounts.at(-1)?.address, RECIPIENT);
});
