// What a token is called in words, for a caller that names tokens by what a token list says of them (Jupiter's). A
// verified one by its symbol. One no list vouches for by its maker's, as people know it by that name, unless the name is
// one people know of another token (anyone can call a token USDC: then it is "fake USDC"), or reads as a link, a handle
// or an address, or is a message: then by its mint.
import { latin } from '../review/sites.ts';

/** Symbols scams like to give their own tokens. */
export const IMITATED: ReadonlySet<string> = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'JUP', 'BONK', 'JTO', 'PYTH', 'RAY', 'ORCA', 'MSOL', 'JITOSOL', 'BSOL', 'JUPSOL', 'INF', 'WIF', 'TRUMP', 'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'PYUSD', 'USDS', 'USDE', 'EURC', 'PENGU', 'POPCAT', 'RENDER', 'HNT']);

/** What a token list says of a token: its symbol, and whether it vouches for it. */
export type Listed = { symbol: string; verified: boolean };

// A maker's name that would take the reader somewhere: a link, a domain, a handle.
const LINKISH = /[/:@\\]|\.[a-z]{2,}/i;
// An address within it: cut short, it would pass for that address.
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
// Longer than any symbol a maker gives: a message in its place.
const LONGEST = 16;

/** The symbol words give `mint`, from what a list says of it (`t`), or the mint when there is none to give. `known`: the
 *  symbols of the verified tokens in view, as `latin` reads them, upper case. */
export function symbolOf(mint: string, t: Listed | null | undefined, known: ReadonlySet<string> = new Set()): string {
    const symbol = t?.symbol.trim() ?? '';
    if (!t || !symbol || ADDRESS.test(symbol)) return mint;
    if (t.verified) return symbol;
    if (symbol.length > LONGEST || LINKISH.test(symbol)) return mint;
    const read = latin(symbol).toUpperCase();
    return IMITATED.has(read) || known.has(read) ? `fake ${symbol}` : symbol;
}
