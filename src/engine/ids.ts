/**
 * Event, order and decision identifiers.
 *
 * Every id is a pure function of (session date, portfolio, kind, sequence).
 * That is not cosmetic: SPEC 14 requires that deleting `state.json` and
 * rebuilding it from `events.jsonl` produces a byte-identical file, and a run
 * that is retried after a half-written commit must produce the same ids rather
 * than a second set that replays as duplicates. A UUID would break both.
 *
 * Ids are readable on purpose — `2026-09-16/dca/ord/1` tells you the day, the
 * portfolio and the kind without a lookup, and the whole ledger is grep-able
 * by date or by portfolio.
 */
import type { DecisionId, IsoDate, OrderId, PortfolioId } from "../domain/types.js";

/** Short tags, so an id stays legible at a glance in a 10,000-line log. */
export const ID_KINDS = {
  deposit: "dep",
  order: "ord",
  fill: "fil",
  rejection: "rej",
  hold: "hld",
  dividend: "div",
  split: "spl",
  valuation: "val",
  skipped: "skp",
  decision: "dec",
} as const;

export type IdKind = keyof typeof ID_KINDS;

export function eventId(
  date: IsoDate,
  portfolio: PortfolioId,
  kind: IdKind,
  sequence: number,
): string {
  return `${date}/${portfolio}/${ID_KINDS[kind]}/${sequence}`;
}

/** The id an ORDER_PLACED event carries, and the one a fill refers back to. */
export function orderId(
  date: IsoDate,
  portfolio: PortfolioId,
  sequence: number,
): OrderId {
  return eventId(date, portfolio, "order", sequence);
}

/**
 * One decision per portfolio per day, so the id needs no sequence: this is
 * also the key `data/decisions/YYYY-MM-DD/<portfolio>.json` is found by.
 */
export function decisionId(date: IsoDate, portfolio: PortfolioId): DecisionId {
  return `${date}/${portfolio}/dec`;
}

/**
 * Hands out the per-portfolio sequence numbers for one session.
 *
 * Kept as a tiny object rather than threaded counters because the daily run
 * emits events for a portfolio from four different places (fills, actions,
 * deposits, decisions) and every one of them needs the next number without
 * knowing what the others did.
 */
export class IdSequencer {
  private readonly counters = new Map<string, number>();

  constructor(readonly date: IsoDate) {}

  next(portfolio: PortfolioId, kind: IdKind): string {
    const key = `${portfolio}/${kind}`;
    const sequence = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, sequence);
    return eventId(this.date, portfolio, kind, sequence);
  }

  /** Peek at what the next id would be without consuming it. */
  peek(portfolio: PortfolioId, kind: IdKind): string {
    return eventId(this.date, portfolio, kind, (this.counters.get(`${portfolio}/${kind}`) ?? 0) + 1);
  }
}
