/**
 * From a data failure to SPEC 1.5.
 *
 * "If the data fetch fails or returns prices older than the last session
 * close, the run logs a SKIPPED event for every portfolio and exits 0."
 *
 * The engine writes the events (phase 4); this decides whether a given failure
 * is one of those days and what the reason should say. Keeping the decision
 * here means the rule is tested in phase 2 rather than asserted in prose and
 * discovered to be wrong in phase 4.
 */
import { MarketDataError } from "./port.js";

/** Reason codes that end up verbatim in `SKIPPED.reason`. */
export const SKIP_REASONS = {
  stale: "stale_data",
  circuit_open: "data_source_unavailable",
  transient: "data_fetch_failed",
  permanent: "data_fetch_failed",
} as const;

/**
 * Should this failure stop the whole run?
 *
 * Every market-data failure does. The alternative is trading part of the
 * universe on a day the data is questionable, which is exactly what rule 5
 * exists to prevent — a partial fetch is not a cheaper version of a good one,
 * it is a different and worse experiment.
 */
export function isSkipCondition(error: unknown): error is MarketDataError {
  return error instanceof MarketDataError;
}

/** The `reason` for the SKIPPED events this failure produces. */
export function skipReasonFor(error: unknown): string {
  if (!(error instanceof MarketDataError)) return "data_fetch_failed";
  return SKIP_REASONS[error.failure];
}

/**
 * One SKIPPED payload per portfolio — every portfolio, including the ones that
 * would not have traded anyway. SPEC 1.7: every decision is recorded, and
 * "we did not look" is a decision.
 */
export function skipEventsFor(
  portfolios: readonly string[],
  error: unknown,
): readonly { readonly portfolio: string; readonly reason: string }[] {
  const reason = skipReasonFor(error);
  return portfolios.map((portfolio) => ({ portfolio, reason }));
}
