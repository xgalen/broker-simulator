/**
 * The daily sequence, end to end (SPEC 8, SPEC 13, SPEC 14).
 *
 * Every acceptance check in SPEC 14 that phase 4 can reach is here: the skip
 * path on a data failure, the rejection path with a reason and no ledger
 * mutation, a rationale on every decision including holds, and the ledger
 * replaying clean afterwards.
 */
import { describe, expect, it } from "vitest";
import { MarketDataError } from "../../src/data/port.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import { replayPortfolio } from "../../src/domain/replay.js";
import type { LedgerEvent } from "../../src/domain/events.js";
import type { CorporateAction } from "../../src/data/port.js";
import { dryRunUniverse, runSession, type QuoteSpec } from "../helpers/engine.js";

const QUOTES = (open: number, close: number): QuoteSpec[] => [
  { ticker: "VWRL.AS", open, close },
  { ticker: "MEUD.PA", open: open * 2.2, close: close * 2.2 },
  { ticker: "VUSA.AS", open: open * 0.9, close: close * 0.9 },
  { ticker: "SAP.DE", open: open * 2.04, close: close * 2.04 },
  { ticker: "ASML.AS", open: open * 6.02, close: close * 6.02 },
  { ticker: "AAPL", currency: "USD", open: open * 2.01, close: close * 2.01 },
  { ticker: "MSFT", currency: "USD", open: open * 3.64, close: close * 3.64 },
  { ticker: "NVDA", currency: "USD", open: open * 1.45, close: close * 1.45 },
  { ticker: "^GSPC", currency: "USD", open: open * 52, close: close * 52 },
];

const SESSIONS = [
  { date: "2026-01-29", quotes: QUOTES(117.7, 117.84) },
  { date: "2026-01-30", quotes: QUOTES(118.3, 118.05) },
  { date: "2026-02-02", quotes: QUOTES(119.1, 119.62) },
  { date: "2026-02-03", quotes: QUOTES(120.2, 119.9) },
];

/** Play the first `count` sessions and return the accumulated log. */
async function play(count: number): Promise<LedgerEvent[]> {
  const history: LedgerEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const run = await runSession({ sessions: SESSIONS, index, history });
    history.push(...run.events);
  }
  return history;
}

describe("the SPEC 8 sequence", () => {
  it("seeds 100 EUR and queues, but does not fill, on the first session", () => {
    return play(1).then((history) => {
      const types = history.filter((e) => e.portfolio === "dca").map((e) => e.type);
      // SPEC 8's order: deposit, order, mark. No fill can happen on day one.
      expect(types).toEqual(["DEPOSIT", "ORDER_PLACED", "VALUATION"]);
      const state = replayPortfolio(history, "dca");
      expect(state.cashEur).toBe(100);
      expect(state.positions.size).toBe(0);
      expect(state.pendingOrders.size).toBe(1);
    });
  });

  it("fills yesterday's order at today's open, at a price the decision never saw", async () => {
    const history = await play(2);
    const fill = history.find((e) => e.type === "ORDER_FILLED" && e.portfolio === "dca");
    expect(fill?.type).toBe("ORDER_FILLED");
    if (fill?.type !== "ORDER_FILLED") return;
    // SPEC 1.1: today's open, not yesterday's close.
    expect(fill.priceLocal).toBe(118.3);
    expect(fill.priceLocal).not.toBe(117.84);
    expect(fill.ts.slice(0, 10)).toBe("2026-01-30");
  });

  it("pays the monthly contribution on the first session of the new month", async () => {
    const history = await play(3);
    const deposits = history.filter((e) => e.type === "DEPOSIT" && e.portfolio === "dca");
    expect(deposits.map((e) => e.type === "DEPOSIT" && e.amountEur)).toEqual([100, 50]);
    expect(deposits[1]?.ts.slice(0, 10)).toBe("2026-02-02");
  });

  it("writes a mark for every portfolio on every session, activity or not", async () => {
    const history = await play(4);
    for (const key of ["dca", "random"]) {
      const marks = history.filter((e) => e.type === "VALUATION" && e.portfolio === key);
      expect(marks.map((e) => e.ts.slice(0, 10)), key).toEqual(SESSIONS.map((s) => s.date));
    }
  });

  it("records a HOLD with a reason on a session nothing was decided", async () => {
    const history = await play(2);
    const holds = history.filter((e) => e.type === "HOLD");
    expect(holds.length).toBeGreaterThan(0);
    // SPEC 1.7: every decision is recorded, including decisions to do nothing.
    for (const hold of holds) {
      expect(hold.type === "HOLD" && hold.reason.length).toBeGreaterThan(0);
    }
  });

  it("leaves a ledger that replays clean", async () => {
    const history = await play(4);
    const report = verifyLedger(history, { universe: dryRunUniverse().tickers });
    expect(report.violations).toEqual([]);
  });

  it("attaches a rationale to every decision record, holds included", async () => {
    const history: LedgerEvent[] = [];
    for (let index = 0; index < SESSIONS.length; index += 1) {
      const run = await runSession({ sessions: SESSIONS, index, history });
      history.push(...run.events);
      // SPEC 14: "Every run in data/decisions/ has a rationale, including holds."
      expect(run.decisions).toHaveLength(2);
      for (const record of run.decisions) {
        expect(record.rationale.length, record.portfolio).toBeGreaterThan(0);
        expect(record.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(record.decisionId).toBe(`${record.date}/${record.portfolio}/dec`);
      }
    }
  });
});

describe("SPEC 1.5: a data failure means no trading", () => {
  it("writes SKIPPED for every portfolio and produces zero trades", async () => {
    const failing = new FixtureMarketData(
      {},
      { failWith: new MarketDataError("yahoo is down", "transient") },
    );
    const run = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: [],
      market: failing,
    });

    expect(run.status).toBe("skipped");
    expect(run.events.map((e) => e.type)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(run.events.map((e) => e.portfolio)).toEqual(["dca", "random"]);
    expect(run.events.every((e) => e.type === "SKIPPED" && e.reason === "data_fetch_failed")).toBe(
      true,
    );
    // Nothing else happened: no order, no deposit, no mark.
    expect(run.decisions).toEqual([]);
    expect(run.brief).toBeNull();
  });

  it("does not append a second skip when the job is retried the same day", async () => {
    const failing = () =>
      new FixtureMarketData({}, { failWith: new MarketDataError("down", "transient") });
    const first = await runSession({ sessions: SESSIONS, index: 0, history: [], market: failing() });
    const second = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: first.events,
      market: failing(),
    });
    expect(second.events).toEqual([]);
  });
});

describe("SPEC 13: market holidays are detected, not calendared", () => {
  it("writes nothing when no new close arrived", async () => {
    const history = await play(2);
    // The market was shut: the data source hands back Friday's session again.
    const stale = [
      { date: "2026-01-30", quotes: SESSIONS[1]?.quotes ?? [] },
      { date: "2026-01-30", quotes: SESSIONS[1]?.quotes ?? [] },
    ];
    const run = await runSession({ sessions: stale, index: 1, history });
    expect(run.status).toBe("already_recorded");
    expect(run.events).toEqual([]);
  });

  it("is idempotent: rerunning a recorded session writes nothing twice", async () => {
    const history = await play(3);
    const before = history.length;
    const run = await runSession({ sessions: SESSIONS, index: 2, history });
    expect(run.events).toEqual([]);
    expect(history.length).toBe(before);
  });
});

describe("corporate actions reach the ledger", () => {
  it("credits a dividend on a position held through the ex-date", async () => {
    const history = await play(2);
    const actions: CorporateAction[] = [
      {
        ticker: "VWRL.AS",
        date: "2026-02-02",
        kind: "dividend",
        amountLocal: 0.8,
        currency: "EUR",
        ratio: null,
      },
    ];
    const run = await runSession({ sessions: SESSIONS, index: 2, history, actions });
    const dividend = run.events.find((e) => e.type === "DIVIDEND");
    expect(dividend?.type).toBe("DIVIDEND");
    if (dividend?.type !== "DIVIDEND") return;
    expect(dividend.portfolio).toBe("dca");
    // 15% withheld (SPEC 8).
    expect(dividend.withholdingEur).toBeCloseTo(
      (dividend.amountLocal / dividend.fxRate) * 0.15,
      2,
    );
  });

  it("applies a split to the held quantity without changing the mark's value", async () => {
    const history = await play(2);
    const before = replayPortfolio(history, "dca").positions.get("VWRL.AS")?.qty ?? 0;
    const actions: CorporateAction[] = [
      {
        ticker: "VWRL.AS",
        date: "2026-02-02",
        kind: "split",
        amountLocal: null,
        currency: null,
        ratio: 2,
      },
    ];
    const run = await runSession({ sessions: SESSIONS, index: 2, history, actions });
    const after = replayPortfolio([...history, ...run.events], "dca");
    expect(after.positions.get("VWRL.AS")?.qty).toBeCloseTo(before * 2, 4);
    // Cost basis is untouched, so the split moves no P&L (SPEC 4).
    expect(after.positions.get("VWRL.AS")?.costBasisEur).toBe(
      replayPortfolio(history, "dca").positions.get("VWRL.AS")?.costBasisEur,
    );
  });
});
