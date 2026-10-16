import { getAddressDecoder, getAddressEncoder, getI64Encoder, getU32Decoder, getU64Encoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

import { STAKE_PROGRAM } from '../programs/addresses.ts';
import { holdings, offsetsOf, type Change, type Changes, type State } from '../review/changes.ts';


/** An account of yours held to the simulated outcome. Amounts may move by the slack; owners and authorities may not
 *  move at all. A field left out is not held: another transaction signed with it changes that field. */
export type Hold =
    | { kind: 'wallet'; account: Address; atLeast: bigint; owner?: Address; space?: number } // lamports
    | { kind: 'token'; account: Address; atLeast: bigint; owner?: Address; delegate?: Address | null; delegated?: bigint; closer?: Address | null } // delegate and delegated go together
    | { kind: 'account'; account: Address; atLeast: bigint; owner?: Address; space?: number; keys: number[]; stake?: Partial<Meta> }; // keys: where your address stays

/** A stake account's authorities and lockup, held as they were reviewed: who stakes, who withdraws, until when, and
 *  who alone can lift it before then. */
export type Meta = { staker: Address; withdrawer: Address; time: bigint; epoch: bigint; custodian: Address };

// How far an amount may land from the simulated one, as a share of how much it moved: in a trade prices move between
// simulation and execution; other amounts only drift, as interest does. In basis points.
export const SLACK = { trade: 1_000n, drift: 100n };

/** Another transaction signed with this one, as its review saw it: every account it writes, and yours among them.
 *  `spare`: what it may take from the wallet past its simulation, as a priority fee set once it is reviewed. */
export type Beside = { changes: Changes; yours: Changes; spare?: bigint };

/** Your accounts the transaction can write, and others it can write with your address in them → their holds. The
 *  wallet's `atLeast` is before fees: whoever builds the transaction takes off what it pays. `trade`: the slack of a
 *  trade, in basis points; a swap the wallet builds itself holds it to the slippage it asked, tighter than a site's.
 *  `beside`: the other transactions signed with it, which may land before it in any order: an amount they take out
 *  lowers its floor by as much, slack included; a field they change (an owner, a size, an authority, your address or
 *  a stake's terms in its data) is not held, as what it is then depends on their order; one that closes the account
 *  leaves nothing for this one to act on, if first, and is not counted. */
export function holds(yours: Changes, wallet: Address, keyed: Change[] = [], trade = SLACK.trade, beside: Beside[] = []): Hold[] {
    const key = getAddressEncoder().encode(wallet);
    const slack = trades(yours) ? trade : SLACK.drift;
    const floor = (before: bigint, after: bigint) => max(0n, after - ((after > before ? after - before : before - after) * slack + 9_999n) / 10_000n);
    return [...yours.accounts, ...keyed].flatMap(({ address, before, after }): Hold[] => {
        if (!after) return [];
        const { taken, apart } = besideOf(address, after, wallet, key, beside);
        if (apart.has('all')) return [];
        const least = (before: bigint, after: bigint) => max(0n, floor(before, after) - taken);
        const kept = <T extends object>(field: Field, part: T) => (apart.has(field) ? {} : part);
        if (address === wallet) {
            return [{ kind: 'wallet', account: address, atLeast: least(before?.lamports ?? 0n, after.lamports + yours.fee), ...kept('owner', { owner: after.program }), ...kept('space', { space: after.space }) }];
        }
        const t = after.token;
        if (t) {
            return [
                {
                    kind: 'token',
                    account: address,
                    atLeast: least(before?.token?.amount ?? 0n, t.amount),
                    ...kept('owner', { owner: t.owner }),
                    ...kept('delegate', { delegate: t.delegate, delegated: t.delegated }),
                    ...kept('closer', { closer: t.closer }),
                },
            ];
        }
        const meta = metaOf(after.program, after.data);
        const stake = meta && (Object.fromEntries(Object.entries(meta).filter(([field]) => !apart.has(field as Field))) as Partial<Meta>);
        const keys = offsetsOf(key, after).filter((o) => !apart.has(`key:${o}`));
        return [{ kind: 'account', account: address, atLeast: least(before?.lamports ?? 0n, after.lamports), ...kept('owner', { owner: after.program }), ...kept('space', { space: after.space }), keys, ...(stake && Object.keys(stake).length > 0 && { stake }) }];
    });
}

/** What other transactions signed with this one may make its guards let pass beyond its own review, only from what
 *  they move between your own accounts (what they send away is in their reviews, and so in what the user sees): for
 *  each of them and each asset, what it moves out of your accounts here past what its holdings lose; in lamports, and
 *  units of any token. What a token account's rent may take, at most, is not counted. */
export function roomBeside(yours: Changes, wallet: Address, beside: Beside[] = []): { lamports: bigint; units: bigint } {
    const key = getAddressEncoder().encode(wallet);
    const moved = new Map<string, { at: number; asset: string; amount: bigint }>();
    for (const { address, after } of yours.accounts) {
        if (!after) continue;
        for (const m of besideOf(address, after, wallet, key, beside).moved) {
            const k = `${m.at}\u0000${m.asset}`;
            moved.set(k, { ...m, amount: (moved.get(k)?.amount ?? 0n) + m.amount });
        }
    }
    let [lamports, units] = [0n, 0n];
    for (const { at, asset, amount } of moved.values()) {
        const b = beside[at];
        const [had, has] = holdings(b.yours).get(asset) ?? [0n, 0n];
        const lost = had - (asset === 'SOL' ? has - b.yours.fee : has);
        const room = amount - (lost > 0n ? lost : 0n);
        if (room <= 0n) continue;
        if (asset === 'SOL') lamports += room;
        else units += room;
    }
    return { lamports: lamports > ROOM_LEFT ? lamports : 0n, units };
}
const ROOM_LEFT = 10_000_000n; // lamports: a token account's rent at most, as several transactions open or close them

/** What other transactions signed with this one bring into the accounts its floors hold: landing before it, what a
 *  floor lets go past this one's review. In lamports, and units of any token. */
export function inflowsBeside(held: Hold[], wallet: Address, beside: Beside[] = []): { lamports: bigint; units: bigint } {
    let [lamports, units] = [0n, 0n];
    for (const h of held) {
        for (const b of beside) {
            const c = b.changes.accounts.find((x) => x.address === h.account);
            if (!c?.before || !c.after) continue;
            const tokens = h.kind === 'token' && h.account !== wallet;
            const [was, is] = tokens ? [c.before.token?.amount ?? 0n, c.after.token?.amount ?? 0n] : [c.before.lamports, c.after.lamports];
            if (is <= was) continue;
            if (tokens) units += is - was;
            else lamports += is - was;
        }
    }
    return { lamports, units };
}

// A field a hold asserts: its owner, size and a token account's authorities, your address at an offset (`key:<n>`), a
// stake's terms one by one; 'all' when the account is not the same kind any more.
type Field = 'owner' | 'space' | 'delegate' | 'closer' | 'all' | keyof Meta | `key:${number}`;

// What the others do to an account this one holds as `after`: what they may take out of its amount (`taken`), what
// each of them moves out of it (`moved`, by its place among them), and the fields they change. One that closes it takes
// all of it, and leaves it, made again, with no delegate nor close authority: one this hold expects is let go.
function besideOf(address: Address, after: NonNullable<State>, wallet: Address, key: ReadonlyUint8Array, beside: Beside[]): { taken: bigint; moved: { at: number; asset: string; amount: bigint }[]; apart: Set<Field> } {
    const apart = new Set<Field>();
    const moved: { at: number; asset: string; amount: bigint }[] = [];
    let taken = 0n;
    const amount = (s: NonNullable<State>) => (address !== wallet && s.token ? s.token.amount : s.lamports);
    const assetOf = (s: NonNullable<State>) => (address !== wallet && s.token && !s.token.native ? s.token.mint : 'SOL');
    for (const [at, b] of beside.entries()) {
        const c = b.changes.accounts.find((x) => x.address === address);
        if (!c || (!c.before && !c.after)) continue;
        const spare = address === wallet ? (b.spare ?? 0n) : 0n;
        if (!c.after) {
            const all = amount(c.before!);
            taken += all + spare;
            moved.push({ at, asset: assetOf(c.before!), amount: all });
            // Made again, it has neither: a hold of none still passes, one of some does not.
            if (after.token?.delegate || after.token?.delegated) apart.add('delegate');
            if (after.token?.closer) apart.add('closer');
            continue;
        }
        // Made by it: what this one would find, if that one lands first, is what it made, as far as it is the same.
        for (const f of differs(c.before ?? after, c.after, after, key)) apart.add(f);
        if (!c.before) continue;
        const by = trades(b.yours) ? SLACK.trade : SLACK.drift;
        const [was, left] = [amount(c.before), amount(c.after)];
        if (left < was) moved.push({ at, asset: assetOf(c.before), amount: was - left });
        taken += (left < was ? was - max(0n, left - ((was - left) * by + 9_999n) / 10_000n) : 0n) + spare;
    }
    return { taken, moved, apart };
}

// The fields of an account one transaction changes, from `a` to `b`, that a hold made of `held` asserts: its owner and
// size; a token account's owner, delegate and close authority (its mint or kind, all of it); elsewhere your address
// where `held` keeps it, and a stake's terms.
function differs(a: NonNullable<State>, b: NonNullable<State>, held: NonNullable<State>, key: ReadonlyUint8Array): Field[] {
    const out: Field[] = [];
    if (held.token || a.token || b.token) {
        const [x, y] = [a.token, b.token];
        if (!x || !y || a.program !== b.program || x.mint !== y.mint || x.native !== y.native) return ['all'];
        if (x.owner !== y.owner) out.push('owner');
        if (x.delegate !== y.delegate || x.delegated !== y.delegated) out.push('delegate');
        if (x.closer !== y.closer) out.push('closer');
        return out;
    }
    if (a.program !== b.program) out.push('owner');
    if (a.space !== b.space) out.push('space');
    const at = (s: NonNullable<State>, from: number, to: number) => s.data.slice(from, to).join(',');
    for (const o of offsetsOf(key, held)) if (at(a, o, o + 32) !== at(b, o, o + 32)) out.push(`key:${o}`);
    if (held.program === STAKE_PROGRAM) {
        const terms: [keyof Meta, number, number][] = [['staker', 12, 44], ['withdrawer', 44, 76], ['time', 76, 84], ['epoch', 84, 92], ['custodian', 92, 124]];
        for (const [field, from, to] of terms) if (at(a, from, to) !== at(b, from, to)) out.push(field);
    }
    return out;
}

// A stake account (kind 1, initialized, or 2, delegated): staker at 12, withdrawer at 44, lockup time at 76, epoch at
// 84, custodian at 92.
function metaOf(program: Address, d: ReadonlyUint8Array): Meta | null {
    if (program !== STAKE_PROGRAM || d.length < 124 || ![1, 2].includes(getU32Decoder().decode(d, 0))) return null;
    const at = (offset: number) => getAddressDecoder().decode(d, offset);
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { staker: at(12), withdrawer: at(44), time: view.getBigInt64(76, true), epoch: view.getBigUint64(84, true), custodian: at(92) };
}

// A trade gives one thing for another: one of your holdings goes down while another goes up.
function trades(yours: Changes): boolean {
    const moves = [...holdings(yours).values()].map(([before, after]) => after - before);
    return moves.some((m) => m < 0n) && moves.some((m) => m > 0n);
}

// Lighthouse v2 instruction data: discriminator, log level (silent), assertion count (LEB128), assertions.
const [DATA_MULTI, INFO_MULTI, TOKEN_MULTI, SILENT] = [3, 6, 10, 0];
const [LAMPORTS, DATA_LENGTH, OWNER] = [0, 1, 2]; // account info
const [TOKEN_OWNER, AMOUNT, DELEGATE, DELEGATED, CLOSER] = [1, 2, 3, 6, 7]; // token account
const [U64, I64, PUBKEY] = [7, 8, 12]; // data values
const [EQUAL, AT_LEAST] = [0, 4];

/** A hold as Lighthouse instructions' data: one, or two for an account whose data keeps your address, or a stake
 *  account, its authorities and lockup held whole. `byDelta`: its amount is held as a change instead (`compared`), so
 *  only the rest is asserted here, and none when there is no rest. */
export function assertions(h: Hold, wallet: Address, byDelta = false): Uint8Array[] {
    const u64 = (v: bigint | number) => [...getU64Encoder().encode(v)];
    const key = (a: Address) => [...getAddressEncoder().encode(a)];
    const option = (a: Address | null) => (a === null ? [0] : [1, ...key(a)]);
    // Each assertion of a multi one, the fields left out of the hold left out.
    const multi = (kind: number, parts: number[][]) => Uint8Array.from([kind, SILENT, parts.length, ...parts.flat()]);
    if (h.kind === 'token') {
        const parts = byDelta ? [] : [[AMOUNT, ...u64(h.atLeast), AT_LEAST]];
        if (h.owner !== undefined) parts.push([TOKEN_OWNER, ...key(h.owner), EQUAL]);
        if (h.delegate !== undefined) parts.push([DELEGATE, ...option(h.delegate), EQUAL], [DELEGATED, ...u64(h.delegated ?? 0n), EQUAL]);
        if (h.closer !== undefined) parts.push([CLOSER, ...option(h.closer), EQUAL]);
        return parts.length ? [multi(TOKEN_MULTI, parts)] : [];
    }
    const parts = byDelta ? [] : [[LAMPORTS, ...u64(h.atLeast), AT_LEAST]];
    if (h.space !== undefined) parts.push([DATA_LENGTH, ...u64(h.space), EQUAL]);
    if (h.owner !== undefined) parts.push([OWNER, ...key(h.owner), EQUAL]);
    const found = parts.length ? [multi(INFO_MULTI, parts)] : [];
    if (h.kind === 'account' && h.stake) {
        const m = h.stake;
        const i64 = (v: bigint) => [...getI64Encoder().encode(v)];
        const held: number[][] = [];
        if (m.staker) held.push([12, PUBKEY, ...key(m.staker)]);
        if (m.withdrawer) held.push([44, PUBKEY, ...key(m.withdrawer)]);
        if (m.time !== undefined) held.push([76, I64, ...i64(m.time)]);
        if (m.epoch !== undefined) held.push([84, U64, ...u64(m.epoch)]);
        if (m.custodian) held.push([92, PUBKEY, ...key(m.custodian)]);
        // Your address at a term's place is asserted by that term, when it is held; else on its own.
        const termed = [m.staker && 12, m.withdrawer && 44, m.custodian && 92].filter((o): o is number => typeof o === 'number');
        const others = h.keys.filter((offset) => !termed.includes(offset)).map((offset) => [offset, PUBKEY, ...key(wallet)]);
        const all = [...held, ...others];
        if (all.length === 0) return found;
        return [...found, Uint8Array.from([DATA_MULTI, SILENT, ...leb128(all.length), ...all.flatMap(([offset, ...value]) => [...leb128(offset), ...value, EQUAL])])];
    }
    if (h.kind === 'wallet' || h.keys.length === 0) return found;
    return [...found, Uint8Array.from([DATA_MULTI, SILENT, ...leb128(h.keys.length), ...h.keys.flatMap((offset) => [...leb128(offset), PUBKEY, ...key(wallet), EQUAL])])];
}

/** A hold's amount as this transaction's own change, against a snapshot Lighthouse takes as it starts: held so
 *  whatever others signed with it do first, in any order. `atLeast`: the least change, below 0 for what may leave;
 *  `tokens`: a token account's amount, else its lamports; `slot`: its snapshot's place in memory, 8 bytes each. */
export type Delta = { account: Address; tokens: boolean; atLeast: bigint; slot: number };

/** The amounts of `held` as changes: each from the floor its account would have alone (no room for others), less what
 *  it held before. An account the transaction opens keeps its floor: there was nothing before to compare with. */
export function byChange(held: Hold[], yours: Changes, keyed: Change[], wallet: Address, trade = SLACK.trade): Delta[] {
    const alone = new Map(holds(yours, wallet, keyed, trade).map((h) => [h.account, h]));
    const changes = new Map([...yours.accounts, ...keyed].map((c) => [c.address, c]));
    const out: Delta[] = [];
    for (const h of held) {
        const before = changes.get(h.account)?.before;
        const floor = alone.get(h.account)?.atLeast;
        if (!before || floor === undefined || (h.kind === 'token' && !before.token)) continue;
        const was = h.kind === 'token' ? before.token!.amount : before.lamports;
        out.push({ account: h.account, tokens: h.kind === 'token', atLeast: floor - was, slot: out.length });
    }
    return out;
}

// Lighthouse's memory: an account derived from the payer and an id ("memory", payer, id), made by the first snapshot
// written, at the size all of them take, and closed as the transaction ends, its rent back to the payer.
const [MEMORY_WRITE, MEMORY_CLOSE, DELTA] = [0, 1, 4];
const [WRITE_DATA, WRITE_INFO, INFO_LAMPORTS] = [0, 1, 1];
const [DELTA_INFO, DELTA_DATA, LAMPORTS_DELTA, U64_DELTA] = [0, 1, 0, 6];
const TOKEN_AMOUNT = 64; // a token account's amount: a u64 at 64, in SPL and Token-2022 accounts alike
export const MEMORY_ID = 0;

/** A snapshot of a delta's amount into memory: its lamports, or a token account's 8 bytes of amount. */
export function snapshot(d: Delta, bump: number): Uint8Array {
    const source = d.tokens ? [WRITE_DATA, ...u16(TOKEN_AMOUNT), ...u16(8)] : [WRITE_INFO, INFO_LAMPORTS];
    return Uint8Array.from([MEMORY_WRITE, MEMORY_ID, bump, ...leb128(d.slot * 8), ...source]);
}

/** The amount now against its snapshot: it may have changed by `atLeast` or more. */
export function compared(d: Delta): Uint8Array {
    const least = [...i128(d.atLeast), AT_LEAST];
    if (d.tokens) return Uint8Array.from([DELTA, SILENT, DELTA_DATA, ...leb128(d.slot * 8), ...leb128(TOKEN_AMOUNT), U64_DELTA, ...least]);
    return Uint8Array.from([DELTA, SILENT, DELTA_INFO, ...leb128(d.slot * 8), LAMPORTS_DELTA, ...least]);
}

/** Closes the memory, its rent back to the payer. */
export const forgotten = (bump: number): Uint8Array => Uint8Array.from([MEMORY_CLOSE, MEMORY_ID, bump]);

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
// Two's complement, little-endian, as Borsh writes an i128.
const i128 = (v: bigint) => {
    const u = BigInt.asUintN(128, v);
    return Array.from({ length: 16 }, (_, i) => Number((u >> BigInt(8 * i)) & 0xffn));
};

// Lighthouse writes counts and offsets as unsigned LEB128.
function leb128(n: number): number[] {
    const out: number[] = [];
    do {
        out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
        n >>>= 7;
    } while (n > 0);
    return out;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
