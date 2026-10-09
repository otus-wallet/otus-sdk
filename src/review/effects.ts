// What one instruction does, in words: a short line for its arguments, and its effects. Read from what its plugin
// says, for the programs Otus reads; for any other, what the simulation changed in your accounts it touches.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { STAKE_PROGRAM_ADDRESS } from '@solana-program/stake';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address, ReadonlyUint8Array } from '@solana/kit';

import { amount, cap, sol } from '../format.ts';
import { TOKEN_PROGRAMS } from '../programs/addresses.ts';
import type { Tone } from './assess.ts';
import type { Explained } from './explain.ts';

export type Effect = { text: string; tone: Tone };
export type Story = { args: string; effects: Effect[] };

/** What the words need to know about the accounts and tokens of the transaction. */
export type Names = {
    wallet: Address;
    who(address: Address): string; // "you", "your USDC account", "4Vn8…Qe2T", a program's name
    mine(address: Address): boolean;
    existed(address: Address): boolean; // before the transaction
    mintOf(tokenAccount: Address): Address | null;
    token(mint: Address | null): { symbol: string; decimals: number | null; verified: boolean }; // a symbol only for a verified token
    program(address: Address): string;
    priorityFee: bigint | null; // lamports the Compute Budget price comes to
    payer: Address;
    changes(address: Address): string[]; // what the simulation changed in an account of yours, in words
    icon?(mint: Address): string | null; // a verified token's logo
    holds?(tokenAccount: Address): bigint | null; // the units a token account held before the transaction
};

const NO_LIMIT = 2n ** 64n - 1n; // an allowance that can never run out

const DEFAULT_ADDRESS = '11111111111111111111111111111111'; // an unset address in a struct: no one

const AUTHORITY: Record<string, string> = { 0: 'The right to mint', 1: 'The right to freeze', 2: 'The ownership', 3: 'The right to close' };

/** One explained instruction → its story. `risky`: its program may be harmful, so what it does to you shows in red.
 *  `first`: it leads a transaction about to be signed, where a nonce's advance makes the whole transaction durable;
 *  anywhere else (later in it, inside a proposal, once landed) the advance only moves the nonce on. */
export function story(e: Explained, n: Names, risky = false, first = false): Story {
    const arg = (name: string) => e.args.find((a) => a.name === name)?.value ?? '';
    const acc = (role: string) => e.accounts.find((a) => a.role === role)?.address;
    const big = (name: string) => (/^\d+$/.test(arg(name)) ? BigInt(arg(name)) : 0n);
    const who = (a: Address | undefined) => (a ? n.who(a) : 'an account');
    const Who = (a: Address | undefined) => cap(who(a));
    const tokens = (units: bigint, mint: Address | null, decimals?: number) => {
        const t = n.token(mint);
        const places = decimals ?? t.decimals;
        return `${places === null ? `${units} units of` : amount(units, places, false)} ${t.symbol}`;
    };
    const line = (text: string, tone: Tone = 'plain'): Effect => ({ text, tone });
    const hurts = (a: Address | undefined) => (a && n.mine(a) ? (risky ? 'danger' : 'warn') : 'plain');

    if (e.source === 'unknown') return unknown(e, n, risky);
    if (e.program === SYSTEM_PROGRAM_ADDRESS) {
        switch (e.name) {
            case 'TransferSol': {
                const [from, to] = [acc('source'), acc('destination')];
                return { args: `${sol(big('amount'))} SOL → ${who(to)}`, effects: [line(`${sol(big('amount'))} SOL from ${who(from)} to ${who(to)}`, to && n.mine(to) && !(from && n.mine(from)) ? 'ok' : 'plain')] };
            }
            case 'CreateAccount':
            case 'CreateAccountWithSeed':
                return { args: `${who(acc('newAccount'))}, owned by ${n.program(arg('programAddress') as Address)}`, effects: [line(`${Who(acc('newAccount'))} owned by ${n.program(arg('programAddress') as Address)}`)] };
            case 'Assign':
            case 'AssignWithSeed':
                return { args: `${Who(acc('account'))} → ${n.program(arg('programAddress') as Address)}`, effects: [line(`Gives ${who(acc('account'))} to ${n.program(arg('programAddress') as Address)}`, acc('account') && n.mine(acc('account')!) ? 'danger' : 'plain')] };
            case 'Allocate':
            case 'AllocateWithSeed':
                return { args: `${arg('space')} bytes`, effects: [line(`Gives ${who(acc('newAccount'))} room for ${arg('space')} bytes`)] };
            case 'AdvanceNonceAccount':
                // Anywhere else, it only moves the nonce on: what was signed on it before can no longer run.
                if (!first) return { args: who(acc('nonceAccount')), effects: [line(`Moves the nonce of ${who(acc('nonceAccount'))} on: what was signed on it can no longer run`)] };
                return { args: who(acc('nonceAccount')), effects: [line('Uses a durable nonce: this transaction never expires', 'danger')] };
            case 'InitializeNonceAccount':
                return { args: `${Who(acc('nonceAccount'))}, used by ${who(arg('nonceAuthority') as Address)}`, effects: [line(`Only ${who(arg('nonceAuthority') as Address)} can use it`)] };
            case 'WithdrawNonceAccount':
                return { args: `${sol(big('withdrawAmount'))} SOL`, effects: [line(`${sol(big('withdrawAmount'))} SOL from ${who(acc('nonceAccount'))} to ${who(acc('recipientAccount'))}`)] };
            case 'AuthorizeNonceAccount':
                return { args: `→ ${who(arg('newNonceAuthority') as Address)}`, effects: [line(`Only ${who(arg('newNonceAuthority') as Address)} can use the nonce in ${who(acc('nonceAccount'))} from now on`, hurts(acc('nonceAccount')))] };
        }
    }
    if (TOKEN_PROGRAMS.includes(e.program)) {
        const mint = acc('mint') ?? n.mintOf(acc('source') ?? acc('account') ?? acc('token') ?? acc('owned') ?? acc('destination') ?? ('' as Address));
        const decimals = /^\d+$/.test(arg('decimals')) ? Number(arg('decimals')) : undefined;
        switch (e.name) {
            case 'Transfer':
            case 'TransferChecked': {
                const [from, to] = [acc('source'), acc('destination')];
                return { args: `${tokens(big('amount'), mint, decimals)} → ${who(to)}`, effects: [line(`${tokens(big('amount'), mint, decimals)} from ${who(from)} to ${who(to)}`, to && n.mine(to) && !(from && n.mine(from)) ? 'ok' : hurts(from) === 'danger' ? 'danger' : 'plain')] };
            }
            case 'Approve':
            case 'ApproveChecked': {
                const [delegate, source] = [acc('delegate'), acc('source')];
                const units = big('amount');
                // Without limit: all the account holds, now and whatever comes to it, until the allowance is revoked.
                if (units === NO_LIMIT) {
                    const what = source && n.mine(source) ? `all your ${n.token(mint).symbol}` : `all the ${n.token(mint).symbol} in ${who(source)}`;
                    return { args: `${who(delegate)} · no limit`, effects: [line(`${Who(delegate)} may move ${what}, with no limit and at any time`, hurts(source))] };
                }
                const held = source ? (n.holds?.(source) ?? null) : null;
                const all = held !== null && held > 0n && units >= held ? ' (all you hold)' : '';
                return { args: `${who(delegate)}, up to ${tokens(units, mint, decimals)}`, effects: [line(`${Who(delegate)} may move up to ${tokens(units, mint, decimals)}${all} from ${who(source)}`, hurts(source))] };
            }
            case 'Revoke':
                return { args: who(acc('source')), effects: [line(`Takes back any allowance on ${who(acc('source'))}`, 'ok')] };
            case 'SetAuthority': {
                const to = arg('newAuthority');
                const right = AUTHORITY[arg('authorityType')] ?? 'An authority';
                return { args: `${right.replace(/^The /, '')} → ${to === 'none' ? 'nobody' : who(to as Address)}`, effects: [line(`${right} of ${who(acc('owned'))} goes to ${to === 'none' ? 'nobody' : who(to as Address)}`, to !== n.wallet ? hurts(acc('owned')) === 'plain' ? 'plain' : 'danger' : 'plain')] };
            }
            case 'CloseAccount': {
                const [account, to] = [acc('account'), acc('destination')];
                return { args: `${Who(account)} → ${who(to)}`, effects: [line(`Closes ${who(account)}; its SOL goes to ${who(to)}`, to && n.mine(to) ? 'plain' : hurts(account))] };
            }
            case 'SyncNative':
                return { args: Who(acc('account')), effects: [line(`Counts the SOL in ${who(acc('account'))} as wrapped SOL`)] };
            case 'MintTo':
            case 'MintToChecked':
                return { args: `${tokens(big('amount'), mint, decimals)} → ${who(acc('token'))}`, effects: [line(`Mints ${tokens(big('amount'), mint, decimals)} to ${who(acc('token'))}`, acc('token') && n.mine(acc('token')!) ? 'ok' : 'plain')] };
            case 'Burn':
            case 'BurnChecked':
                return { args: tokens(big('amount'), mint, decimals), effects: [line(`Burns ${tokens(big('amount'), mint, decimals)} from ${who(acc('account'))}`, hurts(acc('account')))] };
            case 'InitializeAccount':
            case 'InitializeAccount2':
            case 'InitializeAccount3':
                return { args: Who(acc('account')), effects: [line(`Sets up ${who(acc('account'))} for ${n.token(mint).symbol}`)] };
            case 'FreezeAccount':
            case 'ThawAccount':
                return { args: Who(acc('account')), effects: [line(`${e.name === 'FreezeAccount' ? 'Freezes' : 'Thaws'} ${who(acc('account'))}`, e.name === 'FreezeAccount' ? hurts(acc('account')) : 'plain')] };
        }
    }
    if (e.program === STAKE_PROGRAM_ADDRESS) {
        // A field of a struct argument, as the client writes it: "{ staker: …, withdrawer: … }".
        const field = (name: string, key: string) => new RegExp(`${key}: ([1-9A-HJ-NP-Za-km-z]{32,44})`).exec(arg(name))?.[1] as Address | undefined;
        const stake = acc('stake');
        switch (e.name) {
            case 'Initialize':
            case 'InitializeChecked': {
                const withdrawer = acc('withdrawAuthority') ?? field('arg0', 'withdrawer');
                const custodian = field('arg1', 'custodian');
                const effects = [line(`Only ${who(withdrawer)} can withdraw from ${who(stake)}`, withdrawer && withdrawer !== n.wallet ? 'warn' : 'plain')];
                if (custodian && custodian !== DEFAULT_ADDRESS) effects.push(line(`${Who(custodian)} holds its lockup`, 'warn'));
                return { args: `${Who(stake)}, withdrawn by ${who(withdrawer)}`, effects };
            }
            case 'DelegateStake':
                return { args: `${Who(stake)} → ${who(acc('vote'))}`, effects: [line(`Delegates ${who(stake)} to validator ${who(acc('vote'))}`)] };
            case 'Deactivate':
                return { args: Who(stake), effects: [line(`Unstakes ${who(stake)}`)] };
            case 'Withdraw':
                return { args: `${sol(big('args'))} SOL → ${who(acc('recipient'))}`, effects: [line(`${sol(big('args'))} SOL from ${who(stake)} to ${who(acc('recipient'))}`, acc('recipient') && n.mine(acc('recipient')!) ? 'ok' : hurts(stake))] };
            case 'Authorize':
            case 'AuthorizeChecked': {
                const to = acc('newAuthority') ?? (arg('arg0') as Address);
                const right = (arg('arg1') || arg('stakeAuthorize')) === '1' ? 'The right to withdraw' : 'The right to stake';
                return { args: `${right.replace(/^The /, '')} → ${who(to)}`, effects: [line(`${right} ${who(stake)} goes to ${who(to)}`, to !== n.wallet && right === 'The right to withdraw' ? (hurts(stake) === 'plain' ? 'warn' : 'danger') : hurts(stake))] };
            }
            case 'Split':
                return { args: `${sol(big('args'))} SOL → ${who(acc('splitStake'))}`, effects: [line(`${sol(big('args'))} SOL of ${who(stake)} moves to ${who(acc('splitStake'))}`)] };
            case 'Merge':
                return { args: `${Who(acc('sourceStake'))} → ${who(acc('destinationStake'))}`, effects: [line(`Merges ${who(acc('sourceStake'))} into ${who(acc('destinationStake'))}`)] };
            case 'SetLockup':
            case 'SetLockupChecked':
                return { args: Who(stake), effects: [line(`Changes the lockup of ${who(stake)}`, hurts(stake))] };
        }
    }
    if (e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && e.name.startsWith('CreateAssociatedToken')) {
        const [ata, owner, mint] = [acc('ata'), acc('owner'), acc('mint')];
        const what = `${owner && owner === n.wallet ? 'your' : `${who(owner)}'s`} ${n.token(mint ?? null).symbol} account`;
        const back = owner && owner === n.wallet ? 'the rent comes back when it closes' : 'the rent is theirs when they close it';
        const effects = ata && n.existed(ata) ? [line(`${cap(what)} is there already: nothing changes`)] : [line(`Opens ${what}, paid by ${who(acc('payer'))}; ${back}`)];
        return { args: cap(what), effects };
    }
    if (e.program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
        switch (e.name) {
            case 'SetComputeUnitLimit':
                return { args: `${Number(arg('units')).toLocaleString('en-US')} CU`, effects: [line(`Caps compute at ${Number(arg('units')).toLocaleString('en-US')} units`)] };
            case 'SetComputeUnitPrice':
                return { args: `${Number(arg('microLamports')).toLocaleString('en-US')} µlamports/CU`, effects: [line(n.priorityFee === null ? 'Sets a priority fee' : `Priority fee ${sol(n.priorityFee)} SOL, paid by ${who(n.payer)}`)] };
            case 'RequestHeapFrame':
                return { args: `${Number(arg('bytes')) / 1024} KB`, effects: [line(`Asks for ${Number(arg('bytes')) / 1024} KB of memory`)] };
            case 'SetLoadedAccountsDataSizeLimit':
                return { args: `${Number(arg('accountDataSizeLimit')).toLocaleString('en-US')} bytes`, effects: [line('Caps how much account data it may load')] };
        }
    }
    if ([MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3].includes(e.program as never)) {
        return { args: `“${clean(arg('memo'))}”`, effects: [line('Writes a note in the transaction log')] };
    }
    return { args: e.args.map((a) => `${a.name} ${clean(a.value)}`).join(' · '), effects: [] };
}

// Text a transaction carries, as a seed: no characters that reorder or hide what is shown, and short.
const clean = (s: string) => {
    const text = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
};

// An instruction no plugin reads: its data in short, and what the simulation changed in your accounts it touches.
function unknown(e: Explained, n: Names, risky: boolean): Story {
    const touched = [...new Set(e.accounts.map((a) => a.address))].filter((a) => n.mine(a));
    // What comes to you is never what harms you: only what leaves shows red.
    const effects = touched.flatMap((a) => n.changes(a)).map((text) => ({ text, tone: (text.startsWith('+') ? 'ok' : risky ? 'danger' : 'plain') as Tone }));
    return { args: e.data ? `No plugin reads it · data ${hex(e.data)}` : 'No plugin reads it', effects: effects.length ? effects : [{ text: touched.length ? 'Nothing of yours changes in the simulation' : 'Touches nothing of yours', tone: 'plain' }] };
}

const hex = (data: ReadonlyUint8Array) => (data.length === 0 ? 'none' : `0x${[...data.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}${data.length > 4 ? '…' : ''} · ${data.length} bytes`);
