/**
 * The one module that imports `yahoo-finance2`.
 *
 * Everything else in `src/data` talks to the `YahooClient` interface below, so
 * the mapping from Yahoo's shapes to ours is unit-testable against recorded
 * JSON with the library nowhere in the picture.
 *
 * Checked against the shipped v4 type declarations rather than memory:
 *  - v4 is class-based — `new YahooFinance(options)`, no module singleton and
 *    no `setGlobalConfig` (that changed in v3; v4's only breaking change is
 *    requiring Node 22+).
 *  - `historical()` is deprecated: the library itself carries a `ripHistorical`
 *    notice saying it relies on an endpoint Yahoo removed. Daily bars come
 *    from `chart()`.
 *  - The library owns rate limiting: `queue: { concurrency, interval }`. That
 *    is the rate limiter SPEC 6 asks for; stacking a second one on top would
 *    only obscure the timing.
 */
import YahooFinance from "yahoo-finance2";
import { MarketDataError, type RateLimitPolicy } from "./port.js";

/** Minimal shapes, covering only the fields we read. */
export interface RawQuote {
  readonly symbol: string;
  readonly currency?: string | undefined;
  readonly fullExchangeName?: string | undefined;
  readonly exchange?: string | undefined;
  readonly quoteType?: string | undefined;
  readonly regularMarketPrice?: number | undefined;
  readonly regularMarketOpen?: number | undefined;
  readonly regularMarketDayHigh?: number | undefined;
  readonly regularMarketDayLow?: number | undefined;
  readonly regularMarketPreviousClose?: number | undefined;
  readonly regularMarketVolume?: number | undefined;
  readonly regularMarketTime?: Date | string | number | undefined;
}

export interface RawChartQuote {
  readonly date: Date | string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly volume: number | null;
  readonly adjclose?: number | null | undefined;
}

export interface RawChart {
  readonly meta: { readonly currency?: string; readonly symbol?: string; readonly exchangeName?: string };
  readonly quotes: readonly RawChartQuote[];
}

export interface RawSearchNews {
  readonly uuid: string;
  readonly title: string;
  readonly publisher: string;
  readonly link: string;
  readonly providerPublishTime: Date | string;
  readonly relatedTickers?: readonly string[] | undefined;
}

export interface RawSearch {
  readonly news?: readonly RawSearchNews[] | undefined;
}

export interface RawSummary {
  readonly summaryDetail?:
    | {
        readonly marketCap?: number | undefined;
        readonly trailingPE?: number | undefined;
        readonly forwardPE?: number | undefined;
        readonly dividendYield?: number | undefined;
        readonly currency?: string | undefined;
      }
    | undefined;
  readonly defaultKeyStatistics?:
    | { readonly priceToBook?: number | undefined; readonly forwardPE?: number | undefined }
    | undefined;
  readonly financialData?:
    | { readonly returnOnEquity?: number | undefined; readonly debtToEquity?: number | undefined }
    | undefined;
  readonly calendarEvents?:
    | {
        readonly earnings?:
          | {
              readonly earningsDate?: readonly (Date | string)[] | undefined;
              readonly isEarningsDateEstimate?: boolean | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface ChartQuery {
  readonly period1: string;
  readonly period2: string;
  readonly interval: "1d" | "1wk" | "1mo";
}

/** What `src/data` needs from Yahoo, and nothing more. */
export interface YahooClient {
  quote(symbols: readonly string[]): Promise<readonly RawQuote[]>;
  chart(symbol: string, query: ChartQuery): Promise<RawChart>;
  quoteSummary(symbol: string, modules: readonly string[]): Promise<RawSummary>;
  search(query: string, newsCount: number): Promise<RawSearch>;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  // Yahoo is an unofficial, unpaid endpoint. Four in flight with a quarter
  // second between starts walks a 150-symbol universe in well under a minute
  // and has never been the thing that got a run throttled.
  concurrency: 4,
  intervalMs: 250,
};

/**
 * Classify a library error.
 *
 * `transient` is the default for anything unrecognised: the breaker caps how
 * long we can be wrong about that, whereas calling a real outage `permanent`
 * would skip a day of trading over one bad response.
 */
export function classifyError(error: unknown): MarketDataError {
  if (error instanceof MarketDataError) return error;

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  // An unknown symbol or a malformed request: asking again changes nothing.
  if (name === "BadRequestError" || name === "InvalidOptionsError") {
    return new MarketDataError(message, "permanent", error);
  }
  // Yahoo changed a schema. Retrying cannot fix it, and it needs a human.
  if (name === "FailedYahooValidationError") {
    return new MarketDataError(
      `Yahoo returned a shape the client did not expect: ${message}`,
      "permanent",
      error,
    );
  }
  return new MarketDataError(message, "transient", error);
}

export interface YahooClientOptions {
  readonly rateLimit?: RateLimitPolicy;
  /** Injected in tests; defaults to the runtime's own fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Build the live client.
 *
 * `validateResult: false` throughout is deliberate. The library validates
 * responses against bundled schemas and throws when Yahoo adds or moves a
 * field — which happens, and which would take down an unattended daily run
 * over a field we never read. We map defensively instead: every field is
 * optional here and becomes `null` when absent.
 */
export function createYahooClient(options: YahooClientOptions = {}): YahooClient {
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const yf = new YahooFinance({
    queue: { concurrency: rateLimit.concurrency, interval: rateLimit.intervalMs },
    suppressNotices: ["yahooSurvey", "ripHistorical"],
    validation: { logErrors: false },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw classifyError(error);
    }
  };

  return {
    quote: (symbols) =>
      call(async () => {
        const rows = (await yf.quote([...symbols], { return: "array" }, {
          validateResult: false,
        })) as unknown as RawQuote[];
        return rows;
      }),

    chart: (symbol, query) =>
      call(async () => {
        const result = (await yf.chart(
          symbol,
          {
            period1: query.period1,
            period2: query.period2,
            interval: query.interval,
            return: "array",
          },
          { validateResult: false },
        )) as unknown as RawChart;
        return result;
      }),

    quoteSummary: (symbol, modules) =>
      call(async () => {
        const result = (await yf.quoteSummary(
          symbol,
          { modules: [...modules] as never },
          { validateResult: false },
        )) as unknown as RawSummary;
        return result;
      }),

    search: (query, newsCount) =>
      call(async () => {
        const result = (await yf.search(
          query,
          { newsCount, quotesCount: 0 },
          { validateResult: false },
        )) as unknown as RawSearch;
        return result;
      }),
  };
}
