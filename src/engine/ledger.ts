/**
 * Reading and writing `data/` (SPEC 3).
 *
 * The I/O half of the engine, kept apart from `run.ts` so the daily sequence
 * stays a function from a log to a log and can be driven a hundred times in a
 * unit test without a filesystem.
 *
 * `events.jsonl` is append-only (SPEC 1.3). There is no update path in this
 * module and no delete path, on purpose: the only supported way to change what
 * the ledger says is to append an event that says something new.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEventLog, type LedgerEvent } from "../domain/events.js";
import type { ReplayResult } from "../domain/replay.js";
import type { MetricsOptions } from "../domain/metrics.js";
import { buildState, serializeState, type StateFile } from "../domain/state.js";
import type { IsoDate, PortfolioId } from "../domain/types.js";
import { canonicalize } from "../brief/hash.js";
import {
  decisionRecordPath,
  DecisionRecordSchema,
  type DecisionRecord,
} from "./decision.js";

export function eventsPath(dataRoot: string): string {
  return join(dataRoot, "events.jsonl");
}

export function statePath(dataRoot: string): string {
  return join(dataRoot, "state.json");
}

export function decisionPath(
  dataRoot: string,
  date: IsoDate,
  portfolio: PortfolioId,
): string {
  return join(dataRoot, decisionRecordPath(date, portfolio));
}

/**
 * One event, as one line.
 *
 * Keys are sorted, which is what makes a rerun of a session produce the same
 * bytes whatever order the engine happened to build the object in. `JSON` on
 * one line rather than pretty-printed: this file is appended to daily and read
 * by streaming, and a diff of it should show added lines, not reindented ones.
 */
export function serializeEvent(event: LedgerEvent): string {
  return JSON.stringify(canonicalize(event));
}

/** The whole log, parsed and validated. Returns `[]` when there is none yet. */
export function readEvents(dataRoot: string): LedgerEvent[] {
  const file = eventsPath(dataRoot);
  if (!existsSync(file)) return [];
  return parseEventLog(readFileSync(file, "utf8"));
}

/**
 * Append events to the log.
 *
 * Appending rather than rewriting is not an optimisation: a rewrite is a path
 * by which the past can change, and SPEC 1.3 does not allow one. A crash
 * mid-append leaves a truncated final line, which `parseEventLog` reports as a
 * parse error on a known line number rather than silently accepting.
 */
export function appendEvents(dataRoot: string, events: readonly LedgerEvent[]): number {
  if (events.length === 0) return 0;
  const file = eventsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${events.map(serializeEvent).join("\n")}\n`, "utf8");
  return events.length;
}

/**
 * Rebuild `state.json` from a replay.
 *
 * SPEC 14: "Deleting `state.json` and rebuilding from `events.jsonl` produces
 * a byte-identical file." Nothing here stamps a time or a version of anything
 * outside the log, which is what makes that true.
 */
export function writeState(
  dataRoot: string,
  result: ReplayResult,
  options: MetricsOptions = {},
): StateFile {
  const state = buildState(result, options);
  const file = statePath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeState(state), "utf8");
  return state;
}

export function readState(dataRoot: string): string | null {
  const file = statePath(dataRoot);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Write one decision record (SPEC 3, SPEC 14: "Every run in `data/decisions/`
 * has a rationale, including holds").
 *
 * Canonical key order, like everything else committed, so a rerun of a session
 * produces no diff.
 */
export function writeDecisionRecord(dataRoot: string, record: DecisionRecord): string {
  const file = decisionPath(dataRoot, record.date, record.portfolio);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(canonicalize(record), null, 2)}\n`, "utf8");
  return file;
}

export function readDecisionRecord(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The decision records a portfolio wrote in the `days` before `sessionDate`,
 * newest first (SPEC 7: "its own decision history for the last 30 days —
 * rationales included, so it can be consistent with or deliberately contradict
 * its past self").
 *
 * Strictly *before* the session: the record for today has not been written yet
 * when the agent is asked to decide, and a window that included it would be a
 * window that could show an agent its own answer.
 *
 * A record that fails to parse is skipped rather than fatal. The history is an
 * input to a prompt, not to a balance, and one corrupt file from an older
 * schema must not stop tonight's run.
 */
export function readRecentDecisions(
  dataRoot: string,
  portfolio: PortfolioId,
  sessionDate: IsoDate,
  days: number,
): readonly DecisionRecord[] {
  const root = join(dataRoot, "decisions");
  if (days <= 0 || !existsSync(root)) return [];

  const from = shiftIsoDate(sessionDate, -days);
  const dates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((date) => date >= from && date < sessionDate)
    .sort()
    .reverse();

  const records: DecisionRecord[] = [];
  for (const date of dates) {
    const file = decisionPath(dataRoot, date, portfolio);
    if (!existsSync(file)) continue;
    try {
      const parsed = DecisionRecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) records.push(parsed.data);
    } catch {
      continue;
    }
  }
  return records;
}

/** Shift a calendar date by whole days, in UTC. Reads no clock. */
function shiftIsoDate(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
