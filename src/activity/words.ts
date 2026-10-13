// A wallet's transactions in words, as Otus's Activity tells them: each in a line ("Swap 1 SOL → 120.58 USDC", "Minted
// 1,000 BONK", to whom, when), what came in and what went out told apart; opened, everything its transaction told:
// every balance it moved, the rent and the fee apart, the other side whole, its programs, memo and failure. A copy of an
// address, the kind dust is sent from, is told as one. Addresses go in the words whole, named as the caller names them
// (Naming): cutting them short is the caller's.
import type { Address } from '@solana/kit';

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LOADER_V3_PROGRAM_ADDRESS } from '@solana-program/loader-v3';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';

import { alike, amount, cap, sol } from '../format.ts';
import { LIGHTHOUSE } from '../programs/addresses.ts';
import type { Step } from '../programs/squads.ts';
import { story, type Names } from '../review/effects.ts';
import { harmless } from './dust.ts';
import { WEIGHTY, type Activity, type Move, type Told } from './summary.ts';

export type RowIcon = 'send' | 'receive' | 'swap' | 'plus' | 'trash' | 'key' | 'refresh' | 'shield' | 'box' | 'cross' | 'bang';
export type RowTone = 'plain' | 'warn' | 'danger';
/** A line of what a transaction told; `way`: a balance it moved, in or out; `unknown`: the program Otus doesn't know
 *  that the line names, or tells what it moved of yours; `copy`: the line that warns of a copy of an address. */
export type Detail = { text: string; tone?: 'ok' | 'warn' | 'danger' | 'dim'; way?: 'in' | 'out'; unknown?: Address; copy?: true };
/** Words of a line, an amount among them marked as what came in or went out; `tone`: words to take note of (a program
 *  Otus doesn't know), whatever the line's. */
export type Part = { text: string; way?: 'in' | 'out'; tone?: 'warn' };

/** One transaction, as a line and its details. `address`: the other side, shown whole; `copy`: made to look like
 *  another, `copies`. `subject`: the instruction the line is about, when it is told by one (its arguments in `sub`). `unknown`:
 *  the programs it calls that Otus doesn't know, whole: a page marks the line for them. */
export type Row = {
    signature: string | null;
    time: number | null;
    icon: RowIcon;
    tone: RowTone;
    title: Part[];
    sub: Part[];
    details: Detail[];
    address: { label: string; address: Address; name: string | null; copy: boolean; copies: Address | null } | null;
    subject: { program: Address; name: string } | null;
    unknown: Address[];
};

/** What the words need: a token's symbol (a verified one's, else its mint), a name for an address (the wallet's own
 *  address marked yours, another wallet's or a contact's name, a program's, else the address), and the addresses you
 *  know. An address goes in whole. */
export type Naming = {
    wallet: Address;
    symbol(mint: Address): string;
    who(address: Address): string;
    program(address: Address): string;
    known: Address[];
};

/** A line's words, as one text. */
export const text = (parts: Part[]) => parts.map((p) => p.text).join('');

const VERBS: Record<Step, string> = { setup: 'new multisig', create: 'create', propose: 'propose', activate: 'activate', approve: 'approve', reject: 'reject', cancel: 'cancel', execute: 'execute', spend: 'spend', close: 'close' };

/** Each transaction read → its row; one Otus could not read says so. The copy of an address, of two alike on the page or
 *  known, is told as one. */
export function rows(read: (Activity | { unreadable: string; signature?: string })[], n: Naming): Row[] {
    const done = read.filter((a): a is Activity => 'kind' in a);
    const copies = copiesOn(done, n.known);
    return read.map((a) => ('unreadable' in a ? unreadable(a.unreadable, a.signature ?? null) : row(a, n, a.other ? (copies.get(a.other) ?? null) : null)));
}

/**
 * The copies among the page's other sides, each with the address it copies. Of two alike (their first and last
 * characters the same, as a poisoner grinds them), the copy is the one that is not known, or, when neither or both
 * are, the one you never sent to and that moved less: dust, against a real payment. Alike addresses are as rare as one
 * in 10^9 by chance, so no amount is needed to tell.
 */
function copiesOn(done: Activity[], known: Address[]): Map<Address, Address> {
    const weight = new Map<Address, number>();
    const add = (a: Address, w: number) => weight.set(a, Math.max(weight.get(a) ?? 0, w));
    for (const a of known) add(a, Infinity);
    for (const a of done) {
        if (!a.other) continue;
        // You sent to it, signing: never the copy. Through a program Otus doesn't know, the other side is a guess.
        if (a.kind === 'send' && a.signed && !a.unknown.length) add(a.other, Infinity);
        else add(a.other, Math.max(0, ...a.moves.map((m) => Math.abs(Number(m.units)) / 10 ** m.decimals)));
    }
    const out = new Map<Address, Address>();
    const all = [...weight.keys()];
    for (const a of all) {
        if (weight.get(a) === Infinity) continue; // known, or sent to: never the copy
        const twin = all.find((b) => b !== a && alike(a, b) && weight.get(b)! >= weight.get(a)!);
        if (twin) out.set(a, twin);
    }
    return out;
}

const unreadable = (why: string, signature: string | null): Row => ({ signature, time: null, icon: 'bang', tone: 'warn', title: [{ text: "Otus couldn't read this one" }], sub: [{ text: why }], details: [], address: null, subject: null, unknown: [] });

function row(a: Activity, n: Naming, copies: Address | null): Row {
    const [outs, ins] = [a.moves.filter((m) => m.units < 0n), a.moves.filter((m) => m.units > 0n)];
    const by = a.main ? n.program(a.main) : '';
    const head = headline(a, n, outs, ins, by);
    const taken = !a.signed && outs.length > 0; // a delegate of its tokens moved them
    const side = a.kind === 'send' ? 'to' : 'from';
    const told = details(a, n, copies, head.shown ?? []);
    // What it did besides its balances. A program Otus doesn't know marks its own words, not the line, unless what it
    // did is a danger.
    const marked = told.filter((d) => !d.way && !(d.unknown && d.tone !== 'danger')).map((d) => d.tone);
    const danger = head.danger || marked.includes('danger');
    return {
        signature: a.signature,
        time: a.time,
        icon: head.icon,
        tone: a.error || danger ? 'danger' : copies || taken || marked.includes('warn') ? 'warn' : 'plain',
        title: head.title,
        sub: copies && a.other && !a.unknown.length ? [{ text: `${side} ${n.who(a.other)} · copies ${copies}` }] : head.sub,
        details: told,
        // Through a program Otus doesn't know, the other side is a guess from the balances: its details say where it went.
        address: a.other && !a.unknown.length ? { label: a.kind === 'send' ? 'To' : 'From', address: a.other, name: named(n, a.other), copy: !!copies, copies } : null,
        subject: head.subject ? { program: head.subject.program, name: head.subject.name } : null,
        unknown: a.unknown,
    };
}

// The line: what happened, in a few words, and with whom or through what.
// `shown`: the balances the line and what is under it say, which the details don't say again.
function headline(a: Activity, n: Naming, outs: Move[], ins: Move[], by: string): { icon: RowIcon; title: Part[]; sub: Part[]; danger?: boolean; subject?: Told; shown?: Move[] } {
    const what = (m: Move, list: Move[]): Part[] => [{ text: quantity(m, n), way: m.units < 0n ? 'out' : 'in' }, ...(list.length > 1 ? [{ text: ` +${list.length - 1}` }] : [])];
    const lead = (list: Move[]) => list.find((m) => m.mint !== null) ?? list[0]; // a token before SOL that may be rent or a tip
    const words = (s: string): Part[] => (s ? [{ text: s }] : []);
    // Through what, under the line: a program Otus doesn't know is said as one, to take note of.
    const strange = a.main !== null && a.unknown.includes(a.main);
    const via = (s: string): Part[] => (strange ? [{ text: UNKNOWN_WAY, tone: 'warn' }] : words(s));
    if (a.error) return { icon: 'cross', title: words(`Failed${by ? ` · ${by}` : ''}`), sub: words(a.payer === n.wallet ? 'Only the fee was spent' : 'Nothing of yours moved') };
    if (a.squads.length) {
        const moved = a.moves.flatMap((m, i): Part[] => [...(i ? [{ text: ' · ' }] : []), { text: `${m.units < 0n ? '−' : '+'}${quantity(m, n)}`, way: m.units < 0n ? 'out' : 'in' }]);
        return { icon: 'shield', title: words(`Squads · ${[...new Set(a.squads.map((s) => VERBS[s]))].join(', ')}`), sub: moved, shown: a.moves };
    }
    switch (a.kind) {
        case 'swap':
            return { icon: 'swap', title: [{ text: 'Swap ' }, ...what(lead(outs), outs), { text: ' → ' }, ...what(lead(ins), ins)], sub: via(by), shown: [lead(outs), lead(ins)] };
        case 'send':
            return { icon: 'send', title: [{ text: a.signed ? 'Sent ' : 'Moved ' }, ...what(lead(outs), outs)], sub: a.unknown.length ? UNKNOWN_SUB : words(a.other ? `to ${n.who(a.other)}` : by), shown: [lead(outs)] };
        case 'receive':
            return { icon: 'receive', title: [{ text: 'Received ' }, ...what(lead(ins), ins)], sub: a.unknown.length ? UNKNOWN_SUB : words(a.other ? `from ${n.who(a.other)}` : by), shown: [lead(ins)] };
        case 'mint': {
            const token = lead(ins);
            // What it cost, when something went for it: an NFT, a pool or stake token paid for.
            const paid = outs.length ? [{ text: 'for ' }, ...what(outs[0], outs)] : [];
            return { icon: 'plus', title: [{ text: 'Minted ' }, ...what(token, ins)], sub: paid.length ? paid : token.mint && a.created.includes(token.mint) ? words('New token') : via(by), shown: [token, ...outs.slice(0, 1)] };
        }
        case 'burn':
            return { icon: 'trash', title: [{ text: 'Burned ' }, ...what(lead(outs), outs)], sub: via(by), shown: [lead(outs)] };
    }
    const about = subjectOf(a);
    if (about) {
        const told = story({ ...about.told, data: new Uint8Array() }, namesFor(a, n));
        const title = about.told.name === 'DelegateStake' && a.staked > 0n ? `Staked ${sol(a.staked)} SOL` : titled(about.told); // how much, when it went into a stake account of yours
        return { icon: iconOf(about.told.name), title: words(title), sub: words(told.args ? cap(told.args) : ''), danger: told.effects.some((e) => e.tone === 'danger'), subject: about.told };
    }
    if (a.rent.yours < 0n) return { icon: 'box', title: words('Closed a token account'), sub: words(`${sol(-a.rent.yours)} SOL of rent freed`) };
    if (a.rent.yours > 0n) return { icon: 'box', title: words('Opened a token account'), sub: via(by) };
    if (a.rent.opened > 0n) return { icon: 'box', title: words('Opened an account'), sub: words(`${sol(a.rent.opened)} SOL of rent`) };
    // A program Otus doesn't know, at its heart: a transaction through it.
    if (strange) return { icon: 'box', title: words('Transaction'), sub: via(by) };
    // Named by its programs, but never by those Otus adds to what it signs (limits, guards).
    const programs = a.programs.filter((p) => p !== COMPUTE_BUDGET_PROGRAM_ADDRESS && p !== LIGHTHOUSE).map((p) => n.program(p));
    return { icon: 'box', title: words(by || programs[0] || 'Transaction'), sub: words(by ? '' : programs.slice(1).join(', ')) };
}

// A send or a receipt through a program Otus doesn't know: what it did inside is that program's own to say.
const UNKNOWN_WAY = 'through an unknown program';
const UNKNOWN_SUB: Part[] = [{ text: UNKNOWN_WAY, tone: 'warn' }];

// What says nothing of what a transaction is for: its limits and fee, a note, the guards Otus adds.
const BACKGROUND = new Set<string>([COMPUTE_BUDGET_PROGRAM_ADDRESS, LIGHTHOUSE, MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3]);

// The instruction a transaction that moved no balance is about: of Solana's own besides the background, the last that
// changes who may do what (an approval before the wrapped SOL it syncs), else the last (a nonce account opened after
// the account it opens). None when it calls another program: then it goes by that program.
function subjectOf(a: Activity): { told: Told; index: number } | null {
    const about = a.instructions.map((told, index) => ({ told, index })).filter(({ told }) => !BACKGROUND.has(told.program));
    if (!about.length || about.some(({ told }) => told.source === 'unknown')) return null;
    return about.findLast(({ told }) => WEIGHTY.test(told.name)) ?? about[about.length - 1];
}

// A title in the past for what moved no balance; any instruction not here goes by its own name ("Sync native").
const TITLES: Record<string, string> = {
    Approve: 'Approved a delegate',
    ApproveChecked: 'Approved a delegate',
    Revoke: 'Revoked a delegate',
    SetAuthority: 'Changed an authority',
    FreezeAccount: 'Froze a token account',
    ThawAccount: 'Thawed a token account',
    CloseAccount: 'Closed a token account',
    InitializeAccount: 'Opened a token account',
    InitializeAccount2: 'Opened a token account',
    InitializeAccount3: 'Opened a token account',
    InitializeMint: 'Created a token',
    InitializeMint2: 'Created a token',
    CreateAccount: 'Opened an account',
    CreateAccountWithSeed: 'Opened an account',
    Assign: 'Gave an account to a program',
    AssignWithSeed: 'Gave an account to a program',
    InitializeNonceAccount: 'Opened a nonce account',
    AdvanceNonceAccount: 'Moved a nonce on',
    AuthorizeNonceAccount: 'Changed a nonce authority',
    WithdrawNonceAccount: 'Withdrew from a nonce account',
    Initialize: 'Opened a stake account',
    InitializeChecked: 'Opened a stake account',
    DelegateStake: 'Staked SOL',
    Deactivate: 'Unstaked',
    Withdraw: 'Withdrew from a stake account',
    Authorize: 'Changed a stake authority',
    AuthorizeChecked: 'Changed a stake authority',
    Split: 'Split a stake account',
    Merge: 'Merged stake accounts',
    SetLockup: 'Changed a stake lockup',
    SetLockupChecked: 'Changed a stake lockup',
    SetAuthorityChecked: 'Changed an authority',
    Upgrade: 'Upgraded a program',
    DeployWithMaxDataLen: 'Deployed a program',
    ExtendProgram: 'Gave a program more room',
    InitializeBuffer: 'Opened a buffer for program code',
    Write: 'Wrote program code',
    Close: 'Closed a program account',
};
// An authority set to no one: what it held can never be changed again (a program made immutable).
const titled = (t: Told) => (/^SetAuthority/.test(t.name) && t.program === LOADER_V3_PROGRAM_ADDRESS && !t.accounts.some((x) => x.role === 'newAuthority') ? 'Removed an authority' : titleOf(t.name));
const titleOf = (name: string) => TITLES[name] ?? cap(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
const iconOf = (name: string): RowIcon => (/Approve|Revoke|Authori/.test(name) ? 'key' : /Nonce|^Upgrade$/.test(name) ? 'refresh' : /^Assign/.test(name) ? 'bang' : 'box');

// What the review's words need, from what the transaction listed: your token accounts by their token, a nonce account
// it sets up as one, the rest by name.
function namesFor(a: Activity, n: Naming): Names {
    const held = new Map(a.held.map((h) => [h.address, h]));
    const decimals = new Map(a.held.map((h) => [h.mint, h.decimals]));
    const yours = (x: Address) => held.get(x)?.owner === n.wallet;
    const nonces = new Set(a.instructions.flatMap((t) => (t.name === 'InitializeNonceAccount' ? t.accounts.filter((x) => x.role === 'nonceAccount').map((x) => x.address) : [])));
    return {
        wallet: n.wallet,
        who: (x) => (yours(x) ? `your ${n.symbol(held.get(x)!.mint)} account` : nonces.has(x) ? `nonce ${n.who(x)}` : n.who(x)),
        mine: (x) => x === n.wallet || yours(x),
        existed: (x) => !a.fresh.includes(x),
        mintOf: (x) => held.get(x)?.mint ?? null,
        token: (mint) => ({ symbol: mint ? n.symbol(mint) : 'tokens', decimals: mint ? (decimals.get(mint) ?? null) : null, verified: false }),
        program: (x) => n.program(x),
        priorityFee: null,
        payer: a.payer,
        changes: () => [],
    };
}

// A name for an address when Otus has one: a contact's, a program's (yours goes by its address, tagged).
const named = (n: Naming, a: Address) => (n.who(a).includes(a) ? null : n.who(a));

// How much moved, unsigned, and of what.
const quantity = (m: Move, n: Naming) => `${amount(m.units < 0n ? -m.units : m.units, m.decimals, false)} ${m.mint === null ? 'SOL' : n.symbol(m.mint)}`;

// A copy of an address on the other side: dust only when nothing else came with it that could hurt.
function copyWords(a: Activity, other: Address, copies: Address): string {
    if (a.kind === 'send') return `${other} looks like ${copies}: one of them may be forged`;
    return harmless(a) ? `Dust from ${other}, made to look like ${copies}: never send to it` : `From ${other}, made to look like ${copies}: never send to it`;
}

// Sends of an unknown program told one by one, at most; the rest counted.
const SENDS_TOLD = 8;

// What an unknown program did with the wallet's: what it handed over or approved first, as dangers; then each send on
// its own (a few, the rest counted), and the SOL put in accounts it opened together.
function throughWords(through: Activity['through'], n: Naming): Detail[] {
    const symbol = (t: Activity['through'][number]) => (t.mint ? n.symbol(t.mint) : 'SOL');
    const dangers = through.flatMap((t): Detail[] => {
        if (t.kind === 'approved') return [{ text: `It let ${n.who(t.to)} move up to ${quantity({ mint: t.mint, units: t.units, decimals: t.decimals }, n)} of yours`, tone: 'danger' }];
        if (t.kind === 'authority') return [{ text: `It gave your ${symbol(t)} account to ${n.who(t.to)}`, tone: 'danger' }];
        if (t.kind === 'closed') return [{ text: `It closed your ${symbol(t)} account, its SOL to ${n.who(t.to)}`, tone: 'danger' }];
        if (t.kind === 'assigned') return [{ text: `It gave your wallet to the program ${n.program(t.to)}`, tone: 'danger' }];
        return [];
    });
    const sent = through.filter((t) => t.kind === 'sent');
    const sends = sent.slice(0, SENDS_TOLD).map((t): Detail => ({ text: `It sent ${quantity({ mint: t.mint, units: t.units, decimals: t.decimals }, n)} to ${n.who(t.to)}`, tone: 'dim' }));
    const more = sent.length > SENDS_TOLD ? [{ text: `It sent ${sent.length - SENDS_TOLD} more`, tone: 'dim' as const }] : [];
    const opened = through.filter((t) => t.kind === 'opened');
    const rent = opened.reduce((sum, t) => sum + t.units, 0n);
    const into = opened.length === 1 ? 'an account it opened' : `${opened.length} accounts it opened`;
    return [...dangers, ...sends, ...more, ...(opened.length ? [{ text: `It put ${sol(rent)} SOL into ${into}`, tone: 'dim' as const }] : [])];
}

// Opened: what the line didn't say. The balances it moved besides those the line shows (`shown`), the rent and the fee
// apart, the warnings, the programs not named already, memo and failure.
function details(a: Activity, n: Naming, copies: Address | null, shown: Move[]): Detail[] {
    const out: Detail[] = a.moves.filter((m) => !shown.includes(m)).map((m) => ({ text: `${m.units < 0n ? '−' : '+'}${quantity(m, n)}`, tone: m.units > 0n ? 'ok' : 'danger', way: m.units > 0n ? 'in' : 'out' }));
    // A copy the line says already (it does unless an unknown program ran: then the other side is a guess).
    if (copies && a.other && a.unknown.length) out.push({ text: copyWords(a, a.other, copies), tone: 'warn', copy: true });
    // Each program Otus doesn't know, whole, and what it was seen to move of yours inside it.
    for (const p of a.unknown) {
        out.push({ text: `Unknown program ${n.program(p)}`, tone: 'warn', unknown: p });
        out.push(...throughWords(a.through.filter((t) => t.program === p), n).map((d) => ({ ...d, unknown: p })));
    }
    // What it did besides its balances, as the review words each instruction of Solana's own: all of it when it moved
    // no balance, else what to look out for (an approval made on the way). Nothing when it failed: none of it happened.
    if (!a.error) {
        const names = namesFor(a, n);
        a.instructions.forEach((told) => {
            if (told.source !== 'plugin' || BACKGROUND.has(told.program)) return;
            for (const e of story({ ...told, data: new Uint8Array() }, names).effects) {
                const marked = e.tone === 'danger' || e.tone === 'warn';
                if (a.kind === 'other' || marked) out.push({ text: e.text, ...(e.tone === 'danger' || e.tone === 'warn' ? { tone: e.tone } : {}) });
            }
        });
    }
    if (!a.signed && a.moves.some((m) => m.units < 0n)) out.push({ text: "You didn't sign it: a delegate of your tokens moved them", tone: 'warn' });
    if (a.error) out.push({ text: `Failed: ${a.error}`, tone: 'danger' });
    if (a.rent.yours > 0n) out.push({ text: `${sol(a.rent.yours)} SOL of rent in a token account of yours: back when it closes`, tone: 'dim' });
    if (a.rent.yours < 0n) out.push({ text: `${sol(-a.rent.yours)} SOL of rent freed from a token account of yours, closed`, tone: 'dim' });
    if (a.rent.theirs > 0n) out.push({ text: `${sol(a.rent.theirs)} SOL to open their token account`, tone: 'dim' });
    if (a.rent.opened > 0n) out.push({ text: `${sol(a.rent.opened)} SOL of rent in the accounts it opened`, tone: 'dim' });
    out.push({ text: `Fee ${sol(a.fee)} SOL, paid by ${n.who(a.payer)}`, tone: 'dim' });
    if (a.memo) out.push({ text: `Memo “${a.memo}”`, tone: 'dim' });
    // Those it doesn't know have a line each.
    const programs = a.programs.filter((p) => !a.unknown.includes(p));
    if (programs.length) out.push({ text: programs.map((p) => n.program(p)).join(' · '), tone: 'dim' });
    return out;
}
