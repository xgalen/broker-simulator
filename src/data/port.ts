/**
 * The market-data port (SPEC 12, phase 2).
 *
 * `src/domain` is pure and `src/data` is where the network lives. This file is
 * the seam between them: an interface plus its value types, with no import of
 * `yahoo-finance2` anywhere in it. The Yahoo adapter implements it, the
 * fixture adapter implements it, and every test above the domain runs against
 * the fixture one — so no test can reach the network by accident.
 *
 * Everything returned here is a point-in-time record (SPEC 6): each value
 * carries the instant it was observed, and `data/prices/YYYY-MM-DD.json` keeps
 * the snapshot forever. Yahoo revises history; the committed snapshot is the
 * truth for that day.
 */
import type { Currency, IsoDate, IsoTimestamp, Ticker } from "../domain/types.js";

// --- Values -----------------------------------------------------------------

/** One instrument at the latest close, as the brief will quote it. */
export interface PriceSnapshot {
  readonly ticker: Ticker;
  readonly currency: Currency;
  /** Home market, which decides when the next open is (SPEC 1.1). */
  readonly exchange: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly previousClose: number | null;
  readonly volume: number | null;
  /** When Yahoo says this price was struck. The input to the staleness check. */
  readonly asOf: IsoTimestamp;
  /** The session this close belongs to. */
  readonly sessionDate: IsoDate;
}

/** A daily bar. `chart()`, never the deprecated `historical()`. */
export interface DailyBar {
  readonly date: IsoDate;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly adjClose: number | null;
  readonly volume: number | null;
}

/** `EURUSD=X` and anything like it: units of `quote` per one `base`. */
export interface FxQuote {
  readonly pair: string;
  readonly base: Currency;
  readonly quote: Currency;
  readonly rate: number;
  readonly asOf: IsoTimestamp;
}

export interface Fundamentals {
  readonly ticker: Ticker;
  readonly currency: Currency | null;
  readonly marketCap: number | null;
  readonly trailingPe: number | null;
  readonly forwardPe: number | null;
  readonly priceToBook: number | null;
  readonly dividendYield: number | null;
  readonly returnOnEquity: number | null;
  readonly debtToEquity: number | null;
  readonly asOf: IsoTimestamp;
}

export interface NewsItem {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt: IsoTimestamp;
  /** Instruments the item resolves to, where resolvable (SPEC 6). */
  readonly tickers: readonly Ticker[];
}

export interface EarningsDate {
  readonly ticker: Ticker;
  readonly date: IsoDate;
  /** Yahoo gives estimated windows as well as confirmed dates. */
  readonly confirmed: boolean;
}

export interface BarsQuery {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly interval?: "1d" | "1wk" | "1mo";
}

/**
 * A dividend or a split, as the engine applies it (SPEC 8 step 2).
 *
 * One type rather than two because the engine asks one question — "what
 * happened to this instrument between these dates" — and because a source that
 * reports both in one response should not be split into two round trips.
 * `date` is the ex-date: the session on or after which a holder is entitled,
 * which is the only date the ledger can act on.
 */
export interface CorporateAction {
  readonly ticker: Ticker;
  readonly date: IsoDate;
  readonly kind: "dividend" | "split";
  /** Dividend: cash per share, in `currency`. `null` for a split. */
  readonly amountLocal: number | null;
  readonly currency: Currency | null;
  /** Split: shares after, per share before. A 4-for-1 is 4. `null` otherwise. */
  readonly ratio: number | null;
}

// --- The port ---------------------------------------------------------------

/**
 * Everything the brief builder and the agent tools may ask of the outside
 * world. Implementations: `YahooMarketData` (live) and `FixtureMarketData`
 * (recorded JSON, used by every test).
 *
 * Every method either returns data or throws a `MarketDataError`. None of them
 * decides what a failure means — that is the caller's job, and for the daily
 * run it means SPEC 1.5: log SKIPPED for every portfolio and exit 0.
 */
export interface MarketDataPort {
  /** Latest close for many instruments. Batched and rate-limited internally. */
  getQuotes(tickers: readonly Ticker[]): Promise<readonly PriceSnapshot[]>;
  getDailyBars(ticker: Ticker, query: BarsQuery): Promise<readonly DailyBar[]>;
  /** Dividends and splits with an ex-date inside the window (SPEC 8 step 2). */
  getCorporateActions(
    ticker: Ticker,
    query: BarsQuery,
  ): Promise<readonly CorporateAction[]>;
  getFxRate(pair: string): Promise<FxQuote>;
  getFundamentals(ticker: Ticker): Promise<Fundamentals>;
  getNewsForTicker(ticker: Ticker): Promise<readonly NewsItem[]>;
  search(query: string): Promise<readonly NewsItem[]>;
  getUpcomingEarnings(
    tickers: readonly Ticker[],
    withinDays: number,
  ): Promise<readonly EarningsDate[]>;
}

// --- Failure ----------------------------------------------------------------

export type MarketDataFailure =
  /** Network, 5xx, timeout: worth another attempt. */
  | "transient"
  /** 4xx, unknown symbol, schema mismatch: another attempt changes nothing. */
  | "permanent"
  /** The breaker is open; nothing was even attempted. */
  | "circuit_open"
  /** Data arrived but is older than the last session close (SPEC 1.5). */
  | "stale";

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly failure: MarketDataFailure,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MarketDataError";
  }

  get retryable(): boolean {
    return this.failure === "transient";
  }
}

/**
 * The SPEC 1.5 condition, raised as one type whatever caused it: the fetch
 * failed, or it succeeded and handed back yesterday's prices. Both mean the
 * same thing to the engine — do not trade today.
 */
export class StaleDataError extends MarketDataError {
  constructor(
    message: string,
    readonly detail: {
      readonly ticker?: Ticker;
      readonly expectedOnOrAfter: IsoDate;
      readonly observed: IsoTimestamp | null;
    },
  ) {
    super(message, "stale");
    this.name = "StaleDataError";
  }
}

// --- Policy -----------------------------------------------------------------

/** Exponential backoff with jitter. Only `transient` failures are retried. */
export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
}

/**
 * Maps onto `yahoo-finance2`'s own queue, which already serialises requests:
 * `new YahooFinance({ queue: { concurrency, interval } })`.
 */
export interface RateLimitPolicy {
  readonly concurrency: number;
  readonly intervalMs: number;
}

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Trips after `failureThreshold` consecutive transient failures and stays open
 * for `cooldownMs`. While open, every call fails immediately with
 * `circuit_open` — which the daily run treats exactly as SPEC 1.5 stale data,
 * rather than hammering a service that is already down.
 */
export interface CircuitPolicy {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

/**
 * How new a price has to be. The run knows the last session close it expects;
 * anything older is stale no matter how cleanly it arrived.
 */
export interface FreshnessPolicy {
  readonly expectedSessionOnOrAfter: IsoDate;
  /** Instruments allowed to lag (a market holiday in one region only). */
  readonly toleratedStaleTickers?: readonly Ticker[];
}

export interface MarketDataConfig {
  readonly retry: RetryPolicy;
  readonly rateLimit: RateLimitPolicy;
  readonly circuit: CircuitPolicy;
}

/** What the run logs and the dashboard shows about the data layer's health. */
export interface DataSourceHealth {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastFailure: { readonly at: IsoTimestamp; readonly message: string } | null;
  readonly requests: number;
  readonly retries: number;
}

// --- Caching ----------------------------------------------------------------

/**
 * Point-in-time cache (SPEC 6). Keys are content-addressed by request, values
 * are whatever the adapter received. The daily snapshot is written once and
 * never refetched: re-reading history from Yahoo would rewrite the past.
 */
export interface ResponseCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
}
