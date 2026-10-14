// What the instructions Otus reads to the unit say they do, held against what the simulation shows. An RPC that answers
// otherwise (a balance read lower than it is, a move left out, an allowance or an owner change left out) would have the
// review, and the guards made from it, miss what the instructions themselves say. Two checks:
// - Value: an account is checked where every instruction that names it is one Otus reads so: what those take out of it
//   must show as gone, less the most they can bring in. One named by a program Otus can't read so (a swap, a protocol,
//   one it doesn't know) could bring in any amount, and is not checked here.
// - State: what an instruction leaves an account as (closed, with its delegate, with its new owner) must show after it,
//   where no later instruction names the account; and an account it takes from or acts on must have been there, or
//   made earlier in the transaction.
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { getAddressDecoder, getU64Decoder, type Address } from '@solana/kit';

import { isWrappedSol, LIGHTHOUSE, STAKE_PROGRAM, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { read, type Changes, type State } from './changes.ts';
import type { Explained } from './explain.ts';
import type { Simulated } from './simulate.ts';

// What an instruction does to the value of one account: lamports, or a token account's units (wrapped SOL's included).
type Asset = 'lamports' | 'units';
// Amounts it takes out of accounts for sure, the most it can bring in, and accounts it may bring any amount into. An
// account it names otherwise keeps its value, or can only lose some (as rent paid): either way it brings nothing in.
// `syncs`: a wrapped SOL account whose units become its SOL past its rent (no more than it holds, or gets). `needs`:
// accounts it acts on, which must be there before, or made earlier in the transaction; `makes`: accounts it makes.
// `leaves`: how it leaves an account, which the simulation must show unless a later instruction names it.
type Effect = {
    out: [Asset, Address, bigint][];
    in: [Asset, Address, bigint][];
    open: [Asset, Address][];
    syncs?: Address;
    needs?: Address[];
    makes?: Address[];
    leaves?: [Address, (after: State) => boolean][];
};

const RENT_MOST = 10_000_000n; // lamports: the most a new token account's rent takes, extensions included

/** Each account the simulation shows otherwise than the instructions Otus reads say: worth more after the transaction
 *  than they can leave it, left as they don't leave it, or acted on though it was not there. Empty for a simulation
 *  that failed. Pure. */
export function untold(s: Simulated, changes: Changes, explained: Explained[]): Address[] {
    if (s.simulation.error !== null) return [];
    const tallies = new Map<string, { in: bigint; out: bigint; open: boolean }>();
    const tally = (asset: Asset, address: Address) => {
        const key = `${asset} ${address}`;
        const found = tallies.get(key) ?? { in: 0n, out: 0n, open: false };
        tallies.set(key, found);
        return found;
    };
    const states = new Map(changes.accounts.map((c) => [c.address, c]));
    const before = (a: Address) => (states.has(a) ? states.get(a)!.before : read(s.accounts.find((x) => x.address === a)?.state ?? { exists: false, address: a }));
    // The last instruction to name each account: what one leaves an account as holds only if none comes after it.
    const last = new Map<Address, number>();
    s.message.instructions.forEach((ix, i) => ix.accountIndices.forEach((j) => last.set(s.accounts[j].address, i)));
    const made = new Set<Address>();
    const syncs = new Set<Address>();
    const wrong = new Set<Address>();
    s.message.instructions.forEach((ix, i) => {
        const effect = effectOf(explained[i]);
        // One Otus can't read may bring in anything, leave accounts any way, and make any of them.
        if (!effect) {
            for (const j of ix.accountIndices) {
                for (const asset of ASSETS) tally(asset, s.accounts[j].address).open = true;
                made.add(s.accounts[j].address);
            }
            return;
        }
        for (const [asset, address, amount] of effect.out) tally(asset, address).out += amount;
        for (const [asset, address, amount] of effect.in) tally(asset, address).in += amount;
        for (const [asset, address] of effect.open) tally(asset, address).open = true;
        for (const a of effect.needs ?? []) if (before(a) === null && !made.has(a)) wrong.add(a);
        for (const a of effect.makes ?? []) made.add(a);
        if (effect.syncs) syncs.add(effect.syncs);
        for (const [a, holds] of effect.leaves ?? []) if (last.get(a) === i && states.has(a) && !holds(states.get(a)!.after)) wrong.add(a);
    });
    // Synced, wrapped SOL counts as units what SOL it holds past its rent, and what SOL it gets.
    for (const a of syncs) {
        const [units, lamports] = [tally('units', a), tally('lamports', a)];
        units.open ||= lamports.open;
        units.in += lamports.in + surplus(before(a));
    }
    // An account no instruction names changes only by the fee it pays.
    for (const { address, before: was, after } of changes.accounts) {
        const more = ASSETS.some((asset) => {
            const t = tallies.get(`${asset} ${address}`) ?? { in: 0n, out: 0n, open: false };
            return !t.open && valueOf(after, asset) - valueOf(was, asset) > t.in - t.out;
        });
        if (more) wrong.add(address);
    }
    return [...wrong];
}

const ASSETS: Asset[] = ['lamports', 'units'];
const valueOf = (state: State, asset: Asset) => (asset === 'lamports' ? (state?.lamports ?? 0n) : (state?.token?.amount ?? 0n));

// The SOL an account holds that its units may come to count: for a wrapped SOL account, past its rent reserve (kept at
// 113) and its units; for an account not set up as a token account yet, all of it; for another token's, none.
function surplus(state: State): bigint {
    if (!state) return 0n;
    if (!state.token) return state.lamports;
    if (!state.token.native) return 0n;
    const reserve = state.data.length >= 121 ? getU64Decoder().decode(state.data, 113) : 0n;
    const left = state.lamports - reserve - state.token.amount;
    return left > 0n ? left : 0n;
}

const FREE: Effect = { out: [], in: [], open: [] };
const MEMOS: readonly Address[] = [MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3];
const NOBODY = '11111111111111111111111111111111';

// What an instruction does to the value and state of the accounts it names, as far as Otus reads it to the unit; null
// when it doesn't: then it may bring any amount into any of them, or leave them any way.
function effectOf(e: Explained): Effect | null {
    // Lighthouse's assertions only read; its memory instructions write accounts of its own and give their rent back.
    if (e.program === LIGHTHOUSE) return e.data[0] !== undefined && e.data[0] >= 2 ? FREE : null;
    if (e.program === COMPUTE_BUDGET_PROGRAM_ADDRESS || MEMOS.includes(e.program)) return FREE;
    if (e.source !== 'plugin') return null;
    const acc = (role: string) => e.accounts.find((a) => a.role === role)?.address;
    const text = (name: string) => e.args.find((a) => a.name === name)?.value ?? '';
    const arg = (name: string) => (/^\d+$/.test(text(name)) ? BigInt(text(name)) : null);
    // `amount` from one account to another: out of the first for sure, at most that into the second.
    const moves = (asset: Asset, from: string, to: string, amount: string): Effect | null => {
        const [a, b, n] = [acc(from), acc(to), arg(amount)];
        return a && b && n !== null ? { out: [[asset, a, n]], in: [[asset, b, n]], open: [] } : null;
    };
    if (e.program === SYSTEM_PROGRAM_ADDRESS) return systemEffect(e.name, acc, text, moves);
    if (TOKEN_PROGRAMS.includes(e.program)) return tokenEffect(e.name, acc, text, arg, moves);
    if (e.program === STAKE_PROGRAM) return stakeEffect(e.name, acc, text, moves);
    // A new token account: the payer only pays its rent; it gets that, and no units, but wrapped SOL counts the SOL it
    // holds past its rent, as the Token program sets it up. One there already stays as it is.
    if (e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && (e.name === 'CreateAssociatedToken' || e.name === 'CreateAssociatedTokenIdempotent')) {
        const [ata, mint] = [acc('ata'), acc('mint')];
        return ata && mint ? { out: [], in: [['lamports', ata, RENT_MOST]], open: [], makes: [ata], ...(isWrappedSol(mint) && { syncs: ata }) } : null;
    }
    return null;
}

type Roles = (role: string) => Address | undefined;
type Moves = (asset: Asset, from: string, to: string, amount: string) => Effect | null;

function systemEffect(name: string, acc: Roles, text: (name: string) => string, moves: Moves): Effect | null {
    switch (name) {
        case 'TransferSol':
        case 'TransferSolWithSeed':
            return moves('lamports', 'source', 'destination', 'amount');
        case 'CreateAccount':
            return made(moves('lamports', 'payer', 'newAccount', 'lamports'), acc('newAccount'));
        case 'CreateAccountWithSeed':
            return made(moves('lamports', 'payer', 'newAccount', 'amount'), acc('newAccount'));
        case 'WithdrawNonceAccount':
            return moves('lamports', 'nonceAccount', 'recipientAccount', 'withdrawAmount');
        case 'Assign': {
            const [account, program] = [acc('account'), text('programAddress')];
            return account ? { ...FREE, leaves: [[account, (after) => after === null || after.program === program]] } : null;
        }
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

const made = (effect: Effect | null, account: Address | undefined): Effect | null => (effect && account ? { ...effect, makes: [account] } : null);

function tokenEffect(name: string, acc: Roles, text: (name: string) => string, arg: (name: string) => bigint | null, moves: Moves): Effect | null {
    switch (name) {
        case 'Transfer':
        case 'TransferChecked': {
            // Wrapped SOL moves its lamports with its units: as many come in, at most.
            const [units, to, n] = [moves('units', 'source', 'destination', 'amount'), acc('destination'), arg('amount')];
            const source = acc('source');
            return units && to && n !== null && source ? { ...units, in: [...units.in, ['lamports', to, n]], needs: [source] } : null;
        }
        case 'Burn':
        case 'BurnChecked': {
            const [account, n] = [acc('account'), arg('amount')];
            return account && n !== null ? { out: [['units', account, n]], in: [], open: [], needs: [account] } : null;
        }
        case 'MintTo':
        case 'MintToChecked': {
            const [token, n] = [acc('token'), arg('amount')];
            return token && n !== null ? { out: [], in: [['units', token, n]], open: [], needs: [token] } : null;
        }
        // Closed, an account's SOL goes where it says, as much as it held; the account is gone.
        case 'CloseAccount': {
            const [account, to] = [acc('account'), acc('destination')];
            return account && to ? { out: [], in: [], open: [['lamports', to]], needs: [account], leaves: [[account, (after) => after === null]] } : null;
        }
        case 'WithdrawExcessLamports': {
            const [source, to] = [acc('source'), acc('destination')];
            return source && to ? { out: [], in: [], open: [['lamports', to]], needs: [source] } : null;
        }
        case 'SyncNative': {
            const account = acc('account');
            return account ? { ...FREE, syncs: account, needs: [account] } : null;
        }
        case 'InitializeAccount':
        case 'InitializeAccount2':
        case 'InitializeAccount3': {
            const [account, mint] = [acc('account'), acc('mint')];
            return account && mint ? { ...FREE, makes: [account], ...(isWrappedSol(mint) && { syncs: account }) } : null;
        }
        case 'Approve':
        case 'ApproveChecked': {
            const [source, delegate, n] = [acc('source'), acc('delegate'), arg('amount')];
            return source && delegate && n !== null ? { ...FREE, needs: [source], leaves: [[source, (after) => after?.token?.delegate === delegate && after.token.delegated === n]] } : null;
        }
        case 'Revoke': {
            const source = acc('source');
            return source ? { ...FREE, needs: [source], leaves: [[source, (after) => after?.token !== undefined && after?.token !== null && after.token.delegate === null]] } : null;
        }
        case 'SetAuthority': {
            // A token account's owner (2) or close authority (3) given to another; a mint's (0, 1) are not read here.
            const [owned, kind, to] = [acc('owned'), text('authorityType'), text('newAuthority')];
            if (!owned) return null;
            if (kind === '2') return { ...FREE, needs: [owned], leaves: [[owned, (after) => after?.token?.owner === to]] };
            if (kind === '3') return { ...FREE, needs: [owned], leaves: [[owned, (after) => (after?.token?.closer ?? 'none') === (to === NOBODY ? 'none' : to)]] };
            return FREE;
        }
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

function stakeEffect(name: string, acc: Roles, text: (name: string) => string, moves: Moves): Effect | null {
    switch (name) {
        case 'Withdraw':
            return moves('lamports', 'stake', 'recipient', 'args');
        case 'Split':
            return moves('lamports', 'stake', 'splitStake', 'args');
        case 'Merge': {
            const to = acc('destinationStake');
            return to ? { out: [], in: [], open: [['lamports', to]] } : null;
        }
        // Who stakes (0) or withdraws (1), given to another: kept at 12 or 44 of the stake account.
        case 'Authorize':
        case 'AuthorizeChecked': {
            const stake = acc('stake');
            const to = acc('newAuthority') ?? text('arg0');
            const at = (text('arg1') || text('stakeAuthorize')) === '1' ? 44 : 12;
            const holds = (after: State) => after !== null && after.data.length >= at + 32 && getAddressDecoder().decode(after.data, at) === to;
            return stake ? { ...FREE, leaves: [[stake, holds]] } : null;
        }
        case 'Initialize':
        case 'InitializeChecked':
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
