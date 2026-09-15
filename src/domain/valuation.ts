/**
 * Mark-to-market, with price and FX contributions kept apart.
 *
 * SPEC 4: "A portfolio can be up because the dollar moved, and the dashboard
 * must not let that masquerade as stock picking." The decomposition below is
 * exact: for an open lot bought at price P0 and rate F0, marked at P1 and F1,
 *
 *   price P&L = qty x (P1 - P0) / F0          (price move, entry FX)
 *   FX    P&L = qty x P1 x (1/F1 - 1/F0)      (FX move, exit price)
 *   sum       = qty x (P1/F1 - P0/F0)         (the whole gross EUR move)
 */
import type { Clock } from "./clock.js";
import type { ValuationPosition } from "./events.js";
import { eur, toEur } from "./money.js";
import type { PortfolioState, Position } from "./replay.js";
import { dateOf } from "./types.js";
import type { Currency, IsoDate, Ticker } from "./types.js";

/** A point-in-time price for one instrument, from the committed snapshot. */
export interface PriceQuote {
  readonly ticker: Ticker;
  readonly priceLocal: number;
  readonly currency: Currency;
  /** Units of `currency` per EUR; exactly 1 for EUR instruments. */
  readonly fxRate: number;
}

export interface PositionValuation {
  readonly ticker: Ticker;
  readonly currency: Currency;
  readonly qty: number;
  readonly priceLocal: number;
  readonly fxRate: number;
  readonly marketValueEur: number;
  readonly costBasisEur: number;
  /** marketValue - all-in cost. Includes the fees paid to get in. */
  readonly unrealizedPnlEur: number;
  readonly pricePnlEur: number;
  readonly fxPnlEur: number;
  readonly feesEur: number;
}

export interface PortfolioValuation {
  readonly cashEur: number;
  readonly marketValueEur: number;
  readonly totalValueEur: number;
  readonly costBasisEur: number;
  readonly unrealizedPnlEur: number;
  readonly unrealizedPricePnlEur: number;
  readonly unrealizedFxPnlEur: number;
  /** Realized plus unrealized FX contribution to date. */
  readonly fxEffectEur: number;
  readonly contributedToDateEur: number;
  readonly positions: readonly PositionValuation[];
  /** Tickers held with no quote in the snapshot; excluded from market value. */
  readonly missingQuotes: readonly Ticker[];
}

/** Mark one open position against a quote. */
export function valuePosition(
  position: Position,
  quote: PriceQuote,
): PositionValuation {
  const marketValue = toEur(position.qty * quote.priceLocal, quote.fxRate);
  const entryPriceLocal =
    position.qty === 0 ? 0 : position.localCostBasis / position.qty;
  const entryFxRate =
    position.grossCostEur === 0
      ? quote.fxRate
      : position.localCostBasis / position.grossCostEur;
  const pricePnl = toEur(
    position.qty * (quote.priceLocal - entryPriceLocal),
    entryFxRate,
  );
  const fxPnl =
    position.qty * quote.priceLocal * (1 / quote.fxRate - 1 / entryFxRate);

  return {
    ticker: position.ticker,
    currency: position.currency,
    qty: position.qty,
    priceLocal: quote.priceLocal,
    fxRate: quote.fxRate,
    marketValueEur: eur(marketValue),
    costBasisEur: position.costBasisEur,
    unrealizedPnlEur: eur(marketValue - position.costBasisEur),
    pricePnlEur: eur(pricePnl),
    fxPnlEur: eur(fxPnl),
    feesEur: eur(position.feesEur + position.fxCostsEur),
  };
}

/**
 * Mark a whole portfolio. Positions without a quote are reported in
 * `missingQuotes` rather than silently valued at zero — a missing price is a
 * data failure (SPEC 1.5), not a wipeout.
 */
export function valuePortfolio(
  state: PortfolioState,
  quotes: ReadonlyMap<Ticker, PriceQuote>,
): PortfolioValuation {
  const positions: PositionValuation[] = [];
  const missingQuotes: Ticker[] = [];
  let marketValue = 0;
  let costBasis = 0;
  let pricePnl = 0;
  let fxPnl = 0;

  for (const ticker of [...state.positions.keys()].sort()) {
    const position = state.positions.get(ticker);
    if (position === undefined || position.qty <= 0) continue;
    const quote = quotes.get(ticker);
    if (quote === undefined) {
      missingQuotes.push(ticker);
      continue;
    }
    const valued = valuePosition(position, quote);
    positions.push(valued);
    marketValue += valued.marketValueEur;
    costBasis += valued.costBasisEur;
    pricePnl += valued.pricePnlEur;
    fxPnl += valued.fxPnlEur;
  }

  return {
    cashEur: state.cashEur,
    marketValueEur: eur(marketValue),
    totalValueEur: eur(state.cashEur + marketValue),
    costBasisEur: eur(costBasis),
    unrealizedPnlEur: eur(marketValue - costBasis),
    unrealizedPricePnlEur: eur(pricePnl),
    unrealizedFxPnlEur: eur(fxPnl),
    fxEffectEur: eur(state.realizedFxPnlEur + fxPnl),
    contributedToDateEur: state.contributedToDateEur,
    positions,
    missingQuotes,
  };
}

/**
 * The payload of the daily VALUATION event (SPEC 4). The engine supplies
 * `id`, `ts` and `portfolio`; everything numeric comes from here so that the
 * written mark always agrees with a replay of the log.
 */
export function buildValuationPayload(valuation: PortfolioValuation): {
  cashEur: number;
  positions: ValuationPosition[];
  marketValueEur: number;
  fxEffectEur: number;
  contributedToDateEur: number;
} {
  return {
    cashEur: valuation.cashEur,
    positions: valuation.positions.map((p) => ({
      ticker: p.ticker,
      qty: p.qty,
      priceLocal: p.priceLocal,
      currency: p.currency,
      fxRate: p.fxRate,
      valueEur: p.marketValueEur,
    })),
    marketValueEur: valuation.marketValueEur,
    fxEffectEur: valuation.fxEffectEur,
    contributedToDateEur: valuation.contributedToDateEur,
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two UTC calendar dates. */
export function calendarDaysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

export interface Staleness {
  readonly lastMarkDate: IsoDate | null;
  readonly ageDays: number | null;
  readonly stale: boolean;
}

/**
 * How old the last mark is relative to the injected clock (SPEC 11: on
 * weekends and holidays the previous mark is carried forward and flagged
 * stale; SPEC 1.5: a stale price means no trading).
 *
 * The clock is a parameter because the domain never reads the host clock.
 */
export function markStaleness(
  state: PortfolioState,
  clock: Clock,
  { maxAgeDays = 1 }: { maxAgeDays?: number } = {},
): Staleness {
  const last = state.marks.at(-1);
  if (last === undefined) {
    return { lastMarkDate: null, ageDays: null, stale: true };
  }
  const ageDays = calendarDaysBetween(dateOf(last.ts), clock.today());
  return { lastMarkDate: last.date, ageDays, stale: ageDays > maxAgeDays };
}
