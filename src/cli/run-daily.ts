/**
 * `run-daily` — one session, end to end (SPEC 8, SPEC 13).
 *
 * The workflow calls this once a day after the US close. It fetches, decides,
 * writes and commits; it never throws on a data failure, because SPEC 1.5 says
 * a bad fetch "logs a SKIPPED event for every portfolio and exits 0" — an
 * unattended job that exits non-zero on a Yahoo hiccup produces a red repo and
 * a habit of ignoring red repos.
 */
import type { Clock } from "../domain/clock.js";
import { replay } from "../domain/replay.js";
import { writeBrief, writePrices } from "../brief/store.js";
import { createControls } from "../controls/index.js";
import type { Decider } from "../engine/decision.js";
import {
  appendEvents,
  readEvents,
  writeDecisionRecord,
  writeState,
} from "../engine/ledger.js";
import { runDaily, type RunDailyResult } from "../engine/run.js";
import type { LoadedConfig } from "./context.js";
import type { MarketDataPort } from "../data/port.js";
import type { FeedReaderPort } from "../data/rss.js";
import type { IsoDate } from "../domain/types.js";

export interface RunDailyCliOptions {
  readonly config: LoadedConfig;
  readonly market: MarketDataPort;
  readonly feedReader: FeedReaderPort;
  readonly clock: Clock;
  readonly dataRoot: string;
  readonly sessionDate?: IsoDate;
  /** Compute everything and print it, but commit nothing to `data/`. */
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
}

export interface RunDailyCliResult {
  readonly run: RunDailyResult;
  readonly written: readonly string[];
  /** SPEC 13's commit subject: `sim: 2026-09-16 (3 trades, 3 holds)`. */
  readonly commitMessage: string;
}

/**
 * Drive one session and persist it.
 *
 * Write order matters if the job dies halfway: the brief and the decision
 * records go down first, then the events, then `state.json`. A crash before
 * the events land leaves evidence of a session that did not happen, which is
 * recoverable; a crash after them with no evidence would not be.
 */
export async function runDailyCli(
  options: RunDailyCliOptions,
): Promise<RunDailyCliResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const { config } = options;

  // Phase 4 runs the controls only. Phases 5-6 add the agents to this map;
  // nothing else in the daily sequence has to change when they do.
  const deciders: ReadonlyMap<string, Decider> = createControls(config.portfolios.all);
  for (const portfolio of config.portfolios.active) {
    if (!deciders.has(portfolio.key)) {
      throw new Error(
        `"${portfolio.key}" is enabled but has no decider; agents arrive in phase 5 (SPEC 12)`,
      );
    }
  }

  const history = readEvents(options.dataRoot);
  const run = await runDaily({
    universe: config.universe,
    portfolios: config.portfolios,
    simulation: config.simulation,
    feeds: config.feeds,
    market: options.market,
    feedReader: options.feedReader,
    clock: options.clock,
    deciders,
    history,
    ...(options.sessionDate ? { sessionDate: options.sessionDate } : {}),
  });

  const written: string[] = [];
  const commitMessage = describeRun(run);

  for (const note of run.notes) log(`  note: ${note}`);

  if (options.dryRun === true) {
    log(`${commitMessage} (dry run: nothing written)`);
    return { run, written, commitMessage };
  }

  if (run.brief !== null && run.prices !== null) {
    written.push(writePrices(options.dataRoot, run.prices));
    written.push(writeBrief(options.dataRoot, run.brief));
  }
  for (const record of run.decisions) {
    written.push(writeDecisionRecord(options.dataRoot, record));
  }
  if (run.events.length > 0) {
    appendEvents(options.dataRoot, run.events);
    written.push(`${run.events.length} event(s)`);
  }

  // Rebuilt from the whole log rather than patched, so `state.json` is always
  // exactly what a fresh replay would produce (SPEC 14).
  if (run.events.length > 0) {
    const events = readEvents(options.dataRoot);
    writeState(options.dataRoot, replay(events, { universe: config.universe.tickers }), {
      riskFreeAnnual: config.simulation.metrics.riskFreeAnnual,
    });
    written.push("state.json");
  }

  log(commitMessage);
  return { run, written, commitMessage };
}

/** SPEC 13: "a message like `sim: 2026-09-16 (3 trades, 3 holds)`". */
export function describeRun(run: RunDailyResult): string {
  if (run.status === "skipped") {
    return `sim: skipped (${run.skipReason ?? "unknown"})`;
  }
  if (run.status === "no_new_session") {
    return `sim: ${run.sessionDate ?? "?"} (no new close, market shut)`;
  }
  if (run.status === "already_recorded") {
    return `sim: ${run.sessionDate ?? "?"} (already recorded)`;
  }

  const trades = run.portfolios.reduce((total, p) => total + p.placed, 0);
  const holds = run.portfolios.filter((p) => p.held).length;
  const fills = run.portfolios.reduce((total, p) => total + p.filled, 0);
  const rejects = run.portfolios.reduce((total, p) => total + p.rejected, 0);

  const parts = [`${trades} trade${trades === 1 ? "" : "s"}`, `${holds} hold${holds === 1 ? "" : "s"}`];
  if (fills > 0) parts.push(`${fills} fill${fills === 1 ? "" : "s"}`);
  if (rejects > 0) parts.push(`${rejects} rejected`);

  return `sim: ${run.sessionDate ?? "?"} (${parts.join(", ")})`;
}
