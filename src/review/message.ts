// A message to sign, before it is signed: words a person can read, or data.
import type { ReadonlyUint8Array } from '@solana/kit';

import type { Finding } from './assess.ts';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // a byte order mark kept, to be seen
// What no written message needs: control characters (tab and line breaks aside), invisible ones, line separators.
const UNWRITTEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// One run of hex, base58 or base64 (url-safe too), long enough to carry data.
const ENCODED = /^[\w+/=-]{16,}$/;
const WORD = /^[A-Za-z][a-z]*$/; // a long word stays a word

/**
 * Data, not words: bytes that are not text (not UTF-8, or with characters no written message has), or text that is one
 * run of an encoding. A program can take a signature over data as an order: Ed25519SigVerify, in a transaction anyone
 * sends, proves the key signed it. A person can't tell what data orders, and neither can Otus.
 */
export function isData(message: ReadonlyUint8Array): boolean {
    let text: string;
    try {
        text = UTF8.decode(message as Uint8Array);
    } catch {
        return true;
    }
    if (UNWRITTEN.test(text)) return true;
    const t = text.trim();
    return ENCODED.test(t) && !WORD.test(t);
}

/** What the review says about a message to sign: data warns as critical. */
export function messageFindings(message: ReadonlyUint8Array): Finding[] {
    if (!isData(message)) return [];
    return [{ level: 'danger', code: 'message-data', text: 'Unreadable message', note: 'A program could take your signature as an order' }];
}
