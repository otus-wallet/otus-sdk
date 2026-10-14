import { getAddressDecoder, getAddressEncoder, getI64Encoder, getU32Decoder, getU64Encoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

import { STAKE_PROGRAM } from '../programs/addresses.ts';
import { holdings, offsetsOf, type Change, type Changes, type State } from '../review/changes.ts';


/** An account of yours held to the simulated outcome. Amounts may move by the slack; owners and authorities may not move at all. */
export type Hold =
    | { kind: 'wallet'; account: Address; atLeast: bigint; owner: Address; space: number } // lamports
    | { kind: 'token'; account: Address; atLeast: bigint; owner: Address; delegate: Address | null; delegated: bigint; closer: Address | null }
    | { kind: 'account'; account: Address; atLeast: bigint; owner: Address; space: number; keys: number[]; stake?: Meta }; // keys: where your address stays

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
 *  lowers its floor by as much, slack included; an account they change past its amount (created, closed, its owner,
 *  size, data or authorities) is not held, as what it is then depends on their order. */
export function holds(yours: Changes, wallet: Address, keyed: Change[] = [], trade = SLACK.trade, beside: Beside[] = []): Hold[] {
    const key = getAddressEncoder().encode(wallet);
    const slack = trades(yours) ? trade : SLACK.drift;
    const floor = (before: bigint, after: bigint, by = slack) => max(0n, after - ((after > before ? after - before : before - after) * by + 9_999n) / 10_000n);
    // What the others may take out of an account, by its amount (`of`); null when one changes it past that.
    const takenBeside = (address: Address, of: (s: NonNullable<State>) => bigint): bigint | null => {
        let taken = 0n;
        for (const b of beside) {
            const c = b.changes.accounts.find((x) => x.address === address);
            if (!c || (c.before === null && c.after === null)) continue;
            if (!c.before || !c.after || !sameButAmount(c.before, c.after)) return null;
            // The fee it pays is in what its simulation left: taken out like the rest.
            const by = trades(b.yours) ? SLACK.trade : SLACK.drift;
            const [was, left] = [of(c.before), of(c.after)];
            if (left < was) taken += was - floor(was, left, by);
            if (address === wallet) taken += b.spare ?? 0n;
        }
        return taken;
    };
    const lamports = (s: NonNullable<State>) => s.lamports;
    const units = (s: NonNullable<State>) => s.token?.amount ?? 0n;
    return [...yours.accounts, ...keyed].flatMap(({ address, before, after }): Hold[] => {
        if (!after) return [];
        const t = after.token;
        const taken = takenBeside(address, address !== wallet && t ? units : lamports);
        if (taken === null) return [];
        const least = (before: bigint, after: bigint) => max(0n, floor(before, after) - taken);
        if (address === wallet) {
            return [{ kind: 'wallet', account: address, atLeast: least(before?.lamports ?? 0n, after.lamports + yours.fee), owner: after.program, space: after.space }];
        }
        if (t) return [{ kind: 'token', account: address, atLeast: least(before?.token?.amount ?? 0n, t.amount), owner: t.owner, delegate: t.delegate, delegated: t.delegated, closer: t.closer }];
        const stake = metaOf(after.program, after.data);
        return [{ kind: 'account', account: address, atLeast: least(before?.lamports ?? 0n, after.lamports), owner: after.program, space: after.space, keys: offsetsOf(key, after), ...(stake && { stake }) }];
    });
}

// Whether an account is the same but for an amount: its lamports, or a token account's units. A token account's
// authorities, a wallet's owner and size, any other account's data are the same.
function sameButAmount(a: NonNullable<State>, b: NonNullable<State>): boolean {
    if (a.program !== b.program || a.space !== b.space) return false;
    if (a.token || b.token) {
        if (!a.token || !b.token) return false;
        const [x, y] = [a.token, b.token];
        return x.mint === y.mint && x.owner === y.owner && x.delegate === y.delegate && x.delegated === y.delegated && x.closer === y.closer && x.native === y.native;
    }
    return a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
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
 *  account, its authorities and lockup held whole. */
export function assertions(h: Hold, wallet: Address): Uint8Array[] {
    const u64 = (v: bigint | number) => [...getU64Encoder().encode(v)];
    const key = (a: Address) => [...getAddressEncoder().encode(a)];
    const option = (a: Address | null) => (a === null ? [0] : [1, ...key(a)]);
    const info = [INFO_MULTI, SILENT, 3, LAMPORTS, ...u64(h.atLeast), AT_LEAST];
    if (h.kind === 'token') {
        return [Uint8Array.from([TOKEN_MULTI, SILENT, 5, AMOUNT, ...u64(h.atLeast), AT_LEAST, TOKEN_OWNER, ...key(h.owner), EQUAL, DELEGATE, ...option(h.delegate), EQUAL, DELEGATED, ...u64(h.delegated), EQUAL, CLOSER, ...option(h.closer), EQUAL])];
    }
    const found = Uint8Array.from([...info, DATA_LENGTH, ...u64(h.space), EQUAL, OWNER, ...key(h.owner), EQUAL]);
    if (h.kind === 'account' && h.stake) {
        const m = h.stake;
        const i64 = (v: bigint) => [...getI64Encoder().encode(v)];
        const held = [[12, PUBKEY, ...key(m.staker)], [44, PUBKEY, ...key(m.withdrawer)], [76, I64, ...i64(m.time)], [84, U64, ...u64(m.epoch)], [92, PUBKEY, ...key(m.custodian)]];
        const others = h.keys.filter((offset) => ![12, 44, 92].includes(offset)).map((offset) => [offset, PUBKEY, ...key(wallet)]);
        const all = [...held, ...others];
        return [found, Uint8Array.from([DATA_MULTI, SILENT, ...leb128(all.length), ...all.flatMap(([offset, ...value]) => [...leb128(offset), ...value, EQUAL])])];
    }
    if (h.kind === 'wallet' || h.keys.length === 0) return [found];
    return [found, Uint8Array.from([DATA_MULTI, SILENT, ...leb128(h.keys.length), ...h.keys.flatMap((offset) => [...leb128(offset), PUBKEY, ...key(wallet), EQUAL])])];
}

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
