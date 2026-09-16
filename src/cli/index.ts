/**
 * The command line (SPEC 3, SPEC 12 phase 4).
 *
 * `main.ts` is the executable; everything else here is a function the tests
 * call directly, so the commands are covered without spawning a process.
 */
export * from "./args.js";
export * from "./context.js";
export * from "./dry-run.js";
export * from "./rebuild-state.js";
export * from "./run-daily.js";
export * from "./verify.js";
