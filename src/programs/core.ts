import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ComputeBudgetInstruction,
    parseComputeBudgetInstruction,
} from '@solana-program/compute-budget';
import { identifyLoaderV3Instruction, LOADER_V3_PROGRAM_ADDRESS, LoaderV3Instruction, parseLoaderV3Instruction } from '@solana-program/loader-v3';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS, parseAddMemoInstruction } from '@solana-program/memo';
import { parseStakeInstruction, STAKE_PROGRAM_ADDRESS, StakeInstruction } from '@solana-program/stake';
import { parseSystemInstruction, SYSTEM_PROGRAM_ADDRESS, SystemInstruction } from '@solana-program/system';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    AssociatedTokenInstruction,
    parseAssociatedTokenInstruction,
    parseTokenInstruction,
    TOKEN_PROGRAM_ADDRESS,
    TokenInstruction,
} from '@solana-program/token';

import { AccountRole, type Address } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from './addresses.ts';
import { codamaPlugin, type KitInstruction, type Plugin } from './plugin.ts';

export { TOKEN_2022_PROGRAM_ADDRESS };

// Token-2022 encodes its base instructions (0 to 24, and 38) as Token does. Its extension instructions stay unknown
// for now, rather than read as the Token instructions that reuse their numbers.
function parseToken2022Instruction(instruction: KitInstruction) {
    const kind = instruction.data[0];
    if (kind > 24 && kind !== 38) throw new Error('a Token-2022 extension instruction');
    return parseTokenInstruction(instruction);
}

// The upgradeable loader takes its optional accounts last, and left out when absent: SetAuthority's new authority (none:
// the program can never be upgraded again), Close's authority and program, ExtendProgram's System Program and payer. Its
// client reads an absent one as the loader's own address in its place, so each left out is put back as that, up to all
// the instruction can take and never below what it needs.
const LOADER_ACCOUNTS: Partial<Record<LoaderV3Instruction, { least: number; most: number }>> = {
    [LoaderV3Instruction.SetAuthority]: { least: 2, most: 3 },
    [LoaderV3Instruction.Close]: { least: 2, most: 4 },
    [LoaderV3Instruction.ExtendProgram]: { least: 2, most: 4 },
};
function parseLoaderInstruction(instruction: KitInstruction) {
    const takes = LOADER_ACCOUNTS[identifyLoaderV3Instruction(instruction)];
    const accounts = instruction.accounts ?? [];
    if (!takes || accounts.length < takes.least || accounts.length >= takes.most) return parseLoaderV3Instruction(instruction);
    const absent = Array.from({ length: takes.most - accounts.length }, () => ({ address: LOADER_V3_PROGRAM_ADDRESS, role: AccountRole.READONLY }));
    return parseLoaderV3Instruction({ ...instruction, accounts: [...accounts, ...absent] });
}

// The stake program's sysvars and config account: older wallets still pass them in its instructions (Clock, the stake
// history, Rent, StakeConfig) where the program now reads them itself, and its client reads the accounts without them.
// None of them can be a stake account, a validator or an authority, so dropping them lines both forms up.
const STAKE_EXTRAS: ReadonlySet<string> = new Set([
    'SysvarC1ock11111111111111111111111111111111',
    'SysvarStakeHistory1111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
    'StakeConfig11111111111111111111111111111111',
]);
const withoutExtras = (plugin: Plugin): Plugin => ({ ...plugin, explain: (instruction) => plugin.explain({ ...instruction, accounts: (instruction.accounts ?? []).filter((a) => !STAKE_EXTRAS.has(a.address)) }) });

/** The programs almost every transaction touches, explained by Solana's own generated clients. */
export const CORE_PLUGINS: Plugin[] = [
    codamaPlugin(SYSTEM_PROGRAM_ADDRESS, 'System Program', parseSystemInstruction, (t) => SystemInstruction[t]),
    codamaPlugin(COMPUTE_BUDGET_PROGRAM_ADDRESS, 'Compute Budget', parseComputeBudgetInstruction, (t) => ComputeBudgetInstruction[t]),
    codamaPlugin(TOKEN_PROGRAM_ADDRESS, 'Token Program', parseTokenInstruction, (t) => TokenInstruction[t]),
    codamaPlugin(TOKEN_2022_PROGRAM_ADDRESS, 'Token-2022', parseToken2022Instruction, (t) => TokenInstruction[t]),
    codamaPlugin(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, 'Associated Token', parseAssociatedTokenInstruction, (t) => AssociatedTokenInstruction[t]),
    withoutExtras(codamaPlugin(STAKE_PROGRAM_ADDRESS, 'Stake Program', parseStakeInstruction, (t) => StakeInstruction[t])),
    codamaPlugin(LOADER_V3_PROGRAM_ADDRESS, 'Upgradeable Loader', parseLoaderInstruction, (t) => LoaderV3Instruction[t]),
    // The Memo program most sites use (MemoSq…fcHr; the client calls it legacy v3), its newer deploy, and the first one.
    codamaPlugin(LEGACY_MEMO_PROGRAM_ADDRESS_V3, 'Memo', parseAddMemoInstruction, () => 'AddMemo'),
    codamaPlugin(MEMO_PROGRAM_ADDRESS, 'Memo', parseAddMemoInstruction, () => 'AddMemo'),
    codamaPlugin(LEGACY_MEMO_PROGRAM_ADDRESS_V1, 'Memo (legacy)', parseAddMemoInstruction, () => 'AddMemo'),
];

/** The programs the core plugins read: Solana's own (stake included), the token programs, memo. */
export const CORE_PROGRAMS: ReadonlySet<Address> = new Set(CORE_PLUGINS.map((p) => p.program));
