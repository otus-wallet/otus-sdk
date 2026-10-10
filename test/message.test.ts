import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isData, messageFindings } from '../src/review/message.ts';

const words = (s: string) => new TextEncoder().encode(s);

test('words a person reads are words: sign-ins, nonces among words, any language, a long word', () => {
    for (const s of [
        'example.com wants you to sign in with your Solana account:\nHH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2\n\nURI: https://example.com\nNonce: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        'Otus lab: sign this message to prove you hold this account.\nNonce: 7c1f…',
        'Sign to log in\r\n\tat 2026-10-10',
        'Firma para entrar · ログイン 🦉',
        'Internationalization',
        'gm',
        '',
        '   ',
        'https://example.com/claim?id=12345678901234567890',
    ])
        assert.equal(isData(words(s)), false, s);
    assert.deepEqual(messageFindings(words('Sign to log in')), []);
});

test('data is data: bytes that are not text, or text that is one run of an encoding', () => {
    const order = new Uint8Array([0x2a, 0x9f, 0x01, 0x00, 0x00, 0x00, 0xe8, 0x03, 0, 0, 0, 0, 0, 0, 0x14]); // borsh-like
    const quiet = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x05, 0x00]); // UTF-8, all of it controls
    for (const m of [
        order,
        quiet,
        new Uint8Array([0xff]),
        new Uint8Array([0xc0, 0x80]), // an overlong NUL
        new Uint8Array([0xed, 0xa0, 0x80]), // a lone surrogate
        new Uint8Array([0xe2, 0x82]), // cut short
        words('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), // hex
        words('0x9f86d081884c7d659a2feaa0'),
        words('  HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2\n'), // base58, padded
        words('KpcBAAAA6AMAAAAAAAAU+/=='), // base64
        words('KpcBAAAA6AMAAAAAAAAU-_'), // url-safe base64
        words('550e8400-e29b-41d4-a716-446655440000'),
        words('camelCaseWithoutDigits'),
        words('Sign to log in\u0000'), // a NUL after words
        words('Sign to​ log in'), // a zero-width space
        words('﻿Sign to log in'), // a byte order mark
        words('Sign to log in Send all'), // a line separator
        new Uint8Array(4096).fill(0x41).map((b, i) => (i % 7 ? b : 0x31)), // a long run
    ])
        assert.equal(isData(m), true, Buffer.from(m).toString('hex').slice(0, 40));
    assert.deepEqual(messageFindings(order), [{ level: 'danger', code: 'message-data', text: 'Unreadable message', note: 'A program could take your signature as an order' }]);
});
