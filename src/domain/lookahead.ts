/**
 * The no-look-ahead check (SPEC 1.1, SPEC 14).
 *
 * "A decision made using data up to the close of day T may only be filled at
 * the next open of day T+1 in that asset's home market. Never fill at a price
 * the agent could see when deciding."
 *
 * The check is structural rather than statistical: every fill is traced back
 * through its ORDER_PLACED to the decision that produced it and to the brief
 * that decision read (decision records store the brief hash, SPEC 6). A fill
 * whose price appears anywhere in that brief is a violation, as is a fill
 * dated on or before the brief itself.
 *
 * Pure: the caller resolves decision -> brief however it likes (from
 * `data/briefs/`, from a fixture) and hands the lookup in.
 */
import type { LedgerEvent, OrderPlacedEvent } from "./events.js";
import { dateOf } from "./types.js";
import type { DecisionId, IsoDate, OrderId, PortfolioId, Ticker } from "./types.js";

/**
 * Every price an agent could see in a brief, per instrument: open, high, low,
 * close, previous close, any reference level quoted for that ticker.
 */
export interface BriefPriceSnapshot {
  readonly briefHash: string;
  /** The session the brief describes; decisions on it fill the next session. */
  readonly date: IsoDate;
  readonly pricesByTicker: ReadonlyMap<Ticker, readonly number[]>;
}

/** Resolves the brief a decision was taken on. */
export type BriefResolver = (
  decisionId: DecisionId,
) => BriefPriceSnapshot | undefined;

export const LOOKAHEAD_CODES = [
  /** The fill price is a price that was printed in the brief. */
  "FILL_PRICE_VISIBLE_IN_BRIEF",
  /** The fill is dated on or before the brief that triggered it. */
  "FILL_NOT_AFTER_BRIEF",
  /** No brief could be resolved, so the fill is unauditable. */
  "BRIEF_NOT_RESOLVED",
  /** The fill has no ORDER_PLACED, so no decision and no brief. */
  "FILL_WITHOUT_ORDER",
] as const;

export type LookAheadCode = (typeof LOOKAHEAD_CODES)[number];

export interface LookAheadViolation {
  readonly code: LookAheadCode;
  readonly message: string;
  readonly portfolio: PortfolioId;
  readonly ticker: Ticker;
  readonly fillEventId: string;
  readonly orderId: OrderId;
  readonly decisionId?: DecisionId;
  readonly briefHash?: string;
}

export interface LookAheadOptions {
  /**
   * How close a fill price may come to a brief price before it counts as the
   * same number. Prices are carried to 4dp, so the default catches equality
   * without flagging genuinely different quotes.
   */
  readonly priceTolerance?: number;
  /**
   * Treat an unresolvable brief as a violation. On by default: a fill nobody
   * can audit is not evidence of no look-ahead.
   */
  readonly requireBrief?: boolean;
}

/**
 * Check every fill in the log against the brief its decision read.
 * Returns an empty array when the ledger is clean.
 */
export function checkLookAhead(
  events: readonly LedgerEvent[],
  resolveBrief: BriefResolver,
  options: LookAheadOptions = {},
): LookAheadViolation[] {
  const priceTolerance = options.priceTolerance ?? 1e-4;
  const requireBrief = options.requireBrief ?? true;
  const violations: LookAheadViolation[] = [];
  const placed = new Map<OrderId, OrderPlacedEvent>();

  for (const event of events) {
    if (event.type === "ORDER_PLACED") {
      placed.set(event.id, event);
      continue;
    }
    if (event.type !== "ORDER_FILLED") continue;

    const order = placed.get(event.orderId);
    if (order === undefined) {
      violations.push({
        code: "FILL_WITHOUT_ORDER",
        message: `fill "${event.id}" references orderId "${event.orderId}", which was never placed`,
        portfolio: event.portfolio,
        ticker: event.ticker,
        fillEventId: event.id,
        orderId: event.orderId,
      });
      continue;
    }

    const brief = resolveBrief(order.decisionId);
    if (brief === undefined) {
      if (requireBrief) {
        violations.push({
          code: "BRIEF_NOT_RESOLVED",
          message: `no brief found for decision "${order.decisionId}"; fill "${event.id}" is unauditable`,
          portfolio: event.portfolio,
          ticker: event.ticker,
          fillEventId: event.id,
          orderId: event.orderId,
          decisionId: order.decisionId,
        });
      }
      continue;
    }

    if (dateOf(event.ts) <= brief.date) {
      violations.push({
        code: "FILL_NOT_AFTER_BRIEF",
        message: `fill on ${dateOf(event.ts)} is not after the ${brief.date} brief it was decided on`,
        portfolio: event.portfolio,
        ticker: event.ticker,
        fillEventId: event.id,
        orderId: event.orderId,
        decisionId: order.decisionId,
        briefHash: brief.briefHash,
      });
    }

    const visible = brief.pricesByTicker.get(event.ticker) ?? [];
    const match = visible.find(
      (price) => Math.abs(price - event.priceLocal) <= priceTolerance,
    );
    if (match !== undefined) {
      violations.push({
        code: "FILL_PRICE_VISIBLE_IN_BRIEF",
        message: `fill price ${event.priceLocal} for "${event.ticker}" was already printed in brief ${brief.briefHash} (${brief.date})`,
        portfolio: event.portfolio,
        ticker: event.ticker,
        fillEventId: event.id,
        orderId: event.orderId,
        decisionId: order.decisionId,
        briefHash: brief.briefHash,
      });
    }
  }

  return violations;
}
