// Otus's transaction review for Solana, on @solana/kit. What a wallet, a bot or an agent needs to know what a
// transaction does before signing it, and to sign it guarded. Each module is also exported on its own path
// ('@otus-wallet/sdk/review/assess', '@otus-wallet/sdk/programs/squads'…), with everything this file leaves out.

// The network: a Chain over any Solana JSON-RPC endpoint.
export { rpcChain, type Chain, type Simulation, type Status } from './chain.ts';
export { rpcAt, rpcFrom, type OtusRpc } from './rpc.ts';

// A transaction reviewed: decoded, its lookup tables resolved, simulated, explained and assessed.
export { review, type Review } from './review/review.ts';
export { decode, type Decoded, type Message } from './review/decode.ts';
export { assess, type Assessment, type Context, type Finding, type Level, type Verdict } from './review/assess.ts';
export { changes, type Change, type Changes } from './review/changes.ts';
export { explain, type Explained } from './review/explain.ts';
export { story, type Effect, type Names, type Story } from './review/effects.ts';
export { hostedOn, lookalike, programsCalled } from './review/sites.ts';
export { isData, messageFindings } from './review/message.ts';
export { squadsTold, type ProposalTold } from './review/squads.ts';

// Prepared to sign: guards on your accounts (Lighthouse), a compute limit and a priority fee.
export { prepare, type Prepared } from './prepare/prepare.ts';

// Instructions told by the IDL their program publishes onchain.
export { toldByIdl, type IdlInstruction } from './idl/idl.ts';

// A wallet's history, a page at a time (Helius' getTransactionsForAddress), each transaction in short and in words.
export { historyPage, NoHistory, type Landed, type Page } from './activity/history.ts';
export { summarize, type Activity, type Held, type Told } from './activity/summary.ts';
export { rows, text, type Detail, type Naming, type Part, type Row, type RowIcon, type RowTone } from './activity/words.ts';
export { dust, harmless, type Dust, type DustContext } from './activity/dust.ts';

// Who besides a wallet can move, burn, freeze or close what it holds.
export { access, delegatesGiven, grantsOf, nonceOf, waitingOn, type Access, type Grant, type Waiting } from './access/access.ts';

export { Refused } from './errors.ts';

// A deployed program, as the upgradeable loader keeps it, and its upgrade authority when that is a Squads multisig.
export { headOf, HEAD_SIZE, programDataAddress, programDataOf, type Head } from './programs/deployed.ts';
export { multisigOf, SQUADS_V3, squadsAccountsIn, type Member, type Multisig } from './programs/multisig.ts';
export { accountByIdl } from './idl/account.ts';
