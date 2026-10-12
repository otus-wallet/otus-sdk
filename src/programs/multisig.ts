// A program's authority, when it is a Squads multisig's vault (v3 or v4): the multisig, read by Squads' own onchain IDL
// (its members and what each may do, how many must agree, how long an approved proposal waits), and which of its vaults
// holds the authority. The vault is confirmed by deriving it from the multisig, never taken from what a transaction
// says.
import { address, getAddressEncoder, getProgramDerivedAddress, getU32Encoder, isAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';

import type { Landed } from '../activity/history.ts';
import { accountByIdl } from '../idl/account.ts';
import type { Idl } from '../idl/read.ts';
import { SQUADS_V4, vaultAt } from './squads.ts';

export const SQUADS_V3 = address('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu');

const MAX_MEMBERS = 256; // more than either version lets a multisig have
const VAULTS = 256; // vaults tried: v4's index is a byte; v3's has never gone near it

/** A member and what it may do: propose, vote, execute (v3 lets every member do all three). */
export type Member = { key: Address; initiate: boolean; vote: boolean; execute: boolean };

/** `threshold`: the votes a proposal needs; `timeLock`: the seconds an approved one waits before it may run;
 *  `vault`: the index of the vault that holds the authority. `configAuthority`: a v4 multisig's one key that changes its
 *  members, threshold and time lock alone, without a vote (null: only a vote can). */
export type Multisig = { address: Address; program: Address; version: 3 | 4; threshold: number; timeLock: number; members: Member[]; vault: number; configAuthority: Address | null };

// A v4 multisig with no config authority names the System Program's address in its place.
const NO_ONE = '11111111111111111111111111111111';

/** The accounts `t`'s Squads instructions name, either version: where its multisig is, each to read and check with
 *  multisigOf. */
export function squadsAccountsIn(t: Landed): Address[] {
    const named = t.message.instructions.flatMap((ix) => {
        const program = t.accounts[ix.programAddressIndex];
        return program === SQUADS_V3 || program === SQUADS_V4 ? ix.accountIndices.map((i) => t.accounts[i]!) : [];
    });
    return [...new Set(named)];
}

/** `account` as the Squads multisig one of whose vaults is `authority`, read by `idl` (its program's); null when it is
 *  not one, or none of its vaults is. */
export async function multisigOf(authority: Address, account: { address: Address; programAddress: Address; data: ReadonlyUint8Array }, idl: Idl): Promise<Multisig | null> {
    if (account.programAddress === SQUADS_V4) {
        const ms = accountByIdl(idl, 'multisig', account.data);
        const members = membersOf(ms?.members, (m) => (isMember(m) ? { key: m.key, ...can(m.permissions.mask) } : null));
        if (!ms || !members || !counted(ms.threshold, members.length) || !isCount(ms.timeLock) || typeof ms.configAuthority !== 'string' || !isAddress(ms.configAuthority)) return null;
        const vault = await vaultIndex(authority, (i) => vaultAt(account.address, i));
        const configAuthority = ms.configAuthority === NO_ONE ? null : ms.configAuthority;
        return vault === null ? null : { address: account.address, program: SQUADS_V4, version: 4, threshold: ms.threshold as number, timeLock: ms.timeLock as number, members, vault, configAuthority };
    }
    if (account.programAddress === SQUADS_V3) {
        const ms = accountByIdl(idl, 'ms', account.data);
        const members = membersOf(ms?.keys, (k) => (typeof k === 'string' && isAddress(k) ? { key: k, initiate: true, vote: true, execute: true } : null));
        if (!ms || !members || !counted(ms.threshold, members.length) || !isCount(ms.authorityIndex)) return null;
        const vault = await vaultIndex(authority, (i) => v3Vault(account.address, i), Math.min((ms.authorityIndex as number) + 1, VAULTS));
        return vault === null ? null : { address: account.address, program: SQUADS_V3, version: 3, threshold: ms.threshold as number, timeLock: 0, members, vault, configAuthority: null };
    }
    return null;
}

// v4's permissions, by bits: initiate, vote, execute.
const can = (mask: number) => ({ initiate: (mask & 1) !== 0, vote: (mask & 2) !== 0, execute: (mask & 4) !== 0 });
const isMember = (m: unknown): m is { key: Address; permissions: { mask: number } } => {
    const { key, permissions } = (m ?? {}) as { key?: unknown; permissions?: { mask?: unknown } };
    return typeof key === 'string' && isAddress(key) && Number.isInteger(permissions?.mask) && (permissions!.mask as number) >= 0 && (permissions!.mask as number) < 8;
};
const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
const counted = (threshold: unknown, members: number) => Number.isInteger(threshold) && (threshold as number) >= 1 && (threshold as number) <= members;

function membersOf(list: unknown, read: (item: unknown) => Member | null): Member[] | null {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MEMBERS) return null;
    const members = list.map(read);
    return members.every((m): m is Member => m !== null) && new Set(members.map((m) => m.key)).size === members.length ? members : null;
}

async function vaultIndex(authority: Address, vault: (index: number) => Promise<Address>, count = VAULTS): Promise<number | null> {
    for (let i = 0; i < count; i++) if ((await vault(i)) === authority) return i;
    return null;
}

/** The vault through which `multisig` holds the authority it was read for. */
export const vaultOf = (multisig: Multisig): Promise<Address> => (multisig.version === 4 ? vaultAt(multisig.address, multisig.vault) : v3Vault(multisig.address, multisig.vault));

// v3 keeps its vaults ("authorities") at the seeds "squad", the multisig, the index as four bytes, "authority".
async function v3Vault(multisig: Address, index: number): Promise<Address> {
    const text = (s: string) => new TextEncoder().encode(s);
    const [vault] = await getProgramDerivedAddress({ programAddress: SQUADS_V3, seeds: [text('squad'), getAddressEncoder().encode(multisig), getU32Encoder().encode(index), text('authority')] });
    return vault;
}
