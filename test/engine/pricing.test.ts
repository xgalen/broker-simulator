/**
 * Order sizing and the frictions (SPEC 8).
 *
 * The arithmetic here has to survive `replay`'s cross-checks exactly, so every
 * case below asserts the identities `replay` will later assert on the
 * committed ledger: gross = qty x price / fx, and net = gross +/- costs.
 */
import { describe, expect, it } from "vitest";
import { eurEquals, toEur } from "../../src/domain/money.js";
import { sizeBuy, sizeSell, spreadRateFor } from "../../src/engine/pricing.js";
import type { ExecutionQuote } from "../../src/engine/pricing.js";
import { liveSimulation, pricesWith } from "../helpers/engine.js";

const simulation = liveSimulation();

const EUR_QUOTE: ExecutionQuote = {
  ticker: "VWRL.AS",
  priceLocal: 118.4,
  currency: "EUR",
  fxRate: 1,
};

const USD_QUOTE: ExecutionQuote = {
  ticker: "AAPL",
  priceLocal: 238.6,
  currency: "USD",
  fxRate: 1.085,
};

function expectConsistent(
  terms: { qty: number; priceLocal: number; fxRate: number; grossEur: number; feeEur: number; fxCostEur: number; netEur: number },
  side: "buy" | "sell",
): void {
  expect(eurEquals(toEur(terms.qty * terms.priceLocal, terms.fxRate), terms.grossEur)).toBe(true);
  const expected =
    side === "buy"
      ? terms.grossEur + terms.feeEur + terms.fxCostEur
      : terms.grossEur - terms.feeEur - terms.fxCostEur;
  expect(eurEquals(expected, terms.netEur)).toBe(true);
}

describe("spread", () => {
  it("applies the FX spread to USD trades only (SPEC 8)", () => {
    expect(spreadRateFor("USD", simulation)).toBeCloseTo(0.0025, 10);
    expect(spreadRateFor("EUR", simulation)).toBe(0);
  });
});

describe("sizeBuy", () => {
  it("treats targetEur as the all-in cash outflow, fee included", () => {
    // SPEC 5 says `dca` buys "with the full contribution". A 50 EUR
    // contribution has to pay the 1 EUR fee out of itself; there is no 51st
    // euro, and an engine that added the fee on top would reject every
    // contribution-day order the control ever placed.
    const sized = sizeBuy(50, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.terms.netEur).toBeLessThanOrEqual(50);
    expect(sized.terms.feeEur).toBe(1);
    expect(sized.terms.fxCostEur).toBe(0);
    expectConsistent(sized.terms, "buy");
  });

  it("charges the spread on a USD buy and still fits the budget", () => {
    const sized = sizeBuy(50, USD_QUOTE, simulation);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.terms.netEur).toBeLessThanOrEqual(50);
    // 25bps of the gross notional.
    expect(sized.terms.fxCostEur).toBeCloseTo(sized.terms.grossEur * 0.0025, 2);
    expectConsistent(sized.terms, "buy");
  });

  it("never spends more than the budget, at any budget", () => {
    for (let budget = 6; budget <= 400; budget += 0.37) {
      for (const quote of [EUR_QUOTE, USD_QUOTE]) {
        const sized = sizeBuy(budget, quote, simulation);
        if (!sized.ok) continue;
        expect(sized.terms.netEur, `${quote.ticker} @ ${budget}`).toBeLessThanOrEqual(
          budget + 1e-9,
        );
        expectConsistent(sized.terms, "buy");
      }
    }
  });

  it("rounds the quantity to 4 decimal places (SPEC 4)", () => {
    const sized = sizeBuy(137.77, USD_QUOTE, simulation);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.terms.qty).toBe(Number(sized.terms.qty.toFixed(4)));
  });

  it("refuses a budget that cannot cover the fee", () => {
    const sized = sizeBuy(0.5, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(false);
    if (sized.ok) return;
    expect(sized.reason).toBe("insufficient_cash");
  });

  it("refuses an order whose gross falls below minOrderEur", () => {
    const sized = sizeBuy(5.5, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(false);
    if (sized.ok) return;
    expect(sized.reason).toBe("below_min_order");
  });
});

describe("sizeSell", () => {
  it("nets the fee and spread out of the proceeds", () => {
    const sized = sizeSell(60, 1, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.terms.netEur).toBeLessThan(sized.terms.grossEur);
    expectConsistent(sized.terms, "sell");
  });

  it("closes the position when the target reaches it, leaving no dust", () => {
    const sized = sizeSell(10_000, 1.2345, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.terms.qty).toBe(1.2345);
  });

  it("refuses a sell whose proceeds would not cover its own fee", () => {
    const sized = sizeSell(0.6, 0.005, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(false);
    if (sized.ok) return;
    expect(["proceeds_below_costs", "below_min_order"]).toContain(sized.reason);
  });

  it("refuses to sell what is not held", () => {
    const sized = sizeSell(50, 0, EUR_QUOTE, simulation);
    expect(sized.ok).toBe(false);
  });
});

describe("SessionPrices", () => {
  const prices = pricesWith(
    "2026-02-05",
    [
      { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
      { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
      // Xetra shut: still quoting Tuesday.
      { ticker: "SAP.DE", open: 241.1, close: 241.8, sessionDate: "2026-02-04" },
      { ticker: "HALTED.AS", open: null, close: 12.5 },
    ],
    { eurusd: 1.085 },
  );

  it("quotes EUR instruments at a rate of exactly 1", () => {
    expect(prices.openOf("VWRL.AS")).toEqual({
      ticker: "VWRL.AS",
      priceLocal: 118.1,
      currency: "EUR",
      fxRate: 1,
    });
  });

  it("converts USD instruments through EURUSD=X", () => {
    expect(prices.openOf("AAPL")?.fxRate).toBe(1.085);
  });

  it("refuses an open for an instrument whose market did not trade today", () => {
    // SPEC 1.1: yesterday's open is a price the decision could already see.
    expect(prices.isStale("SAP.DE")).toBe(true);
    expect(prices.openOf("SAP.DE")).toBeNull();
    // It is still marked, at its last close, flagged rather than interpolated.
    expect(prices.closeOf("SAP.DE")?.priceLocal).toBe(241.8);
  });

  it("refuses an open the market never printed", () => {
    expect(prices.openOf("HALTED.AS")).toBeNull();
  });

  it("has no path to a price it was not given", () => {
    expect(prices.openOf("NOT.IN.BRIEF")).toBeNull();
    expect(prices.closeOf("NOT.IN.BRIEF")).toBeNull();
  });
});
