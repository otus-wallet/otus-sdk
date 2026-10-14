// What the instructions Otus reads to the unit say they move, held against what the simulation shows. An RPC that
// answers otherwise (a balance read lower than it is, a move left out) would have the review, and the guards made from
// it, miss a drain the instructions themselves say. An account is checked where every instruction that names it is one
// Otus reads so: what those take out of it must show as gone, less what they can bring in. One named by a program Otus
// can't read so (a swap, a protocol, one it doesn't know) could bring in any amount, and is not checked here.
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import type { Address } from '@solana/kit';

import { LIGHTHOUSE, STAKE_PROGRAM, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import type { Changes, State } from './changes.ts';
import type { Explained } from './explain.ts';
import type { Simulated } from './simulate.ts';

// What an instruction does to the value of one account: lamports, or a token account's units (wrapped SOL's included).
type Asset = 'lamports' | 'units';
// Amounts it takes out of accounts for sure, the most it can bring in, and accounts it may bring any amount into. An
// account it names otherwise keeps its value, or can only lose some (as rent paid): either way it brings nothing in.
type Effect = { out: [Asset, Address, bigint][]; in: [Asset, Address, bigint][]; open: [Asset, Address][] };

/** Each account whose value the simulation shows higher after the transaction than the instructions that name it can
 *  leave it: what they say goes out of it, the simulation leaves out. Empty for a simulation that failed. Pure. */
export function untold(s: Simulated, changes: Changes, explained: Explained[]): Address[] {
    if (s.simulation.error !== null) return [];
    const tallies = new Map<string, { in: bigint; out: bigint; open: boolean }>();
    const tally = (asset: Asset, address: Address) => {
        const key = `${asset} ${address}`;
        const found = tallies.get(key) ?? { in: 0n, out: 0n, open: false };
        tallies.set(key, found);
        return found;
    };
    s.message.instructions.forEach((ix, i) => {
        const effect = effectOf(explained[i]);
        if (!effect) {
            for (const j of ix.accountIndices) for (const asset of ASSETS) tally(asset, s.accounts[j].address).open = true;
            return;
        }
        for (const [asset, address, amount] of effect.out) tally(asset, address).out += amount;
        for (const [asset, address, amount] of effect.in) tally(asset, address).in += amount;
        for (const [asset, address] of effect.open) tally(asset, address).open = true;
    });
    // An account no instruction names changes only by the fee it pays.
    return changes.accounts.flatMap(({ address, before, after }) => {
        const shown = ASSETS.some((asset) => {
            const t = tallies.get(`${asset} ${address}`) ?? { in: 0n, out: 0n, open: false };
            return !t.open && valueOf(after, asset) - valueOf(before, asset) > t.in - t.out;
        });
        return shown ? [address] : [];
    });
}

const ASSETS: Asset[] = ['lamports', 'units'];
const valueOf = (state: State, asset: Asset) => (asset === 'lamports' ? (state?.lamports ?? 0n) : (state?.token?.amount ?? 0n));

const FREE: Effect = { out: [], in: [], open: [] };
const MEMOS: readonly Address[] = [MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3];

// What an instruction does to the value of the accounts it names, as far as Otus reads it to the unit; null when it
// doesn't: then it may bring any amount into any of them.
function effectOf(e: Explained): Effect | null {
    // Lighthouse's assertions only read; its memory instructions write accounts of its own and give their rent back.
    if (e.program === LIGHTHOUSE) return e.data[0] !== undefined && e.data[0] >= 2 ? FREE : null;
    if (e.program === COMPUTE_BUDGET_PROGRAM_ADDRESS || MEMOS.includes(e.program)) return FREE;
    if (e.source !== 'plugin') return null;
    const acc = (role: string) => e.accounts.find((a) => a.role === role)?.address;
    const arg = (name: string) => {
        const v = e.args.find((a) => a.name === name)?.value ?? '';
        return /^\d+$/.test(v) ? BigInt(v) : null;
    };
    // `amount` from one account to another: out of the first for sure, at most that into the second.
    const moves = (asset: Asset, from: string, to: string, amount: string): Effect | null => {
        const [a, b, n] = [acc(from), acc(to), arg(amount)];
        return a && b && n !== null ? { out: [[asset, a, n]], in: [[asset, b, n]], open: [] } : null;
    };
    const opens = (...roles: [Asset, string][]): Effect | null => {
        const open = roles.flatMap(([asset, role]): [Asset, Address][] => (acc(role) ? [[asset, acc(role)!]] : []));
        return open.length === roles.length ? { ...FREE, open } : null;
    };
    if (e.program === SYSTEM_PROGRAM_ADDRESS) {
        switch (e.name) {
            case 'TransferSol':
            case 'TransferSolWithSeed':
                return moves('lamports', 'source', 'destination', 'amount');
            case 'CreateAccount':
                return moves('lamports', 'payer', 'newAccount', 'lamports');
            case 'CreateAccountWithSeed':
                return moves('lamports', 'payer', 'newAccount', 'amount');
            case 'WithdrawNonceAccount':
                return moves('lamports', 'nonceAccount', 'recipientAccount', 'withdrawAmount');
            case 'Assign':
            case 'AssignWithSeed':
            case 'Allocate':
            case 'AllocateWithSeed':
            case 'AdvanceNonceAccount':
            case 'InitializeNonceAccount':
            case 'AuthorizeNonceAccount':
            case 'UpgradeNonceAccount':
                return FREE;
        }
        return null;
    }
    if (TOKEN_PROGRAMS.includes(e.program)) {
        switch (e.name) {
            case 'Transfer':
            case 'TransferChecked': {
                // Wrapped SOL moves its lamports with its units.
                const units = moves('units', 'source', 'destination', 'amount');
                const lamports = acc('destination') && arg('amount') !== null ? { asset: 'lamports' as const, to: acc('destination')!, n: arg('amount')! } : null;
                return units && lamports ? { ...units, in: [...units.in, [lamports.asset, lamports.to, lamports.n]] } : null;
            }
            case 'Burn':
            case 'BurnChecked': {
                const [account, n] = [acc('account'), arg('amount')];
                return account && n !== null ? { out: [['units', account, n]], in: [], open: [] } : null;
            }
            case 'MintTo':
            case 'MintToChecked': {
                const [token, n] = [acc('token'), arg('amount')];
                return token && n !== null ? { out: [], in: [['units', token, n]], open: [] } : null;
            }
            // Closed, an account's SOL goes where it says, as much as it held; synced or set up, wrapped SOL counts
            // the SOL the account holds.
            case 'CloseAccount':
                return opens(['lamports', 'destination']);
            case 'WithdrawExcessLamports':
                return opens(['lamports', 'destination']);
            case 'SyncNative':
            case 'InitializeAccount':
            case 'InitializeAccount2':
            case 'InitializeAccount3':
                return opens(['units', 'account']);
            case 'Approve':
            case 'ApproveChecked':
            case 'Revoke':
            case 'SetAuthority':
            case 'FreezeAccount':
            case 'ThawAccount':
            case 'InitializeMint':
            case 'InitializeMint2':
            case 'InitializeMultisig':
            case 'InitializeMultisig2':
            case 'InitializeImmutableOwner':
            case 'GetAccountDataSize':
            case 'AmountToUiAmount':
            case 'UiAmountToAmount':
                return FREE;
        }
        return null;
    }
    if (e.program === STAKE_PROGRAM) {
        switch (e.name) {
            case 'Withdraw':
                return moves('lamports', 'stake', 'recipient', 'args');
            case 'Split':
                return moves('lamports', 'stake', 'splitStake', 'args');
            case 'Merge':
                return opens(['lamports', 'destinationStake']);
            case 'Initialize':
            case 'InitializeChecked':
            case 'Authorize':
            case 'AuthorizeChecked':
            case 'AuthorizeWithSeed':
            case 'AuthorizeCheckedWithSeed':
            case 'DelegateStake':
            case 'Deactivate':
            case 'DeactivateDelinquent':
            case 'SetLockup':
            case 'SetLockupChecked':
            case 'GetMinimumDelegation':
                return FREE;
        }
        return null;
    }
    // A new token account, made with the payer's SOL (it only pays), wrapped SOL counting what it is made with.
    if (e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && (e.name === 'CreateAssociatedToken' || e.name === 'CreateAssociatedTokenIdempotent')) {
        return opens(['lamports', 'ata'], ['units', 'ata']);
    }
    return null;
}
