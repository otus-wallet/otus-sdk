import { lamports, type Address, type MaybeEncodedAccount } from '@solana/kit';

import { mintTerms, type MintTerms } from '../access/mint.ts';

import type { Chain } from '../chain.ts';
import { Refused } from '../errors.ts';
import { assess, type Assessment, type Context } from './assess.ts';
import { changes, type Changes } from './changes.ts';
import { decode } from './decode.ts';
import { deployments, type Deployment } from './programs.ts';
import { explain, type Explained } from './explain.ts';
import { resolve } from './resolve.ts';
import { simulate, type Simulated } from './simulate.ts';

export type Review = Simulated & { changes: Changes; explained: Explained[]; deployments: Map<Address, Deployment>; assessment: Assessment };

/** One transaction through steps 3 to 8. Throws Refused for what cannot be signed at all. */
export async function review(bytes: Uint8Array, context: Context, chain: Chain): Promise<Review> {
    const decoded = await decode(bytes);
    if (!decoded.signers.includes(context.wallet)) throw new Refused('this wallet does not sign this transaction');
    const resolved = await resolve(decoded, chain);
    // When its programs were deployed is worth knowing, never worth failing the review for.
    const [simulated, deployed] = await Promise.all([simulate(resolved, chain), deployments(resolved, chain).catch(() => new Map<Address, Deployment>())]);
    const changed = changes(simulated);
    const explained = explain(resolved);
    // Who else its mints let control tokens of yours is worth knowing, never worth failing the review for.
    const mints = await mintsOf(simulated, changed, chain).catch(() => new Map<Address, MintTerms>());
    const assessment = assess(simulated, changed, explained, { now: Math.floor(Date.now() / 1000), ...context, deployments: deployed, mints });
    return { ...simulated, changes: changed, explained, deployments: deployed, assessment };
}

// The terms of every mint whose tokens an account the transaction writes holds, as each mint stands when it ends: as
// the simulation leaves one it writes, else as loaded with the transaction, else read now.
async function mintsOf(s: Simulated, changed: Changes, chain: Chain): Promise<Map<Address, MintTerms>> {
    const wanted = new Set(changed.accounts.flatMap((c) => [c.before?.token?.mint, c.after?.token?.mint]).filter((m): m is Address => m !== undefined));
    const found = new Map<Address, MaybeEncodedAccount>();
    for (const c of changed.accounts) {
        if (!wanted.has(c.address) || !c.after) continue;
        found.set(c.address, { exists: true, address: c.address, programAddress: c.after.program, lamports: lamports(c.after.lamports), data: new Uint8Array(c.after.data), executable: false, space: BigInt(c.after.space) });
    }
    for (const a of s.accounts) if (wanted.has(a.address) && !found.has(a.address)) found.set(a.address, a.state);
    const missing = [...wanted].filter((m) => !found.has(m));
    if (missing.length) (await chain.accounts(missing)).accounts.forEach((a, i) => found.set(missing[i], a));
    const terms = new Map<Address, MintTerms>();
    for (const [mint, account] of found) {
        const t = mintTerms(account);
        if (t) terms.set(mint, t);
    }
    return terms;
}
