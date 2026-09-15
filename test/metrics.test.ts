/**
 * SPEC 9. The headline assertion is the deposit one: a 50 EUR contribution
 * into a 110 EUR portfolio must register as a 0% day, not a 45% gain.
 */
import { describe, expect, it } from "vitest";
import {
  buildDailySeries,
  computeMetrics,
  maxDrawdown,
  timeWeightedReturn,
  xirr,
} from "../src/domain/metrics.js";
import { replay, replayPortfolio } from "../src/domain/replay.js";
import { fixtureEvents, UNIVERSE } from "./helpers/fixtures.js";

const twr = replayPortfolio(fixtureEvents("ledger-twr.jsonl"), "twr", {
  universe: UNIVERSE,
});
const clean = replay(fixtureEvents("ledger-clean.jsonl"), { universe: UNIVERSE });

describe("time-weighted return, chained daily", () => {
  const series = buildDailySeries(twr);

  it("has one point per mark", () => {
    expect(series.map((point) => point.date)).toEqual([
      "2026-01-02",
      "2026-01-05",
      "2026-01-06",
      "2026-02-02",
      "2026-02-03",
    ]);
  });

  it("attributes each deposit to the day it opened", () => {
    expect(series.map((point) => point.externalFlowEur)).toEqual([100, 0, 0, 50, 0]);
  });

  it("does not let a deposit register as a gain", () => {
    // 110 EUR portfolio, 50 EUR paid in, marked at 160: a 0% day.
    const depositDay = series[3];
    expect(depositDay?.totalValueEur).toBe(160);
    expect(depositDay?.externalFlowEur).toBe(50);
    expect(depositDay?.dailyReturn).toBeCloseTo(0, 12);
  });

  it("chains the daily sub-periods", () => {
    expect(series[2]?.dailyReturn).toBeCloseTo(0.1, 12); // 100 -> 110
    expect(series[4]?.dailyReturn).toBeCloseTo(-0.06875, 12); // 160 -> 149
    expect(timeWeightedReturn(series)).toBeCloseTo(0.024375, 12); // 1.1 x 0.93125
  });

  it("separates return from money put in", () => {
    // Up 2.4% time-weighted while down 1 EUR on 150 EUR contributed: the two
    // numbers answer different questions, which is why SPEC 9 wants both.
    expect(series.at(-1)?.pnlEur).toBe(-1);
    expect(computeMetrics(twr).timeWeightedReturn).toBe(0.024375);
    expect(computeMetrics(twr).moneyWeightedReturn).toBeLessThan(0);
  });

  it("measures drawdown on the deposit-neutral index", () => {
    expect(maxDrawdown(series)).toBeCloseTo(-0.06875, 12);
  });

  it("matches simple value growth when there are no flows after the seed", () => {
    const value = clean.portfolios.get("value");
    if (value === undefined) throw new Error("no state");
    // 100 EUR in, marked at 105.34, no further contributions.
    expect(computeMetrics(value).timeWeightedReturn).toBe(0.0534);
    expect(computeMetrics(value).pnlEur).toBe(5.34);
  });
});

describe("money-weighted return (XIRR)", () => {
  it("solves a flat one-year doubling", () => {
    const rate = xirr([
      { date: "2026-01-01", amountEur: -100 },
      { date: "2027-01-01", amountEur: 200 },
    ]);
    expect(rate).not.toBeNull();
    expect(rate ?? 0).toBeCloseTo(1.0, 4);
  });

  it("returns null when the flows never change sign", () => {
    expect(
      xirr([
        { date: "2026-01-01", amountEur: -100 },
        { date: "2027-01-01", amountEur: -50 },
      ]),
    ).toBeNull();
  });

  it("returns null for a portfolio with no marks", () => {
    const empty = replayPortfolio(fixtureEvents("ledger-orphan-fill.jsonl"), "orphan");
    expect(computeMetrics(empty).moneyWeightedReturn).toBeNull();
  });
});

describe("per-portfolio metrics (SPEC 9)", () => {
  const value = clean.portfolios.get("value");
  if (value === undefined) throw new Error("no state");
  const metrics = computeMetrics(value, { riskFreeAnnual: 0.02 });

  it("reports the window it covers", () => {
    expect(metrics.firstDate).toBe("2026-09-15");
    expect(metrics.lastDate).toBe("2026-09-21");
    expect(metrics.days).toBe(5);
  });

  it("reports hit rate and holding period on closed positions", () => {
    expect(metrics.closedTrades).toBe(1);
    expect(metrics.hitRate).toBe(1);
    expect(metrics.averageHoldingDays).toBe(4);
  });

  it("makes fee drag a first-class number (SPEC 8)", () => {
    // Three 1 EUR fees plus 0.14 of FX spread on 100 EUR contributed.
    expect(metrics.cumulativeFeesEur).toBe(3.14);
    expect(metrics.feeDragPct).toBe(3.14);
  });

  it("keeps the FX effect visible next to the return", () => {
    expect(metrics.cumulativeFxEffectEur).toBe(3.6);
    expect(metrics.realizedFxPnlEur).toBe(3.6);
    expect(metrics.realizedPricePnlEur).toBe(2.4);
  });

  it("computes volatility, Sharpe and turnover", () => {
    expect(metrics.annualizedVolatility).toBeGreaterThan(0);
    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.turnover).toBeGreaterThan(0);
  });

  it("leaves ratio metrics null rather than dividing by zero", () => {
    const empty = replayPortfolio(fixtureEvents("ledger-orphan-fill.jsonl"), "orphan");
    const emptyMetrics = computeMetrics(empty);
    expect(emptyMetrics.hitRate).toBeNull();
    expect(emptyMetrics.averageHoldingDays).toBeNull();
    expect(emptyMetrics.turnover).toBeNull();
    expect(emptyMetrics.sharpe).toBeNull();
    expect(emptyMetrics.days).toBe(0);
  });

  it("ranks the control against the agent on the same basis", () => {
    const dca = clean.portfolios.get("dca");
    if (dca === undefined) throw new Error("no state");
    // The headline number of the project: return relative to dca, after fees.
    const dcaMetrics = computeMetrics(dca);
    expect(dcaMetrics.timeWeightedReturn).toBe(-0.015);
    expect(metrics.timeWeightedReturn - dcaMetrics.timeWeightedReturn).toBeCloseTo(
      0.0684,
      6,
    );
  });
});
