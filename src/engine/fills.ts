/**
 * Fill simulation (SPEC 8 step 1, SPEC 1.1).
 *
 * "Fill pending orders from the previous run, using today's open in the
 * asset's home market."
 *
 * The no-look-ahead rule is enforced structurally rather than trusted: an
 * order may only be filled on a session strictly after the one it was placed
 * on, and the only price this module will use is that later session's open.
 * The close of the deciding session — the last number the decider actually saw
 * — is never reachable from here.
 *
 * One order is filled per call, against the state as it stands at that moment.
 * The caller re-derives state from the log between calls, so two buys queued
 * on the same day cannot both spend the same euro.
 */
import { eur } from "../domain/money.js";
import type { OrderPlacedEvent } from "../domain/events.js";
import type { PortfolioState } from "../domain/replay.js";
import { dateOf } from "../domain/types.js";
import type { IsoDate } from "../domain/types.js";
import type { Universe } from "../data/universe.js";
import type { Guardrails, SimulationConfig } from "./config.js";
import {
  minimumBuyBudget,
  sizeBuy,
  sizeSell,
  type FillTerms,
  type SessionPrices,
} from "./pricing.js";
import type { RejectionCode } from "./validate.js";

/** Codes a fill attempt can add on top of the validator's (SPEC 8 timing). */
export const FILL_REJECTION_CODES = ["order_expired"] as const;

export type FillRejectionCode = RejectionCode | (typeof FILL_REJECTION_CODES)[number];

export type FillOutcome =
  | { readonly kind: "filled"; readonly order: OrderPlacedEvent; readonly terms: FillTerms }
  | {
      readonly kind: "rejected";
      readonly order: OrderPlacedEvent;
      readonly reasonCode: FillRejectionCode;
      readonly detail: string;
    }
  /** No usable open today. The order stays queued and tries the next session. */
  | { readonly kind: "deferred"; readonly order: OrderPlacedEvent; readonly reason: string };

export interface FillInput {
  readonly order: OrderPlacedEvent;
  readonly state: PortfolioState;
  readonly prices: SessionPrices;
  readonly universe: Universe;
  readonly simulation: SimulationConfig;
  readonly guardrails: Guardrails;
  readonly sessionDate: IsoDate;
}

/**
 * How many sessions have closed since the order was placed.
 *
 * Counted in marks, not in calendar days: one VALUATION is written per trading
 * session (SPEC 4), so this is an exchange-calendar-free session count, and a
 * long weekend does not age an order three days.
 */
export function sessionsSincePlaced(
  state: PortfolioState,
  order: OrderPlacedEvent,
): number {
  const placedDate = dateOf(order.ts);
  return state.marks.filter((mark) => mark.date > placedDate).length;
}

/** Attempt one pending order against this session's open. */
export function fillOrder(input: FillInput): FillOutcome {
  const { order, state, prices, universe, simulation, guardrails, sessionDate } = input;

  // SPEC 1.1, as a hard gate. Nothing below can run on the day of the
  // decision, whatever the caller thinks it is doing.
  if (sessionDate <= dateOf(order.ts)) {
    return {
      kind: "deferred",
      order,
      reason: `placed on ${dateOf(order.ts)}; the next session is the earliest it may fill`,
    };
  }

  // The whitelist is re-checked at fill time: an instrument can be removed
  // from `universe.yaml` while an order sits in the queue, and filling it then
  // would put an untradable position in the book (SPEC 1.6).
  if (!universe.has(order.ticker)) {
    return {
      kind: "rejected",
      order,
      reasonCode: "off_whitelist",
      detail: `"${order.ticker}" left the universe before this order could fill`,
    };
  }

  const quote = prices.openOf(order.ticker);
  if (quote === null) {
    const waited = sessionsSincePlaced(state, order);
    if (waited >= simulation.engine.pendingOrderExpirySessions) {
      return {
        kind: "rejected",
        order,
        reasonCode: "order_expired",
        detail: `no usable open for "${order.ticker}" in ${waited} session(s); the thesis is stale`,
      };
    }
    return {
      kind: "deferred",
      order,
      reason: `no usable open for "${order.ticker}" on ${sessionDate}`,
    };
  }

  if (order.side === "sell") {
    const position = state.positions.get(order.ticker);
    if (position === undefined || position.qty <= 0) {
      return {
        kind: "rejected",
        order,
        reasonCode: "no_position",
        detail: `nothing held in "${order.ticker}" by the time the order reached the open`,
      };
    }
    const sized = sizeSell(order.targetEur, position.qty, quote, simulation);
    if (!sized.ok) {
      return {
        kind: "rejected",
        order,
        reasonCode: sized.reason === "below_min_order" ? "below_min_order" : "unfillable_size",
        detail: sized.detail,
      };
    }
    return { kind: "filled", order, terms: sized.terms };
  }

  // A buy is re-costed at the open, which is the whole point of the rule: the
  // price has moved since the decision, and the cash on hand is what decides
  // how much of the intent survives.
  const available = eur(state.cashEur - guardrails.cashFloorEur);
  const budget = Math.min(order.targetEur, available);
  if (budget < minimumBuyBudget(simulation)) {
    return {
      kind: "rejected",
      order,
      reasonCode: "insufficient_cash",
      detail: `${available.toFixed(2)} EUR available above the ${guardrails.cashFloorEur.toFixed(2)} EUR floor at the open, need at least ${minimumBuyBudget(simulation).toFixed(2)}`,
    };
  }

  const sized = sizeBuy(budget, quote, simulation);
  if (!sized.ok) {
    return {
      kind: "rejected",
      order,
      reasonCode:
        sized.reason === "insufficient_cash"
          ? "insufficient_cash"
          : sized.reason === "below_min_order"
            ? "below_min_order"
            : "unfillable_size",
      detail: sized.detail,
    };
  }

  return { kind: "filled", order, terms: sized.terms };
}
