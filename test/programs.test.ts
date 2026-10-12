import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { LOADER_V3_PROGRAM_ADDRESS } from '@solana-program/loader-v3';
import type { Address, MaybeEncodedAccount, ReadonlyUint8Array } from '@solana/kit';

import type { Landed } from '../src/activity/history.ts';
import { readIdl, type Idl } from '../src/idl/read.ts';
import { headOf, programDataAddress, programDataOf } from '../src/programs/deployed.ts';
import { multisigOf, SQUADS_V3, squadsAccountsIn, vaultOf } from '../src/programs/multisig.ts';
import { SQUADS_V4, vaultAt } from '../src/programs/squads.ts';
import { key } from './helpers.ts';

// Public mainnet accounts, read once: Jupiter's program, its program data's head and its upgrade authority's Squads v3
// multisig; a Squads v4 multisig; both versions' IDLs as they publish them.
type Fixture = { address: Address; owner: Address; executable: boolean; data: string };
const fixture = (path: string): Fixture => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const bytes = (f: Fixture) => new Uint8Array(Buffer.from(f.data, 'base64'));
const account = (f: Fixture, data = bytes(f), owner = f.owner) => ({ address: f.address, programAddress: owner, executable: f.executable, data });
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;
const [program, head, v3, v4] = ['./fixtures/jupiter-program.json', './fixtures/jupiter-program-data-head.json', './fixtures/squads-v3-multisig.json', './fixtures/squads-v4-multisig.json'].map(fixture);
const JUPITER_AUTHORITY = 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ' as Address;
const idlOf = async (p: Address): Promise<Idl> => {
    const f = fixture(`./idl/${p}.anchor.json`);
    const stored: MaybeEncodedAccount = { exists: true, address: f.address, programAddress: f.owner, data: bytes(f), executable: false, lamports: 1n as never, space: BigInt(bytes(f).length) };
    return (await readIdl(stored, 'anchor', p))!;
};

test("a program's account names its program data, at the address the program derives; anything else is refused", async () => {
    assert.equal(await programDataOf(JUPITER, account(program!)), '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT');
    assert.equal(await programDataAddress(JUPITER), '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT');
    const data = bytes(program!);
    const refused: [string, Parameters<typeof programDataOf>[1]][] = [
        ['another owner', account(program!, data, key(1))],
        ["one that doesn't run", { ...account(program!), executable: false }],
        ['cut short', account(program!, data.slice(0, 35))],
        ['too long', account(program!, new Uint8Array([...data, 0]))],
        ['a program data tag', account(program!, new Uint8Array([3, ...data.slice(1)]))],
        ['another program data', account(program!, new Uint8Array([...data.slice(0, 4), ...new Uint8Array(32).fill(7)]))],
    ];
    for (const [why, a] of refused) assert.equal(await programDataOf(JUPITER, a), null, why);
    assert.equal(await programDataOf(key(5), account(program!)), null); // another program's
});

test("a program data's head: when its code was deployed and who may change it; no one once immutable", () => {
    assert.deepEqual(headOf(account(head!)), { slot: 454_465_850n, authority: JUPITER_AUTHORITY });
    const data = bytes(head!);
    // Made immutable: its authority none, the bytes after the option left as they were.
    assert.deepEqual(headOf(account(head!, new Uint8Array([...data.slice(0, 12), 0, ...data.slice(13)]))), { slot: 454_465_850n, authority: null });
    // Read whole, its code after the head: the same.
    assert.deepEqual(headOf(account(head!, new Uint8Array([...data, 1, 2, 3]))), { slot: 454_465_850n, authority: JUPITER_AUTHORITY });
    for (const [why, d, owner] of [
        ['cut short', data.slice(0, 44), LOADER_V3_PROGRAM_ADDRESS],
        ["a program's tag", new Uint8Array([2, ...data.slice(1)]), LOADER_V3_PROGRAM_ADDRESS],
        ['an option that is neither', new Uint8Array([...data.slice(0, 12), 2, ...data.slice(13)]), LOADER_V3_PROGRAM_ADDRESS],
        ['another owner', data, key(1)],
        ['nothing', new Uint8Array(), LOADER_V3_PROGRAM_ADDRESS],
    ] as const) {
        assert.equal(headOf({ programAddress: owner as Address, data: d as Uint8Array }), null, why);
    }
});

test("Jupiter's upgrade authority: vault 1 of a Squads v3 multisig, four of its members to agree", async () => {
    const idl = await idlOf(SQUADS_V3);
    const ms = await multisigOf(JUPITER_AUTHORITY, account(v3!), idl);
    assert.ok(ms);
    assert.deepEqual([ms.version, ms.address, ms.program, ms.threshold, ms.timeLock, ms.vault], [3, v3!.address, SQUADS_V3, 4, 0, 1]);
    assert.equal(ms.configAuthority, null);
    assert.ok(ms.members.length >= 4 && ms.members.every((m) => m.initiate && m.vote && m.execute));
    assert.equal(await vaultOf(ms), JUPITER_AUTHORITY);
    // Not one of its vaults; not Squads'; another account; read by the other version's IDL; bytes changed or cut.
    assert.equal(await multisigOf(key(9), account(v3!), idl), null);
    assert.equal(await multisigOf(JUPITER_AUTHORITY, account(v3!, bytes(v3!), key(1)), idl), null);
    assert.equal(await multisigOf(JUPITER_AUTHORITY, account(v3!, bytes(v3!), SQUADS_V4), await idlOf(SQUADS_V4)), null);
    const data = bytes(v3!);
    assert.equal(await multisigOf(JUPITER_AUTHORITY, account(v3!, new Uint8Array([data[0]! ^ 1, ...data.slice(1)])), idl), null);
    assert.equal(await multisigOf(JUPITER_AUTHORITY, account(v3!, data.slice(0, 60)), idl), null);
});

test('a Squads v4 multisig: each member with what it may do, its time lock, the vault found by deriving it', async () => {
    const idl = await idlOf(SQUADS_V4);
    const vault0 = await vaultAt(v4!.address, 0);
    const ms = await multisigOf(vault0, account(v4!), idl);
    assert.ok(ms);
    assert.deepEqual([ms.version, ms.program, ms.threshold, ms.timeLock, ms.vault], [4, SQUADS_V4, 3, 0, 0]);
    assert.equal(ms.configAuthority, null); // only a vote changes it
    // With a config authority: that one key changes its members alone, and is said.
    const controlled = bytes(v4!);
    controlled.set(new Uint8Array(32).fill(9), 8 + 32); // after its discriminator and create key
    const one = await multisigOf(vault0, account(v4!, controlled), idl);
    assert.ok(one?.configAuthority && one.configAuthority !== '11111111111111111111111111111111');
    assert.equal(ms.members.length, 8);
    assert.equal(await vaultOf(ms), vault0);
    assert.ok(ms.members.some((m) => m.initiate && !m.vote && !m.execute)); // proposes only
    assert.ok(ms.members.some((m) => !m.initiate && m.vote && !m.execute)); // votes only
    assert.ok(ms.members.some((m) => m.initiate && m.vote && m.execute));
    assert.equal((await multisigOf(await vaultAt(v4!.address, 3), account(v4!), idl))?.vault, 3); // another of its vaults, by its own index
    assert.equal(await multisigOf(key(9), account(v4!), idl), null);
});

test("where a transaction's multisig may be: what its Squads instructions name, either version, once each", () => {
    const [a, b, c] = [key(40), key(41), key(42)];
    const t = { accounts: [a, b, c, SQUADS_V3, SQUADS_V4, key(43)], message: { instructions: [{ programAddressIndex: 3, accountIndices: [0, 1] }, { programAddressIndex: 4, accountIndices: [1, 2] }, { programAddressIndex: 5, accountIndices: [5] }] } } as unknown as Landed;
    assert.deepEqual(squadsAccountsIn(t), [a, b, c]);
});

test("the changes a transaction made to a program: Jupiter's last upgrade, run by its multisig inside its own", async () => {
    const { exactJson, readPage } = await import('../src/activity/history.ts');
    const { changesIn } = await import('../src/programs/deployed.ts');
    const [t] = (await readPage(exactJson(readFileSync(new URL('./fixtures/jupiter-upgrade.json', import.meta.url), 'utf8')), 10)).items;
    assert.ok(t && !('unreadable' in t));
    const DATA = '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT' as Address;
    const [change, ...more] = changesIn(t, DATA);
    assert.deepEqual([change?.name, change?.via, more.length], ['Upgrade', SQUADS_V3, 0]);
    assert.equal(change!.accounts.find((a) => a.role === 'authority')?.address, JUPITER_AUTHORITY);
    assert.equal(change!.accounts.find((a) => a.role === 'programAccount')?.address, JUPITER);
    // Another program's data: nothing of it changed here. What runs inside, unreadable to the loader's client: left out.
    assert.deepEqual(changesIn(t, key(5)), []);
    const garbled = { ...t, inner: t.inner!.map((x) => ({ ...x, instructions: x.instructions.map((i) => ({ ...i, data: new Uint8Array([99]) })) })) };
    assert.deepEqual(changesIn(garbled, DATA), []);
});

test("a change is counted only where the program data itself is what the loader changes, never named elsewhere", async () => {
    const { changesIn } = await import('../src/programs/deployed.ts');
    const { getCloseInstruction, getSetAuthorityInstruction, getUpgradeInstruction, getWriteInstruction, LOADER_V3_PROGRAM_ADDRESS: LOADER } = await import('@solana-program/loader-v3');
    const { createNoopSigner } = await import('@solana/kit');
    const DATA = '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT' as Address;
    const [attacker, buffer, theirData, theirProgram] = [key(50), key(51), key(52), key(53)];
    const signer = createNoopSigner(attacker);
    // A transaction of these instructions, top-level, as the SDK reads one landed.
    const landedOf = (...ixs: { programAddress: Address; accounts?: readonly { address: Address }[]; data?: Uint8Array | ReadonlyUint8Array }[]) => {
        const accounts: Address[] = [LOADER];
        const at = (a: Address) => (accounts.includes(a) ? accounts.indexOf(a) : accounts.push(a) - 1);
        const instructions = ixs.map((ix) => ({ programAddressIndex: at(ix.programAddress), accountIndices: (ix.accounts ?? []).map((m) => at(m.address)), data: ix.data ?? new Uint8Array() }));
        return { accounts, message: { instructions }, inner: [] } as unknown as Landed;
    };
    const spoofs = [
        getCloseInstruction({ bufferOrProgramDataAccount: buffer, destinationAccount: DATA, authority: signer }), // its own buffer, the SOL "to" the program data
        getUpgradeInstruction({ programDataAccount: theirData, programAccount: theirProgram, bufferAccount: buffer, spillAccount: DATA, authority: signer }), // its own program, spilling "to" it
        getSetAuthorityInstruction({ bufferOrProgramDataAccount: buffer, currentAuthority: signer, newAuthority: DATA }), // its own buffer, given "to" it
        { ...getWriteInstruction({ bufferAccount: buffer, bufferAuthority: signer, offset: 0, bytes: new Uint8Array([1]) }), accounts: [...getWriteInstruction({ bufferAccount: buffer, bufferAuthority: signer, offset: 0, bytes: new Uint8Array([1]) }).accounts, { address: DATA, role: 0 }] },
    ];
    for (const ix of spoofs) assert.deepEqual(changesIn(landedOf(ix), DATA), [], ix.programAddress + ' ' + ix.data[0]);
    // Its own authority changed: counted.
    const real = getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: signer, newAuthority: buffer });
    assert.deepEqual(changesIn(landedOf(...spoofs, real), DATA).map((c) => c.name), ['SetAuthority']);
});

test("a site asking for the loader is no everyday call: told as one of the programs it calls", async () => {
    const { programsCalled } = await import('../src/review/sites.ts');
    const { LOADER_V3_PROGRAM_ADDRESS: LOADER } = await import('@solana-program/loader-v3');
    const message = { staticAccounts: [key(1), LOADER, '11111111111111111111111111111111' as Address], instructions: [{ programAddressIndex: 1 }, { programAddressIndex: 2 }] };
    assert.deepEqual(programsCalled(message as never), [LOADER]);
});

test("an IDL whose account reader could run on without end (a list of nothing, counted by the data) reads nothing", async () => {
    const { accountByIdl } = await import('../src/idl/account.ts');
    const idl = await idlOf(SQUADS_V4);
    const root = structuredClone(idl.root);
    const account = root.program.accounts!.find((a) => a.name === 'multisig')!;
    const fields = (account.data as { fields: { name: string; type: unknown }[] }).fields;
    fields.find((f) => f.name === 'members')!.type = { kind: 'arrayTypeNode', item: { kind: 'structTypeNode', fields: [] }, count: { kind: 'prefixedCountNode', prefix: { kind: 'numberTypeNode', format: 'u32', endian: 'le' } } };
    const started = Date.now();
    assert.equal(accountByIdl({ ...idl, root }, 'multisig', bytes(v4!)), null);
    assert.ok(Date.now() - started < 1000);
    assert.ok(accountByIdl(idl, 'multisig', bytes(v4!))); // the IDL as published reads it
});
