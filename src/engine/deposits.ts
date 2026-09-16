/**
 * Contributions (SPEC 5, SPEC 8 step 3).
 *
 * "Each portfolio is seeded with 100 EUR on day one, then receives 50 EUR on
 * the first trading day of every subsequent month."
 *
 * Derived from the log rather than from a calendar, which is the same move
 * SPEC 13 asks for on market holidays: "handle market holidays by detecting no
 * new close rather than hardcoding a calendar". The first trading day of a
 * month is simply the first session the engine runs whose month differs from
 * the month of the last deposit — no exchange calendar, no timezone, and
 * correct when the first of the month is a Sunday, a holiday, or a day the
 * data source was down.
 */
import type { PortfolioState } from "../domain/replay.js";
import type { IsoDate } from "../domain/types.js";
import type { SimulationConfig } from "./config.js";

export interface DepositDecision {
  readonly amountEur: number;
  /** `seed` is the 100 EUR of day one; `monthly` is every contribution after. */
  readonly kind: "seed" | "monthly";
  readonly reason: string;
}

/** `YYYY-MM` of an ISO date. */
export function monthOf(date: IsoDate): string {
  return date.slice(0, 7);
}

/**
 * What this portfolio is owed on this session, or `null` for nothing.
 *
 * Idempotent within a month by construction: once a deposit is recorded for
 * `2026-10`, no second session in October can produce another. A retried run,
 * or two runs on the same day, cannot double-credit.
 */
export function depositFor(
  state: PortfolioState,
  sessionDate: IsoDate,
  simulation: SimulationConfig,
): DepositDecision | null {
  const last = state.flows.at(-1);

  if (last === undefined) {
    return {
      amountEur: simulation.initialDepositEur,
      kind: "seed",
      reason: `initial deposit on the first session (${sessionDate})`,
    };
  }

  // A session that is not after the last deposit is a rerun of a day already
  // credited, not a new one.
  if (sessionDate <= last.date) return null;
  if (monthOf(sessionDate) === monthOf(last.date)) return null;

  return {
    amountEur: simulation.monthlyDepositEur,
    kind: "monthly",
    reason: `monthly contribution, first trading session of ${monthOf(sessionDate)}`,
  };
}

/**
 * True when this session credited a contribution. The controls key off this:
 * SPEC 5 gives both of them a monthly cadence, and "the month turned" is
 * exactly "a deposit landed", with no second definition to drift from it.
 */
export function isContributionSession(
  state: PortfolioState,
  sessionDate: IsoDate,
): boolean {
  return state.flows.at(-1)?.date === sessionDate;
}
