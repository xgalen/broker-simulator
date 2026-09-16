/**
 * Prices for one session, and the arithmetic that turns an order into a fill.
 *
 * Two jobs, kept together because they share one invariant: the numbers this
 * module produces have to survive `replay`'s cross-checks exactly. A fill is
 * written once and re-derived on every rebuild, so `grossEur` must equal
 * `qty x priceLocal / fxRate` to the cent and `netEur` must equal gross plus
 * or minus its costs. Anything computed loosely here becomes a
 * FILL_AMOUNTS_INCONSISTENT violation in `pnpm verify` three weeks later.
 *
 * SPEC 1.1 lives here too, in the shape of the API: `openOf` is the only way
 * to price a fill and it reads the session the engine is *currently* running,
 * which is strictly after the session the deciding brief described.
 */
import { eur, floorTo, QTY_DP, qty as roundQty } from "../domain/money.js";
import type { PriceQuote } from "../domain/valuation.js";
import type { Currency, IsoDate, Ticker } from "../domain/types.js";
import type { BriefDocument } from "../brief/types.js";
import type { SimulationConfig } from "./config.js";

/** The smallest share increment the ledger can express (SPEC 4: 4dp). */
const QTY_TICK = 10 ** -QTY_DP;

/** A tradable price with everything needed to move it into EUR. */
export interface ExecutionQuote {
  readonly ticker: Ticker;
  readonly priceLocal: number;
  readonly currency: Currency;
  /** Units of `currency` per one EUR; exactly 1 for EUR instruments. */
  readonly fxRate: number;
}

/**
 * The session's prices, read off the brief.
 *
 * The brief is the committed point-in-time record (SPEC 6), so the engine
 * prices everything from it rather than re-asking the data layer: a fill and
 * the mark that follows it then agree by construction, and a rerun of the day
 * reproduces both.
 */
export class SessionPrices {
  private readonly fxByCurrency: ReadonlyMap<Currency, number>;
  private readonly staleTickers: ReadonlySet<Ticker>;

  constructor(readonly brief: BriefDocument) {
    this.staleTickers = new Set(brief.gaps.stale);
    const fx = new Map<Currency, number>([["EUR", 1]]);
    for (const pair of brief.fx) {
      // `EURUSD=X` quotes USD per one EUR: base EUR, quote USD, rate 1.08.
      // That is the convention `money.toEur` divides by, so it is stored
      // against the quote currency untouched.
      if (pair.base === "EUR") fx.set(pair.quote, pair.rate);
    }
    this.fxByCurrency = fx;
  }

  get date(): IsoDate {
    return this.brief.date;
  }

  /**
   * True when this instrument's newest close predates the session — a market
   * shut for a regional holiday while the rest of the universe traded.
   *
   * Such a name is still marked, at its last close and flagged (SPEC 11: carry
   * the previous mark forward, never interpolate), but it must not be traded:
   * SPEC 1.5 is unconditional about not trading on stale prices.
   */
  isStale(ticker: Ticker): boolean {
    if (this.staleTickers.has(ticker)) return true;
    const instrument = this.brief.instruments[ticker];
    return instrument !== undefined && instrument.sessionDate !== this.brief.date;
  }

  /** Units of `currency` per EUR, or `null` when the pair is not quoted. */
  fxRateFor(currency: Currency): number | null {
    const rate = this.fxByCurrency.get(currency);
    return rate !== undefined && rate > 0 ? rate : null;
  }

  /**
   * This session's opening price — the only price an order placed yesterday
   * may be filled at (SPEC 1.1).
   *
   * `null` when the market printed no usable open. The engine leaves such an
   * order queued rather than reaching for the close, which would be a price
   * struck hours after the fill was supposed to happen.
   */
  openOf(ticker: Ticker): ExecutionQuote | null {
    // An instrument whose market did not open today has no "today's open" to
    // fill at. Reaching for the one it printed on its last trading day would
    // be filling at a price the decider could already see — precisely the
    // look-ahead SPEC 1.1 forbids.
    if (this.isStale(ticker)) return null;
    return this.quoteAt(ticker, "open");
  }

  /** This session's close, which is what the daily mark is taken at. */
  closeOf(ticker: Ticker): ExecutionQuote | null {
    return this.quoteAt(ticker, "close");
  }

  private quoteAt(ticker: Ticker, field: "open" | "close"): ExecutionQuote | null {
    const instrument = this.brief.instruments[ticker];
    if (instrument === undefined) return null;
    const priceLocal = instrument[field];
    if (priceLocal === null || !(priceLocal > 0)) return null;
    const fxRate = this.fxRateFor(instrument.currency);
    if (fxRate === null) return null;
    return { ticker, priceLocal, currency: instrument.currency, fxRate };
  }

  /** Every held ticker marked at the close, for `valuePortfolio`. */
  closingQuotes(tickers: Iterable<Ticker>): Map<Ticker, PriceQuote> {
    const quotes = new Map<Ticker, PriceQuote>();
    for (const ticker of tickers) {
      const quote = this.closeOf(ticker);
      if (quote !== null) quotes.set(ticker, quote);
    }
    return quotes;
  }
}

// --- Order sizing -----------------------------------------------------------

/** The numbers an ORDER_FILLED event carries, ready to be written. */
export interface FillTerms {
  readonly qty: number;
  readonly priceLocal: number;
  readonly currency: Currency;
  readonly fxRate: number;
  readonly grossEur: number;
  readonly feeEur: number;
  readonly fxCostEur: number;
  /** Magnitude of the cash movement, always positive (SPEC 4). */
  readonly netEur: number;
}

export type SizingFailure =
  /** The budget cannot cover the fee and spread, let alone a share. */
  | "insufficient_cash"
  /** What is left after costs buys less than one 4dp share tick. */
  | "below_min_quantity"
  /** Gross notional below `minOrderEur` (SPEC 8). */
  | "below_min_order"
  /** A sell whose proceeds would not cover its own fee. */
  | "proceeds_below_costs";

export type SizingResult =
  | { readonly ok: true; readonly terms: FillTerms }
  | { readonly ok: false; readonly reason: SizingFailure; readonly detail: string };

/**
 * The smallest all-in budget that could produce a valid buy.
 *
 * An order of exactly `minOrderEur` in notional still has to pay the fee out of
 * the same cash (see `sizeBuy`), so a budget below `minOrderEur + fee` cannot
 * yield one whatever the price is. Callers check this *before* sizing so that a
 * shortage of cash is reported as a shortage of cash, rather than as the
 * too-small order it eventually becomes.
 */
export function minimumBuyBudget(simulation: SimulationConfig): number {
  return simulation.minOrderEur + simulation.feePerOrderEur;
}

/** The FX spread (SPEC 8), as a fraction. Zero on EUR instruments. */
export function spreadRateFor(currency: Currency, simulation: SimulationConfig): number {
  return currency === "EUR" ? 0 : simulation.fxSpreadBps / 10_000;
}

/**
 * Size a buy against an all-in cash budget.
 *
 * `targetEur` is the total cash leaving the portfolio, fee and FX spread
 * included — not the notional with costs added on top. The distinction decides
 * whether `dca` works at all: SPEC 5 says it "buys with the full contribution",
 * and a 50 EUR contribution cannot also pay a 1 EUR fee out of a 51st euro
 * that does not exist.
 */
export function sizeBuy(
  budgetEur: number,
  quote: ExecutionQuote,
  simulation: SimulationConfig,
): SizingResult {
  const feeEur = simulation.feePerOrderEur;
  const spread = spreadRateFor(quote.currency, simulation);

  const maxGross = (budgetEur - feeEur) / (1 + spread);
  if (!(maxGross > 0)) {
    return {
      ok: false,
      reason: "insufficient_cash",
      detail: `${budgetEur.toFixed(2)} EUR does not cover the ${feeEur.toFixed(2)} EUR fee`,
    };
  }

  let qty = floorTo((maxGross * quote.fxRate) / quote.priceLocal, QTY_DP);
  if (!(qty > 0)) {
    return {
      ok: false,
      reason: "below_min_quantity",
      detail: `${maxGross.toFixed(2)} EUR buys less than ${QTY_TICK} of "${quote.ticker}" at ${quote.priceLocal}`,
    };
  }

  // Rounding the quantity down to 4dp and then rounding each EUR figure to the
  // cent can still land a cent over budget. Step the quantity back a tick at a
  // time until it does not: cash must never go negative (SPEC 4), and a loop
  // that can only shrink terminates.
  let terms = buildTerms(qty, quote, feeEur, spread, "buy");
  while (terms.netEur > budgetEur + 1e-9 && qty > 0) {
    qty = roundQty(qty - QTY_TICK);
    if (!(qty > 0)) {
      return {
        ok: false,
        reason: "below_min_quantity",
        detail: `no whole quantity of "${quote.ticker}" fits ${budgetEur.toFixed(2)} EUR after costs`,
      };
    }
    terms = buildTerms(qty, quote, feeEur, spread, "buy");
  }

  if (terms.grossEur < simulation.minOrderEur) {
    return {
      ok: false,
      reason: "below_min_order",
      detail: `gross ${terms.grossEur.toFixed(2)} EUR is below minOrderEur ${simulation.minOrderEur.toFixed(2)}`,
    };
  }

  return { ok: true, terms };
}

/**
 * Size a sell against an EUR target, capped by the quantity actually held.
 *
 * A target at or above the whole position closes it: leaving a 0.0001-share
 * remainder behind would keep a position open, keep it in every mark, and
 * distort `minHoldDays` and the holding-period statistics for the sake of a
 * rounding artefact.
 */
export function sizeSell(
  targetEur: number,
  heldQty: number,
  quote: ExecutionQuote,
  simulation: SimulationConfig,
): SizingResult {
  if (!(heldQty > 0)) {
    return {
      ok: false,
      reason: "below_min_quantity",
      detail: `no position in "${quote.ticker}" to sell`,
    };
  }

  const feeEur = simulation.feePerOrderEur;
  const spread = spreadRateFor(quote.currency, simulation);
  const wanted = floorTo((targetEur * quote.fxRate) / quote.priceLocal, QTY_DP);

  // Within one tick of the whole position, or over it: close it out.
  const qty = wanted >= heldQty - QTY_TICK ? roundQty(heldQty) : wanted;
  if (!(qty > 0)) {
    return {
      ok: false,
      reason: "below_min_quantity",
      detail: `${targetEur.toFixed(2)} EUR is less than ${QTY_TICK} of "${quote.ticker}" at ${quote.priceLocal}`,
    };
  }

  const terms = buildTerms(qty, quote, feeEur, spread, "sell");
  if (!(terms.netEur > 0)) {
    return {
      ok: false,
      reason: "proceeds_below_costs",
      detail: `gross ${terms.grossEur.toFixed(2)} EUR does not cover ${feeEur.toFixed(2)} EUR of fees and ${terms.fxCostEur.toFixed(2)} EUR of spread`,
    };
  }
  if (terms.grossEur < simulation.minOrderEur && qty < heldQty) {
    // A partial sell below the minimum is a rejected order; closing a position
    // that has *become* smaller than the minimum is not, or dust would be
    // untradable forever.
    return {
      ok: false,
      reason: "below_min_order",
      detail: `gross ${terms.grossEur.toFixed(2)} EUR is below minOrderEur ${simulation.minOrderEur.toFixed(2)}`,
    };
  }

  return { ok: true, terms };
}

function buildTerms(
  qty: number,
  quote: ExecutionQuote,
  feeEur: number,
  spread: number,
  side: "buy" | "sell",
): FillTerms {
  const grossEur = eur((qty * quote.priceLocal) / quote.fxRate);
  const fxCostEur = eur(grossEur * spread);
  const feeRounded = eur(feeEur);
  return {
    qty,
    priceLocal: quote.priceLocal,
    currency: quote.currency,
    fxRate: quote.fxRate,
    grossEur,
    feeEur: feeRounded,
    fxCostEur,
    netEur: eur(
      side === "buy"
        ? grossEur + feeRounded + fxCostEur
        : grossEur - feeRounded - fxCostEur,
    ),
  };
}
