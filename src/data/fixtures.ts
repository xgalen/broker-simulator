/**
 * `MarketDataPort` over recorded JSON.
 *
 * Every test above the domain runs against this, which is what makes "the
 * domain core must be unit-testable with zero network access" (SPEC 2) true
 * of the layers above it too.
 *
 * It can also be told to fail, which is how the SPEC 14 acceptance check —
 * "a simulated data-source failure produces SKIPPED events and zero trades" —
 * is exercised without unplugging anything.
 */
import type { Ticker } from "../domain/types.js";
import {
  MarketDataError,
  type BarsQuery,
  type DailyBar,
  type EarningsDate,
  type FxQuote,
  type Fundamentals,
  type MarketDataPort,
  type NewsItem,
  type PriceSnapshot,
} from "./port.js";

export interface FixtureData {
  readonly quotes?: readonly PriceSnapshot[];
  readonly bars?: Readonly<Record<Ticker, readonly DailyBar[]>>;
  readonly fx?: Readonly<Record<string, FxQuote>>;
  readonly fundamentals?: Readonly<Record<Ticker, Fundamentals>>;
  readonly news?: Readonly<Record<string, readonly NewsItem[]>>;
  readonly earnings?: readonly EarningsDate[];
}

export interface FixtureOptions {
  /** When set, every call throws this instead of answering. */
  readonly failWith?: MarketDataError;
}

export class FixtureMarketData implements MarketDataPort {
  readonly calls: string[] = [];

  constructor(
    private readonly data: FixtureData,
    private readonly options: FixtureOptions = {},
  ) {}

  /**
   * Every method is `async` so a simulated failure *rejects* rather than
   * throwing synchronously. A caller writing `port.getQuotes(...).catch(...)`
   * must be able to catch it, exactly as it would from the live adapter.
   */
  private record(call: string): void {
    this.calls.push(call);
    if (this.options.failWith) throw this.options.failWith;
  }

  async getQuotes(tickers: readonly Ticker[]): Promise<readonly PriceSnapshot[]> {
    this.record(`getQuotes(${tickers.length})`);
    const wanted = new Set(tickers);
    return (this.data.quotes ?? []).filter((q) => wanted.has(q.ticker));
  }

  async getDailyBars(ticker: Ticker, query: BarsQuery): Promise<readonly DailyBar[]> {
    this.record(`getDailyBars(${ticker})`);
    const bars = this.data.bars?.[ticker] ?? [];
    return bars.filter((b) => b.date >= query.from && b.date <= query.to);
  }

  async getFxRate(pair: string): Promise<FxQuote> {
    this.record(`getFxRate(${pair})`);
    const rate = this.data.fx?.[pair];
    if (rate === undefined) {
      throw new MarketDataError(`no fixture for "${pair}"`, "permanent");
    }
    return rate;
  }

  async getFundamentals(ticker: Ticker): Promise<Fundamentals> {
    this.record(`getFundamentals(${ticker})`);
    const found = this.data.fundamentals?.[ticker];
    if (found === undefined) {
      throw new MarketDataError(`no fixture for "${ticker}"`, "permanent");
    }
    return found;
  }

  async getNewsForTicker(ticker: Ticker): Promise<readonly NewsItem[]> {
    this.record(`getNewsForTicker(${ticker})`);
    return this.data.news?.[ticker] ?? [];
  }

  async search(query: string): Promise<readonly NewsItem[]> {
    this.record(`search(${query})`);
    return this.data.news?.[query] ?? [];
  }

  async getUpcomingEarnings(
    tickers: readonly Ticker[],
    withinDays: number,
  ): Promise<readonly EarningsDate[]> {
    this.record(`getUpcomingEarnings(${tickers.length},${withinDays})`);
    const wanted = new Set(tickers);
    return (this.data.earnings ?? []).filter((e) => wanted.has(e.ticker));
  }
}
