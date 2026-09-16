/**
 * `rebuild-state` — regenerate `state.json` from `events.jsonl` (SPEC 1.3).
 *
 * "`state.json` is a cache that can always be rebuilt from `events.jsonl`."
 * SPEC 14 makes that testable: "Deleting `state.json` and rebuilding from
 * `events.jsonl` produces a byte-identical file."
 *
 * `--check` asserts exactly that without writing, which is what CI runs. If it
 * ever fails, the committed cache and the log disagree and the log wins.
 */
import { replay } from "../domain/replay.js";
import { buildState, serializeState } from "../domain/state.js";
import { readEvents, readState, writeState } from "../engine/ledger.js";
import type { SimulationConfig } from "../engine/config.js";
import type { Universe } from "../data/universe.js";

export interface RebuildOptions {
  readonly dataRoot: string;
  readonly universe: Universe;
  readonly simulation: SimulationConfig;
  /** Compare against the committed file instead of overwriting it. */
  readonly check?: boolean;
  readonly log?: (line: string) => void;
}

export interface RebuildResult {
  readonly ok: boolean;
  readonly events: number;
  readonly identical: boolean | null;
}

export function rebuildStateCli(options: RebuildOptions): RebuildResult {
  const log = options.log ?? ((line: string) => console.log(line));
  const events = readEvents(options.dataRoot);
  const result = replay(events, { universe: options.universe.tickers });
  const metrics = { riskFreeAnnual: options.simulation.metrics.riskFreeAnnual };

  if (options.check === true) {
    const rebuilt = serializeState(buildState(result, metrics));
    const committed = readState(options.dataRoot);

    // An empty ledger with no cache is consistent, not broken. It is what a
    // fresh repository looks like, and what a day of SKIPPED runs leaves
    // behind (SPEC 1.5), and CI must not go red on either.
    if (events.length === 0 && committed === null) {
      log("rebuild-state --check: no events and no state.json; nothing to compare");
      return { ok: true, events: 0, identical: null };
    }

    const identical = committed !== null && committed === rebuilt;
    log(
      identical
        ? `rebuild-state --check: state.json matches a fresh replay of ${events.length} event(s)`
        : committed === null
          ? `rebuild-state --check: ${events.length} event(s) in the log but no state.json committed`
          : "rebuild-state --check: state.json differs from a fresh replay of the log",
    );
    return { ok: identical, events: events.length, identical };
  }

  writeState(options.dataRoot, result, metrics);
  log(`rebuild-state: state.json rebuilt from ${events.length} event(s)`);
  return { ok: true, events: events.length, identical: null };
}
