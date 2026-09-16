/**
 * SPEC 14: "A simulated data-source failure produces SKIPPED events and zero
 * trades." The engine that writes those events is phase 4; what is testable
 * now is that every way the data layer can fail lands on the SPEC 1.5 path,
 * and that the events it implies are well-formed against the domain schema.
 */
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { parseEvent } from "../../src/domain/events.js";
import { MarketDataError, StaleDataError } from "../../src/data/port.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import { recordingSleep } from "../../src/data/resilience.js";
import { YahooMarketData } from "../../src/data/yahoo.js";
import { isSkipCondition, skipEventsFor, skipReasonFor } from "../../src/data/skip.js";
import type { RawQuote, YahooClient } from "../../src/data/yahooClient.js";

const PORTFOLIOS = ["news", "value", "contrarian", "macro", "news-frozen", "dca", "random"];
const clock = fixedClock("2026-09-15T22:30:00Z");

describe("a data-source failure is a skip condition", () => {
  it("treats a transient outage as one", () => {
    expect(isSkipCondition(new MarketDataError("gateway down", "transient"))).toBe(true);
    expect(skipReasonFor(new MarketDataError("gateway down", "transient"))).toBe("data_fetch_failed");
  });

  it("treats stale prices as one, with their own reason", () => {
    const error = new StaleDataError("yesterday's close", {
      expectedOnOrAfter: "2026-09-15",
      observed: null,
    });
    expect(isSkipCondition(error)).toBe(true);
    expect(skipReasonFor(error)).toBe("stale_data");
  });

  it("treats an open circuit as one", () => {
    expect(skipReasonFor(new MarketDataError("cooling down", "circuit_open"))).toBe(
      "data_source_unavailable",
    );
  });

  it("falls back to a generic reason for a failure it does not recognise", () => {
    expect(skipReasonFor(new TypeError("bug"))).toBe("data_fetch_failed");
  });

  it("skips every portfolio, not just the ones that meant to trade", () => {
    const events = skipEventsFor(PORTFOLIOS, new MarketDataError("down", "transient"));
    expect(events).toHaveLength(7);
    expect(events.map((e) => e.portfolio)).toEqual(PORTFOLIOS);
  });

  it("produces SKIPPED payloads the domain accepts", () => {
    const error = new StaleDataError("stale", { expectedOnOrAfter: "2026-09-15", observed: null });
    for (const [index, skip] of skipEventsFor(PORTFOLIOS, error).entries()) {
      const event = parseEvent({
        id: `skip-2026-09-15-${index}`,
        ts: "2026-09-15T22:30:00Z",
        portfolio: skip.portfolio,
        type: "SKIPPED",
        reason: skip.reason,
      });
      expect(event.type).toBe("SKIPPED");
      expect(event.portfolio).toBe(skip.portfolio);
    }
  });
});

describe("a simulated outage, end to end through the port", () => {
  const downClient: YahooClient = {
    quote: () => Promise.reject(new MarketDataError("ECONNRESET", "transient")),
    chart: () => Promise.reject(new MarketDataError("ECONNRESET", "transient")),
    quoteSummary: () => Promise.reject(new MarketDataError("ECONNRESET", "transient")),
    search: () => Promise.reject(new MarketDataError("ECONNRESET", "transient")),
  };

  it("exhausts retries, trips the breaker, and every call then skips", async () => {
    const port = new YahooMarketData(downClient, {
      clock,
      sleep: recordingSleep(),
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      circuit: { failureThreshold: 2, cooldownMs: 60_000, halfOpenProbes: 1 },
    });

    await expect(port.getQuotes(["AAPL"])).rejects.toThrow(/ECONNRESET/);
    await expect(port.getQuotes(["AAPL"])).rejects.toThrow(/ECONNRESET/);
    expect(port.health.state).toBe("open");

    const error = await port.getQuotes(["AAPL"]).catch((e: unknown) => e);
    expect(isSkipCondition(error)).toBe(true);
    expect(skipReasonFor(error)).toBe("data_source_unavailable");
    expect(skipEventsFor(PORTFOLIOS, error)).toHaveLength(7);
  });

  it("lets a fixture port simulate the same failure with no client at all", async () => {
    const port = new FixtureMarketData(
      {},
      { failWith: new MarketDataError("simulated outage", "transient") },
    );
    const error = await port.getQuotes(["AAPL"]).catch((e: unknown) => e);
    expect(isSkipCondition(error)).toBe(true);
    expect(skipReasonFor(error)).toBe("data_fetch_failed");
  });

  it("answers normally from fixtures when nothing is wrong", async () => {
    const quote: RawQuote = { symbol: "AAPL" };
    expect(quote.symbol).toBe("AAPL");
    const port = new FixtureMarketData({
      quotes: [
        {
          ticker: "AAPL",
          currency: "USD",
          exchange: "NasdaqGS",
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          previousClose: 1.4,
          volume: 10,
          asOf: "2026-09-15T20:00:00.000Z",
          sessionDate: "2026-09-15",
        },
      ],
    });
    expect(await port.getQuotes(["AAPL"])).toHaveLength(1);
  });
});
