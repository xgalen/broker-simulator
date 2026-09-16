/**
 * Order validation (SPEC 1.6, SPEC 8, SPEC 14).
 *
 * "An order for a ticker not in `config/universe.yaml` is rejected by the
 * validator, logged with the rejection reason, and never reaches the ledger."
 * The same is true of every other guardrail: this module is the only thing
 * standing between what a decider *wants* and what the ledger records, and it
 * says no by writing an ORDER_REJECTED event rather than by throwing.
 *
 * Two things are worth being explicit about.
 *
 * **Sizing here is an estimate.** Orders are validated against the close of the
 * session that produced them, but they fill at the *next* open (SPEC 1.1). A
 * position limit checked today can therefore be a fraction of a percent out
 * tomorrow. That is unavoidable and correct: the alternative is checking the
 * limit against a price the decider was not allowed to see.
 *
 * **Cash is reserved across the batch.** Three orders that each fit the cash
 * balance individually do not fit it together, so the budget is drawn down as
 * the batch is walked, and anything already queued and unfilled is reserved
 * first.
 */
import { eur } from "../domain/money.js";
import type { PortfolioState } from "../domain/replay.js";
import { calendarDaysBetween } from "../domain/valuation.js";
import { dateOf } from "../domain/types.js";
import type { IsoDate } from "../domain/types.js";
import type { Universe } from "../data/universe.js";
import type { PortfolioConfig, SimulationConfig } from "./config.js";
import type { ProposedOrder } from "./decision.js";
import { minimumBuyBudget, sizeBuy, sizeSell, type SessionPrices } from "./pricing.js";

/**
 * Every way an order can be refused. These strings are written verbatim into
 * `ORDER_REJECTED.reasonCode` and are grouped on the dashboard, so they are
 * part of the data format: add codes, never repurpose one.
 */
export const REJECTION_CODES = [
  /** SPEC 1.6: not in `universe.yaml`, or a reference that is not tradable. */
  "off_whitelist",
  /** targetEur is not a usable amount. */
  "invalid_order",
  /** SPEC 8: below `minOrderEur`. */
  "below_min_order",
  /** SPEC 8: `maxTradesPerMonth` already spent. */
  "trade_cap_exceeded",
  /** SPEC 8: `minHoldDays` not yet elapsed on the position being sold. */
  "min_hold_days",
  /** A sell with nothing held. Shorting is off (SPEC 8). */
  "no_position",
  /** Not enough cash above `cashFloorEur` to fund the order. */
  "insufficient_cash",
  /** SPEC 8: `maxPositionPct`, once the portfolio is big enough for it to bite. */
  "position_limit",
  /** No usable price to size against; the decision cannot be costed. */
  "no_price",
  /** SPEC 1.5: the instrument's newest close predates the session. */
  "stale_price",
  /** The order is for a ticker this decision already queued today. */
  "duplicate_order",
  /** Sized down to nothing, or proceeds that would not cover the fee. */
  "unfillable_size",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export type OrderVerdict =
  | { readonly status: "accepted"; readonly order: ProposedOrder; readonly estimatedNetEur: number }
  | {
      readonly status: "rejected";
      readonly order: ProposedOrder;
      readonly reasonCode: RejectionCode;
      readonly detail: string;
    };

export interface ValidationInput {
  readonly portfolio: PortfolioConfig;
  /** State after this session's fills, corporate actions and deposit. */
  readonly state: PortfolioState;
  readonly universe: Universe;
  readonly simulation: SimulationConfig;
  readonly prices: SessionPrices;
  readonly sessionDate: IsoDate;
  readonly orders: readonly ProposedOrder[];
  /** ORDER_PLACED events already recorded this calendar month. */
  readonly tradesThisMonth: number;
  /** Cash + positions at this session's close, for the percentage limits. */
  readonly totalValueEur: number;
}

/** Verdicts in the order they were proposed, so ids line up with intents. */
export function validateOrders(input: ValidationInput): readonly OrderVerdict[] {
  const { portfolio, state, universe, simulation, prices, sessionDate } = input;
  const guardrails = portfolio.guardrails;

  // Cash a buy may actually consume: the balance, less the floor, less
  // whatever earlier orders in this batch have already claimed and whatever is
  // still queued from a session that could not fill.
  let availableEur = eur(state.cashEur - guardrails.cashFloorEur);
  for (const pending of state.pendingOrders.values()) {
    if (pending.order.side === "buy") {
      availableEur = eur(availableEur - pending.order.targetEur);
    }
  }

  let tradesUsed = input.tradesThisMonth;
  const queuedTickers = new Set<string>();
  const verdicts: OrderVerdict[] = [];

  const reject = (
    order: ProposedOrder,
    reasonCode: RejectionCode,
    detail: string,
  ): void => {
    verdicts.push({ status: "rejected", order, reasonCode, detail });
  };

  for (const order of input.orders) {
    if (!Number.isFinite(order.targetEur) || order.targetEur <= 0) {
      reject(order, "invalid_order", `targetEur ${order.targetEur} is not a positive amount`);
      continue;
    }

    // SPEC 1.6 first: an off-whitelist ticker is refused before anything else
    // is computed about it.
    if (!universe.has(order.ticker)) {
      reject(
        order,
        "off_whitelist",
        universe.isReference(order.ticker)
          ? `"${order.ticker}" is a reference instrument and is not tradable`
          : `"${order.ticker}" is not in the universe`,
      );
      continue;
    }

    if (queuedTickers.has(order.ticker)) {
      reject(order, "duplicate_order", `"${order.ticker}" was already queued by this decision`);
      continue;
    }

    if (tradesUsed >= guardrails.maxTradesPerMonth) {
      reject(
        order,
        "trade_cap_exceeded",
        `${tradesUsed} of ${guardrails.maxTradesPerMonth} trades already used this month`,
      );
      continue;
    }

    if (order.targetEur < simulation.minOrderEur) {
      reject(
        order,
        "below_min_order",
        `targetEur ${order.targetEur.toFixed(2)} is below minOrderEur ${simulation.minOrderEur.toFixed(2)}`,
      );
      continue;
    }

    // Sized against the close of the session just ended — the last price the
    // decider was allowed to see.
    const quote = prices.closeOf(order.ticker);
    if (quote === null) {
      reject(order, "no_price", `no usable close for "${order.ticker}" on ${prices.date}`);
      continue;
    }
    if (prices.isStale(order.ticker)) {
      // SPEC 1.5, per instrument: the rest of the universe traded today, this
      // one did not, and an order against yesterday's price is not a trade the
      // portfolio gets to make.
      reject(
        order,
        "stale_price",
        `"${order.ticker}" last closed before ${prices.date}; SPEC 1.5 forbids trading on it`,
      );
      continue;
    }

    if (order.side === "sell") {
      const position = state.positions.get(order.ticker);
      if (position === undefined || position.qty <= 0) {
        reject(
          order,
          "no_position",
          `no position in "${order.ticker}"; shorting is disabled for "${portfolio.key}"`,
        );
        continue;
      }
      const heldDays = calendarDaysBetween(dateOf(position.openedTs), sessionDate);
      if (heldDays < guardrails.minHoldDays) {
        reject(
          order,
          "min_hold_days",
          `held ${heldDays} day(s), below minHoldDays ${guardrails.minHoldDays}`,
        );
        continue;
      }
      const sized = sizeSell(order.targetEur, position.qty, quote, simulation);
      if (!sized.ok) {
        reject(
          order,
          sized.reason === "below_min_order" ? "below_min_order" : "unfillable_size",
          sized.detail,
        );
        continue;
      }
      queuedTickers.add(order.ticker);
      tradesUsed += 1;
      verdicts.push({ status: "accepted", order, estimatedNetEur: sized.terms.netEur });
      continue;
    }

    // --- Buy ---------------------------------------------------------------
    const budget = Math.min(order.targetEur, availableEur);
    if (budget < minimumBuyBudget(simulation)) {
      reject(
        order,
        "insufficient_cash",
        `${availableEur.toFixed(2)} EUR available above the ${guardrails.cashFloorEur.toFixed(2)} EUR floor, need at least ${minimumBuyBudget(simulation).toFixed(2)} to place a ${simulation.minOrderEur.toFixed(2)} EUR order and pay its fee`,
      );
      continue;
    }

    const sized = sizeBuy(budget, quote, simulation);
    if (!sized.ok) {
      reject(
        order,
        sized.reason === "insufficient_cash"
          ? "insufficient_cash"
          : sized.reason === "below_min_order"
            ? "below_min_order"
            : "unfillable_size",
        sized.detail,
      );
      continue;
    }

    const limit = positionLimit(input, order, sized.terms.grossEur, quote.ticker);
    if (limit !== null) {
      reject(order, "position_limit", limit);
      continue;
    }

    availableEur = eur(availableEur - sized.terms.netEur);
    queuedTickers.add(order.ticker);
    tradesUsed += 1;
    verdicts.push({ status: "accepted", order, estimatedNetEur: sized.terms.netEur });
  }

  return verdicts;
}

/**
 * SPEC 8's percentage cap, dormant below `positionLimitsActiveAboveEur`.
 *
 * "A 25% position cap on a 50 EUR portfolio means 12.50 EUR per name, below
 * `minOrderEur`, and the agent would be unable to act at all in month one."
 * So the limit does not apply until the portfolio is worth enough for it to
 * mean something. Returns the rejection detail, or `null` when the order fits.
 */
function positionLimit(
  input: ValidationInput,
  order: ProposedOrder,
  addedEur: number,
  ticker: string,
): string | null {
  const { guardrails } = input.portfolio;
  if (guardrails.maxPositionPct >= 100) return null;
  if (input.totalValueEur <= guardrails.positionLimitsActiveAboveEur) return null;

  const existing = input.state.positions.get(ticker);
  const existingValue =
    existing === undefined ? 0 : (input.prices.closeOf(ticker)?.priceLocal ?? 0) * existing.qty;
  const existingEur =
    existing === undefined
      ? 0
      : existingValue / (input.prices.closeOf(ticker)?.fxRate ?? 1);

  // The buy does not change total equity — it moves cash into a position — so
  // the denominator is today's total value, not the value plus the purchase.
  const afterEur = existingEur + addedEur;
  const capEur = (input.totalValueEur * guardrails.maxPositionPct) / 100;
  if (afterEur <= capEur + 0.005) return null;

  return `"${order.ticker}" would reach ${afterEur.toFixed(2)} EUR, above the ${guardrails.maxPositionPct}% cap of ${capEur.toFixed(2)} EUR on a ${input.totalValueEur.toFixed(2)} EUR portfolio`;
}
