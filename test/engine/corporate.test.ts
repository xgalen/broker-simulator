/**
 * Corporate actions (SPEC 8 step 2).
 *
 * Dividends credit cash net of the configured withholding, splits multiply the
 * held quantity. The interesting cases are the boundaries: an action on
 * something the portfolio does not hold, an action already applied, and one
 * that arrives while the run was skipping for a data failure.
 */
import { describe, expect, it } from "vitest";
import { actionWindow, applyCorporateActions } from "../../src/engine/corporate.js";
import type { CorporateAction } from "../../src/data/port.js";
import {
  deposit,
  filled,
  liveSimulation,
  mark,
  placed,
  pricesWith,
  stateFrom,
} from "../helpers/engine.js";

const simulation = liveSimulation();
const SESSION = "2026-02-10";

const prices = pricesWith(
  SESSION,
  [
    { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
    { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
  ],
  { eurusd: 1.085 },
);

/** 10 shares of VWRL.AS (EUR) and 4 of AAPL (USD). */
const held = stateFrom("dca", [
  deposit("dca", "2026-01-05", 3000),
  placed("dca", "2026-01-06", { ticker: "VWRL.AS", side: "buy", targetEur: 1200 }),
  filled("dca", "2026-01-07", {
    orderId: "2026-01-06/dca/ord/1",
    ticker: "VWRL.AS",
    side: "buy",
    qty: 10,
    priceLocal: 117.0,
  }),
  placed("dca", "2026-01-08", { ticker: "AAPL", side: "buy", targetEur: 900, sequence: 2 }),
  filled("dca", "2026-01-09", {
    orderId: "2026-01-08/dca/ord/2",
    ticker: "AAPL",
    side: "buy",
    qty: 4,
    priceLocal: 238.0,
    currency: "USD",
    fxRate: 1.085,
    sequence: 2,
  }),
  mark("dca", "2026-02-09", { cashEur: 900 }),
]);

function dividend(ticker: string, perShare: number, currency: string): CorporateAction {
  return { ticker, date: SESSION, kind: "dividend", amountLocal: perShare, currency, ratio: null };
}

function split(ticker: string, ratio: number): CorporateAction {
  return { ticker, date: SESSION, kind: "split", amountLocal: null, currency: null, ratio };
}

describe("dividends", () => {
  it("pays on the quantity held and withholds the configured percentage", () => {
    const result = applyCorporateActions(held, [dividend("VWRL.AS", 0.8, "EUR")], prices, simulation);
    const paid = result.dividends[0];
    expect(paid?.amountLocal).toBe(8); // 10 shares x 0.80
    expect(paid?.withholdingEur).toBeCloseTo(1.2, 2); // 15% of 8 EUR
    expect(paid?.netEur).toBeCloseTo(6.8, 2);
  });

  it("converts a USD distribution through EURUSD=X before withholding", () => {
    const result = applyCorporateActions(held, [dividend("AAPL", 0.25, "USD")], prices, simulation);
    const paid = result.dividends[0];
    expect(paid?.amountLocal).toBe(1); // 4 shares x 0.25 USD
    expect(paid?.fxRate).toBe(1.085);
    // 1 USD / 1.085 = 0.9217 EUR gross, 15% withheld.
    expect(paid?.withholdingEur).toBeCloseTo(0.14, 2);
    expect(paid?.netEur).toBeCloseTo(0.78, 2);
  });

  it("ignores an action on an instrument the portfolio does not hold", () => {
    const result = applyCorporateActions(held, [dividend("SAP.DE", 2.5, "EUR")], prices, simulation);
    expect(result.dividends).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("reports rather than drops a dividend it cannot convert", () => {
    // A held position paying in a currency with no quoted rate is a cash
    // figure that would quietly stop matching reality.
    const result = applyCorporateActions(
      held,
      [dividend("AAPL", 0.25, "CHF")],
      prices,
      simulation,
    );
    expect(result.dividends).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no CHF rate/);
  });

  it("rounds the amount so the ledger carries no float noise", () => {
    const result = applyCorporateActions(held, [dividend("VWRL.AS", 0.071, "EUR")], prices, simulation);
    const amount = result.dividends[0]?.amountLocal ?? 0;
    expect(amount).toBe(Number(amount.toFixed(6)));
  });
});

describe("splits", () => {
  it("carries the ratio through as shares-after-per-share-before", () => {
    const result = applyCorporateActions(held, [split("AAPL", 4)], prices, simulation);
    expect(result.splits).toEqual([{ ticker: "AAPL", ratio: 4 }]);
  });

  it("pays a same-window dividend on the pre-split count, then splits", () => {
    const result = applyCorporateActions(
      held,
      [split("VWRL.AS", 2), dividend("VWRL.AS", 0.5, "EUR")],
      prices,
      simulation,
    );
    // The dividend is ordered first and paid on the 10 shares held through it.
    expect(result.dividends[0]?.amountLocal).toBe(5);
    expect(result.splits[0]?.ratio).toBe(2);
  });

  it("refuses a split with no usable ratio rather than multiplying by nothing", () => {
    const result = applyCorporateActions(
      held,
      [{ ticker: "AAPL", date: SESSION, kind: "split", amountLocal: null, currency: null, ratio: 0 }],
      prices,
      simulation,
    );
    expect(result.splits).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no usable ratio/);
  });
});

describe("actionWindow", () => {
  it("opens the day after the last mark, so nothing is applied twice", () => {
    expect(actionWindow(held, SESSION)).toEqual({ from: "2026-02-10", to: "2026-02-10" });
  });

  it("widens to cover sessions the run skipped", () => {
    const stale = stateFrom("dca", [
      deposit("dca", "2026-01-05", 100),
      mark("dca", "2026-02-04", { cashEur: 100 }),
    ]);
    // Four days of SKIPPED runs: the dividends in between are still owed.
    expect(actionWindow(stale, SESSION)).toEqual({ from: "2026-02-05", to: SESSION });
  });

  it("collapses to the session before the first mark, when nothing is held", () => {
    expect(actionWindow(stateFrom("dca", []), SESSION)).toEqual({
      from: SESSION,
      to: SESSION,
    });
  });
});
