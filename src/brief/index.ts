/**
 * The daily market brief (SPEC 12, phase 3).
 *
 * One document, built once per run by deterministic code and handed unchanged
 * to every agent (SPEC 1.4). `build.ts` composes it from the data-layer ports,
 * `hash.ts` seals it, `store.ts` commits it.
 */
export * from "./build.js";
export * from "./hash.js";
export * from "./headlines.js";
export * from "./returns.js";
export * from "./store.js";
export * from "./types.js";
