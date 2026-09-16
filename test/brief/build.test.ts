/**
 * The brief builder end to end (SPEC 12, phase 3), entirely offline.
 *
 * The golden case is the one that matters: the same recorded inputs must
 * produce the same committed bytes and the same hash, today and in a year.
 * Every decision record in this project cites a brief hash, and a builder that
 * drifted would quietly invalidate the whole audit trail.
 */
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import type { Ticker } from "../../src/domain/types.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import {
  MarketDataError,
  StaleDataError,
  type BarsQuery,
  type DailyBar,
  type MarketDataPort,
  type PriceSnapshot,
} from "../../src/data/index.js";
import { serializeBrief, verifyBriefHash } from "../../src/brief/hash.js";
import { BriefSchema } from "../../src/brief/types.js";
import {
  BRIEF_CLOCK,
  BRIEF_SESSION,
  buildFixtureBrief,
  fixtureMarketData,
  fixtureUniverse,
  goldenBrief,
} from "../helpers/brief.js";

const universe = fixtureUniverse();

/** A port that answers from the fixtures but fails one method. */
class FailingBars implements MarketDataPort {
  constructor(
    private readonly inner: MarketDataPort,
    private readonly failure: MarketDataError,
  ) {}
  getQuotes(tickers: readonly Ticker[]): Promise<readonly PriceSnapshot[]> {
    return this.inner.getQuotes(tickers);
  }
  getDailyBars(_ticker: Ticker, _query: BarsQuery): Promise<readonly DailyBar[]> {
    return Promise.reject(this.failure);
  }
  getFxRate(pair: string) {
    return this.inner.getFxRate(pair);
  }
  getFundamentals(ticker: Ticker) {
    return this.inner.getFundamentals(ticker);
  }
  getNewsForTicker(ticker: Ticker) {
    return this.inner.getNewsForTicker(ticker);
  }
  search(query: string) {
    return this.inner.search(query);
  }
  getUpcomingEarnings(tickers: readonly Ticker[], withinDays: number) {
    return this.inner.getUpcomingEarnings(tickers, withinDays);
  }
}

describe("buildBrief", () => {
  it("reproduces the committed golden brief byte for byte", async () => {
    const { brief } = await buildFixtureBrief();
    expect(serializeBrief(brief)).toBe(goldenBrief());
  });

  it("produces an identical hash from identical inputs", async () => {
    const first = await buildFixtureBrief();
    const second = await buildFixtureBrief();
    expect(second.brief.briefHash).toBe(first.brief.briefHash);
    expect(serializeBrief(second.brief)).toBe(serializeBrief(first.brief));
  });

  it("does not depend on the order the data source answered in", async () => {
    const data = fixtureMarketData();
    const shuffled = {
      ...data,
      quotes: [...(data.quotes ?? [])].reverse(),
      bars: Object.fromEntries(Object.entries(data.bars ?? {}).map(([k, v]) => [k, [...v].reverse()])),
    };
    const { brief } = await buildFixtureBrief({ market: new FixtureMarketData(shuffled) });
    const { brief: reference } = await buildFixtureBrief();
    expect(brief.briefHash).toBe(reference.briefHash);
  });

  it("carries a hash that verifies against its own content", async () => {
    const { brief } = await buildFixtureBrief();
    expect(verifyBriefHash(brief)).toBe(true);
    expect(BriefSchema.safeParse(brief).success).toBe(true);
  });

  it("dates itself to the newest close any whitelisted name reported", async () => {
    const { brief } = await buildFixtureBrief();
    expect(brief.date).toBe(BRIEF_SESSION);
    expect(brief.generatedAt).toBe(BRIEF_CLOCK.nowIso());
  });

  it("quotes every whitelisted instrument, keyed by ticker", async () => {
    const { brief } = await buildFixtureBrief();
    expect(Object.keys(brief.instruments).sort()).toEqual([...universe.tickers].sort());
    for (const instrument of Object.values(brief.instruments)) {
      expect(instrument.close).toBeTypeOf("number");
      expect(instrument.returns.d1).toBeTypeOf("number");
    }
  });

  it("carries the index levels and the FX rate SPEC 6 asks for", async () => {
    const { brief } = await buildFixtureBrief();
    expect(brief.references.map((r) => r.ticker)).toEqual([
      "^GDAXI",
      "^GSPC",
      "^STOXX",
      "^TNX",
      "^VIX",
    ]);
    expect(brief.fx).toEqual([
      { pair: "EURUSD=X", base: "EUR", quote: "USD", rate: 1.0856, asOf: "2026-09-15T20:30:00.000Z" },
    ]);
  });

  it("lists upcoming earnings in date order", async () => {
    const { brief } = await buildFixtureBrief();
    expect(brief.earnings).toEqual([
      { ticker: "SAP.DE", date: "2026-09-17", confirmed: true },
      { ticker: "AAPL", date: "2026-09-21", confirmed: false },
    ]);
  });

  it("deduplicates headlines across feeds and tags them", async () => {
    const { brief } = await buildFixtureBrief();
    const rally = brief.headlines.find((h) => h.title.startsWith("Wall Street closes higher"));
    // One story, carried by two feeds and the Yahoo search.
    expect(rally?.duplicates).toBe(2);
    expect(rally?.tickers).toEqual(["AAPL", "MSFT"]);
    expect(brief.headlines.filter((h) => h.title.startsWith("Wall Street closes higher"))).toHaveLength(1);
  });

  it("writes a price snapshot covering everything it quoted", async () => {
    const { prices } = await buildFixtureBrief();
    expect(prices.date).toBe(BRIEF_SESSION);
    expect(prices.quotes.map((q) => q.ticker)).toEqual(
      [...universe.quotableTickers].sort((a, b) => (a < b ? -1 : 1)),
    );
  });

  it("omits an instrument with no quote and says so in the gaps", async () => {
    const data = fixtureMarketData();
    const market = new FixtureMarketData({
      ...data,
      quotes: (data.quotes ?? []).filter((q) => q.ticker !== "MSFT"),
    });
    const { brief } = await buildFixtureBrief({ market });
    expect(brief.instruments["MSFT"]).toBeUndefined();
    expect(brief.gaps.missing).toEqual(["MSFT"]);
  });

  it("flags a lagging instrument as stale rather than interpolating it", async () => {
    const data = fixtureMarketData();
    const market = new FixtureMarketData({
      ...data,
      quotes: (data.quotes ?? []).map((q) =>
        q.ticker === "SAP.DE" ? { ...q, sessionDate: "2026-09-14" } : q,
      ),
    });
    const { brief } = await buildFixtureBrief({ market });
    expect(brief.date).toBe(BRIEF_SESSION);
    expect(brief.gaps.stale).toEqual(["SAP.DE"]);
    expect(brief.instruments["SAP.DE"]?.sessionDate).toBe("2026-09-14");
  });

  it("raises SPEC 1.5 when the caller asks for freshness and the data lags", async () => {
    const data = fixtureMarketData();
    const market = new FixtureMarketData({
      ...data,
      quotes: (data.quotes ?? []).map((q) =>
        q.ticker === "SAP.DE" ? { ...q, sessionDate: "2026-09-14" } : q,
      ),
    });
    await expect(
      buildFixtureBrief({ market, freshness: { expectedSessionOnOrAfter: BRIEF_SESSION } }),
    ).rejects.toThrow(StaleDataError);
  });

  it("propagates a price failure, because that is a day with no trading", async () => {
    const market = new FixtureMarketData(fixtureMarketData(), {
      failWith: new MarketDataError("yahoo is down", "transient"),
    });
    await expect(buildFixtureBrief({ market })).rejects.toThrow(MarketDataError);
  });

  it("refuses to brief a session in which nothing was quoted", async () => {
    const market = new FixtureMarketData({ ...fixtureMarketData(), quotes: [] });
    await expect(buildFixtureBrief({ market })).rejects.toThrow(/no session to brief on/);
  });

  it("survives an instrument with no chart, leaving its returns null", async () => {
    const market = new FailingBars(
      new FixtureMarketData(fixtureMarketData()),
      new MarketDataError("no history for this symbol", "permanent"),
    );
    const { brief } = await buildFixtureBrief({ market });
    expect(brief.instruments["AAPL"]?.returns).toEqual({
      d1: null,
      d5: null,
      m1: null,
      m6: null,
      y1: null,
    });
    expect(brief.instruments["AAPL"]?.close).toBeTypeOf("number");
  });

  it("stops on a chart failure that is the data source going down", async () => {
    const market = new FailingBars(
      new FixtureMarketData(fixtureMarketData()),
      new MarketDataError("connection reset", "transient"),
    );
    await expect(buildFixtureBrief({ market })).rejects.toThrow(/connection reset/);
  });

  it("thins the brief when a feed dies, and records which one", async () => {
    const { brief } = await buildFixtureBrief();
    const dead = brief.sources.find((source) => source.source === "dead-feed");
    expect(dead?.error).toMatch(/no fixture/);
    expect(dead?.items).toBe(0);
    expect(brief.headlines.length).toBeGreaterThan(0);
  });

  it("is built before any agent runs, so a later clock is a different brief", async () => {
    const later = await buildFixtureBrief({ clock: fixedClock("2026-09-15T20:31:00.000Z") });
    const { brief } = await buildFixtureBrief();
    expect(later.brief.briefHash).not.toBe(brief.briefHash);
  });
});

describe("the brief as the look-ahead check reads it (SPEC 1.1)", () => {
  it("prints, per instrument, exactly the prices a fill may not reuse", async () => {
    const { brief } = await buildFixtureBrief();
    const apple = brief.instruments["AAPL"];
    expect(apple).toBeDefined();
    const visible = [apple?.open, apple?.high, apple?.low, apple?.close, apple?.previousClose];
    expect(visible.every((price) => typeof price === "number")).toBe(true);
    // The session the brief describes; a fill on it would be a look-ahead.
    expect(brief.date).toBe(apple?.sessionDate);
  });
});
