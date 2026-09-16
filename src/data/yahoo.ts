/**
 * `MarketDataPort`, implemented over Yahoo (SPEC 12 phase 2).
 *
 * Every call goes through the breaker and then retry, in that order: an open
 * breaker must cost nothing, so it is checked before any attempt is made
 * rather than after three of them.
 *
 * The mapping is deliberately defensive. Yahoo omits fields without warning
 * and revises others, so anything absent becomes `null` and reaches the brief
 * as a gap rather than as a crash or, worse, a zero.
 */
import type { Clock } from "../domain/clock.js";
import type { IsoDate, IsoTimestamp, Ticker } from "../domain/types.js";
import {
  MarketDataError,
  type BarsQuery,
  type DailyBar,
  type DataSourceHealth,
  type EarningsDate,
  type FxQuote,
  type Fundamentals,
  type MarketDataPort,
  type NewsItem,
  type PriceSnapshot,
  type ResponseCache,
} from "./port.js";
import { CircuitBreaker, DEFAULT_CIRCUIT, DEFAULT_RETRY, realSleep, withRetry, type Sleep } from "./resilience.js";
import type { RawChart, RawQuote, RawSearch, RawSummary, YahooClient } from "./yahooClient.js";
import type { CircuitPolicy, RetryPolicy } from "./port.js";

const FUNDAMENTALS_MODULES = [
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
] as const;

function toIso(value: Date | string | number | undefined, fallback: IsoTimestamp): IsoTimestamp {
  if (value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? date.toISOString() : fallback;
}

function toDate(value: Date | string | undefined): IsoDate | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? (date.toISOString().slice(0, 10) as IsoDate) : null;
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Yahoo's shape for one quote -> ours. Exported for the mapping tests. */
export function mapQuote(raw: RawQuote, observedAt: IsoTimestamp): PriceSnapshot {
  const asOf = toIso(raw.regularMarketTime, observedAt);
  return {
    ticker: raw.symbol,
    currency: raw.currency ?? "",
    exchange: raw.fullExchangeName ?? raw.exchange ?? "",
    open: num(raw.regularMarketOpen),
    high: num(raw.regularMarketDayHigh),
    low: num(raw.regularMarketDayLow),
    close: num(raw.regularMarketPrice),
    previousClose: num(raw.regularMarketPreviousClose),
    volume: num(raw.regularMarketVolume),
    asOf,
    // The session a close belongs to is the calendar date of its own
    // timestamp, which is what the staleness gate compares against.
    sessionDate: asOf.slice(0, 10),
  };
}

export function mapChart(raw: RawChart): readonly DailyBar[] {
  const bars: DailyBar[] = [];
  for (const quote of raw.quotes) {
    const date = toDate(quote.date);
    if (date === null) continue;
    bars.push({
      date,
      open: num(quote.open),
      high: num(quote.high),
      low: num(quote.low),
      close: num(quote.close),
      adjClose: num(quote.adjclose),
      volume: num(quote.volume),
    });
  }
  return bars;
}

export function mapFundamentals(
  ticker: Ticker,
  raw: RawSummary,
  observedAt: IsoTimestamp,
): Fundamentals {
  const detail = raw.summaryDetail;
  const stats = raw.defaultKeyStatistics;
  const financial = raw.financialData;
  return {
    ticker,
    currency: detail?.currency ?? null,
    marketCap: num(detail?.marketCap),
    trailingPe: num(detail?.trailingPE),
    forwardPe: num(detail?.forwardPE ?? stats?.forwardPE),
    priceToBook: num(stats?.priceToBook),
    dividendYield: num(detail?.dividendYield),
    returnOnEquity: num(financial?.returnOnEquity),
    debtToEquity: num(financial?.debtToEquity),
    asOf: observedAt,
  };
}

export function mapNews(raw: RawSearch): readonly NewsItem[] {
  return (raw.news ?? []).map((item) => ({
    id: item.uuid,
    title: item.title,
    publisher: item.publisher,
    url: item.link,
    publishedAt: toIso(item.providerPublishTime, new Date(0).toISOString()),
    tickers: [...(item.relatedTickers ?? [])],
  }));
}

export interface YahooMarketDataOptions {
  readonly clock: Clock;
  readonly retry?: RetryPolicy;
  readonly circuit?: CircuitPolicy;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly cache?: ResponseCache;
}

export class YahooMarketData implements MarketDataPort {
  private readonly breaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: Sleep;
  private readonly random: (() => number) | undefined;
  private readonly cache: ResponseCache | undefined;
  private readonly clock: Clock;
  private retries = 0;

  constructor(
    private readonly client: YahooClient,
    options: YahooMarketDataOptions,
  ) {
    this.clock = options.clock;
    this.retryPolicy = options.retry ?? DEFAULT_RETRY;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random;
    this.cache = options.cache;
    this.breaker = new CircuitBreaker(options.clock, options.circuit ?? DEFAULT_CIRCUIT);
  }

  get health(): DataSourceHealth {
    const snapshot = this.breaker.snapshot;
    return {
      state: snapshot.state,
      consecutiveFailures: snapshot.consecutiveFailures,
      lastFailure: snapshot.lastFailure,
      requests: snapshot.requests,
      retries: this.retries,
    };
  }

  /** Breaker outside, retry inside: an open breaker never sleeps on a backoff. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.breaker.execute(() =>
      withRetry(operation, {
        policy: this.retryPolicy,
        sleep: this.sleep,
        ...(this.random ? { random: this.random } : {}),
        onRetry: () => {
          this.retries += 1;
        },
      }),
    );
  }

  /**
   * Cached calls are answered from the cache without touching the breaker: a
   * committed point-in-time snapshot is as good as a fetch and cannot be stale
   * in a way re-fetching would fix (SPEC 6 — never re-fetch history).
   */
  private async cached<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const hit = await this.cache?.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await this.run(operation);
    await this.cache?.set(key, value);
    return value;
  }

  async getQuotes(tickers: readonly Ticker[]): Promise<readonly PriceSnapshot[]> {
    if (tickers.length === 0) return [];
    const observedAt = this.clock.nowIso();
    const rows = await this.run(() => this.client.quote(tickers));
    return rows.map((row) => mapQuote(row, observedAt));
  }

  async getDailyBars(ticker: Ticker, query: BarsQuery): Promise<readonly DailyBar[]> {
    const interval = query.interval ?? "1d";
    return this.cached(`chart:${ticker}:${query.from}:${query.to}:${interval}`, async () => {
      const raw = await this.client.chart(ticker, {
        period1: query.from,
        period2: query.to,
        interval,
      });
      return mapChart(raw);
    });
  }

  async getFxRate(pair: string): Promise<FxQuote> {
    const [snapshot] = await this.getQuotes([pair]);
    if (snapshot === undefined || snapshot.close === null) {
      throw new MarketDataError(`no rate came back for "${pair}"`, "transient");
    }
    // "EURUSD=X" quotes USD per one EUR, which is exactly the convention
    // `money.toEur` expects: units of local currency per one EUR.
    const base = pair.slice(0, 3);
    const quote = pair.slice(3, 6);
    return {
      pair,
      base,
      quote,
      rate: snapshot.close,
      asOf: snapshot.asOf,
    };
  }

  async getFundamentals(ticker: Ticker): Promise<Fundamentals> {
    const observedAt = this.clock.nowIso();
    const raw = await this.run(() => this.client.quoteSummary(ticker, FUNDAMENTALS_MODULES));
    return mapFundamentals(ticker, raw, observedAt);
  }

  async getNewsForTicker(ticker: Ticker): Promise<readonly NewsItem[]> {
    const raw = await this.run(() => this.client.search(ticker, 10));
    // Yahoo's search returns items that merely mention the query, so the tag
    // is only trusted when Yahoo itself related the story to the instrument.
    return mapNews(raw).map((item) => ({
      ...item,
      tickers: item.tickers.includes(ticker) ? item.tickers : [ticker, ...item.tickers],
    }));
  }

  async search(query: string): Promise<readonly NewsItem[]> {
    const raw = await this.run(() => this.client.search(query, 10));
    return mapNews(raw);
  }

  async getUpcomingEarnings(
    tickers: readonly Ticker[],
    withinDays: number,
  ): Promise<readonly EarningsDate[]> {
    const today = this.clock.today();
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const found: EarningsDate[] = [];
    for (const ticker of tickers) {
      let raw: RawSummary;
      try {
        raw = await this.run(() => this.client.quoteSummary(ticker, ["calendarEvents"]));
      } catch (error) {
        // One name without a calendar must not cost the whole brief its
        // earnings section; a real outage still trips the breaker below.
        if (error instanceof MarketDataError && error.failure === "permanent") continue;
        throw error;
      }
      const earnings = raw.calendarEvents?.earnings;
      for (const value of earnings?.earningsDate ?? []) {
        const date = toDate(value);
        if (date === null || date < today || date > horizon) continue;
        found.push({
          ticker,
          date,
          confirmed: earnings?.isEarningsDateEstimate === false,
        });
      }
    }
    return found;
  }
}
