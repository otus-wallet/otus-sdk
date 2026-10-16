import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LOADER_V3_PROGRAM_ADDRESS } from '@solana-program/loader-v3';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    address,
    getAddressDecoder,
    getAddressEncoder,
    getI64Decoder,
    getU32Decoder,
    getU64Decoder,
    isAddress,
    isOffCurveAddress,
    type Address,
    type ReadonlyUint8Array,
} from '@solana/kit';
import type { MintTerms } from '../access/mint.ts';

import { alike, cap, told } from '../format.ts';
import { LIGHTHOUSE, STAKE_PROGRAM, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { CORE_PROGRAMS } from '../programs/core.ts';
import { BRANDS, HOLDS, PROGRAM_NAMES } from '../programs/known.ts';
import { holdings, offsetsOf, plain, read, units, type Change, type Changes, type State } from './changes.ts';
import { RENT_MOST, untold } from './consistency.ts';
import { durable } from './decode.ts';
import type { Explained } from './explain.ts';
import type { Deployment } from './programs.ts';
import { hostedOn, lookalike, programsCalled } from './sites.ts';
import type { Simulated } from './simulate.ts';

/** How much a finding matters. A notice is worth knowing and changes nothing: the verdict is the worst of the rest. */
export type Level = 'ok' | 'notice' | 'warn' | 'danger';
/** A colour a line gets: a level, or plain text. */
export type Tone = Level | 'plain';
export type Verdict = 'ok' | 'warn' | 'danger';
/** `programs`: the programs it is about besides its subject, as the channel of what it says. */
export type Finding = { level: Level; code: string; text: string; note?: string; subject?: Address; programs?: Address[] };

/** What the wallet knows that the transaction does not say. */
export type Context = {
    wallet: Address; // the account asked to sign
    signedBefore: number | null; // when you first signed a transaction for this site, in seconds since 1970; null: never
    host?: string; // the site's, to tell one that imitates a known site
    programsBefore?: Address[]; // what the transactions you signed for this site called (programsCalled); undefined: none kept
    now?: number; // seconds since 1970, to tell how long ago a program was deployed
    deployments?: Map<Address, Deployment>;
    own?: boolean; // made in Otus itself: no site asked for it
    to?: Address; // for a transfer made in Otus: the address typed
    wallets?: Address[]; // every account of yours in Otus, watched ones too: what lands with them, or in their token accounts, is yours
    signers?: Address[]; // the accounts of yours Otus signs for (a key it holds, a Ledger): what goes to one stays yours to control
    contacts?: Map<Address, string>; // the addresses you keep, by your names for them
    sent?: Address[]; // the addresses you sent to: a copy of one is what address poisoning counts on
    mints?: Map<Address, MintTerms>; // the terms of the mints whose tokens it moves, as they stand when it ends
};

/** What one program gets from you. `name`: Otus's, for a program it knows; null for one it doesn't. `accounts`: how
 *  many of yours it can write. `unseen`: it has your signature where the RPC did not list what it calls. */
export type ProgramUse = { program: Address; name: string | null; signature: boolean; writable: boolean; accounts: number; unseen: boolean };

/** One asset of yours that moves: your net change, the fee aside, and the accounts on the other side, biggest first.
 *  `holder`: who holds that side (a token account's owner, or the account itself); `wallet`: a key someone holds. */
export type Flow = { asset: 'SOL' | Address; change: bigint; others: { address: Address; holder: Address; amount: bigint; wallet: boolean }[] };

/** Value that lands with someone else in a transaction you sign, beyond what left your accounts: out of a program's
 *  custody (a lending pool's vault, say) to a wallet that is not one of yours, nor holds a token account of yours; or,
 *  when nothing comes back to you, to a program's accounts. `known`: your name for that wallet, when you keep it;
 *  `programs`: those whose instructions name where it lands. */
export type Payout = { holder: Address; known: string | null; program: boolean; amounts: { asset: 'SOL' | Address; amount: bigint }[]; programs: Address[] };

/** What an account of the transaction is. */
export type Kind = 'you' | 'your-tokens' | 'yours' | 'programs' | 'mints' | 'tokens' | 'wallets' | 'program-accounts' | 'sysvars' | 'new';

export type Assessment = {
    verdict: Verdict; // the worst finding, notices aside
    findings: Finding[]; // worst first
    mine: Set<Address>; // the accounts yours at either end: the wallet, token accounts it owns, accounts only it can withdraw from
    yours: Changes; // your fee (0 when another account pays), and each account it writes with any part yours, as the part yours at each end: what guards hold
    leaves: Map<Address, Leaving>; // accounts of yours (`mine`) with a part not yours when it ends: who controls that part then
    shared: Map<Address, Address>; // token accounts of yours that get tokens, or become yours, under a mint whose permanent delegate (not yours) can move or burn them at any time: who
    keyed: Change[]; // other accounts it can write with your address in them: not yours, but guarded so your place stays
    programs: ProgramUse[];
    flows: Flow[];
    payouts: Payout[];
    kinds: Map<Address, Kind>;
};

/** Who controls, when the transaction ends, a part of an account of yours not yours then: its SOL, its tokens. An
 *  address (a wallet, a program's address, or the program that now owns the account), or null: no one has set it up,
 *  and anyone may. */
export type Leaving = { sol?: Address | null; tokens?: Address | null };

export const HIGH_FEE = 5_000_000n; // lamports
export const HUGE_FEE = 50_000_000n; // lamports: no transaction needs this much
const ORDER: Record<Level, number> = { danger: 0, warn: 1, notice: 2, ok: 3 };
const [HOUR, DAY] = [3_600, 86_400];
const FRESH = 7 * DAY; // a program deployed this recently gets a word
const RENT_BACK = 10_000_000n; // lamports: SOL this small landing with someone else is rent given back to whoever paid it
const SLOTS_PER_EPOCH = 432_000n;
type Clock = { now: number | null; epoch: bigint };

/** The earlier steps' output → findings, verdict, your changes, flows, and what each program gets from you. Pure. */
export function assess(s: Simulated, changes: Changes, explained: Explained[], context: Context): Assessment {
    const { wallet } = context;
    const key = getAddressEncoder().encode(wallet);
    // When it is, for a stake lockup: the time, and the epoch from the slot (432,000 slots each; where early epochs were
    // shorter, this reads one below the true epoch, so a lockup counts a little longer, never shorter).
    const clock: Clock = { now: context.now ?? null, epoch: s.slot / SLOTS_PER_EPOCH };
    // What is yours at each end, each account and asset apart: what you control when it starts and when it ends.
    const { mine, ends, yours, theirs, touched, leaves } = endsOf(s, changes, explained, wallet, clock);
    // Your address inside an account does not make it yours: anyone can write it into theirs.
    const keyed = changes.accounts.filter((c) => !touched.has(c.address) && (holds(c.before, key) || holds(c.after, key)));
    const programs = programUses(s, explained, new Set([...mine, ...touched]), context);
    const flows = flowsOf(theirs, yours, leaves, wallet);
    const findings: Finding[] = [];
    const add = (level: Level, code: string, text: string, subject?: Address, note?: string) =>
        findings.push({ level, code, text, ...(note !== undefined && { note }), ...(subject !== undefined && { subject }) });
    const given = new Set<Address>(); // who gets your funds, or a say over them: checked against the addresses you keep
    const shared = new Map<Address, Address>();

    // What the simulation shows. A failed one shows nothing, and a site can make it fail on purpose.
    const failed = s.simulation.error !== null;
    if (failed) add('warn', 'simulation-failed', 'The transaction would fail now, so its effects cannot be seen', undefined, 'A site can make it fail on purpose, to hide what it does');
    else add('ok', 'simulated', 'Changes');
    // What its instructions say they take, left out of the simulation: an RPC that hides it, from the review and the guards.
    const hidden = untold(s, changes, explained);
    if (hidden.length) add('warn', 'untold', 'The simulation leaves out what it does', hidden[0], "Its instructions do more to this account than the RPC's simulation shows");
    // Tokens your wallet moves out of someone else's account, as its delegate: seldom done, and what a lie about who
    // holds an account of yours looks like.
    const lent = allowed(s, explained, wallet, false).filter((a) => !mine.has(a));
    if (lent.length) add('warn', 'spends-allowance', "You move tokens from someone else's account", lent[0], 'Your wallet is allowed to: check that it should');
    const shown = findings.length;
    // Your other wallets Otus signs for: what goes to one of them stays yours to control, said, not critical. One you
    // only watch is not: anyone's address can be watched.
    const ours = new Set<Address>([wallet, ...(context.signers ?? [])]);
    const toOurs = (a: Address) => ours.has(a) && a !== wallet;
    // Control of something of yours handed to an address no key holds, a program's: said, to check, naming the
    // programs acting on it when Otus knows them all. Handed to someone's key: lost, critical.
    const program = (account: Address) => (byProtocol(s, account) ? `a program's address, through ${protocolsNaming(s, account)}` : "a program's address");
    for (const { address, before, after } of [...changes.accounts.filter((c) => touched.has(c.address)), ...keyed]) {
        const [from, to] = [before?.token ?? null, after?.token ?? null];
        if (address === wallet) {
            if (after && !plain(after)) add('danger', 'wallet-change', 'Your wallet would no longer be yours', address, `A program takes it over, with all it holds: ${name(after.program)}`);
        } else if (before && after && !plain(before) && before.program !== after.program) {
            if (touched.has(address)) add('danger', 'owner-change', 'An account of yours changes owner', address, `New owner ${name(after.program)}. You lose control of it.`);
            else add('warn', 'owner-change', 'An account with your address in it changes owner', address, `New owner ${name(after.program)}. Your place in it may go.`);
        }
        if (from && to && from.owner !== to.owner) given.add(to.owner);
        if (to?.delegate && to.delegate !== from?.delegate) given.add(to.delegate);
        if (to?.closer && to.closer !== from?.closer) given.add(to.closer);
        // One of yours given away; one given to you is yours now, nothing lost.
        if (from && to && from.owner !== to.owner && to.owner !== wallet) {
            if (toOurs(to.owner)) add('warn', 'token-owner-change', 'A token account of yours goes to another of your wallets', address, `New owner ${to.owner}`);
            else if (isOffCurveAddress(to.owner)) add('warn', 'token-owner-change', `A token account of yours goes to ${program(address)}`, address, `New owner ${to.owner}, an address no key holds: check it is the one you meant`);
            else add('danger', 'token-owner-change', 'A token account of yours changes owner', address, `New owner ${to.owner}. You lose control of it.`);
        }
        if (to?.delegate && (to.delegate !== from?.delegate || to.delegated > (from?.delegated ?? 0n))) {
            // Someone allowed all the account holds, or without end, takes all of it whenever it likes. A program's own
            // address, as a marketplace's, only as its program lets it: said, to check.
            // Nearly all of it (nine tenths, the bar for almost all your SOL) is as much a loss.
            const all = to.delegated >= ENDLESS || (to.amount > 0n && to.delegated * 10n >= to.amount * 9n);
            const most = to.delegated < ENDLESS && to.delegated < to.amount;
            if (all && !ours.has(to.delegate) && !isOffCurveAddress(to.delegate)) add('danger', 'delegate', most ? 'Someone could take almost all the tokens in an account of yours' : 'Someone could take all the tokens in an account of yours', address, `${to.delegate} could move them at any time`);
            else if (all && !ours.has(to.delegate)) add('warn', 'delegate', `A token account of yours is open to ${program(address)}`, address, `${to.delegate}, an address no key holds, could move all of it`);
            else add('warn', 'delegate', 'A token account of yours gets a delegate, or a bigger allowance', address, `${to.delegate} could move its tokens`);
        }
        if (to?.closer && to.closer !== from?.closer) {
            // Closing a token account sends all its SOL where the closer says: a wrapped SOL account's, or SOL beyond
            // any rent in another; else only its rent.
            const sol = to.native || (after?.lamports ?? 0n) > RENT_MOST;
            if (sol && !to.native && !ours.has(to.closer) && !isOffCurveAddress(to.closer)) add('danger', 'close-authority', 'Someone else can take the SOL in your token account', address, `${to.closer} could close it and take its SOL`);
            else if (sol && !to.native && !ours.has(to.closer)) add('warn', 'close-authority', `${cap(program(address))} could close your token account and take its SOL`, address, `${to.closer}, an address no key holds`);
            else if (to.native && !ours.has(to.closer) && !isOffCurveAddress(to.closer)) add('danger', 'close-authority', 'Someone could take the SOL in your wrapped SOL account', address, `${to.closer} could close it and take its SOL at any time`);
            else if (to.native && !ours.has(to.closer)) add('warn', 'close-authority', `${cap(program(address))} could close your wrapped SOL account`, address, `${to.closer}, an address no key holds, could take its SOL`);
            else add('warn', 'close-authority', 'A token account of yours gets a new close authority', address, `${to.closer} could close it`);
        }
        // Tokens you get, in an account of yours, opened for you or become yours: under a mint whose permanent delegate
        // can move or burn anyone's at any time, someone else controls them too. A rule of the token, not of this
        // transaction: said where they show, not graded. A Token-2022 mint Otus couldn't read may have one.
        const gets = to !== null && ours.has(to.owner) && (!from || !ours.has(from.owner) || to.amount > from.amount);
        if (gets) {
            const terms = context.mints?.get(to.mint);
            const lender = terms?.extensions.find((e) => e.kind === 'permanentDelegate')?.delegate;
            if (lender && !ours.has(lender)) {
                given.add(lender);
                shared.set(address, lender);
            } else if (!terms && after?.program === TOKEN_2022_PROGRAM_ADDRESS) add('warn', 'token-terms-unread', "Otus couldn't read the terms of a token you get", address, `${to.mint}: who else can move it is not known`);
        }
        // An account of yours left frozen: its tokens can't move until the mint's freeze authority thaws it.
        if (to?.frozen && !from?.frozen && ours.has(to.owner)) {
            const thawer = context.mints?.get(to.mint)?.freezeAuthority;
            add('warn', 'frozen', 'A token account of yours is frozen', address, thawer ? `Its tokens can't move until ${thawer} thaws it` : "Its tokens can't move");
        }
        // Your stake under a lockup in force that someone else keeps: made so now, or getting your SOL, as into a stake
        // account made for you beforehand. You can't withdraw until it ends, or they lift it.
        const [was, is] = [stake(before, clock), stake(after, clock)];
        if (is) for (const a of [is.staker, is.withdrawer, is.custodian]) if (a !== was?.staker && a !== was?.withdrawer && a !== was?.custodian) given.add(a);
        const kept = is !== null && is.locked && !ours.has(is.custodian) && ours.has(is.withdrawer); // as it ends
        const fed = (after?.lamports ?? 0n) > (before?.lamports ?? 0n);
        if (kept && (is.lockup !== was?.lockup || fed) && !lockedBefore(is.lockup)) {
            const text = is.lockup === was?.lockup ? 'Your SOL goes into stake someone else keeps locked' : nobody(is.custodian) ? 'Your stake gets a lockup no one can lift' : 'Your stake gets a lockup someone else holds';
            const note = nobody(is.custodian) ? "No one can lift it: you can't withdraw until it ends" : `${is.custodian} can lift it: until then you can't withdraw`;
            const program = !nobody(is.custodian) && isOffCurveAddress(is.custodian); // a vesting program's, say
            const said = toOurs(is.custodian) ? 'Your stake gets a lockup another of your wallets holds' : program ? `${text}: a program's address can lift it` : text;
            add(toOurs(is.custodian) || program ? 'warn' : 'danger', 'stake-lockup', said, address, note);
        }
        // Your stake, made or getting your SOL, that someone else manages: they can unstake it or move it to another
        // validator, not take it.
        if (is !== null && is.withdrawer === wallet && is.staker !== wallet && fed) add('warn', 'stake-staker', 'Someone else manages this stake', address, `${is.staker} can unstake it or change its validator`);
        // An authority of yours given up to no one: its tag cleared, your key left behind in the bytes. No key gains it: said, to check, as it can't be undone.
        if (before && after && !from) for (const role of givenUp(before, after, key)) add('warn', 'authority-change', `You give up your ${role}: no one will ever hold it`, address, "It can't be undone");
        // Your address inside any other account, as its authority or owner, stays where it was.
        if (before && after && !from) {
            for (const offset of offsetsOf(key, before)) {
                // Where that field is now: the same place, but in a Token-2022 mint's extension, which moves as one
                // before it grows; read by the extensions' own layout. Not found: unknown, as gone to anyone.
                const at = fieldAfter(before, after, offset);
                const now = at !== null && after.data.length >= at + 32 ? after.data.slice(at, at + 32) : null;
                if (now && now.every((b, i) => b === key[i])) continue; // still yours
                const role = roleAt(before, offset);
                // A Token-2022 mint extension's authority set to no one (all zeros there): given up, as givenUp says.
                if (role && at !== null && offset >= 166 && isMint(before) && now?.every((b) => b === 0)) {
                    add('warn', 'authority-change', `You give up your ${role}: no one will ever hold it`, address, "It can't be undone");
                    continue;
                }
                const holder = now && now.some((b) => b !== 0) ? getAddressDecoder().decode(now) : null;
                if (role && holder) given.add(holder);
                // To another of your wallets Otus signs for: said, not critical. To an address no key holds, a program's
                // (a protocol taking a stake deposited, a DAO taking a mint): said, to check. To anyone's key: lost,
                // critical.
                if (role && holder && toOurs(holder)) add('warn', 'authority-change', `Your ${role} goes to another of your wallets`, address, `Now ${holder}`);
                else if (role && holder && isOffCurveAddress(holder)) add('warn', 'authority-change', `Your ${role} goes to ${program(address)}`, address, `To ${holder}, an address no key holds: check it is the one you meant`);
                else if (role) add('danger', 'authority-change', `You would lose your ${role}`, address);
                else add('warn', 'authority-change', 'Your address would leave an account that held it, maybe as its authority', address);
            }
        }
    }
    // An upgrade authority of yours used: new code for your program, or its program data closed, ending it for good.
    for (const [program, text] of upgrades(s, wallet)) add('danger', 'program-change', text, program, 'Signed with your upgrade authority');
    // Your SOL into a stake account another key withdraws: theirs to take out, whatever the site calls it. Only SOL that
    // could have come from you, not more than you send. A program's own address withdrawing, as a stake pool's reserve,
    // takes it only as its program lets it: when only programs Otus names put it there.
    // The SOL that leaves accounts of yours, whatever comes back to others of them: SOL paid to you beside it hides none.
    const sent = yours.accounts.reduce((sum, c) => {
        const lost = (c.before?.lamports ?? 0n) - (c.after?.lamports ?? 0n);
        return lost > 0n ? sum + lost : sum;
    }, 0n);
    const gaining = theirs.accounts.filter((c) => (c.after?.lamports ?? 0n) > (c.before?.lamports ?? 0n));
    // And what the instructions say your accounts send each account, though more comes back to them.
    const said = sentInWords(explained, changes).filter((w) => w.kind === 'SOL' && w.from !== undefined && touched.has(w.from));
    for (const c of gaining) {
        const o = { address: c.address, amount: (c.after?.lamports ?? 0n) - (c.before?.lamports ?? 0n) };
        const state = changes.accounts.find((x) => x.address === c.address)?.after ?? null;
        const is = stake(state, clock);
        if (is) given.add(is.withdrawer);
        // What of it can be yours: no more than you send, or than the words say you send it. Rent's worth is no
        // one's to take.
        const told = said.filter((w) => w.to === o.address).reduce((sum, w) => sum + w.amount, 0n);
        const most = sent > told ? sent : told;
        const part = o.amount < most ? o.amount : most;
        if (part <= RENT_BACK) continue;
        // Set up by no one yet (a stake or nonce account never initialized): whoever sets it up first takes it.
        if (unset(state)) {
            add('danger', 'stake-withdrawer', 'Your SOL goes into an account no one has set up', o.address, 'Whoever sets it up first can take the SOL out');
            continue;
        }
        // Into a token account whose tokens are yours and whose SOL someone else takes by closing it: yours in name only.
        const t = state?.token;
        const closer = t && t.owner === wallet ? (t.closer ?? t.owner) : null;
        if (closer && !ours.has(closer)) {
            if (findings.some((f) => f.code === 'close-authority' && f.subject === o.address)) continue; // said already
            if (isOffCurveAddress(closer)) add('warn', 'close-authority', `Your SOL goes into a token account ${program(o.address)} can close`, o.address, `${closer}, an address no key holds, takes its SOL when it closes it`);
            else add('danger', 'close-authority', 'Someone else can take the SOL you put in your token account', o.address, `${closer} can close it and take its SOL`);
            continue;
        }
        const nonce = nonceAuthority(state);
        if (nonce && nonce !== wallet) {
            if (ours.has(nonce)) continue;
            if (isOffCurveAddress(nonce)) add('warn', 'stake-withdrawer', `Your SOL goes into a nonce account that ${program(o.address)} withdraws`, o.address, `${nonce}, an address no key holds: check what you get back`);
            else add('danger', 'stake-withdrawer', 'Someone else can withdraw this nonce account', o.address, `${nonce} can take the SOL out`);
            continue;
        }
        // Another of your wallets withdrawing it is yours to control, unless someone else's lockup holds it. A
        // program's address withdrawing it (a pool's reserve, say): said, to check. Someone's key: theirs, critical.
        if (!is || is.withdrawer === wallet) continue;
        const lockedBy = is.locked && !ours.has(is.custodian) ? is.custodian : null;
        if (toOurs(is.withdrawer) && !lockedBy) add('warn', 'stake-withdrawer', 'Another of your wallets can withdraw this stake', o.address, `${is.withdrawer} can take the SOL out`);
        else if (toOurs(is.withdrawer)) add(!nobody(lockedBy!) && isOffCurveAddress(lockedBy!) ? 'warn' : 'danger', 'stake-lockup', 'Your SOL goes into stake someone else keeps locked', o.address, nobody(lockedBy!) ? "No one can lift its lockup: until it ends, it can't be withdrawn" : `${lockedBy} holds its lockup: until it ends, it can't be withdrawn`);
        else if (isOffCurveAddress(is.withdrawer)) add('warn', 'stake-withdrawer', `Your SOL goes into stake that ${program(o.address)} withdraws`, o.address, `${is.withdrawer}, an address no key holds: check what you get back`);
        else add('danger', 'stake-withdrawer', 'Someone else can withdraw this stake', o.address, `${is.withdrawer} can take the SOL out`);
    }
    // Stake of yours under this lockup that was under it already: split or merged among your stakes, none of them coming
    // under it anew (one locked now that wasn't), all of them together no more than before but for the rent reserves of
    // the accounts made, and none of your free SOL going in beyond those. Then nothing of yours is newly locked.
    function lockedBefore(lockup: string): boolean {
        let [had, has, made] = [0n, 0n, 0n];
        for (const c of changes.accounts) {
            const [was, is] = [stake(c.before, clock), stake(c.after, clock)];
            const wasIn = was !== null && was.withdrawer === wallet && was.lockup === lockup;
            const isIn = is !== null && is.withdrawer === wallet && is.lockup === lockup;
            if (was && !wasIn && isIn) return false; // an existing stake newly under it
            if (wasIn) had += c.before?.lamports ?? 0n;
            if (isIn) has += c.after?.lamports ?? 0n;
            // A new one's rent reserve, as its meta says (after its kind).
            if (isIn && !c.before && c.after && c.after.data.length >= 12) made += getU64Decoder().decode(c.after.data, 4);
        }
        const sol = flows.find((f) => f.asset === 'SOL')?.change ?? 0n;
        return had > 0n && has <= had + made && sol >= -made;
    }
    if (!failed && findings.length === shown) add('ok', 'no-authority-change', 'No owner or authority changes', undefined, 'Owners and authorities stay as they are');
    if (!failed) for (const [what, subject] of outflows(yours)) add('warn', 'large-outflow', `You send almost all ${what}`, subject);

    // What the message asks for.
    if (durable(s.message)) add('warn', 'durable-nonce', 'Durable nonce: this transaction never expires', undefined, 'It can be kept and sent at any time later');
    if (yours.fee > HUGE_FEE) add('danger', 'high-fee', 'A huge network fee', undefined, 'It goes to whoever makes the block');
    else if (yours.fee > HIGH_FEE) add('warn', 'high-fee', 'High network fee');
    else if (yours.fee > 0n) add('ok', 'normal-fee', 'Normal network fee');

    // Who gets what from you. A program Otus doesn't know gets a word: a warning when it gets your signature or
    // accounts, a notice otherwise (a notice too once its own IDL describes it: see described). What it does is said
    // too: taking your signature into a program that keeps something of yours no balance shows, or where Otus cannot
    // see; warnings, as Otus infers them.
    for (const p of programs) {
        const named = p.name ?? 'An unknown program';
        const getsYou = p.signature || p.writable;
        if (p.name === null) {
            const what = p.accounts > 0 ? `It uses ${p.accounts} of your accounts` : 'It uses your signature';
            add(getsYou ? 'warn' : 'notice', 'unknown-program', `${p.program} is not a program Otus knows`, p.program, getsYou ? what : 'It touches nothing of yours');
            if (p.unseen) add('warn', 'reach-unseen', "Otus can't see what an unknown program does with your signature", p.program, 'The RPC did not list what it calls');
        }
        const d = context.deployments?.get(p.program);
        const age = d?.deployed && context.now ? Math.max(0, context.now - d.deployed) : null;
        // Known programs redeploy often; a fresh one only counts for a program no one can name.
        if (d && age !== null && age < FRESH && !d.builtin && p.name === null) {
            add('warn', 'fresh-program', `${named} was deployed ${ago(age)}`, p.program, d.upgradeable ? 'Its authority can still change it' : 'It can no longer change');
        }
    }
    // Where your signature reaches: a program Otus doesn't know calling one that keeps something of yours, at any depth;
    // or given it beside one, which it can call once it lands, whatever it did when simulated.
    const reached = holdsCalls(s, wallet);
    const where = (held: Set<Address>) => [...held].map((q) => PROGRAM_NAMES.get(q)).join(', ');
    for (const [caller, held] of reached) add('warn', 'reaches-holdings', `An unknown program uses your signature in ${where(held)}`, caller, HOLDINGS);
    const seen = new Set([...reached.values()].flatMap((held) => [...held]));
    for (const [caller, held] of holdsBeside(s, wallet)) {
        const fresh = new Set([...held].filter((q) => !seen.has(q)));
        if (fresh.size) add('warn', 'reaches-holdings', `An unknown program can use your signature in ${where(fresh)}`, caller, HOLDINGS);
    }
    if (programs.length > 0 && programs.every((p) => p.name !== null)) add('ok', 'all-known', 'Known programs', undefined, programs.map((p) => p.name).join(', '));

    if (!failed) findings.push(...leaving(programs, explained, changes, flows, yours, ends, nftBack(s, changes, key)));

    // Value that lands with someone else without leaving your accounts: said exactly, for you to judge. To an address
    // you keep, by its name.
    const payouts = failed ? [] : payoutsOf(s, theirs, yours, leaves, flows, context);
    for (const p of payouts) {
        const [level, code, text]: [Level, string, string] = p.known ? ['notice', 'pays-known', `Funds go to ${p.known}`] : ['warn', 'pays-others', p.program ? "Funds go to a program's account, not to you" : 'Funds go to someone else, not to you'];
        findings.push({ level, code, text, subject: p.holder, programs: p.programs });
        given.add(p.holder);
    }
    // Where yours goes: who holds it, and the very account (any account's address can be ground to look like another).
    for (const flow of flows) if (flow.change < 0n) for (const o of flow.others) given.add(o.holder).add(o.address);
    for (const f of findings) if (f.code === 'sends-to-wallet' && f.subject) given.add(f.subject);
    for (const a of namedTo(explained)) given.add(a); // what balances can't show: a failed simulation, a payment in a trade
    if (context.to) given.add(context.to);
    findings.push(...lookalikes([...given], context));

    // Where the request comes from.
    const kinds = kindsOf(s, changes, mine, wallet);
    if (context.own) {
        add('ok', 'own-transfer', 'Made in Otus', undefined, 'No site asked for it');
        // Typed to a program's account, or to an address no key can hold: what goes there may not come back.
        const to = context.to;
        const kind = to ? kinds.get(to) : undefined;
        if (to && (kind === 'program-accounts' || kind === 'programs' || kind === 'mints' || (kind === 'new' && isOffCurveAddress(to)))) add('warn', 'to-program', 'You send to a program’s account', to, 'Not to someone with a key: what you send may not come back');
    } else {
        findings.push(...siteFindings(context));
        const since = context.signedBefore;
        // A program none of the transactions you signed for it called: worth knowing, as a site taken over would ask for
        // one. A first transaction has nothing to go by, nor one for a site whose programs Otus did not keep yet.
        const before = context.programsBefore;
        const fresh = since !== null && before ? programsCalled(s.message).filter((p) => !before.includes(p)) : [];
        if (fresh.length) findings.push({ level: 'notice', code: 'new-program', text: fresh.length === 1 ? 'New program for this site' : 'New programs for this site', note: fresh.map(name).join(', '), programs: fresh });
    }

    return { ...ranked(findings), mine, yours, leaves, shared, keyed, programs, flows, payouts, kinds };
}

/**
 * What is known of the site a request comes from: whether its host imitates a known site's, whether it is put up where
 * anyone can put one up, and your history with it. A site becomes known a day after the first transaction you signed
 * for it (`signedBefore`): a site can ask for a harmless one first, but a scam rarely waits a day. `connecting`: asked
 * before any transaction, when it asks to connect, and told for that.
 */
export function siteFindings({ host, signedBefore: since, now }: Pick<Context, 'host' | 'signedBefore' | 'now'>, connecting = false): Finding[] {
    const findings: Finding[] = [];
    const add = (level: Level, code: string, text: string, note?: string) => findings.push({ level, code, text, ...(note !== undefined && { note }) });
    const imitated = host ? lookalike(host) : null;
    if (imitated) add('warn', 'lookalike', `This site looks like ${imitated}`, `${host} is not ${imitated}`);
    // Put up where anyone can put one up in a minute: what a scam site, made and dropped by the day, is put up on.
    const hosted = host ? hostedOn(host) : null;
    if (hosted) add('warn', 'shared-host', `Hosted on ${hosted}`, 'Anyone can put up a site there');
    // A time that is no number is none; with no time now, how long ago is unknown: new, not known.
    const signed = Number.isFinite(since) ? (since as number) : null;
    const age = signed !== null && Number.isFinite(now) ? Math.max(0, (now as number) - signed) : null;
    if (signed === null && connecting) add('warn', 'first-visit', 'New site', 'You never signed a transaction for it in Otus');
    else if (signed === null) add('warn', 'first-visit', 'First transaction for this site', 'You never signed one for it from this wallet');
    else if (age === null || age < DAY) add('notice', 'new-site', 'New site', age === null ? undefined : `You first signed a transaction for it ${ago(age)}`);
    else add('ok', 'known-site', 'Known site', host ? `${host} · signed for before` : undefined);
    return findings;
}

/**
 * The findings once the IDLs of the programs Otus doesn't know are read. `described`: each such program whose own
 * IDL tells every instruction of it here, by the name it gives itself. Described, it is shown for what it says it is,
 * by that name: a notice, while guards hold what it does with you (`held`: they are on, and Otus sends it now). An IDL
 * names instructions and binds nothing: unguarded, or sent later by the site, a program that gets you stays a warning.
 * One that is not described stays as it was, and says so. One whose name borrows the brand of a program Otus knows is
 * said, a warning: what a site does to pass a program off as another.
 */
export function described(findings: Finding[], named: Map<Address, string>, programs: ProgramUse[], held = true): Finding[] {
    const told = findings.map((f): Finding => {
        if (f.code !== 'unknown-program' || !f.subject) return f;
        const name = named.get(f.subject);
        if (!name) return { ...f, note: `${f.note} · Otus can't read what it does` };
        return { ...f, level: f.level === 'warn' && !held ? 'warn' : 'notice', text: `${name} is not a program Otus knows`, note: `${f.note} · its own IDL describes it` };
    });
    const posing = programs.flatMap((p): Finding[] => {
        const name = named.get(p.program);
        const brand = name && p.name === null ? borrowed(name) : null;
        const core = name && p.name === null && !brand ? posingAs(name) : null; // a plain word, as a crate may be called
        if (!name || !(brand || core)) return [];
        return [{ level: 'warn', code: 'imitation-program', text: `An unknown program calls itself ${name}`, subject: p.program, note: `It is not the ${brand ?? core} program Otus knows: ${p.program}` }];
    });
    return [...told, ...posing];
}

// A name's words, lowercase: "jupiterAggregator_v2" → jupiter, aggregator, v2; "OKXRouter" → okx, router.
const words = (name: string) =>
    name.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// What a program Otus doesn't know may borrow to pass for another: the brands, the wallets', and the names of the
// programs every transaction uses. Matched by whole words, so "Python" is not Pyth. Words as plain as Memo or Vote,
// and names forks keep, as SPL Governance's or a stake pool's, are no borrowing.
const BORROWABLE: ReadonlySet<string> = new Set([
    ...BRANDS,
    ...['otus', 'phantom', 'solflare', 'backpack'],
    ...['systemprogram', 'tokenprogram', 'token2022', 'associatedtoken', 'computebudget', 'stakeprogram', 'voteprogram', 'addresslookuptable'],
]);

// What a brand comes with in one word of a product's name: "jupiterv6", "kaminolend", "raydiumamm", "orcawhirlpool"
// (another brand), "realjupiter".
const PRODUCT = /^(?:v?\d+|swap|amm|clmm|cpmm|dlmm|router|route|lend|lending|aggregator|agg|perps?|dex|pools?|vaults?|farms?|stake|staking|bridge|program|protocol|finance|fi|labs|exchange|markets?|network|oracle|wallet|official|app|pro|io|xyz|sol)*$/;
const BEFORE = /^(?:the|real|official|my|true|get|go|super)/;

// The brand a word is made of, as a product of it; null when it is another word ("python" is no Pyth).
function brandIn(word: string, depth = 0): string | null {
    if (BORROWABLE.has(word)) return word;
    for (const b of BORROWABLE) if (word.startsWith(b) && (PRODUCT.test(word.slice(b.length)) || (depth === 0 && brandIn(word.slice(b.length), 1)))) return b;
    return null;
}

// A name, whole, that one of Solana's own programs goes by: "System", "Token", "Upgradeable Loader". Only whole:
// "token_vesting" or "stake_pool_router" borrow nothing, nor the names forks keep, as SPL Governance's.
const fold = (name: string) => words(name).join('');
const OWN_NAMES = new Map<string, string>(
    ['System', 'System Program', 'Token', 'Token Program', 'SPL Token', 'Token 2022', 'Stake', 'Stake Program', 'Memo', 'Vote', 'Vote Program', 'Loader', 'BPF Loader', 'Native Loader', 'Upgradeable Loader', 'Wrapped SOL', 'Compute Budget', 'Associated Token'].map((n): [string, string] => [fold(n), n]),
);
const posingAs = (name: string) => OWN_NAMES.get(fold(name)) ?? null;

// Digits that pass for letters: "jup1ter", "kam1n0".
const unleet = (word: string) => word.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');

// The name a program borrows: a brand its words spell in a row, or one a word is a product of, as written or with its
// digits read as letters, after a word such as "real" or "official".
function borrowed(name: string): string | null {
    const w = words(name);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j <= w.length; j++) if (BORROWABLE.has(w.slice(i, j).join(''))) return w.slice(i, j).join('');
    for (const word of w.flatMap((x) => [x, unleet(x)])) {
        const found = brandIn(word) ?? brandIn(word.replace(BEFORE, ''));
        if (found) return found;
    }
    return null;
}

/** Findings worst first, and the verdict: the worst of them, notices aside. */
export function ranked(findings: Finding[]): { verdict: Verdict; findings: Finding[] } {
    const sorted = findings.toSorted((a, b) => ORDER[a.level] - ORDER[b.level]);
    const worst = sorted[0]?.level;
    return { verdict: worst === 'danger' || worst === 'warn' ? worst : 'ok', findings: sorted };
}

/** How long ago, in words: "40 minutes ago", "3 hours ago", "2 days ago". */
export function ago(seconds: number): string {
    const [n, unit] = seconds < HOUR ? [Math.max(1, Math.round(seconds / 60)), 'minute'] : seconds < DAY ? [Math.round(seconds / HOUR), 'hour'] : [Math.round(seconds / DAY), 'day'];
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

// What is yours at each end of the transaction, each account and asset apart, read from what each account is:
// - your wallet's SOL, while it stays a plain wallet;
// - a token account's tokens, its owner's; its SOL, whoever can close it (its close authority, or its owner);
// - a stake account's SOL, whoever can withdraw it, unless someone else's lockup holds it; a nonce account's, its
//   authority's; one not set up is no one's, anyone may take it.
// `yours`: each account with any part yours, as the part that is yours at each end. `theirs`: every account as the rest.
// `mine`: the accounts yours at either end by what they are for (a token account's tokens, any other's SOL), named so
// ("your USDC account", what happened to it), and those read and yours. `ends`: what of each account is yours when the
// transaction ends (or, closed, when it began). `touched`: every account with any part yours at either end, or taken
// value out of by your wallet.
// An account your wallet takes value out of as its authority, as only its owner could (not lent to it), counts as yours
// however the RPC says it is held: what it loses is yours, the worse reading; what it gains, whoever holds it at the end.
function endsOf(s: Simulated, changes: Changes, explained: Explained[], wallet: Address, clock: Clock) {
    const lent = new Set(allowed(s, explained, wallet));
    const moved = new Set(authorized(explained, wallet).flatMap(([, a]) => (lent.has(a) ? [] : [a])));
    const of = (address: Address, state: State) => {
        const held = controls(address, state, clock, wallet);
        return { sol: held.sol === wallet, tokens: held.tokens === wallet };
    };
    const yours: Change[] = [];
    const theirs: Change[] = [];
    const [mine, touched] = [new Set<Address>([wallet]), new Set<Address>()];
    const ends = new Map<Address, { sol: boolean; tokens: boolean }>([[wallet, { sol: true, tokens: false }]]);
    const leaves = new Map<Address, Leaving>();
    // Who holds a part at the end: who controls it, else the program the account now belongs to; no one when not set up.
    const holding = (who: Address | null, after: NonNullable<State>) => {
        if (who) return who;
        if (unset(after)) return null;
        const k = stake(after, clock);
        return k?.locked ? k.custodian : after.program; // a stake under someone else's lockup: theirs until it ends
    };
    for (const c of changes.accounts) {
        const [start, end] = [of(c.address, c.before), of(c.address, c.after)];
        const auth = moved.has(c.address);
        // An amount at each end → the part of it yours.
        const part = (b: bigint, a: bigint, y0: boolean, y1: boolean): [bigint, bigint] => {
            if (y0 || !auth) return [y0 ? b : 0n, y1 ? a : 0n];
            return y1 ? [b, a] : [b > a ? b - a : 0n, 0n];
        };
        const [b, a] = [c.before?.lamports ?? 0n, c.after?.lamports ?? 0n];
        const [sb, sa] = part(b, a, start.sol, end.sol);
        // Tokens by mint: of one kept, the same mint at both ends; of another, none at the end.
        const [tb, ta] = [c.before?.token?.amount ?? 0n, c.after?.token?.amount ?? 0n];
        const same = c.before?.token && c.after?.token && c.before.token.mint === c.after.token.mint;
        const [ub, ua] = same ? part(tb, ta, start.tokens, end.tokens) : [part(tb, 0n, start.tokens, false)[0], part(0n, ta, false, end.tokens)[1]];
        const at = (state: State, lamports: bigint, amount: bigint): State => state && { ...state, lamports, token: state.token && { ...state.token, amount } };
        theirs.push({ address: c.address, before: at(c.before, b - sb, tb - ub), after: at(c.after, a - sa, ta - ua) });
        if (!(start.sol || start.tokens || end.sol || end.tokens || auth) && c.address !== wallet) continue; // your wallet always
        touched.add(c.address);
        yours.push({ address: c.address, before: at(c.before, sb, ub), after: at(c.after, sa, ua) });
        // Named yours by what it is for, at either end: a token account by its tokens, any other by its SOL; and one
        // your wallet takes value out of that loses some, or that the transaction closes (a swap's wrapped SOL, say).
        const main = (at: { sol: boolean; tokens: boolean }, state: State) => (state?.token ? at.tokens : at.sol);
        // One that also gains is not: what goes into it goes to whoever holds it then.
        const gains = a - sa > b - sb || ta - ua > tb - ub;
        if (main(start, c.before) || main(end, c.after) || (auth && !gains && (!c.after || sb > 0n || ub > 0n))) mine.add(c.address);
        if (c.after && mine.has(c.address) && (!end.sol || (c.after.token && !end.tokens))) {
            const held = controls(c.address, c.after, clock, wallet);
            leaves.set(c.address, {
                ...(!end.sol && { sol: holding(held.sol, c.after) }),
                ...(c.after.token && !end.tokens && { tokens: holding(held.tokens, c.after) }),
            });
        }
        ends.set(c.address, c.after ? end : start);
    }
    // The accounts the transaction reads and doesn't write: as they are.
    const written = new Set(changes.accounts.map((c) => c.address));
    for (const a of s.accounts) {
        if (written.has(a.address)) continue;
        const state = read(a.state);
        const held = of(a.address, state);
        if (state?.token ? held.tokens : held.sol) mine.add(a.address);
        ends.set(a.address, held);
    }
    return { mine, ends, leaves, yours: { fee: s.signers[0] === wallet ? changes.fee : 0n, accounts: yours }, theirs: { fee: changes.fee, accounts: theirs }, touched };
}

// Who controls an account's SOL and its tokens: a plain wallet, itself; a token account's tokens, its owner, and its SOL
// (`solOf`); any other account's SOL, whoever can withdraw it (`withdrawer`). Null: no one of ours to name.
function controls(address: Address, state: State, clock: Clock, wallet: Address): { sol: Address | null; tokens: Address | null } {
    if (!state) return { sol: null, tokens: null };
    const t = state.token;
    if (t) return { sol: solOf(t, wallet), tokens: t.native ? solOf(t, wallet) : t.owner };
    if (plain(state)) return { sol: address, tokens: null };
    return { sol: withdrawer(state, clock), tokens: null };
}

// Who can take a token account's SOL (and a wrapped SOL account's tokens): its owner, by a transfer or its excess
// lamports, and its close authority, by closing it. Yours only when both are you; else the one who isn't.
export const solOf = (t: { owner: Address; closer: Address | null }, wallet: Address): Address => (t.closer && t.closer !== t.owner && t.owner === wallet ? t.closer : t.owner);

// The token accounts of someone else your wallet takes tokens or SOL out of, as the RPC says it may: as their delegate,
// or (`closing`) closing one as its close authority, which moves only its rent. Theirs, used with their leave.
function allowed(s: Simulated, explained: Explained[], wallet: Address, closing = true): Address[] {
    return authorized(explained, wallet).flatMap(([name, a]) => {
        const state = s.accounts.find((x) => x.address === a)?.state;
        const token = state ? read(state)?.token : null;
        if (!token || token.owner === wallet) return [];
        // A close moves only rent: not wrapped SOL, and no more SOL in it than rent.
        if (name === 'CloseAccount') return closing && token.closer === wallet && !token.native && (state ? read(state)?.lamports ?? 0n : 0n) <= RENT_MOST ? [a] : [];
        return token.delegate === wallet ? [a] : [];
    });
}

// The accounts your wallet, as their authority, takes value out of in the instructions Otus reads: a token account it
// transfers, burns, closes or gives an allowance from; a stake or nonce account it withdraws. Unless the RPC says it may
// as someone else's delegate or close authority, only their owner could: yours, whoever the RPC says holds them, as one
// that named someone else would keep them, and their guards, out of the review.
const AUTHORIZED: Record<string, [string, string]> = {
    Transfer: ['authority', 'source'],
    TransferChecked: ['authority', 'source'],
    Burn: ['authority', 'account'],
    BurnChecked: ['authority', 'account'],
    CloseAccount: ['owner', 'account'],
    Approve: ['owner', 'source'],
    ApproveChecked: ['owner', 'source'],
    Withdraw: ['withdrawAuthority', 'stake'],
    WithdrawNonceAccount: ['nonceAuthority', 'nonceAccount'],
};
function authorized(explained: Explained[], wallet: Address): [string, Address][] {
    return explained.flatMap((e): [string, Address][] => {
        const native = TOKEN_PROGRAMS.includes(e.program) || e.program === STAKE_PROGRAM || e.program === SYSTEM_PROGRAM_ADDRESS;
        const roles = e.source === 'plugin' && native && Object.hasOwn(AUTHORIZED, e.name) ? AUTHORIZED[e.name] : null;
        const [by, of] = roles ? roles.map((role) => e.accounts.find((a) => a.role === role)?.address) : [];
        return by === wallet && of ? [[e.name, of]] : [];
    });
}

// Who can take the SOL out of an account other than a token account: a nonce account's authority, or a stake account's
// withdrawer, unless a lockup someone else keeps holds it.
function withdrawer(state: State, clock: Clock): Address | null {
    if (!state || state.token) return null;
    const d = state.data;
    const at = (offset: number) => getAddressDecoder().decode(d, offset);
    // A nonce account: version, state (1: initialized), authority, nonce, fee.
    if (state.program === SYSTEM_PROGRAM_ADDRESS && state.space === 80 && getU32Decoder().decode(d, 4) === 1) return at(8);
    // A stake account: its withdrawer's, unless a lockup someone else can lift holds it.
    const k = stake(state, clock);
    if (k) return k.locked && k.custodian !== k.withdrawer ? null : k.withdrawer;
    return null;
}

// A stake account, kind 1 (initialized) or 2 (delegated): its staker and withdrawer, and its lockup (a time, an epoch, and the
// custodian who alone can lift it before then), in force while its time or its epoch is still ahead, as the Stake
// program reads it; with no clock, or no time known, whenever it has one. Its data: kind, rent reserve, staker,
// withdrawer, time, epoch, custodian.
function stake(state: State, clock?: Clock): { staker: Address; withdrawer: Address; custodian: Address; locked: boolean; lockup: string } | null {
    if (!state || state.token || state.program !== STAKE_PROGRAM || state.data.length < 124 || ![1, 2].includes(getU32Decoder().decode(state.data, 0))) return null;
    const d = state.data;
    const [time, epoch, custodian] = [getI64Decoder().decode(d, 76), getU64Decoder().decode(d, 84), getAddressDecoder().decode(d, 92)];
    const ahead = (clock?.now ?? null) === null ? time !== 0n : time > BigInt(clock!.now!);
    return { staker: getAddressDecoder().decode(d, 12), withdrawer: getAddressDecoder().decode(d, 44), custodian, locked: ahead || epoch > (clock?.epoch ?? 0n), lockup: `${time}:${epoch}:${custodian}` };
}

/** The calls made inside a transaction's instructions (`tops`: each one's program), each with its caller, the latest
 *  call one level up (the instruction's own program at the top), and every program above it. Where the RPC gives no
 *  depth, the caller is taken as the instruction's program, and any program before the call as above it. */
export function callsIn(inner: Simulated['simulation']['inner'], tops: Address[]): { index: number; program: Address; caller: Address; above: Address[] }[] {
    return inner.flatMap((group) => {
        const top = tops[group.index];
        if (!top) return [];
        const line: Address[] = [top]; // the program at each depth, the top at depth 1
        const before: Address[] = [top];
        return group.calls.map((call) => {
            const depth = call.depth && call.depth >= 2 ? call.depth : null;
            const caller = depth ? (line[depth - 2] ?? top) : top;
            const above = depth ? line.slice(0, depth - 1) : [...before];
            if (depth) line.splice(depth - 1, line.length, call.program);
            before.push(call.program);
            return { index: group.index, program: call.program, caller, above };
        });
    });
}

// Programs Otus doesn't know above a call to one which keeps something of yours (HOLDS), under an instruction you
// sign, at any depth: the nearest of them, with what it reached.
function holdsCalls(s: Simulated, wallet: Address): Map<Address, Set<Address>> {
    const signed = new Set(s.message.instructions.flatMap((ix, i) => (ix.accountIndices.some((j) => s.accounts[j].address === wallet && s.accounts[j].signer) ? [i] : [])));
    const found = new Map<Address, Set<Address>>();
    for (const { index, program, above } of callsIn(s.simulation.inner, s.message.instructions.map((ix) => s.accounts[ix.programAddressIndex].address))) {
        const unknown = above.findLast((q) => q !== program && !PROGRAM_NAMES.has(q));
        if (signed.has(index) && REACHABLE.has(program) && unknown) found.set(unknown, new Set([...(found.get(unknown) ?? []), program]));
    }
    return found;
}

// Programs Otus doesn't know given your signature in an instruction that also names a program which keeps something of
// yours (HOLDS). A program can call another only when the instruction it runs in names that one: so it can when it
// lands, whatever the simulation saw it do, as a program may act otherwise then.
function holdsBeside(s: Simulated, wallet: Address): Map<Address, Set<Address>> {
    const found = new Map<Address, Set<Address>>();
    for (const ix of s.message.instructions) {
        const program = s.accounts[ix.programAddressIndex].address;
        const named = ix.accountIndices.map((j) => s.accounts[j]);
        if (PROGRAM_NAMES.has(program) || !named.some((a) => a.address === wallet && a.signer)) continue;
        const held = named.filter((a) => REACHABLE.has(a.address)).map((a) => a.address);
        if (held.length) found.set(program, new Set([...(found.get(program) ?? []), ...held]));
    }
    return found;
}

const HOLDINGS = 'Where it could touch loans, stakes, votes or programs of yours, which no balance shows';

// What a program Otus doesn't know must not reach with your signature: the programs that keep something of yours where
// no balance shows it, and the Upgradeable Loader, where your signature may be a program's upgrade authority.
const UPGRADEABLE_LOADER_ADDRESS = address('BPFLoaderUpgradeab1e11111111111111111111111');
const REACHABLE: ReadonlySet<Address> = new Set([...HOLDS, UPGRADEABLE_LOADER_ADDRESS]);

// What the Upgradeable Loader is asked to do with your signature as a program's upgrade authority: Upgrade (its 7th
// account), or Close of a program data account (its 3rd), which ends the program for good; a buffer closed is only
// its rent back. A program data account's kind is 3.
function upgrades(s: Simulated, wallet: Address): [Address, string][] {
    return s.message.instructions.flatMap((ix): [Address, string][] => {
        if (s.accounts[ix.programAddressIndex].address !== UPGRADEABLE_LOADER || ix.data.length < 4) return [];
        const at = (i: number) => (ix.accountIndices[i] === undefined ? undefined : s.accounts[ix.accountIndices[i]]);
        const signs = (i: number) => at(i)?.address === wallet && at(i)?.signer === true;
        const kind = getU32Decoder().decode(ix.data, 0);
        if (kind === 3 && signs(6)) return [[at(1)?.address ?? at(0)!.address, 'Your program gets new code']];
        const closed = at(0) ? read(at(0)!.state) : null;
        const data = closed?.program === UPGRADEABLE_LOADER && closed.data.length >= 4 && getU32Decoder().decode(closed.data, 0) === 3;
        if (kind === 5 && signs(2) && data) return [[at(3)?.address ?? at(0)!.address, 'Your program is closed for good']];
        return [];
    });
}

// Whether only programs Otus names that act by their own rules (a marketplace, a stake pool) name this account: then an
// address of their own it gets is theirs, used as their program lets it. Not when Solana's own programs name it, which
// a site asks directly with what it likes (Token's Approve, System's and Stake's), nor a program Otus doesn't know.
function byProtocol(s: Simulated, account: Address): boolean {
    const naming = s.message.instructions.filter((ix) => ix.accountIndices.some((j) => s.accounts[j].address === account)).map((ix) => s.accounts[ix.programAddressIndex].address);
    // A budget, a memo, an assertion or an associated account made beside it give no one a say over it.
    const acting = naming.filter((p) => !BYSTANDERS.has(p));
    return acting.length > 0 && acting.every((p) => PROGRAM_NAMES.has(p) && !CORE_PROGRAMS.has(p) && !EXECUTORS.has(p));
}
const ENDLESS = 2n ** 63n; // an allowance this large is as good as without end
const INCINERATOR = address('1nc1nerator11111111111111111111111111111111');
const VOTE_PROGRAM = address('Vote111111111111111111111111111111111111111');
const BUILTINS: ReadonlySet<Address> = new Set([SYSTEM_PROGRAM_ADDRESS, STAKE_PROGRAM, VOTE_PROGRAM, LOADER_V3_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS]);

// An address no one can sign for: the incinerator, a sysvar, a builtin program's address, which is a name, not made from
// a key (most other programs' were, and someone may still hold it). A lockup it keeps no one can lift.
const nobody = (a: Address) => a === INCINERATOR || SYSVARS.has(a) || BUILTINS.has(a);

// A Token-2022 mint's extensions, by their layout: from byte 166, each a type (u16), a length (u16) and that many bytes,
// to the end or to a type 0 (unused space). Null when they don't fit it.
function extensions(data: ReadonlyUint8Array): { type: number; start: number; end: number }[] | null {
    const found = [];
    for (let i = 166; i + 4 <= data.length; ) {
        const [type, length] = [data[i] | (data[i + 1] << 8), data[i + 2] | (data[i + 3] << 8)];
        if (type === 0) break;
        if (i + 4 + length > data.length) return null;
        found.push({ type, start: i + 4, end: i + 4 + length });
        i += 4 + length;
    }
    return found;
}

// Where a field of an account is after the transaction: where it was, but in a Token-2022 mint's extension, at the same
// place in that extension wherever it moved. Null when the extension is gone, or the extensions don't read.
function fieldAfter(before: NonNullable<State>, after: NonNullable<State>, offset: number): number | null {
    if (!isMint(before) || offset < 166) return offset;
    const was = extensions(before.data)?.find((e) => offset >= e.start && offset + 32 <= e.end);
    const is = was && isMint(after) ? extensions(after.data)?.filter((e) => e.type === was.type) : null;
    if (!was || !is || is.length !== 1) return null;
    const at = is[0].start + (offset - was.start);
    return at + 32 <= is[0].end ? at : null;
}

// A stake account (kind 0) or nonce account (state 0) never set up: anyone may set it up as theirs.
function unset(state: State): boolean {
    if (!state || state.token) return false;
    if (state.program === STAKE_PROGRAM && state.data.length >= 4) return getU32Decoder().decode(state.data, 0) === 0;
    if (state.program === SYSTEM_PROGRAM_ADDRESS && state.space === 80) return getU32Decoder().decode(state.data, 4) === 0;
    return false;
}

// A nonce account's authority, who can withdraw its SOL; null for any other account.
const nonceAuthority = (state: State): Address | null =>
    state && !state.token && state.program === SYSTEM_PROGRAM_ADDRESS && state.space === 80 && getU32Decoder().decode(state.data, 4) === 1 ? getAddressDecoder().decode(state.data, 8) : null;

// Authorities of yours an account no longer has, its tag cleared to none while your key stays in the bytes: a mint's
// (tags at 0 and 46, keys at 4 and 50), a program's upgrade authority (program data: tag at 12, key at 13).
function givenUp(before: NonNullable<State>, after: NonNullable<State>, key: ReadonlyUint8Array): string[] {
    const yoursAt = (s: NonNullable<State>, offset: number) => s.data.length >= offset + 32 && key.every((b, i) => s.data[offset + i] === b);
    const tagged = (s: NonNullable<State>, at: number, size: number) => s.data.length > at && (size === 4 ? getU32Decoder().decode(s.data, at) : s.data[at]) === 1;
    const roles: [string, number, number, number][] = [];
    if (isMint(before) && isMint(after)) roles.push(['mint authority', 0, 4, 4], ['freeze authority', 46, 4, 50]);
    if (before.program === UPGRADEABLE_LOADER && after.program === UPGRADEABLE_LOADER && before.data.length >= 45 && getU32Decoder().decode(before.data, 0) === 3) roles.push(['program upgrade authority', 12, 1, 13]);
    return roles.filter(([, tag, size, at]) => tagged(before, tag, size) && yoursAt(before, at) && !tagged(after, tag, size)).map(([role]) => role);
}

// The programs Otus knows that name an account at the top of the transaction, by name: who acts on it.
const protocolsNaming = (s: Simulated, account: Address) =>
    [...new Set(s.message.instructions.filter((ix) => ix.accountIndices.some((j) => s.accounts[j].address === account)).map((ix) => s.accounts[ix.programAddressIndex].address).filter((p) => !BYSTANDERS.has(p)))]
        .map((p) => PROGRAM_NAMES.get(p) ?? p)
        .join(', ');

// Programs that run whatever their members or voters decided, with the signatures they are given: they vouch for no
// account of theirs.
// Token Metadata too: it delegates to whatever account it is given.
const EXECUTORS: ReadonlySet<Address> = new Set(
    ['SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', 'GovaE4iu227srtG2s3tZzB4RmWBzw8sTwrCLZz7kN7rY', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'].map((a) => address(a)),
);
const BYSTANDERS: ReadonlySet<Address> = new Set([COMPUTE_BUDGET_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, LIGHTHOUSE]);

// An account other than a token account with your address in its data: you may be its authority, or anyone put it there.
const holds = (state: State, key: ReadonlyUint8Array) => state !== null && state.token === null && offsetsOf(key, state).length > 0;

// What instructions Otus reads send, in words the user sees, from an account to another: SOL by the System Program (and
// wrapped SOL by the Token Programs, which moves lamports), tokens by the Token Programs, the SOL of an account they
// close, and the rent a token account is made with (at most what one can take, once however often it is made).
function sentInWords(explained: Explained[], changes: Changes): Send[] {
    const sends: Send[] = [];
    const made = new Set<Address>();
    const before = new Map(changes.accounts.map((c) => [c.address, c.before?.lamports ?? 0n]));
    const after = new Map(changes.accounts.map((c) => [c.address, c.after?.lamports ?? 0n]));
    for (const e of explained) {
        if (e.source === 'unknown') continue;
        const arg = (name: string) => {
            const v = e.args.find((a) => a.name === name)?.value ?? '';
            return /^\d+$/.test(v) ? BigInt(v) : 0n;
        };
        const at = (role: string) => e.accounts.find((a) => a.role === role)?.address;
        const pair = (kind: Send['kind'], source: string, destination: string, amount: bigint) => sends.push({ kind, from: at(source), to: at(destination), amount });
        if (e.program === SYSTEM_PROGRAM_ADDRESS) {
            if (e.name === 'TransferSol' || e.name === 'TransferSolWithSeed') pair('SOL', 'source', 'destination', arg('amount'));
            else if (e.name === 'CreateAccount') pair('SOL', 'payer', 'newAccount', arg('lamports'));
            else if (e.name === 'CreateAccountWithSeed') pair('SOL', 'payer', 'newAccount', arg('amount'));
            else if (e.name === 'WithdrawNonceAccount') pair('SOL', 'nonceAccount', 'recipientAccount', arg('withdrawAmount'));
        } else if (e.program === STAKE_PROGRAM) {
            if (e.name === 'Withdraw') pair('SOL', 'stake', 'recipient', arg('args'));
            else if (e.name === 'Split') pair('SOL', 'stake', 'splitStake', arg('args'));
        } else if (TOKEN_PROGRAMS.includes(e.program)) {
            if (e.name === 'Transfer' || e.name === 'TransferChecked') {
                const source = changes.accounts.find((c) => c.address === at('source'));
                const native = (source?.before ?? source?.after)?.token?.native === true; // one made here too
                pair(native ? 'SOL' : 'token', 'source', 'destination', arg('amount'));
            }
            else if (e.name === 'CloseAccount') {
                const closed = at('account');
                if (closed) pair('SOL', 'account', 'destination', before.get(closed) ?? 0n);
            }
        } else if (e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && (e.name === 'CreateAssociatedToken' || e.name === 'CreateAssociatedTokenIdempotent')) {
            const ata = at('ata');
            // Only one made here: a token account there already ("nothing changes", its words say) takes no rent. An
            // address only sent SOL before is still made, and paid for.
            const there = changes.accounts.find((c) => c.address === ata)?.before;
            if (!ata || made.has(ata) || (there && (there.token || there.program !== SYSTEM_PROGRAM_ADDRESS))) continue;
            made.add(ata);
            const rent = (after.get(ata) ?? 0n) - (before.get(ata) ?? 0n);
            pair('SOL', 'payer', 'ata', rent < 0n ? 0n : rent > RENT_MOST ? RENT_MOST : rent);
        }
    }
    return sends;
}
type Send = { kind: 'SOL' | 'token'; from: Address | undefined; to: Address | undefined; amount: bigint };

const name = (program: Address) => PROGRAM_NAMES.get(program) ?? program;
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

/** Solana's sysvars, by their exact addresses: a wallet's address can start with "Sysvar" too. */
export const SYSVARS: ReadonlySet<Address> = new Set(
    [
        'SysvarC1ock11111111111111111111111111111111',
        'SysvarEpochRewards1111111111111111111111111',
        'SysvarEpochSchedu1e111111111111111111111111',
        'Sysvar1nstructions1111111111111111111111111',
        'SysvarLastRestartS1ot1111111111111111111111',
        'SysvarRecentB1ockHashes11111111111111111111',
        'SysvarRent111111111111111111111111111111111',
        'SysvarS1otHashes111111111111111111111111111',
        'SysvarS1otHistory11111111111111111111111111',
        'SysvarStakeHistory1111111111111111111111111',
        'SysvarFees111111111111111111111111111111111',
        'SysvarRewards111111111111111111111111111111',
    ].map((a) => address(a)),
);

/** A mint: 82 bytes, or a Token-2022 mint with extensions, marked 1 after the room a token account takes. */
export const isMint = (s: NonNullable<State>) => TOKEN_PROGRAMS.includes(s.program) && (s.space === 82 || (s.program === TOKEN_2022_PROGRAM_ADDRESS && s.space > 165 && s.space !== 355 && s.data[165] === 1));

// The role of an address at this offset, where well-known programs keep one.
function roleAt(s: NonNullable<State>, offset: number): string | null {
    const token = TOKEN_PROGRAMS.includes(s.program);
    if (isMint(s)) return offset === 4 ? 'mint authority' : offset === 50 ? 'freeze authority' : offset > 165 ? 'authority in a Token-2022 mint' : null;
    if (token && s.space === 355) return 'place among a token multisig signers';
    if (s.program === SYSTEM_PROGRAM_ADDRESS && s.space === 80 && offset === 8) return 'nonce authority';
    if (s.program === STAKE_PROGRAM) return ({ 12: 'stake authority', 44: 'withdraw authority', 92: 'stake lockup custodian' } as Record<number, string>)[offset] ?? null;
    if (s.program === UPGRADEABLE_LOADER && offset === 13) return 'program upgrade authority';
    // A vote account: its withdrawer at 36 in versions 1 to 3 (the oldest keeps its voter there).
    if (s.program === VOTE_PROGRAM && offset === 36 && s.data.length >= 68 && [1, 2, 3].includes(getU32Decoder().decode(s.data, 0))) return 'vote account withdraw authority';
    return null;
}

// Your assets going to someone else in a way Otus cannot read in words (what an instruction Otus reads sends is shown
// in words, so that much counts as seen). Through a program Otus doesn't know, whoever receives counts, its own
// accounts included; through programs it knows, a wallet (their own accounts are where deposits go). Something coming
// back to you makes it a trade: through programs Otus knows, nothing to say; through one it doesn't, worth checking.
// Nothing coming back: said, with how much and to whom, a small share told as a fee maybe. Always a warning, never
// critical: it is what the balances show and Otus cannot read, not a proof of harm.
function leaving(programs: ProgramUse[], explained: Explained[], changes: Changes, flows: Flow[], yours: Changes, ends: Map<Address, { sol: boolean; tokens: boolean }>, nft: boolean): Finding[] {
    const blind = programs.filter((p) => (p.signature || p.writable) && explained.some((e) => e.program === p.program && e.source === 'unknown'));
    const strange = blind.some((p) => p.name === null);
    const sends = sentInWords(explained, changes);
    const mine = new Map(yours.accounts.map((c) => [c.address, (c.before ?? c.after)?.token?.mint ?? null]));
    const changed = new Map(changes.accounts.map((c) => [c.address, c]));
    const gained = (address: Address, asset: string) => {
        const c = changed.get(address);
        const of = (s: State) => (asset === 'SOL' ? (s?.lamports ?? 0n) : units(s, asset));
        return c ? of(c.after) - of(c.before) : 0n;
    };
    // What of an asset words send from your accounts to each account not yours, no more than that account keeps of it:
    // said. Sent to yourself, sent by someone else, or passed on (sent back, closed back, routed through an account
    // made for it) is not.
    const saidTo = (f: Flow) => {
        const sent = new Map<Address, bigint>();
        for (const s of sends) {
            if (!s.from || !s.to || !mine.has(s.from) || ends.get(s.to)?.[s.kind === 'SOL' ? 'sol' : 'tokens']) continue; // yours when it ends: kept
            const right = f.asset === 'SOL' ? s.kind === 'SOL' : s.kind === 'token' && mine.get(s.from) === f.asset;
            if (right) sent.set(s.to, (sent.get(s.to) ?? 0n) + s.amount);
        }
        return new Map([...sent].map(([to, amount]): [Address, bigint] => {
            const kept = gained(to, f.asset);
            return [to, kept <= 0n ? 0n : kept < amount ? kept : amount];
        }));
    };
    // Of what others get, what can be yours unsaid: no more than what leaves you past what is said, as what they get may
    // come from someone else (a vault's own rent for an account it opens, inside a program's call).
    const hidden = flows.flatMap((f) => {
        const to = saidTo(f);
        const unsaid = f.change < 0n ? -f.change - [...to.values()].reduce((a, b) => a + b, 0n) : 0n;
        if (unsaid <= 0n) return [];
        return f.others.flatMap((o) => {
            const beyond = o.amount - (to.get(o.address) ?? 0n);
            return (o.wallet || strange) && beyond > 0n ? [{ f, o: { ...o, amount: beyond < unsaid ? beyond : unsaid } }] : [];
        });
    });
    if (!blind.length || !hidden.length) return [];
    const by = blind.map((p) => p.name ?? 'an unknown program').join(', ');
    const subject = hidden[0].o.holder;
    if (nft || flows.some((f) => f.change > 0n)) return strange ? [{ level: 'warn', code: 'check-balances', text: 'Check the balances', subject, note: `A trade through ${by}, which Otus cannot read`, programs: blind.filter((p) => p.name === null).map((p) => p.program) }] : [];
    // A fee is a small share of an asset in all, not to each: split across many wallets, a drain is no fee.
    const share = (f: Flow) => hidden.filter((h) => h.f === f).reduce((sum, h) => sum + h.o.amount, 0n);
    const small = hidden.every(({ f }) => share(f) * 20n <= -f.change);
    const assets = new Set(hidden.map(({ f }) => f.asset)).size;
    const text = small ? 'A small part of your assets goes to someone else' : assets === 1 ? 'An asset of yours goes to someone else' : `${assets} of your assets go to someone else`;
    return [{ level: 'warn', code: 'sends-to-wallet', text, subject, note: `Through ${by}, which Otus cannot read${small ? ': a fee, maybe' : ''}`, programs: (strange ? blind.filter((p) => p.name === null) : blind).map((p) => p.program) }];
}

/**
 * Of addresses getting your funds or a say over them, each that only looks like one you keep, one of your wallets, or
 * one you sent to (the same ends, other characters between, as address poisoning grinds them): critical, said whole.
 * One you keep or sent to itself is not.
 */
export function lookalikes(addresses: Address[], context: Pick<Context, 'wallet' | 'wallets' | 'contacts' | 'sent'>): Finding[] {
    const own = [context.wallet, ...(context.wallets ?? [])];
    const sent = context.sent ?? [];
    return [...new Set(addresses)].flatMap((a): Finding[] => {
        if (own.includes(a) || context.contacts?.has(a) || sent.includes(a)) return [];
        const said = (text: string, note: string): Finding[] => [{ level: 'danger', code: 'lookalike-address', text, subject: a, note }];
        for (const [kept, label] of context.contacts ?? []) {
            const whose = `${told(label, 32) || 'a contact'}'s`;
            if (alike(a, kept)) return said(`This address looks like ${whose}`, `${a} is not ${whose}`);
        }
        if (own.some((w) => alike(a, w))) return said('This address looks like one of your wallets', `${a} is not one of them`);
        if (sent.some((s) => alike(a, s))) return said('This address looks like one you sent to', `${a} is not the one you sent to`);
        return [];
    });
}

// Who the instructions Otus reads name as getting your funds or a say over them: a transfer's destination, an account
// closed into, a delegate, a new authority of a token, a stake or a nonce.
function namedTo(explained: Explained[]): Address[] {
    const out: string[] = [];
    for (const e of explained) {
        if (e.source === 'unknown') continue;
        const acc = (role: string) => e.accounts.find((a) => a.role === role)?.address;
        const arg = (name: string) => e.args.find((a) => a.name === name)?.value;
        const take = (...found: (string | undefined)[]) => out.push(...found.filter((x): x is string => x !== undefined && isAddress(x)));
        if (e.program === SYSTEM_PROGRAM_ADDRESS) take(acc('destination'), acc('recipientAccount'), arg('newNonceAuthority'));
        else if (e.program === STAKE_PROGRAM) take(acc('recipient'), acc('newAuthority'), e.name === 'Authorize' ? arg('arg0') : undefined);
        else if (TOKEN_PROGRAMS.includes(e.program)) take(acc('destination'), acc('delegate'), arg('newAuthority'));
        else if (e.program === LOADER_V3_PROGRAM_ADDRESS) take(acc('newAuthority'));
    }
    return out as Address[];
}

// What lands with someone else (not your accounts in Otus, nor token accounts any of them owns, ATA or not), by asset,
// beyond what left your accounts in it: from a program's custody, then. With a wallet, always counted. With a program's
// accounts, only one that gives nothing here (a pool, or a protocol trading for you, both gives and takes), and only as
// much as custody released: a vault that got nothing back paying out (your position withdrawn elsewhere), or, when you
// paid and nothing came back, any (what your trade buys, sent elsewhere). Each part on its own: a twentieth or less of
// what comes to you in the same asset is a fee; SOL this small, rent given back. Shared out to those that got most first.
function payoutsOf(s: Simulated, theirs: Changes, yours: Changes, leaves: Map<Address, Leaving>, flows: Flow[], context: Context): Payout[] {
    const own = new Set<Address>([context.wallet, ...(context.signers ?? [])]); // one only watched could be anyone's
    const [back, paidAny] = [flows.some((f) => f.change > 0n), flows.some((f) => f.change < 0n)];
    const amount = (state: State, asset: string) => (asset === 'SOL' ? (state?.lamports ?? 0n) : units(state, asset));
    const gains = new Map<string, { holder: Address; address: Address; amount: bigint; wallet: boolean }[]>();
    const out = new Map<string, { holder: Address; amount: bigint }[]>(); // what left accounts not yours, by asset
    const [giving, getting] = [new Set<Address>(), new Set<Address>()];
    for (const c of theirs.accounts) {
        const state = c.after ?? c.before;
        const holder = state?.token?.owner ?? stake(state)?.withdrawer ?? c.address;
        if (own.has(holder)) continue;
        const wallet = Boolean(state?.token || stake(state) || plain(state)) && !isOffCurveAddress(holder);
        const mints = new Set([c.before?.token, c.after?.token].flatMap((t) => (t && !t.native ? [t.mint] : [])));
        for (const asset of ['SOL', ...mints]) {
            const delta = amount(c.after, asset) - amount(c.before, asset);
            if (delta < 0n) {
                out.set(asset, [...(out.get(asset) ?? []), { holder, amount: -delta }]);
                giving.add(holder);
            }
            if (delta > 0n) {
                gains.set(asset, [...(gains.get(asset) ?? []), { holder, address: c.address, amount: delta, wallet }]);
                getting.add(holder);
            }
        }
    }
    const net = holdings(yours);
    // What parts of yours that leave you lose (a stake handed to a pool for SOL back): paid, though SOL comes back.
    const gross = new Map<string, bigint>();
    for (const c of yours.accounts) {
        const left = leaves.get(c.address);
        const lost = (asset: string, b: bigint, a: bigint) => b > a && gross.set(asset, (gross.get(asset) ?? 0n) + b - a);
        if (left?.sol !== undefined) lost('SOL', c.before?.lamports ?? 0n, c.after?.lamports ?? 0n);
        if (left?.tokens !== undefined) for (const mint of new Set([c.before?.token, c.after?.token].flatMap((t) => (t && !t.native ? [t.mint] : [])))) lost(mint, units(c.before, mint), units(c.after, mint));
    }
    const by = new Map<Address, Payout>();
    const sum = (list: { amount: bigint }[]) => list.reduce((n, g) => n + g.amount, 0n);
    for (const [asset, list] of gains) {
        const [before, after] = net.get(asset) ?? [0n, 0n];
        // What you paid: what your holdings lose, or what parts of yours that leave you lose, the more of the two.
        const fell = before > after ? before - after : 0n;
        const paid = (gross.get(asset) ?? 0n) > fell ? (gross.get(asset) ?? 0n) : fell;
        const got = after > before ? after - before : 0n;
        const [wallets, programs] = [list.filter((g) => g.wallet), list.filter((g) => !g.wallet && !giving.has(g.holder))];
        const released = sum((out.get(asset) ?? []).filter((o) => !getting.has(o.holder) || (paidAny && !back)));
        // What you paid goes to wallets first, as payments do, then to programs' accounts, as deposits do.
        const toWallets = sum(wallets);
        const reached = sum(programs) < released ? sum(programs) : released;
        const unpaid = paid > toWallets ? paid - toWallets : 0n;
        const said = (part: bigint) => (part <= 0n || part * 20n <= got || (asset === 'SOL' && part <= RENT_BACK) ? 0n : part);
        for (const [group, share] of [[wallets, said(toWallets - paid)], [programs, said(reached - unpaid)]] as const) {
            let rest = share;
            for (const g of group.toSorted((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
                if (rest <= 0n) break;
                const part = g.amount < rest ? g.amount : rest;
                rest -= part;
                const p = by.get(g.holder) ?? { holder: g.holder, known: context.contacts?.get(g.holder) ?? null, program: !g.wallet, amounts: [], programs: [] };
                p.amounts.push({ asset: asset as Payout['amounts'][number]['asset'], amount: part });
                p.programs = [...new Set([...p.programs, ...namers(s, g.address)])];
                by.set(g.holder, p);
            }
        }
    }
    return [...by.values()];
}

// An NFT that may come to you without any token balance showing it: a Metaplex Core asset that becomes yours, or a
// compressed one, which only Bubblegum's calls move (what they move, no account shows).
const CORE = address('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const BUBBLEGUM = address('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
function nftBack(s: Simulated, changes: Changes, key: ReadonlyUint8Array): boolean {
    const yoursAt = (state: State) => state?.program === CORE && state.data[0] === 1 && key.every((b, i) => state.data[1 + i] === b); // an asset: its kind, then its owner
    if (changes.accounts.some((c) => yoursAt(c.after) && !yoursAt(c.before))) return true;
    return s.message.instructions.some((ix) => s.accounts[ix.programAddressIndex].address === BUBBLEGUM) || s.simulation.inner.some((g) => g.calls.some((c) => c.program === BUBBLEGUM));
}

// The programs whose instructions name this account.
const namers = (s: Simulated, address: Address) =>
    s.message.instructions.filter((ix) => ix.accountIndices.some((j) => s.accounts[j].address === address)).map((ix) => s.accounts[ix.programAddressIndex].address);

// Nine tenths or more of your SOL, or of one of your tokens, leaving your accounts, the fee included: a site can ask
// for one of any size.
function outflows(yours: Changes): [string, Address | undefined][] {
    return [...holdings(yours)].flatMap(([asset, [before, kept]]): [string, Address | undefined][] => {
        const after = asset === 'SOL' ? kept - yours.fee : kept;
        return before > 0n && (before - after) * 10n >= before * 9n ? [asset === 'SOL' ? ['your SOL', undefined] : ['of one of your tokens', asset as Address]] : [];
    });
}

// Each asset of yours that moves, and on the other side the accounts whose same asset moved the other way.
function flowsOf(theirs: Changes, yours: Changes, leaves: Map<Address, Leaving>, wallet: Address): Flow[] {
    const others = theirs.accounts;
    const amount = (s: State, asset: string) => (asset === 'SOL' ? (s?.lamports ?? 0n) : units(s, asset));
    return [...holdings(yours)].flatMap(([asset, [before, after]]): Flow[] => {
        const change = after - before;
        if (change === 0n) return [];
        const side = others.flatMap((c) => {
            const delta = amount(c.after, asset) - amount(c.before, asset);
            if (delta === 0n || delta > 0n === change > 0n) return [];
            const state = c.after ?? c.before;
            const staker = stake(state)?.withdrawer; // a stake account is whoever can withdraw it
            const token = state?.token;
            // A part of an account of yours that leaves you: whoever controls it then (the program a wallet is handed to).
            const left = leaves.get(c.address)?.[asset === 'SOL' ? 'sol' : 'tokens'];
            const holder = left ?? (token && (asset === 'SOL' ? solOf(token, wallet) : token.owner)) ?? staker ?? c.address;
            if (holder === wallet) return []; // your wallet is not someone else (a stake of yours under someone's lockup, say)
            return [{ address: c.address, holder, amount: delta < 0n ? -delta : delta, wallet: state?.token || staker ? !isOffCurveAddress(holder) : plain(state) }];
        });
        return [{ asset: asset as Flow['asset'], change, others: side.toSorted((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)) }];
    });
}

// What each account of the transaction is: yours, a program, a mint, someone's token account or wallet, a program's.
function kindsOf(s: Simulated, changes: Changes, mine: Set<Address>, wallet: Address): Map<Address, Kind> {
    const after = new Map(changes.accounts.map((c) => [c.address, c.after]));
    return new Map(
        s.accounts.map((a): [Address, Kind] => {
            const state = read(a.state);
            if (a.address === wallet) return [a.address, 'you'];
            if (mine.has(a.address)) return [a.address, (state ?? after.get(a.address) ?? null)?.token ? 'your-tokens' : 'yours'];
            if (a.state.exists && a.state.executable) return [a.address, 'programs'];
            if (SYSVARS.has(a.address)) return [a.address, 'sysvars'];
            if (!state) return [a.address, 'new'];
            if (state.token) return [a.address, 'tokens'];
            if (isMint(state)) return [a.address, 'mints'];
            return [a.address, plain(state) ? 'wallets' : 'program-accounts'];
        }),
    );
}

function programUses(s: Simulated, explained: Explained[], mine: Set<Address>, { wallet }: Context): ProgramUse[] {
    const uses = new Map<Address, ProgramUse & { written: Set<Address> }>();
    s.message.instructions.forEach((ix, i) => {
        const program = s.accounts[ix.programAddressIndex].address;
        const touched = ix.accountIndices.map((j) => s.accounts[j]);
        const use = uses.get(program) ?? {
            program,
            name: explained[i].programName ?? PROGRAM_NAMES.get(program) ?? null,
            signature: false,
            writable: false,
            accounts: 0,
            unseen: false,
            written: new Set<Address>(),
        };
        const signs = touched.some((a) => a.address === wallet && a.signer);
        use.signature ||= signs;
        for (const a of touched) if (a.writable && mine.has(a.address)) use.written.add(a.address);
        use.writable = use.written.size > 0;
        use.accounts = use.written.size;
        use.unseen ||= signs && !s.simulation.innerListed;
        uses.set(program, use);
    });
    return [...uses.values()].map(({ written: _, ...use }) => use);
}
