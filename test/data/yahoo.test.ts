/**
 * The Yahoo adapter: mapping, and the resilience wiring around it.
 *
 * The `yahoo-finance2` package is never imported here. The adapter talks to
 * the `YahooClient` interface and these tests hand it recorded JSON, which is
 * what keeps the suite runnable with the network unplugged (SPEC 2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { MarketDataError } from "../../src/data/port.js";
import { MemoryCache } from "../../src/data/cache.js";
import { recordingSleep } from "../../src/data/resilience.js";
import { YahooMarketData, mapChart, mapFundamentals, mapNews, mapQuote } from "../../src/data/yahoo.js";
import { classifyError } from "../../src/data/yahooClient.js";
import type {
  ChartQuery,
  RawChart,
  RawQuote,
  RawSearch,
  RawSummary,
  YahooClient,
} from "../../src/data/yahooClient.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "yahoo");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;

const quotes = load<RawQuote[]>("quote-batch.json");
const chart = load<RawChart>("chart-aapl.json");
const summary = load<RawSummary>("summary-sap.json");
const sparseSummary = load<RawSummary>("summary-sparse.json");
const calendar = load<RawSummary>("calendar-aapl.json");
const search = load<RawSearch>("search-asml.json");

const clock = fixedClock("2026-09-15T22:30:00Z");

/** A client that answers from fixtures and counts its calls. */
class FakeClient implements YahooClient {
  calls: string[] = [];
  constructor(private readonly behaviour: Partial<YahooClient> = {}) {}

  quote(symbols: readonly string[]): Promise<readonly RawQuote[]> {
    this.calls.push(`quote:${symbols.join(",")}`);
    if (this.behaviour.quote) return this.behaviour.quote(symbols);
    const wanted = new Set(symbols);
    return Promise.resolve(quotes.filter((q) => wanted.has(q.symbol)));
  }
  chart(symbol: string, query: ChartQuery): Promise<RawChart> {
    this.calls.push(`chart:${symbol}`);
    if (this.behaviour.chart) return this.behaviour.chart(symbol, query);
    return Promise.resolve(chart);
  }
  quoteSummary(symbol: string, modules: readonly string[]): Promise<RawSummary> {
    this.calls.push(`summary:${symbol}:${modules.join("+")}`);
    if (this.behaviour.quoteSummary) return this.behaviour.quoteSummary(symbol, modules);
    return Promise.resolve(modules.includes("calendarEvents") ? calendar : summary);
  }
  search(query: string, newsCount: number): Promise<RawSearch> {
    this.calls.push(`search:${query}`);
    if (this.behaviour.search) return this.behaviour.search(query, newsCount);
    return Promise.resolve(search);
  }
}

const adapter = (client: YahooClient, extra = {}): YahooMarketData =>
  new YahooMarketData(client, { clock, sleep: recordingSleep(), ...extra });

describe("mapping Yahoo's shapes", () => {
  it("maps a quote, keeping the session its close belongs to", () => {
    const raw = quotes[0]!;
    const mapped = mapQuote(raw, clock.nowIso());
    expect(mapped).toMatchObject({
      ticker: "AAPL",
      currency: "USD",
      exchange: "NasdaqGS",
      open: 238.9,
      high: 242.15,
      low: 238.04,
      close: 241.37,
      previousClose: 239.11,
      volume: 44812300,
      asOf: "2026-09-15T20:00:02.000Z",
      sessionDate: "2026-09-15",
    });
  });

  it("turns absent fields into null rather than zero", () => {
    const mapped = mapQuote(quotes[3]!, clock.nowIso());
    expect(mapped.open).toBeNull();
    expect(mapped.high).toBeNull();
    expect(mapped.volume).toBeNull();
    expect(mapped.close).toBe(104.66);
  });

  it("falls back to the observation time when Yahoo sends no timestamp", () => {
    const mapped = mapQuote({ symbol: "X" }, clock.nowIso());
    expect(mapped.asOf).toBe("2026-09-15T22:30:00.000Z");
    expect(mapped.sessionDate).toBe("2026-09-15");
  });

  it("maps daily bars from chart(), including a session with no trade", () => {
    const bars = mapChart(chart);
    expect(bars).toHaveLength(4);
    expect(bars[0]).toEqual({
      date: "2026-09-11",
      open: 235.1,
      high: 237.4,
      low: 234.2,
      close: 236.8,
      adjClose: 236.8,
      volume: 38210400,
    });
    expect(bars[3]!.close).toBeNull();
  });

  it("maps fundamentals across the three summary modules", () => {
    const mapped = mapFundamentals("SAP.DE", summary, clock.nowIso());
    expect(mapped).toEqual({
      ticker: "SAP.DE",
      currency: "EUR",
      marketCap: 249800000000,
      trailingPe: 42.17,
      forwardPe: 31.05,
      priceToBook: 4.88,
      dividendYield: 0.0102,
      returnOnEquity: 0.1184,
      debtToEquity: 24.6,
      asOf: "2026-09-15T22:30:00.000Z",
    });
  });

  it("survives a summary with almost nothing in it", () => {
    const mapped = mapFundamentals("X", sparseSummary, clock.nowIso());
    expect(mapped.currency).toBe("USD");
    expect(mapped.marketCap).toBeNull();
    expect(mapped.returnOnEquity).toBeNull();
  });

  it("maps news, defaulting the tags Yahoo did not resolve", () => {
    const items = mapNews(search);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: "6f1f0b2e-2c3a-4d5e-9a10-7c1f2b3d4e5f",
      title: "ASML lifts guidance on EUV demand",
      publisher: "Reuters",
      url: "https://example.invalid/asml-guidance",
      publishedAt: "2026-09-15T06:12:00.000Z",
      tickers: ["ASML.AS", "ASML"],
    });
    expect(items[1]!.tickers).toEqual([]);
  });

  it("maps an empty news response to an empty list, not a failure", () => {
    expect(mapNews({})).toEqual([]);
  });
});

describe("YahooMarketData", () => {
  it("fetches a batch of quotes in one call", async () => {
    const client = new FakeClient();
    const got = await adapter(client).getQuotes(["AAPL", "SAP.DE"]);
    expect(got.map((q) => q.ticker)).toEqual(["AAPL", "SAP.DE"]);
    expect(client.calls).toEqual(["quote:AAPL,SAP.DE"]);
  });

  it("asks for nothing when given nothing", async () => {
    const client = new FakeClient();
    expect(await adapter(client).getQuotes([])).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("reads the FX rate as units of local currency per EUR", async () => {
    const fx = await adapter(new FakeClient()).getFxRate("EURUSD=X");
    expect(fx).toEqual({
      pair: "EURUSD=X",
      base: "EUR",
      quote: "USD",
      rate: 1.0842,
      asOf: "2026-09-15T20:59:00.000Z",
    });
  });

  it("fails rather than inventing a rate when FX does not come back", async () => {
    const client = new FakeClient({ quote: () => Promise.resolve([]) });
    await expect(adapter(client).getFxRate("EURUSD=X")).rejects.toThrow(/no rate came back/);
  });

  it("passes the requested range to Yahoo, which does the windowing", async () => {
    let seen: ChartQuery | undefined;
    const client = new FakeClient({
      chart: (_symbol, query) => {
        seen = query;
        return Promise.resolve(chart);
      },
    });
    const bars = await adapter(client).getDailyBars("AAPL", {
      from: "2026-09-14",
      to: "2026-09-15",
    });
    expect(seen).toEqual({ period1: "2026-09-14", period2: "2026-09-15", interval: "1d" });
    // Whatever Yahoo returns is mapped as-is: re-filtering here would quietly
    // disagree with the snapshot committed for that day (SPEC 6).
    expect(bars).toHaveLength(4);
  });

  it("serves a second identical bars request from cache (SPEC 6)", async () => {
    const client = new FakeClient();
    const port = adapter(client, { cache: new MemoryCache() });
    const query = { from: "2026-09-01", to: "2026-09-15" } as const;
    await port.getDailyBars("AAPL", query);
    await port.getDailyBars("AAPL", query);
    expect(client.calls).toEqual(["chart:AAPL"]);
  });

  it("keeps only earnings inside the horizon", async () => {
    const found = await adapter(new FakeClient()).getUpcomingEarnings(["AAPL"], 7);
    expect(found).toEqual([{ ticker: "AAPL", date: "2026-09-18", confirmed: true }]);
  });

  it("skips a name with no calendar instead of losing the whole section", async () => {
    const client = new FakeClient({
      quoteSummary: (symbol) =>
        symbol === "BAD"
          ? Promise.reject(new MarketDataError("no such symbol", "permanent"))
          : Promise.resolve(calendar),
    });
    const found = await adapter(client).getUpcomingEarnings(["BAD", "AAPL"], 7);
    expect(found.map((e) => e.ticker)).toEqual(["AAPL"]);
  });

  it("retries a transient failure underneath the port", async () => {
    let calls = 0;
    const client = new FakeClient({
      quote: () => {
        calls += 1;
        return calls < 2
          ? Promise.reject(new MarketDataError("reset by peer", "transient"))
          : Promise.resolve(quotes.filter((q) => q.symbol === "AAPL"));
      },
    });
    const port = adapter(client);
    await expect(port.getQuotes(["AAPL"])).resolves.toHaveLength(1);
    expect(calls).toBe(2);
    expect(port.health.retries).toBe(1);
  });

  it("opens the breaker after repeated outages and then fails fast", async () => {
    const client = new FakeClient({
      quote: () => Promise.reject(new MarketDataError("gateway down", "transient")),
    });
    const port = adapter(client, {
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      circuit: { failureThreshold: 2, cooldownMs: 60_000, halfOpenProbes: 1 },
    });

    await expect(port.getQuotes(["AAPL"])).rejects.toThrow(/gateway down/);
    await expect(port.getQuotes(["AAPL"])).rejects.toThrow(/gateway down/);
    expect(port.health.state).toBe("open");

    const before = client.calls.length;
    await expect(port.getQuotes(["AAPL"])).rejects.toMatchObject({ failure: "circuit_open" });
    expect(client.calls.length).toBe(before);
  });

  it("reports health for the dashboard", async () => {
    const port = adapter(new FakeClient());
    await port.getQuotes(["AAPL"]);
    expect(port.health).toMatchObject({ state: "closed", consecutiveFailures: 0, requests: 1 });
  });
});

/**
 * The bug that made every live run skip.
 *
 * The first real session failed with `No fundamentals data found for symbol:
 * IWDA.AS`. ETFs have no earnings calendar, Yahoo reports that as a plain
 * Error, `classifyError` called anything unrecognised `transient`, and
 * `getUpcomingEarnings` rethrew anything that was not `permanent` — so the
 * first fund in the universe killed the brief, and with it the session. There
 * are 30 funds in the universe: this was deterministic, not flaky.
 */
describe("one instrument without a calendar cannot end the session", () => {
  const noData = (ticker: string): Error =>
    new Error(`No fundamentals data found for symbol: ${ticker}`);

  it("classifies Yahoo's no-data-for-symbol as permanent, not retryable", () => {
    const classified = classifyError(noData("IWDA.AS"));
    expect(classified.failure).toBe("permanent");
    expect(classified.retryable).toBe(false);
  });

  it("still treats an unrecognised error as transient", () => {
    expect(classifyError(new Error("socket hang up")).failure).toBe("transient");
  });

  it("skips the instrument and keeps the rest of the earnings section", async () => {
    const client = new FakeClient({
      quoteSummary: (symbol) =>
        symbol === "IWDA.AS"
          ? Promise.reject(new MarketDataError(`No fundamentals data found for symbol: ${symbol}`, "permanent"))
          : Promise.resolve(calendar),
    });
    const found = await adapter(client).getUpcomingEarnings(["IWDA.AS", "AAPL"], 7);
    expect(found.map((entry) => entry.ticker)).toEqual(["AAPL"]);
  });

  it("skips a transient failure too, rather than losing the session to it", async () => {
    // Retries are already spent by the time the catch is reached: the choice
    // left is this instrument or the whole brief.
    const client = new FakeClient({
      quoteSummary: (symbol) =>
        symbol === "BAD"
          ? Promise.reject(new MarketDataError("socket hang up", "transient"))
          : Promise.resolve(calendar),
    });
    const found = await adapter(client, {
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
    }).getUpcomingEarnings(["BAD", "AAPL"], 7);
    expect(found.map((entry) => entry.ticker)).toEqual(["AAPL"]);
  });

  it("still fails the session when the upstream itself is down", async () => {
    // An open circuit is not a fact about one symbol. Carrying on would report
    // an empty earnings section that means "nothing could be fetched at all".
    const client = new FakeClient({
      quoteSummary: () => Promise.reject(new MarketDataError("gateway down", "transient")),
    });
    const port = adapter(client, {
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      circuit: { failureThreshold: 1, cooldownMs: 60_000, halfOpenProbes: 1 },
    });
    await expect(port.getUpcomingEarnings(["A", "B", "C"], 7)).rejects.toMatchObject({
      failure: "circuit_open",
    });
  });

  it("survives a whole universe of instruments that have no calendar", async () => {
    const client = new FakeClient({
      quoteSummary: (symbol) =>
        Promise.reject(new MarketDataError(`No fundamentals data found for symbol: ${symbol}`, "permanent")),
    });
    const funds = ["IWDA.AS", "EUNL.DE", "VWCE.DE", "VUSA.AS"];
    await expect(adapter(client).getUpcomingEarnings(funds, 7)).resolves.toEqual([]);
  });
});
