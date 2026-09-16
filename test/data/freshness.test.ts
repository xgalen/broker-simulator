/**
 * SPEC 1.5: stale data means no trading. These tests pin the condition that
 * makes the daily run write SKIPPED for every portfolio and exit 0.
 */
import { describe, expect, it } from "vitest";
import { StaleDataError, type PriceSnapshot } from "../../src/data/port.js";
import { assertFresh, checkFreshness } from "../../src/data/freshness.js";

function snapshot(ticker: string, sessionDate: string): PriceSnapshot {
  return {
    ticker,
    currency: "EUR",
    exchange: "XETRA",
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    previousClose: 10.2,
    volume: 1000,
    asOf: `${sessionDate}T15:35:00.000Z`,
    sessionDate,
  };
}

const policy = { expectedSessionOnOrAfter: "2026-09-15" };

describe("freshness", () => {
  it("accepts a quote from the expected session", () => {
    const report = checkFreshness([snapshot("SAP.DE", "2026-09-15")], ["SAP.DE"], policy);
    expect(report.fresh).toHaveLength(1);
    expect(report.stale).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
  });

  it("accepts a quote newer than expected", () => {
    const report = checkFreshness([snapshot("SAP.DE", "2026-09-16")], ["SAP.DE"], policy);
    expect(report.fresh).toHaveLength(1);
  });

  it("flags yesterday's close as stale", () => {
    const report = checkFreshness([snapshot("SAP.DE", "2026-09-14")], ["SAP.DE"], policy);
    expect(report.stale).toEqual([
      { ticker: "SAP.DE", sessionDate: "2026-09-14", tolerated: false },
    ]);
  });

  it("reports a ticker that came back with no quote at all", () => {
    const report = checkFreshness([], ["SAP.DE"], policy);
    expect(report.missing).toEqual(["SAP.DE"]);
  });

  it("raises SPEC 1.5 rather than trading on a stale price", () => {
    expect(() => assertFresh([snapshot("SAP.DE", "2026-09-14")], ["SAP.DE"], policy)).toThrow(
      StaleDataError,
    );
  });

  it("names the instrument and both dates, so the SKIPPED reason is legible", () => {
    expect(() => assertFresh([snapshot("SAP.DE", "2026-09-14")], ["SAP.DE"], policy)).toThrow(
      /"SAP\.DE" last traded 2026-09-14, before the expected session 2026-09-15/,
    );
  });

  it("raises when a quote is missing entirely", () => {
    expect(() => assertFresh([], ["SAP.DE", "AAPL"], policy)).toThrow(/no quote came back/);
  });

  it("carries the stale tag on the error, for the SKIPPED event", () => {
    try {
      assertFresh([snapshot("SAP.DE", "2026-09-14")], ["SAP.DE"], policy);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleDataError);
      expect((error as StaleDataError).failure).toBe("stale");
      expect((error as StaleDataError).retryable).toBe(false);
      expect((error as StaleDataError).detail.expectedOnOrAfter).toBe("2026-09-15");
    }
  });

  it("lets a tolerated market lag without stopping the run", () => {
    const report = assertFresh(
      [snapshot("SAP.DE", "2026-09-14"), snapshot("AAPL", "2026-09-15")],
      ["SAP.DE", "AAPL"],
      { ...policy, toleratedStaleTickers: ["SAP.DE"] },
    );
    expect(report.fresh.map((s) => s.ticker)).toEqual(["AAPL"]);
    // Still reported, so the dashboard can mark it stale rather than drawing
    // a line that implies movement on a day the market was shut (SPEC 11).
    expect(report.stale).toEqual([
      { ticker: "SAP.DE", sessionDate: "2026-09-14", tolerated: true },
    ]);
  });

  it("still fails when an untolerated name is stale alongside a tolerated one", () => {
    expect(() =>
      assertFresh(
        [snapshot("SAP.DE", "2026-09-14"), snapshot("AAPL", "2026-09-14")],
        ["SAP.DE", "AAPL"],
        { ...policy, toleratedStaleTickers: ["SAP.DE"] },
      ),
    ).toThrow(/"AAPL" last traded/);
  });
});
