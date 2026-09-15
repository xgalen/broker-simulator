import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/domain/clock.js";
import { replay } from "../src/domain/replay.js";
import {
  buildValuationPayload,
  markStaleness,
  valuePortfolio,
  valuePosition,
  type PriceQuote,
} from "../src/domain/valuation.js";
import { fixtureEvents, UNIVERSE } from "./helpers/fixtures.js";

const result = replay(fixtureEvents("ledger-clean.jsonl"), { universe: UNIVERSE });
const value = result.portfolios.get("value");
if (value === undefined) throw new Error("no value portfolio");

const quotes = new Map<string, PriceQuote>([
  ["SAP.DE", { ticker: "SAP.DE", priceLocal: 76.0, currency: "EUR", fxRate: 1 }],
]);

describe("valuation", () => {
  it("marks a portfolio at cash plus positions", () => {
    const valued = valuePortfolio(value, quotes);
    expect(valued.cashEur).toBe(44.54);
    expect(valued.marketValueEur).toBe(60.8);
    expect(valued.totalValueEur).toBe(105.34);
    expect(valued.contributedToDateEur).toBe(100);
  });

  it("agrees with the mark the engine actually wrote", () => {
    const written = value.marks.at(-1);
    expect(valuePortfolio(value, quotes).totalValueEur).toBe(
      written?.totalValueEur,
    );
  });

  it("splits unrealized P&L into price and FX, exactly (SPEC 4)", () => {
    // Bought 0.15 AAPL at 200 USD / 1.25, marked at 210 USD / 1.20.
    const midResult = replay(
      fixtureEvents("ledger-clean.jsonl").filter(
        (event) => event.ts <= "2026-09-17T20:30:03Z",
      ),
      { universe: UNIVERSE },
    );
    const mid = midResult.portfolios.get("value");
    if (mid === undefined) throw new Error("no state");
    const aapl = mid.positions.get("AAPL");
    if (aapl === undefined) throw new Error("no AAPL position");

    const valued = valuePosition(aapl, {
      ticker: "AAPL",
      priceLocal: 210.0,
      currency: "USD",
      fxRate: 1.2,
    });
    expect(valued.marketValueEur).toBe(26.25);
    expect(valued.pricePnlEur).toBe(1.2);
    expect(valued.fxPnlEur).toBe(1.05);
    // price + FX = the whole gross EUR move (26.25 - 24.00).
    expect(valued.pricePnlEur + valued.fxPnlEur).toBeCloseTo(2.25, 10);
    // All-in P&L is that move less the 1.06 it cost to get in.
    expect(valued.unrealizedPnlEur).toBe(1.19);
  });

  it("reports the cumulative FX effect, realized plus unrealized", () => {
    expect(valuePortfolio(value, quotes).fxEffectEur).toBe(3.6);
    expect(value.marks.at(-1)?.fxEffectEur).toBe(3.6);
  });

  it("reports missing quotes instead of valuing a position at zero (SPEC 1.5)", () => {
    const valued = valuePortfolio(value, new Map());
    expect(valued.missingQuotes).toEqual(["SAP.DE"]);
    expect(valued.marketValueEur).toBe(0);
  });

  it("builds the VALUATION payload the engine commits", () => {
    const payload = buildValuationPayload(valuePortfolio(value, quotes));
    expect(payload).toEqual({
      cashEur: 44.54,
      positions: [
        {
          ticker: "SAP.DE",
          qty: 0.8,
          priceLocal: 76.0,
          currency: "EUR",
          fxRate: 1,
          valueEur: 60.8,
        },
      ],
      marketValueEur: 60.8,
      fxEffectEur: 3.6,
      contributedToDateEur: 100,
    });
  });

  it("orders positions deterministically", () => {
    const midResult = replay(
      fixtureEvents("ledger-clean.jsonl").filter(
        (event) => event.ts <= "2026-09-17T20:30:03Z",
      ),
      { universe: UNIVERSE },
    );
    const mid = midResult.portfolios.get("value");
    if (mid === undefined) throw new Error("no state");
    const valued = valuePortfolio(
      mid,
      new Map([
        ["SAP.DE", { ticker: "SAP.DE", priceLocal: 152.5, currency: "EUR", fxRate: 1 }],
        ["AAPL", { ticker: "AAPL", priceLocal: 210.0, currency: "USD", fxRate: 1.2 }],
      ]),
    );
    expect(valued.positions.map((p) => p.ticker)).toEqual(["AAPL", "SAP.DE"]);
  });
});

describe("staleness (SPEC 11), against an injected clock", () => {
  it("is fresh the day after the last mark", () => {
    const staleness = markStaleness(value, fixedClock("2026-09-22T06:00:00Z"));
    expect(staleness).toEqual({
      lastMarkDate: "2026-09-21",
      ageDays: 1,
      stale: false,
    });
  });

  it("goes stale once the mark is carried forward past its window", () => {
    const staleness = markStaleness(value, fixedClock("2026-09-24T06:00:00Z"));
    expect(staleness.ageDays).toBe(3);
    expect(staleness.stale).toBe(true);
  });

  it("treats a portfolio with no mark at all as stale", () => {
    const empty = replay(fixtureEvents("ledger-orphan-fill.jsonl"));
    const state = empty.portfolios.get("orphan");
    if (state === undefined) throw new Error("no state");
    expect(markStaleness(state, fixedClock("2026-09-24T06:00:00Z"))).toEqual({
      lastMarkDate: null,
      ageDays: null,
      stale: true,
    });
  });
});
