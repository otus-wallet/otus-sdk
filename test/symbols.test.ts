import assert from 'node:assert/strict';
import { test } from 'node:test';

import { symbolOf } from '../src/activity/symbols.ts';

const MINT = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D';
const token = (symbol: string, verified: boolean) => ({ symbol, verified });

test('a verified token by its symbol; one no list vouches for by its maker’s', () => {
    assert.equal(symbolOf(MINT, token('jlUSDC', true)), 'jlUSDC');
    assert.equal(symbolOf(MINT, token('PEPE2', false)), 'PEPE2');
    assert.equal(symbolOf(MINT, token('  PEPE2 ', false)), 'PEPE2');
});

test('no name to give: the mint', () => {
    for (const t of [null, undefined, token('', false), token('   ', true)]) assert.equal(symbolOf(MINT, t), MINT);
});

test('an unverified token named as one people know is a fake, however it spells it', () => {
    assert.equal(symbolOf(MINT, token('USDC', false)), 'fake USDC');
    assert.equal(symbolOf(MINT, token('usdc', false)), 'fake usdc');
    assert.equal(symbolOf(MINT, token('ＵＳＤＣ', false)), 'fake ＵＳＤＣ'); // full-width, read as USDC
    assert.equal(symbolOf(MINT, token('jlUSDC', false), ['jlUSDC']), 'fake jlUSDC'); // a verified one's in view
    assert.equal(symbolOf(MINT, token('USDC', true)), 'USDC'); // the real one
});

test("a maker's name that reads as a link, a handle or an address, or is a message: the mint", () => {
    for (const s of ['claim.com', 'x.com/free', 'https://a', '@airdrop', 'a\\b', 'VISIT-TO-CLAIM-REWARD', MINT, `go ${MINT}`]) assert.equal(symbolOf(MINT, token(s, false)), MINT, s);
    // A verified one that holds an address is the mint too: cut short, it would pass for that address.
    assert.equal(symbolOf(MINT, token(MINT, true)), MINT);
});

test('a name with what does not show, moves the rest or breaks a line is no name: the mint', () => {
    for (const s of ['\u202ECDSU', 'US\u200BDC', 'AB\nOK verified', 'USDC\u2800', 'USDC\u3164', 'PEPE\u2066']) assert.equal(symbolOf(MINT, token(s, false)), MINT, JSON.stringify(s));
    assert.equal(symbolOf(MINT, token('US\u200BDC', true)), MINT); // verified or not
});

test('a fake reads as one however it is written: digits for letters, signs around it, spaces within', () => {
    for (const s of ['U5DC', 'S0L', '$USDC', 'USDC.', 'U S D C', 'B0NK', 'J1TOSOL']) assert.equal(symbolOf(MINT, token(s, false)), `fake ${s}`, s);
    assert.equal(symbolOf(MINT, token('jlUSDC', false), ['JLUSDC']), 'fake jlUSDC');
    assert.equal(symbolOf(MINT, token('PEPE2', false)), 'PEPE2');
});

