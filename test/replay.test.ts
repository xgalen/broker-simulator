import { describe, expect, it } from "vitest";
import { replay, replayPortfolio } from "../src/domain/replay.js";
import { fixtureEvents, UNIVERSE } from "./helpers/fixtures.js";

const events = fixtureEvents("ledger-clean.jsonl");
const result = replay(events, { universe: UNIVERSE });

function state(portfolio: string) {
  const found = result.portfolios.get(portfolio);
  if (found === undefined) throw new Error(`no state for ${portfolio}`);
  return found;
}

describe("replay", () => {
  it("replays a clean ledger with no violations", () => {
    expect(result.violations).toEqual([]);
    expect(result.eventCount).toBe(28);
    expect(result.lastEventTs).toBe("2026-09-21T20:30:05Z");
  });

  it("keeps portfolios independent (SPEC 5: they do not share cash)", () => {
    expect([...result.portfolios.keys()].sort()).toEqual(["dca", "value"]);
    expect(state("value").cashEur).toBe(44.54);
    expect(state("dca").cashEur).toBe(1.0);
  });

  it("derives cash from deposits, fills, fees and dividends", () => {
    // 100 deposit - 60.00 SAP - 25.06 AAPL + 0.68 dividend + 28.92 sale
    expect(state("value").cashEur).toBe(44.54);
    expect(state("value").contributedToDateEur).toBe(100);
  });

  it("holds cost basis all-in, with fees and FX costs tracked separately", () => {
    const sap = state("value").positions.get("SAP.DE");
    expect(sap).toBeDefined();
    expect(sap?.costBasisEur).toBe(60.0);
    expect(sap?.grossCostEur).toBe(59.0);
    expect(sap?.feesEur).toBe(1.0);
    expect(sap?.currency).toBe("EUR");
  });

  it("applies a split to quantity while leaving cost basis alone", () => {
    const sap = state("value").positions.get("SAP.DE");
    expect(sap?.qty).toBe(0.8);
    expect(sap?.costBasisEur).toBe(60.0);
    // Implied entry price halves: 59.00 local cost over 0.8 shares.
    expect((sap?.localCostBasis ?? 0) / (sap?.qty ?? 1)).toBeCloseTo(73.75, 10);
  });

  it("closes a position and removes it from the book", () => {
    expect(state("value").positions.has("AAPL")).toBe(false);
    expect(state("value").realizedTrades).toHaveLength(1);
  });

  it("splits realized P&L into price and FX (SPEC 4)", () => {
    const trade = state("value").realizedTrades[0];
    expect(trade?.ticker).toBe("AAPL");
    expect(trade?.qty).toBe(0.15);
    expect(trade?.costEur).toBe(25.06);
    expect(trade?.proceedsEur).toBe(28.92);
    expect(trade?.realizedPnlEur).toBe(3.86);
    // Bought at 200 USD / 1.25, sold at 220 USD / 1.10: most of the gain is
    // the dollar, not the stock.
    expect(trade?.pricePnlEur).toBe(2.4);
    expect(trade?.fxPnlEur).toBe(3.6);
    expect(trade?.feesEur).toBe(2.14);
    expect(trade?.holdingDays).toBe(4);
    expect(trade?.closedByOrderId).toBe("v-011");
  });

  it("reconciles price P&L plus FX P&L minus fees with realized P&L", () => {
    const trade = state("value").realizedTrades[0];
    const sum =
      (trade?.pricePnlEur ?? 0) + (trade?.fxPnlEur ?? 0) - (trade?.feesEur ?? 0);
    expect(sum).toBeCloseTo(trade?.realizedPnlEur ?? 0, 10);
  });

  it("credits dividends net of withholding", () => {
    expect(state("value").dividendsNetEur).toBe(0.68);
    expect(state("value").withholdingEur).toBe(0.12);
  });

  it("accumulates fees, FX costs and turnover", () => {
    expect(state("value").feesPaidEur).toBe(3.0);
    expect(state("value").fxCostsPaidEur).toBe(0.14);
    expect(state("value").turnoverEur).toBe(113.0);
  });

  it("counts every decision, including the ones to do nothing (SPEC 1.7)", () => {
    expect(state("value").counters).toEqual({
      ordersPlaced: 3,
      ordersFilled: 3,
      ordersRejected: 0,
      holds: 2,
      skips: 0,
      deposits: 1,
      splits: 1,
      dividends: 1,
    });
    expect(state("dca").counters.holds).toBe(4);
  });

  it("leaves no pending orders once everything is filled", () => {
    expect(state("value").pendingOrders.size).toBe(0);
  });

  it("collects one mark per trading day", () => {
    expect(state("value").marks.map((mark) => mark.date)).toEqual([
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-21",
    ]);
    expect(state("value").marks.at(-1)?.totalValueEur).toBe(105.34);
  });

  it("records deposits as external flows for the return calculation", () => {
    expect(state("value").flows).toEqual([
      { date: "2026-09-15", ts: "2026-09-15T20:30:02Z", amountEur: 100 },
    ]);
  });

  it("replayPortfolio matches the slice of the full replay (SPEC 4 signature)", () => {
    const single = replayPortfolio(events, "value", { universe: UNIVERSE });
    expect(single.cashEur).toBe(state("value").cashEur);
    expect(single.positions.get("SAP.DE")?.qty).toBe(0.8);
    expect(replayPortfolio(events, "nobody").cashEur).toBe(0);
  });

  it("is a pure fold: replaying twice gives the same numbers", () => {
    const again = replay(fixtureEvents("ledger-clean.jsonl"), { universe: UNIVERSE });
    expect(again.portfolios.get("value")?.cashEur).toBe(state("value").cashEur);
    expect(again.portfolios.get("value")?.realizedPnlEur).toBe(
      state("value").realizedPnlEur,
    );
  });

  it("never mutates the events it was handed (SPEC 1.3: append-only)", () => {
    const snapshot = JSON.stringify(events);
    replay(events, { universe: UNIVERSE });
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it("logs SKIPPED days with no trades and no mark (SPEC 1.5)", () => {
    const skipped = replay(fixtureEvents("ledger-skipped.jsonl"), {
      universe: UNIVERSE,
    });
    expect(skipped.violations).toEqual([]);
    for (const portfolio of ["value", "dca"]) {
      const s = skipped.portfolios.get(portfolio);
      expect(s?.counters.skips).toBe(1);
      expect(s?.counters.ordersPlaced).toBe(0);
      expect(s?.counters.ordersFilled).toBe(0);
    }
    // Cash is untouched and no mark was written on the stale day.
    expect(skipped.portfolios.get("value")?.cashEur).toBe(100);
    expect(skipped.portfolios.get("value")?.marks).toHaveLength(1);
  });
});
