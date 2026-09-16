/**
 * The execution engine (SPEC 8, SPEC 12 phase 4).
 *
 * Order validation, fill simulation, corporate actions, monthly contributions
 * and the daily valuation mark — the whole path from "a decider wants
 * something" to "the ledger says what happened".
 *
 * The engine computes no balances of its own: after every event it writes it
 * re-derives the portfolio by replaying the log (SPEC 1.3), so there is one
 * implementation of what a fill does to cash and `pnpm verify` checks that one.
 */
export * from "./config.js";
export * from "./corporate.js";
export * from "./decision.js";
export * from "./deposits.js";
export * from "./fills.js";
export * from "./ids.js";
export * from "./ledger.js";
export * from "./pricing.js";
export * from "./run.js";
export * from "./validate.js";
