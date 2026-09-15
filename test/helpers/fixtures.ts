/**
 * Test-side file I/O. The domain never touches the filesystem, so fixtures are
 * read here and handed to the pure functions as text or plain objects.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEventLog, type LedgerEvent } from "../../src/domain/events.js";
import type { BriefPriceSnapshot } from "../../src/domain/lookahead.js";
import type { Ticker } from "../../src/domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

export function fixtureText(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

export function fixtureEvents(name: string): LedgerEvent[] {
  return parseEventLog(fixtureText(name));
}

/** The shape of a committed `data/briefs/YYYY-MM-DD.json`, trimmed to prices. */
interface BriefFixture {
  readonly briefHash: string;
  readonly date: string;
  readonly decisionIds: readonly string[];
  readonly instruments: Record<
    string,
    { open: number; high: number; low: number; close: number; previousClose: number }
  >;
}

/**
 * Load the brief fixtures and index them by the decisions taken on them, the
 * way `data/decisions/` will (each decision record stores its brief hash).
 */
export function briefResolver(
  names: readonly string[],
): (decisionId: string) => BriefPriceSnapshot | undefined {
  const byDecision = new Map<string, BriefPriceSnapshot>();
  for (const name of names) {
    const brief = JSON.parse(fixtureText(name)) as BriefFixture;
    const pricesByTicker = new Map<Ticker, number[]>();
    for (const [ticker, bar] of Object.entries(brief.instruments)) {
      pricesByTicker.set(ticker, [
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.previousClose,
      ]);
    }
    const snapshot: BriefPriceSnapshot = {
      briefHash: brief.briefHash,
      date: brief.date,
      pricesByTicker,
    };
    for (const decisionId of brief.decisionIds) {
      byDecision.set(decisionId, snapshot);
    }
  }
  return (decisionId) => byDecision.get(decisionId);
}

/** The whitelist from `config/universe.yaml`, as a fixture. */
export const UNIVERSE: readonly Ticker[] = [
  "ASML.AS",
  "SAP.DE",
  "AAPL",
  "MSFT",
  "IWDA.AS",
  "VWCE.DE",
];
