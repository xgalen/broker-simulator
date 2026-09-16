/**
 * The data layer (SPEC 12, phase 2): adapters, caching, rate limiting and
 * failure handling.
 *
 * `port.ts` is the interface the rest of the system depends on. Only
 * `yahooClient.ts` imports `yahoo-finance2`, and a structural test enforces
 * that, so every layer above can be exercised with the network unplugged.
 */
export * from "./cache.js";
export * from "./fixtures.js";
export * from "./freshness.js";
export * from "./port.js";
export * from "./resilience.js";
export * from "./skip.js";
export * from "./universe.js";
export * from "./yahoo.js";
export * from "./yahooClient.js";
