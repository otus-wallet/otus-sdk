// A program's name, from its own IDL, held against the brands and programs Otus knows: an IDL is anyone's to write.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { described } from '../src/review/assess.ts';
import { key } from './helpers.ts';

const PROGRAM = key(40);
const posing = (name: string) => described([], new Map([[PROGRAM, name]]), [{ program: PROGRAM, name: null, signature: false, writable: false, accounts: 0, unseen: false }]).map((f) => f.code);

test('a name that borrows a brand is said; a long run of digits in one is refused at once', () => {
    for (const name of ['jupiterv6', 'jupiter6', 'jupiter2024', 'jupiterv2swap', 'kaminolend', 'realjupiter', 'raydiumamm3']) assert.deepEqual(posing(name), ['imitation-program'], name);
    for (const name of ['pythonUtils', 'driftwood', 'jupiter6z', 'jupiterv12x']) assert.deepEqual(posing(name), [], name);
    // Digits split every way took twice as long with each one more: hours, for the 39 a name can carry.
    const t = performance.now();
    assert.deepEqual(posing(`jupiter${'1'.repeat(39)}z`), []);
    assert.deepEqual(posing(`jupiter${'1'.repeat(40)}`), ['imitation-program']);
    assert.ok(performance.now() - t < 500);
});
