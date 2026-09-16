/**
 * The three things the live run must get right before it is trusted with a
 * real ledger (SPEC 1 rules 1 and 3, SPEC 8).
 *
 * Thursday, Friday, Monday — with Saturday deliberately absent from the
 * scenario. This drives the real CLI, engine, controls and ledger; only the
 * market port and the clock are swapped for the fixture.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventLog } from "../../src/domain/events.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import { dryRunCli, parseScenario } from "../../src/cli/dry-run.js";
import { repoRoot } from "../helpers/engine.js";
import type { LedgerEvent } from "../../src/domain/events.js";

const SCENARIO = "test/fixtures/live/three-days.json";
const THURSDAY = "2026-04-30";
const FRIDAY = "2026-05-01";
const SATURDAY = "2026-05-02";
const MONDAY = "2026-05-04";

let outDir: string;
let events: LedgerEvent[];

/** Every instrument's open, per session, straight from the fixture. */
const opens = new Map<string, Map<string, number>>();

beforeAll(async () => {
  const scenario = parseScenario(readFileSync(join(repoRoot, SCENARIO), "utf8"), SCENARIO);
  for (const session of scenario.sessions) {
    const byTicker = new Map<string, number>();
    for (const quote of session.quotes) {
      if (quote.open !== null) byTicker.set(quote.ticker, quote.open);
    }
    opens.set(session.date, byTicker);
  }

  outDir = mkdtempSync(join(tmpdir(), "sim-live-seq-"));
  await dryRunCli({ scenarioFile: SCENARIO, outDir, repoRoot, log: () => {} });
  events = parseEventLog(readFileSync(join(outDir, "events.jsonl"), "utf8"));
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const dateOf = (event: LedgerEvent): string => event.ts.slice(0, 10);
const ofType = <T extends LedgerEvent["type"]>(type: T): Extract<LedgerEvent, { type: T }>[] =>
  events.filter((event): event is Extract<LedgerEvent, { type: T }> => event.type === type);

describe("three sessions across a weekend", () => {
  it("replays clean", () => {
    expect(verifyLedger(events).violations).toEqual([]);
  });

  it("ran exactly the three sessions, and never Saturday", () => {
    const days = [...new Set(ofType("VALUATION").map(dateOf))].sort();
    expect(days).toEqual([THURSDAY, FRIDAY, MONDAY]);
    expect(days).not.toContain(SATURDAY);
  });
});

describe("the 100 EUR seed", () => {
  it("lands once per portfolio, and only on the first session", () => {
    const seeds = ofType("DEPOSIT").filter((deposit) => deposit.amountEur === 100);
    const portfolios = [...new Set(ofType("VALUATION").map((mark) => mark.portfolio))];
    expect(portfolios.length).toBeGreaterThan(0);
    expect(seeds).toHaveLength(portfolios.length);
    for (const seed of seeds) {
      expect(dateOf(seed)).toBe(THURSDAY);
    }
    // One per portfolio, not two for one and none for another.
    expect(new Set(seeds.map((seed) => seed.portfolio)).size).toBe(portfolios.length);
  });

  it("is not repeated on the later sessions", () => {
    const later = ofType("DEPOSIT").filter((deposit) => dateOf(deposit) !== THURSDAY);
    for (const deposit of later) {
      // May's 50 EUR contribution is legitimate; a second 100 EUR seed is not.
      expect(deposit.amountEur).not.toBe(100);
    }
  });

  it("credits May's contribution on the Friday, the month's first session", () => {
    const monthly = ofType("DEPOSIT").filter((deposit) => deposit.amountEur === 50);
    expect(monthly.length).toBeGreaterThan(0);
    for (const deposit of monthly) {
      expect(dateOf(deposit)).toBe(FRIDAY);
    }
  });
});

describe("no look-ahead: every fill uses the next session's open", () => {
  it("fills at least one order, or this suite proves nothing", () => {
    expect(ofType("ORDER_FILLED").length).toBeGreaterThan(0);
  });

  it("prices every fill at the open of the session it filled in", () => {
    for (const fill of ofType("ORDER_FILLED")) {
      const open = opens.get(dateOf(fill))?.get(fill.ticker);
      expect(open, `no open for ${fill.ticker} on ${dateOf(fill)}`).toBeDefined();
      expect(fill.priceLocal, `${fill.ticker} on ${dateOf(fill)}`).toBe(open);
    }
  });

  it("never fills at a price from the session that decided the order", () => {
    const placed = new Map(ofType("ORDER_PLACED").map((order) => [order.id, order]));
    for (const fill of ofType("ORDER_FILLED")) {
      const order = placed.get(fill.orderId);
      expect(order, `fill ${fill.id} has no order`).toBeDefined();
      const decidedOn = dateOf(order!);
      expect(dateOf(fill) > decidedOn, `${fill.ticker} filled on its own decision day`).toBe(true);
      // The decisive check: the price must not be one the agent could see.
      const visible = opens.get(decidedOn)?.get(fill.ticker);
      expect(fill.priceLocal).not.toBe(visible);
    }
  });
});

describe("a Friday order fills on Monday", () => {
  it("queues orders on the Friday", () => {
    const friday = ofType("ORDER_PLACED").filter((order) => dateOf(order) === FRIDAY);
    expect(friday.length).toBeGreaterThan(0);
  });

  it("fills them at Monday's open, not Saturday's and not Friday's", () => {
    const fridayOrders = new Set(
      ofType("ORDER_PLACED").filter((order) => dateOf(order) === FRIDAY).map((order) => order.id),
    );
    const fills = ofType("ORDER_FILLED").filter((fill) => fridayOrders.has(fill.orderId));
    expect(fills.length).toBe(fridayOrders.size);

    for (const fill of fills) {
      expect(dateOf(fill)).toBe(MONDAY);
      expect(fill.priceLocal).toBe(opens.get(MONDAY)?.get(fill.ticker));
      expect(fill.priceLocal).not.toBe(opens.get(FRIDAY)?.get(fill.ticker));
    }
  });

  it("writes nothing at all on the Saturday", () => {
    expect(events.filter((event) => dateOf(event) === SATURDAY)).toEqual([]);
  });
});
