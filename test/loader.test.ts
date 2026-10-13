import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    getCloseInstruction,
    getExtendProgramInstruction,
    getSetAuthorityCheckedInstruction,
    getSetAuthorityInstruction,
    getUpgradeInstruction,
    LOADER_V3_PROGRAM_ADDRESS,
} from '@solana-program/loader-v3';
import { AccountRole, createNoopSigner, type Address, type Instruction } from '@solana/kit';

import { rows, text } from '../src/activity/words.ts';
import { CORE_PLUGINS } from '../src/programs/core.ts';
import { story, type Names } from '../src/review/effects.ts';
import type { Explained } from '../src/review/explain.ts';
import { key, PAYER } from './helpers.ts';

// A program, its program data, a buffer of new code, and someone else.
const [PROGRAM, DATA, BUFFER, OTHER] = [key(90), key(91), key(92), key(93)];
const loader = CORE_PLUGINS.find((p) => p.program === LOADER_V3_PROGRAM_ADDRESS)!;
const named: Record<string, string> = { [PROGRAM]: 'the program', [DATA]: 'its data', [BUFFER]: 'the buffer', [OTHER]: 'someone', [PAYER]: 'you' };
const names: Names = {
    wallet: PAYER,
    who: (a) => named[a] ?? a,
    mine: (a) => a === PAYER,
    existed: () => true,
    mintOf: () => null,
    token: () => ({ symbol: 'tokens', decimals: null, verified: false }),
    program: (a) => a,
    priorityFee: null,
    payer: PAYER,
    changes: () => [],
};
const explained = (ix: Instruction): Explained => {
    const e = loader.explain({ ...ix, accounts: ix.accounts ?? [], data: ix.data ?? new Uint8Array() } as never);
    return { program: LOADER_V3_PROGRAM_ADDRESS, programName: loader.name, source: 'plugin', data: ix.data ?? new Uint8Array(), ...(e as Pick<Explained, 'name' | 'accounts' | 'args'>) };
};
const told = (ix: Instruction) => story(explained(ix), names);
const me = createNoopSigner(PAYER);
// As it lands onchain: an optional account left out, not its client's stand-in for one.
const landed = (ix: Instruction): Instruction => ({ ...ix, accounts: ix.accounts!.filter((a) => a.address !== LOADER_V3_PROGRAM_ADDRESS) });

test("an upgrade: the program's code replaced with the buffer's", () => {
    const ix = getUpgradeInstruction({ programDataAccount: DATA, programAccount: PROGRAM, bufferAccount: BUFFER, spillAccount: PAYER, authority: me });
    assert.deepEqual(told(ix), {
        args: 'The program ← the buffer',
        effects: [
            { text: 'Replaces the code of the program with what the buffer holds', tone: 'danger' }, // your program's
            { text: 'The SOL left in the buffer goes to you', tone: 'plain' },
        ],
    });
});

test('an authority given away, or set to no one as the loader takes it (its new authority left out)', () => {
    const away = told(getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: me, newAuthority: OTHER }));
    assert.deepEqual(away, { args: '→ someone', effects: [{ text: 'Someone is now the authority of its data', tone: 'danger' }] });
    // Checked: the new authority signs too; from someone else to you, it is no loss of yours.
    const back = told(getSetAuthorityCheckedInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: createNoopSigner(OTHER), newAuthority: me }));
    assert.deepEqual(back.effects, [{ text: 'You is now the authority of its data', tone: 'warn' }]);
    // To an account the transaction itself makes yours (whoever made it holds its key): as red as to anyone.
    const made = story(explained(getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: me, newAuthority: OTHER })), { ...names, mine: (a) => a === PAYER || a === OTHER });
    assert.equal(made.effects[0]!.tone, 'danger');
    const none = getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: me });
    assert.equal(none.accounts!.length, 3); // its client's stand-in for the one left out
    for (const ix of [none, landed(none)]) {
        assert.deepEqual(told(ix), { args: 'no one', effects: [{ text: 'Its data has no authority now: it can never be changed again', tone: 'danger' }] });
    }
    assert.equal(landed(none).accounts!.length, 2);
});

test('a close: of a buffer, or of a program, which can never run again', () => {
    const buffer = getCloseInstruction({ bufferOrProgramDataAccount: BUFFER, destinationAccount: PAYER, authority: me });
    assert.deepEqual(told(landed(buffer)).effects, [{ text: 'Closes the buffer; its SOL goes to you', tone: 'plain' }]);
    const program = getCloseInstruction({ bufferOrProgramDataAccount: DATA, destinationAccount: PAYER, authority: me, programAccount: PROGRAM });
    assert.deepEqual(told(program).effects.at(-1), { text: 'The program can never run again', tone: 'danger' }); // yours, closed
    // Someone else's program, by its own authority: told, no alarm.
    const theirs = getUpgradeInstruction({ programDataAccount: DATA, programAccount: PROGRAM, bufferAccount: BUFFER, spillAccount: OTHER, authority: createNoopSigner(OTHER) });
    assert.equal(told(theirs).effects[0]!.tone, 'warn');
    const extend = getExtendProgramInstruction({ programDataAccount: DATA, programAccount: PROGRAM, additionalBytes: 4096 });
    assert.deepEqual(told(landed(extend)), { args: '4096 bytes', effects: [{ text: 'Gives the program room for 4096 more bytes', tone: 'plain' }] });
});

test('what does not fit is refused: too few accounts, an instruction it has not, data cut short', () => {
    const none = getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: me });
    const hostile: [string, Instruction][] = [
        ['one account', { ...none, accounts: none.accounts!.slice(0, 1) }],
        ['no such instruction', { ...none, data: new Uint8Array([99, 0, 0, 0]) }],
        ['data cut short', { ...getExtendProgramInstruction({ programDataAccount: DATA, programAccount: PROGRAM, additionalBytes: 1 }), data: new Uint8Array([6, 0, 0, 0, 1]) }],
        ['no data', { ...none, data: new Uint8Array() }],
    ];
    for (const [why, ix] of hostile) assert.throws(() => loader.explain({ ...ix, accounts: ix.accounts ?? [], data: ix.data ?? new Uint8Array() } as never), Error, why);
    // Past what it can take: read as given, the extra account named by its place.
    const more = { ...none, accounts: [...none.accounts!, { address: OTHER, role: AccountRole.READONLY }] };
    assert.ok(explained(more).accounts.some((a) => a.role === 'account 4' && a.address === OTHER));
});

test("Activity's line: what the loader did, by its own words", () => {
    const base = { signatures: {}, slot: 1n, time: 1, error: null, kind: 'other' as const, moves: [], fee: 5000n, payer: PAYER, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], held: [], fresh: [] as Address[], staked: 0n, signed: true, other: null, programs: [LOADER_V3_PROGRAM_ADDRESS], unknown: [] as Address[], through: [], main: null, squads: [], memo: null, inner: [] };
    const naming = { wallet: PAYER, symbol: (m: Address) => m, who: (a: Address) => named[a] ?? a, program: (a: Address) => a, known: [] };
    const upgrade = explained(getUpgradeInstruction({ programDataAccount: DATA, programAccount: PROGRAM, bufferAccount: BUFFER, spillAccount: PAYER, authority: me }));
    const final = explained(landed(getSetAuthorityInstruction({ bufferOrProgramDataAccount: DATA, currentAuthority: me })));
    const [up, immutable] = rows([{ ...base, signature: 'u', instructions: [upgrade] }, { ...base, signature: 'f', instructions: [final] }], naming);
    assert.deepEqual([up.icon, text(up.title), text(up.sub)], ['refresh', 'Upgraded a program', 'The program ← the buffer']);
    assert.deepEqual([text(immutable.title), immutable.tone, immutable.subject], ['Removed an authority', 'danger', { program: LOADER_V3_PROGRAM_ADDRESS, name: 'SetAuthority' }]);
});
