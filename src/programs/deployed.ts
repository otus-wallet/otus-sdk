// A program as the upgradeable loader keeps it. Its account names where its code is: its program data, at an address
// the program derives. That account's head says when its code was last deployed and who may change it (no one, once
// the program is immutable). Only the loader's exact layouts are read (its UpgradeableLoaderState, as bincode lays it
// out); anything else is no such account.
import { LOADER_V3_PROGRAM_ADDRESS } from '@solana-program/loader-v3';
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getU32Decoder, getU64Decoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

const PROGRAM = 2; // the state's tag of a program's account
const PROGRAM_DATA = 3; // of its program data
const PROGRAM_SIZE = 36; // the tag, then its program data's address

/** The bytes of a program data account read for its head: its tag, slot and authority, never its code. */
export const HEAD_SIZE = 45;

/** When a program's code was last deployed (or upgraded), and who may change it; null: no one ever can. */
export type Head = { slot: bigint; authority: Address | null };

/** Where `program`'s program data is, as the loader derives it. */
export async function programDataAddress(program: Address): Promise<Address> {
    const [address] = await getProgramDerivedAddress({ programAddress: LOADER_V3_PROGRAM_ADDRESS, seeds: [getAddressEncoder().encode(program)] });
    return address;
}

/** `program`'s account → where its program data is: null unless it is the loader's, runs, holds just that, and names
 *  the address the program derives. */
export async function programDataOf(program: Address, account: { programAddress: Address; executable: boolean; data: ReadonlyUint8Array }): Promise<Address | null> {
    if (account.programAddress !== LOADER_V3_PROGRAM_ADDRESS || !account.executable || account.data.length !== PROGRAM_SIZE || tag(account.data) !== PROGRAM) return null;
    const data = getAddressDecoder().decode(account.data.slice(4, PROGRAM_SIZE));
    return data === (await programDataAddress(program)) ? data : null;
}

/** A program data account (its first HEAD_SIZE bytes or more) → its head; null unless it is the loader's and holds a
 *  program data's state. */
export function headOf(account: { programAddress: Address; data: ReadonlyUint8Array }): Head | null {
    const { data } = account;
    if (account.programAddress !== LOADER_V3_PROGRAM_ADDRESS || data.length < HEAD_SIZE || tag(data) !== PROGRAM_DATA) return null;
    // An optional authority: its tag, then its 32 bytes (left as they were when it becomes none).
    const option = data[12];
    if (option !== 0 && option !== 1) return null;
    return { slot: getU64Decoder().decode(data, 4), authority: option === 1 ? getAddressDecoder().decode(data.slice(13, HEAD_SIZE)) : null };
}

const tag = (data: ReadonlyUint8Array) => getU32Decoder().decode(data, 0);
