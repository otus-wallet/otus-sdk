import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amount, rounded } from '../src/format.ts';

// Whole units of a token with `decimals`, as base units: "1665397.86417", 5 → 166539786417n.
const units = (s: string, decimals: number) => {
    const [whole, fraction = ''] = s.split('.');
    return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
};

test('rounded: under a million, at most two decimals, digits grouped', () => {
    assert.equal(rounded(units('33308.21123', 5), 5), '33,308.21');
    assert.equal(rounded(units('0.107283', 6), 6), '0.11');
    assert.equal(rounded(units('0.05', 9), 9), '0.05');
    assert.equal(rounded(units('12.5', 9), 9), '12.5');
    assert.equal(rounded(units('1', 6), 6), '1');
    assert.equal(rounded(units('0.0149', 6), 6), '0.01');
    assert.equal(rounded(units('0.015', 6), 6), '0.02'); // half up
    assert.equal(rounded(units('999999.99', 6), 6), '999,999.99');
});

test('rounded: from a million on, in millions, billions and trillions', () => {
    assert.equal(rounded(units('1665397.86417', 5), 5), '1.67M');
    assert.equal(rounded(units('1000000', 6), 6), '1M');
    assert.equal(rounded(units('2500000000', 0), 0), '2.5B');
    assert.equal(rounded(units('3000000000000', 9), 9), '3T');
    assert.equal(rounded(units('123456789000000000', 0), 0), '123,456.79T');
});

test('rounded: what rounds to a thousand of one is one of the next', () => {
    assert.equal(rounded(units('999999.996', 6), 6), '1M');
    assert.equal(rounded(units('999999.994', 6), 6), '999,999.99');
    assert.equal(rounded(units('999996000', 0), 0), '1B');
    assert.equal(rounded(units('999994999', 0), 0), '999.99M');
});

test('rounded: under 0.01, its first two digits that are not zero, never 0', () => {
    assert.equal(rounded(units('0.001', 9), 9), '0.001');
    assert.equal(rounded(units('0.000005', 9), 9), '0.000005');
    assert.equal(rounded(units('0.000123456', 9), 9), '0.00012');
    assert.equal(rounded(units('0.000125', 9), 9), '0.00013');
    assert.equal(rounded(units('0.00999', 6), 6), '0.01');
    assert.equal(rounded(1n, 9), '0.000000001');
    assert.equal(rounded(1n, 18), '0.000000000000000001');
    assert.equal(rounded(15n, 18), '0.000000000000000015');
    assert.equal(rounded(155n, 18), '0.00000000000000016');
});

test('rounded: nothing, no decimals, and either sign the same', () => {
    assert.equal(rounded(0n, 9), '0');
    assert.equal(rounded(5n, 0), '5');
    assert.equal(rounded(-units('1665397.86417', 5), 5), '1.67M');
    assert.equal(rounded(-units('0.001', 9), 9), '0.001');
});

test('rounded: never far from the amount whole', () => {
    // Every power of ten and its neighbours, over decimals people use: within half a unit of the last place shown.
    for (const decimals of [0, 2, 5, 6, 9]) {
        for (let p = 0; p <= 22; p++) {
            for (const n of [10n ** BigInt(p) - 1n, 10n ** BigInt(p), 10n ** BigInt(p) + 7n]) {
                if (n <= 0n) continue;
                const shown = rounded(n, decimals);
                const whole = Number(amount(n, decimals, false).replaceAll(',', ''));
                const [, digits, letter = ''] = /^([\d,.]+)([MBT]?)$/.exec(shown)!;
                const value = Number(digits!.replaceAll(',', '')) * { '': 1, M: 1e6, B: 1e9, T: 1e12 }[letter]!;
                assert.ok(value > 0, `${n}/${decimals}: ${shown}`);
                assert.ok(Math.abs(value - whole) / whole <= 0.05, `${n}/${decimals}: ${shown} for ${whole}`);
            }
        }
    }
});
