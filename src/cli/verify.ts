/**
 * `verify` — replay the log and assert every invariant (SPEC 4, SPEC 14).
 *
 * "`pnpm verify` replays the whole event log and asserts: cash never negative,
 * quantity never negative, no position outside the whitelist, every
 * `ORDER_FILLED` has a preceding `ORDER_PLACED`, and every fill date is
 * strictly after its decision date."
 *
 * On top of that it runs the look-ahead check (SPEC 1.1) against the committed
 * briefs, which is the one invariant that cannot be checked from the ledger
 * alone: it needs the document each decision actually read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatViolations, verifyLedger } from "../domain/invariants.js";
import { checkLookAhead, type BriefPriceSnapshot } from "../domain/lookahead.js";
import type { LedgerEvent } from "../domain/events.js";
import type { DecisionId, Ticker } from "../domain/types.js";
import { BriefSchema } from "../brief/types.js";
import { DecisionRecordSchema } from "../engine/decision.js";
import { readEvents } from "../engine/ledger.js";
import type { Universe } from "../data/universe.js";

export interface VerifyOptions {
  readonly dataRoot: string;
  readonly universe: Universe;
  readonly log?: (line: string) => void;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly events: number;
  readonly invariantViolations: number;
  readonly lookAheadViolations: number;
  readonly lines: readonly string[];
}

export function verifyCli(options: VerifyOptions): VerifyResult {
  const log = options.log ?? ((line: string) => console.log(line));
  const events = readEvents(options.dataRoot);
  const lines: string[] = [];

  const report = verifyLedger(events, { universe: options.universe.tickers });
  if (!report.ok) lines.push(formatViolations(report.violations));

  const lookAhead = checkLookAhead(events, buildBriefResolver(options.dataRoot), {
    // A ledger with no decision records yet — a fresh repo, or a log of pure
    // SKIPPED days — should not fail for want of evidence it never had.
    requireBrief: hasDecisionRecords(options.dataRoot),
  });
  for (const violation of lookAhead) {
    lines.push(`${violation.code} [${violation.portfolio}] ${violation.message}`);
  }

  const ok = report.ok && lookAhead.length === 0;
  log(
    ok
      ? `verify: ${events.length} event(s), ${report.result.portfolios.size} portfolio(s), all invariants hold`
      : `verify: ${report.violations.length} invariant violation(s), ${lookAhead.length} look-ahead violation(s)`,
  );
  for (const line of lines) log(line);

  return {
    ok,
    events: events.length,
    invariantViolations: report.violations.length,
    lookAheadViolations: lookAhead.length,
    lines,
  };
}

function decisionsDir(dataRoot: string): string {
  return join(dataRoot, "decisions");
}

function hasDecisionRecords(dataRoot: string): boolean {
  const dir = decisionsDir(dataRoot);
  return existsSync(dir) && readdirSync(dir).length > 0;
}

/**
 * Resolve every decision to the brief it read, via the committed records.
 *
 * `data/decisions/<date>/<portfolio>.json` stores the brief hash (SPEC 6), and
 * `data/briefs/<date>.json` stores the prices. Following that chain is the only
 * honest way to ask "could the agent see this price": going straight to the
 * brief for the fill's own date would compare against a document the decision
 * never read.
 */
export function buildBriefResolver(
  dataRoot: string,
): (decisionId: DecisionId) => BriefPriceSnapshot | undefined {
  const byDecision = new Map<DecisionId, BriefPriceSnapshot>();
  const briefCache = new Map<string, BriefPriceSnapshot | null>();
  const dir = decisionsDir(dataRoot);
  if (!existsSync(dir)) return () => undefined;

  for (const day of readdirSync(dir).sort()) {
    const dayDir = join(dir, day);
    for (const file of readdirSync(dayDir).filter((name) => name.endsWith(".json"))) {
      const parsed = DecisionRecordSchema.safeParse(
        JSON.parse(readFileSync(join(dayDir, file), "utf8")),
      );
      if (!parsed.success) continue;
      const record = parsed.data;
      const snapshot = loadBriefPrices(dataRoot, record.date, briefCache);
      if (snapshot !== null && snapshot.briefHash === record.briefHash) {
        byDecision.set(record.decisionId, snapshot);
      }
    }
  }

  return (decisionId) => byDecision.get(decisionId);
}

/**
 * Every price a brief printed for an instrument.
 *
 * All five OHLC-ish fields, because SPEC 1.1 is about any price the agent could
 * see, not only the one it would most plausibly have traded at.
 */
function loadBriefPrices(
  dataRoot: string,
  date: string,
  cache: Map<string, BriefPriceSnapshot | null>,
): BriefPriceSnapshot | null {
  const cached = cache.get(date);
  if (cached !== undefined) return cached;

  const file = join(dataRoot, "briefs", `${date}.json`);
  if (!existsSync(file)) {
    cache.set(date, null);
    return null;
  }
  const parsed = BriefSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    cache.set(date, null);
    return null;
  }

  const brief = parsed.data;
  const pricesByTicker = new Map<Ticker, number[]>();
  for (const [ticker, instrument] of Object.entries(brief.instruments)) {
    const prices = [
      instrument.open,
      instrument.high,
      instrument.low,
      instrument.close,
      instrument.previousClose,
    ].filter((price): price is number => price !== null);
    pricesByTicker.set(ticker, prices);
  }

  const snapshot: BriefPriceSnapshot = {
    briefHash: brief.briefHash,
    date: brief.date,
    pricesByTicker,
  };
  cache.set(date, snapshot);
  return snapshot;
}

/** Exported for the dry-run, which verifies its own scratch ledger. */
export function verifyEvents(
  events: readonly LedgerEvent[],
  universe: Universe,
): { readonly ok: boolean; readonly report: string } {
  const report = verifyLedger(events, { universe: universe.tickers });
  return { ok: report.ok, report: formatViolations(report.violations) };
}
