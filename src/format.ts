// Numbers and addresses as people read them. Pure, for the review and the pages alike.

/** An address in short: its first and last four characters. */
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Base units as a decimal, digits grouped and trailing zeros dropped, with its sign when asked: −1500000000, 9 → "−1.5". */
export function amount(units: bigint, decimals: number, signed = true): string {
    const abs = units < 0n ? -units : units;
    const scale = 10n ** BigInt(decimals);
    const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    const sign = !signed ? '' : units < 0n ? '−' : units > 0n ? '+' : '';
    return `${sign}${(abs / scale).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Base units as an amount is read at a glance, without a sign, digits grouped: at most two decimals ("33,308.21"); from a
 * million on, in millions, billions and trillions ("1.67M"); under 0.01, its first two digits that aren't zero
 * ("0.00012"), so that what isn't nothing never reads 0. Rounded half up. For a line that opens onto the amount whole:
 * what is signed or paid is told whole (`amount`).
 */
export function rounded(units: bigint, decimals: number): string {
    const abs = units < 0n ? -units : units;
    const scale = 10n ** BigInt(decimals);
    if (abs === 0n) return '0';
    if (abs * 100n < scale) {
        // Its first two digits: the zeros after the point before them, and two places more.
        const kept = decimals - abs.toString().length + 2;
        if (kept >= decimals) return amount(abs, decimals, false);
        const by = 10n ** BigInt(decimals - kept);
        return amount((abs + by / 2n) / by, kept, false);
    }
    const hundredths = (abs * 100n + scale / 2n) / scale;
    if (hundredths < 100_000_000n) return amount(hundredths, 2, false);
    // A thousand of one, rounded, is one of the next: 999,999.996 is 1M, never 1,000K.
    for (const [i, [power, letter]] of LARGE.entries()) {
        const by = 10n ** BigInt(power) * scale;
        const of = (abs * 100n + by / 2n) / by;
        if (of < 100_000n || i === LARGE.length - 1) return `${amount(of, 2, false)}${letter}`;
    }
    return amount(abs, decimals, false);
}
const LARGE = [[6, 'M'], [9, 'B'], [12, 'T']] as const;

export const SOL_DECIMALS = 9;

/** Lamports as SOL, without a sign. */
export const sol = (lamports: bigint) => amount(lamports, SOL_DECIMALS, false);

/** Base units as a signed decimal, or as raw units when the decimals are not known. */
export const quantity = (units: bigint, decimals: number | null) => (decimals === null ? `${units} units` : amount(units, decimals));

/** A count and its word: "1 signature", "3 signatures". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether two addresses look alike as people check them, by their ends: at least six characters alike between the start
 *  and the end, two or more at each, as wallets shorten addresses and address poisoners forge them ("7xKX…gAsU" passes
 *  for the other). Two random addresses are, about once in 10^9 (their first character is not evenly spread). */
export function alike(a: string, b: string): boolean {
    const n = Math.min(a.length, b.length);
    let head = 0;
    while (head < n && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return head >= 2 && tail >= 2 && head + tail >= 6;
}

/** The first letter up. */
// Only a plain first word ("you", "your", "an"): an address, cut short or whole, is never changed.
export const cap = (s: string) => (/^[a-z]{1,12}(\s|$)/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

/** Text a program or a node wrote, shown as written: without characters that move or hide others, and kept short. */
export const told = (s: string, max = 120) => {
    const shown = [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()];
    return shown.length > max ? `${shown.slice(0, max - 1).join('')}…` : shown.join('');
};
