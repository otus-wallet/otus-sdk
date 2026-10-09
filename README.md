# @otus-wallet/sdk

The transaction review behind [Otus Wallet](https://github.com/otus-wallet/otus-app), on
[@solana/kit](https://github.com/anza-xyz/kit): know what a Solana transaction does before signing it, and sign it
guarded. For wallets, bots and agents alike.

- Decodes any transaction: legacy, v0 and v1, its lookup tables resolved.
- Simulates it, and reads every account it can write, before and after.
- Tells each program and instruction in plain words: Solana's own programs, Squads v4 proposals, and any program by
  the IDL it publishes onchain.
- A verdict with its findings, each with a stable code: unlimited approvals, owner changes, unknown programs, sites
  and addresses that imitate others, and more.
- Guards: Lighthouse assertions that make the transaction fail onchain if your accounts would end up worse than
  reviewed.
- A wallet's history, each transaction in short (Helius' `getTransactionsForAddress`).
- Who besides a wallet can move what it holds: delegates and close authorities on its token accounts, what its
  tokens' issuers can do, and signed transactions still waiting on a durable nonce.

## Install

```sh
npm install @otus-wallet/sdk
```

## Use

```ts
import { prepare, review, rpcAt, rpcChain } from '@otus-wallet/sdk';

const chain = rpcChain(rpcAt('https://your-rpc.example'));

// `bytes`: the wire transaction; `wallet`: the account asked to sign it.
const r = await review(bytes, { wallet, signedBefore: null, host: 'app.example.com' }, chain);
r.assessment.verdict;  // 'ok' | 'warn' | 'danger'
r.assessment.findings; // [{ level, code, text, note }], worst first
r.changes;             // the fee, and every account it can write, before and after

const p = await prepare(r, wallet, chain);
p.bytes; // the transaction to sign: guarded when the wallet alone signs it
p.holds; // the guards it carries
```

`review` throws `Refused` for a transaction that cannot be signed at all. Each module is also exported on its own
path, such as `@otus-wallet/sdk/programs/squads`.

## Develop

```sh
npm ci
npm test
npm run typecheck
npm run build
```

## License

[Apache-2.0](LICENSE)
