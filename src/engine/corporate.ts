/**
 * Corporate actions (SPEC 8 step 2).
 *
 * Dividends credit cash net of a configurable withholding rate; splits
 * multiply the held quantity. Both are applied before the day's deposit and
 * well before any decision, so an agent reasoning about its own position sees
 * the post-action holding rather than a stale one.
 *
 * Only actions with an ex-date the portfolio actually held through are
 * applied. The window is open-closed — `(lastProcessed, session]` — so a run
 * that was skipped for a data failure picks up the dividends it missed on the
 * next run, and a run that is retried applies none of them twice.
 */
import { eur, roundTo, toEur } from "../domain/money.js";
import type { PortfolioState } from "../domain/replay.js";
import type { IsoDate } from "../domain/types.js";
import type { CorporateAction } from "../data/port.js";
import type { SimulationConfig } from "./config.js";
import type { SessionPrices } from "./pricing.js";

/** A DIVIDEND event's numbers, ready to be stamped with an id and written. */
export interface DividendPayload {
  readonly ticker: string;
  readonly amountLocal: number;
  readonly currency: string;
  readonly fxRate: number;
  readonly withholdingEur: number;
  readonly netEur: number;
}

/** A SPLIT event's numbers. */
export interface SplitPayload {
  readonly ticker: string;
  readonly ratio: number;
}

export interface CorporateActionResult {
  readonly dividends: readonly DividendPayload[];
  readonly splits: readonly SplitPayload[];
  /** Actions that were dropped, and why. Surfaced in the run log. */
  readonly skipped: readonly { readonly action: CorporateAction; readonly reason: string }[];
}

/**
 * The window of ex-dates this session is responsible for.
 *
 * The lower bound is the day after the last mark, because every session the
 * engine completes writes one (SPEC 4). Before the first mark there is nothing
 * held and therefore nothing to pay, so the window collapses to the session.
 */
export function actionWindow(
  state: PortfolioState,
  sessionDate: IsoDate,
): { readonly from: IsoDate; readonly to: IsoDate } {
  const lastMark = state.marks.at(-1);
  if (lastMark === undefined) return { from: sessionDate, to: sessionDate };
  const from = nextDay(lastMark.date);
  return { from: from > sessionDate ? sessionDate : from, to: sessionDate };
}

function nextDay(date: IsoDate): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Turn the session's raw actions into ledger payloads for one portfolio.
 *
 * An action on an instrument the portfolio does not hold is not an error and
 * not an event — it simply does not apply to this portfolio. Something the
 * portfolio *does* hold but cannot be converted (no FX rate for the currency)
 * is reported in `skipped`, because silently dropping a dividend on a held
 * position is a cash figure that quietly stops matching reality.
 */
export function applyCorporateActions(
  state: PortfolioState,
  actions: readonly CorporateAction[],
  prices: SessionPrices,
  simulation: SimulationConfig,
): CorporateActionResult {
  const dividends: DividendPayload[] = [];
  const splits: SplitPayload[] = [];
  const skipped: { action: CorporateAction; reason: string }[] = [];

  // Splits before dividends on the same ticker would change the share count a
  // dividend is paid on. Yahoo dates them so that does not happen in practice,
  // but the ordering is fixed here rather than left to the source: dividends
  // first, on the quantity held through the ex-date, then splits.
  const ordered = [...actions].sort((a, b) =>
    a.date === b.date
      ? a.kind === b.kind
        ? a.ticker.localeCompare(b.ticker)
        : a.kind === "dividend"
          ? -1
          : 1
      : a.date < b.date
        ? -1
        : 1,
  );

  // Quantities are tracked locally so a split earlier in the window is
  // reflected in a dividend later in it, without writing to the ledger twice.
  const heldQty = new Map<string, number>();
  for (const [ticker, position] of state.positions) {
    if (position.qty > 0) heldQty.set(ticker, position.qty);
  }

  for (const action of ordered) {
    const qty = heldQty.get(action.ticker);
    if (qty === undefined || qty <= 0) continue;

    if (action.kind === "split") {
      if (action.ratio === null || !(action.ratio > 0)) {
        skipped.push({ action, reason: "split carries no usable ratio" });
        continue;
      }
      splits.push({ ticker: action.ticker, ratio: action.ratio });
      heldQty.set(action.ticker, qty * action.ratio);
      continue;
    }

    const position = state.positions.get(action.ticker);
    const currency = action.currency ?? position?.currency ?? null;
    if (action.amountLocal === null || !(action.amountLocal > 0) || currency === null) {
      skipped.push({ action, reason: "dividend carries no usable amount or currency" });
      continue;
    }
    const fxRate = prices.fxRateFor(currency);
    if (fxRate === null) {
      skipped.push({ action, reason: `no ${currency} rate to convert the dividend at` });
      continue;
    }

    // Rounded before it is written: `perShare * qty` is a float product of two
    // decimals and lands on things like 0.8963749999999999, which would sit in
    // the committed ledger forever looking like precision it does not have.
    // Six places is well below a cent on any plausible distribution.
    const amountLocal = roundTo(action.amountLocal * qty, 6);
    const grossEur = toEur(amountLocal, fxRate);
    const withholdingEur = eur((grossEur * simulation.dividendWithholdingPct) / 100);
    dividends.push({
      ticker: action.ticker,
      amountLocal,
      currency,
      fxRate,
      withholdingEur,
      // Derived by subtraction from the same rounded figure `replay` will
      // check against, so the two can never disagree by a cent.
      netEur: eur(eur(grossEur) - withholdingEur),
    });
  }

  return { dividends, splits, skipped };
}
