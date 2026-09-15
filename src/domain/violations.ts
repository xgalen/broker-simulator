/** Invariant breaches found while replaying the log (SPEC 4, SPEC 14). */
import type { IsoTimestamp, PortfolioId } from "./types.js";

export const VIOLATION_CODES = [
  /** Structural problems with the log itself. */
  "DUPLICATE_EVENT_ID",
  /** A portfolio's own events run backwards in time. */
  "EVENTS_OUT_OF_ORDER",
  /** SPEC 4: cash never negative. */
  "CASH_NEGATIVE",
  /** SPEC 4: quantity never negative. */
  "QTY_NEGATIVE",
  /** SPEC 4 / 1.6: no position outside the whitelist. */
  "POSITION_OFF_WHITELIST",
  "ORDER_OFF_WHITELIST",
  /** SPEC 4: every ORDER_FILLED has a preceding ORDER_PLACED. */
  "FILL_WITHOUT_ORDER",
  /** SPEC 4 / 1.1: every fill date is strictly after its decision date. */
  "FILL_NOT_AFTER_DECISION",
  /** Internal arithmetic of a fill does not add up. */
  "FILL_AMOUNTS_INCONSISTENT",
  "FILL_CURRENCY_MISMATCH",
  /** A written VALUATION mark disagrees with the replayed state. */
  "VALUATION_MISMATCH",
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface InvariantViolation {
  readonly code: ViolationCode;
  readonly message: string;
  readonly portfolio: PortfolioId;
  readonly eventId?: string;
  readonly ts?: IsoTimestamp;
}
