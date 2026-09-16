/**
 * The brief builder (SPEC 12, phase 3).
 *
 * "`src/brief` builds `data/briefs/YYYY-MM-DD.json` once per run, before any
 * agent starts." Everything the five agents share starts here, which makes two
 * properties of this file load-bearing:
 *
 *  - **Deterministic.** The same inputs produce the same bytes and therefore
 *    the same hash. Nothing is read from the host — the clock is injected, the
 *    market data and the feeds arrive through ports, and every collection is
 *    sorted before it is written. A hash that drifted between two builds of the
 *    same day would make every decision record that cites it unverifiable.
 *  - **Honest about gaps.** A missing price is a missing instrument and a
 *    listed gap, never a zero and never a quietly interpolated number.
 *
 * Failure has two levels, and the difference is deliberate. Prices failing is
 * SPEC 1.5 — the caller gets a `MarketDataError`, logs SKIPPED for every
 * portfolio and exits 0, because trading on a bad price is a false trade. News
 * failing is a thinner brief: it is recorded in `sources` and the run goes on,
 * because a missing publisher is not a reason to stop the experiment.
 */
import type { Clock } from "../domain/clock.js";
import { roundTo } from "../domain/money.js";
import type { IsoDate, Ticker } from "../domain/types.js";
import { assertFresh } from "../data/freshness.js";
import { enabledFeeds, type FeedsDocument } from "../data/feeds.js";
import {
  MarketDataError,
  type FreshnessPolicy,
  type MarketDataPort,
  type PriceSnapshot,
} from "../data/port.js";
import type { FeedReaderPort } from "../data/rss.js";
import type { Universe } from "../data/universe.js";
import { sealBrief } from "./hash.js";
import { buildAliasIndex, selectHeadlines, type RawHeadline } from "./headlines.js";
import { computeReturns, EMPTY_RETURNS } from "./returns.js";
import {
  BRIEF_SCHEMA_VERSION,
  BriefError,
  type BriefDocument,
  type EarningsBrief,
  type FxBrief,
  type InstrumentBrief,
  type PriceSnapshotFile,
  type ReferenceBrief,
  type SourceHealth,
  type UnhashedBrief,
} from "./types.js";

/** SPEC 6: "Upcoming earnings dates within the next 7 days". */
const EARNINGS_HORIZON_DAYS = 7;

/**
 * Enough daily bars for a 1y return with room for holidays, half-sessions and
 * the occasional multi-day gap in an illiquid listing.
 */
const DEFAULT_BARS_LOOKBACK_DAYS = 400;

export interface BuildBriefOptions {
  readonly universe: Universe;
  readonly feeds: FeedsDocument;
  readonly market: MarketDataPort;
  readonly feedReader: FeedReaderPort;
  readonly clock: Clock;
  /**
   * The session the brief describes. Derived from the quotes when omitted,
   * which is how SPEC 13 asks for market holidays to be handled: detect that
   * no new close arrived rather than hardcoding a calendar.
   */
  readonly sessionDate?: IsoDate;
  /** When set, SPEC 1.5 is enforced here and a stale universe throws. */
  readonly freshness?: FreshnessPolicy;
  readonly barsLookbackDays?: number;
}

export interface BriefBuildResult {
  readonly brief: BriefDocument;
  /** The raw snapshot for `data/prices/YYYY-MM-DD.json`. */
  readonly prices: PriceSnapshotFile;
}

function shiftDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function pct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return roundTo(current / previous - 1, 6);
}

function byTicker<T extends { readonly ticker: string }>(a: T, b: T): number {
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

/**
 * The session every other date is measured against: the newest close any
 * tradable instrument reported. Taking the maximum rather than the minimum is
 * what makes a regional holiday a gap in one market instead of a brief dated
 * to whichever exchange was shut longest.
 */
function deriveSessionDate(quotes: readonly PriceSnapshot[], universe: Universe): IsoDate {
  let latest: IsoDate | null = null;
  for (const quote of quotes) {
    if (!universe.has(quote.ticker)) continue;
    if (latest === null || quote.sessionDate > latest) latest = quote.sessionDate;
  }
  if (latest === null) {
    throw new MarketDataError(
      "no quote came back for any whitelisted instrument; there is no session to brief on",
      "transient",
    );
  }
  return latest;
}

/** Read every configured feed and every Yahoo query, degrading per source. */
async function collectHeadlineSources(
  options: BuildBriefOptions,
): Promise<{ items: RawHeadline[]; sources: SourceHealth[] }> {
  const items: RawHeadline[] = [];
  const sources: SourceHealth[] = [];

  const results = await options.feedReader.read(enabledFeeds(options.feeds));
  for (const result of results) {
    sources.push({
      source: result.feedId,
      items: result.items.length,
      dropped: result.dropped,
      error: result.error,
    });
    for (const item of result.items) {
      items.push({
        id: `${item.feedId}:${item.id}`,
        title: item.title,
        source: item.feedId,
        url: item.url,
        publishedAt: item.publishedAt,
        tickers: [],
      });
    }
  }

  for (const query of options.feeds.yahoo.queries) {
    const source = `yahoo:${query}`;
    try {
      const news = await options.market.search(query);
      const taken = news.slice(0, options.feeds.yahoo.maxItemsPerQuery);
      sources.push({ source, items: taken.length, dropped: news.length - taken.length, error: null });
      for (const item of taken) {
        items.push({
          id: `${source}:${item.id}`,
          title: item.title,
          source,
          url: item.url,
          publishedAt: item.publishedAt,
          tickers: item.tickers,
        });
      }
    } catch (cause) {
      // A search that fails costs its own stories. The prices are already in
      // hand by this point, so the run still has everything SPEC 1.5 requires.
      sources.push({
        source,
        items: 0,
        dropped: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { items, sources };
}

/**
 * Build today's brief and the price snapshot that backs it.
 *
 * The order matters: prices first, because they decide whether there is a
 * session to brief on at all, then returns, then the news that is only worth
 * gathering once the run knows it is going to happen.
 */
export async function buildBrief(options: BuildBriefOptions): Promise<BriefBuildResult> {
  const { universe, market, clock } = options;
  const generatedAt = clock.nowIso();

  const quotes = await market.getQuotes(universe.quotableTickers);
  const sessionDate = options.sessionDate ?? deriveSessionDate(quotes, universe);

  // SPEC 1.5, when the caller asks for it: stale or missing prices stop the
  // run here, before a single agent has read anything.
  const freshness = options.freshness;
  const staleTickers = freshness
    ? assertFresh(quotes, universe.tickers, freshness).stale.map((entry) => entry.ticker)
    : quotes.filter((q) => universe.has(q.ticker) && q.sessionDate < sessionDate).map((q) => q.ticker);

  const quoteByTicker = new Map<Ticker, PriceSnapshot>();
  for (const quote of quotes) quoteByTicker.set(quote.ticker, quote);

  // --- FX (SPEC 4: USD positions are valued through EURUSD=X) ---------------
  const fx: FxBrief[] = [];
  for (const pair of universe.document.fx) {
    const quoted = quoteByTicker.get(pair.pair);
    const rate =
      quoted?.close ?? (await market.getFxRate(pair.pair).then((q) => q.rate, () => null));
    const asOf = quoted?.asOf ?? generatedAt;
    if (rate === null) {
      // Without the rate, no USD position can be valued and no US order can be
      // sized. That is a data failure, not a gap to note and carry on from.
      throw new MarketDataError(`no rate came back for "${pair.pair}"`, "transient");
    }
    fx.push({ pair: pair.pair, base: pair.base, quote: pair.quote, rate, asOf });
  }

  // --- Instruments and their trailing returns -------------------------------
  const instruments: Record<Ticker, InstrumentBrief> = {};
  const missing: Ticker[] = [];
  const from = shiftDays(sessionDate, -(options.barsLookbackDays ?? DEFAULT_BARS_LOOKBACK_DAYS));

  for (const instrument of universe.document.instruments) {
    const quote = quoteByTicker.get(instrument.ticker);
    if (quote === undefined) {
      missing.push(instrument.ticker);
      continue;
    }

    let returns = EMPTY_RETURNS;
    try {
      const bars = await market.getDailyBars(instrument.ticker, { from, to: sessionDate });
      returns = computeReturns(bars, sessionDate);
    } catch (error) {
      // One instrument without a chart reaches the agents with null returns.
      // Anything worse than "this symbol has no history" is the data source
      // failing, and that is SPEC 1.5's business, not a gap to paper over.
      if (!(error instanceof MarketDataError) || error.failure !== "permanent") throw error;
    }

    instruments[instrument.ticker] = {
      ticker: instrument.ticker,
      name: instrument.name,
      market: instrument.market,
      currency: instrument.currency,
      region: instrument.region,
      type: instrument.type,
      sector: instrument.sector ?? null,
      exposure: instrument.exposure ?? null,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      previousClose: quote.previousClose,
      volume: quote.volume,
      sessionDate: quote.sessionDate,
      asOf: quote.asOf,
      returns,
    };
  }

  // --- Reference levels (SPEC 6: a handful of indices and yields) -----------
  const references: ReferenceBrief[] = [];
  for (const reference of universe.document.references) {
    const quote = quoteByTicker.get(reference.ticker);
    if (quote === undefined) {
      missing.push(reference.ticker);
      continue;
    }
    references.push({
      ticker: reference.ticker,
      name: reference.name,
      kind: reference.kind,
      level: quote.close,
      previousClose: quote.previousClose,
      changePct: pct(quote.close, quote.previousClose),
      sessionDate: quote.sessionDate,
      asOf: quote.asOf,
    });
  }

  // --- Earnings within the week --------------------------------------------
  const earningsSeen = new Set<string>();
  const earnings: EarningsBrief[] = [];
  for (const entry of await market.getUpcomingEarnings(universe.tickers, EARNINGS_HORIZON_DAYS)) {
    const key = `${entry.ticker}:${entry.date}`;
    if (earningsSeen.has(key) || !universe.has(entry.ticker)) continue;
    earningsSeen.add(key);
    earnings.push({ ticker: entry.ticker, date: entry.date, confirmed: entry.confirmed });
  }
  earnings.sort((a, b) => (a.date === b.date ? byTicker(a, b) : a.date < b.date ? -1 : 1));

  // --- Headlines ------------------------------------------------------------
  const collected = await collectHeadlineSources(options);
  const headlines = selectHeadlines(collected.items, {
    asOf: generatedAt,
    maxAgeHours: options.feeds.window.maxAgeHours,
    maxHeadlines: options.feeds.window.maxHeadlines,
    aliases: buildAliasIndex(universe, options.feeds.tagging),
    universe,
  });

  const unhashed: UnhashedBrief = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    date: sessionDate,
    generatedAt,
    fx: [...fx].sort((a, b) => (a.pair < b.pair ? -1 : 1)),
    instruments,
    references: [...references].sort(byTicker),
    headlines,
    earnings,
    gaps: {
      stale: [...new Set(staleTickers)].sort(),
      missing: [...new Set(missing)].sort(),
    },
    sources: collected.sources,
  };

  if (Object.keys(instruments).length === 0) {
    throw new BriefError(`no instrument had a usable quote for ${sessionDate}`);
  }

  return {
    brief: sealBrief(unhashed),
    prices: {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      date: sessionDate,
      fetchedAt: generatedAt,
      quotes: [...quotes].sort(byTicker).map((quote) => ({ ...quote })),
    },
  };
}
