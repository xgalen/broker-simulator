/**
 * The domain core (SPEC 12, phase 1): events, replay, valuation, metrics.
 *
 * Everything under `src/domain` is pure — no network, no filesystem, no
 * reads of the system clock. Anything that needs "now" takes a `Clock`.
 */
export * from "./clock.js";
export * from "./events.js";
export * from "./invariants.js";
export * from "./lookahead.js";
export * from "./metrics.js";
export * from "./money.js";
export * from "./replay.js";
export * from "./state.js";
export * from "./types.js";
export * from "./valuation.js";
export * from "./violations.js";
