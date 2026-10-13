// Addresses Otus knows by heart: programs it reads, and tokens it names without asking. Constants only, so any page
// can take them without the plugins.
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address, type Address } from '@solana/kit';

export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const TOKEN_PROGRAMS: readonly Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
export const isTokenProgram = (a: string) => (TOKEN_PROGRAMS as readonly string[]).includes(a);
export const STAKE_PROGRAM = address('Stake11111111111111111111111111111111111111');
// Lighthouse sees your wallet as a signer. On mainnet it is immutable: no upgrade authority since slot 294179293.
export const LIGHTHOUSE = address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

export const WSOL = address('So11111111111111111111111111111111111111112');
export const WSOL_2022 = address('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP'); // Token-2022's wrapped SOL
/** Wrapped SOL, of either token program: SOL itself held in a token account. */
export const isWrappedSol = (mint: string) => mint === WSOL || mint === WSOL_2022;
export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

/** Helius Sender's tip accounts (helius.dev/docs/sending-transactions/sender): one of them is paid for each transaction
 *  it lands. */
export const SENDER_TIPS: readonly Address[] = [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((a) => address(a));
