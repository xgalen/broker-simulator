/**
 * The staleness gate (SPEC 1.5).
 *
 * "If the data fetch fails or returns prices older than the last session
 * close, the run logs a SKIPPED event for every portfolio and exits 0. Never
 * trade on stale prices."
 *
 * Both halves of that sentence end up as the same exception here, because the
 * engine's response to them is identical. Pure: the expected session is passed
 * in, never derived from the host clock.
 */
import type { IsoDate, Ticker } from "../domain/types.js";
import { StaleDataError, type FreshnessPolicy, type PriceSnapshot } from "./port.js";

export interface FreshnessReport {
  readonly fresh: readonly PriceSnapshot[];
  readonly stale: readonly {
    readonly ticker: Ticker;
    readonly sessionDate: IsoDate;
    readonly tolerated: boolean;
  }[];
  readonly missing: readonly Ticker[];
}

/**
 * Sort a batch of quotes into fresh, stale and missing.
 *
 * A tolerated ticker may lag without failing the run: when Wall Street is open
 * and Frankfurt is shut for a German holiday, the US half of the universe is
 * perfectly tradable and the run should not stop. Tolerated names are reported
 * so the caller can still mark them stale on the dashboard rather than drawing
 * a line that implies movement (SPEC 11).
 */
export function checkFreshness(
  snapshots: readonly PriceSnapshot[],
  expected: readonly Ticker[],
  policy: FreshnessPolicy,
): FreshnessReport {
  const tolerated = new Set(policy.toleratedStaleTickers ?? []);
  const seen = new Set<Ticker>();
  const fresh: PriceSnapshot[] = [];
  const stale: { ticker: Ticker; sessionDate: IsoDate; tolerated: boolean }[] = [];

  for (const snapshot of snapshots) {
    seen.add(snapshot.ticker);
    if (snapshot.sessionDate >= policy.expectedSessionOnOrAfter) {
      fresh.push(snapshot);
    } else {
      stale.push({
        ticker: snapshot.ticker,
        sessionDate: snapshot.sessionDate,
        tolerated: tolerated.has(snapshot.ticker),
      });
    }
  }

  return {
    fresh,
    stale,
    missing: expected.filter((ticker) => !seen.has(ticker)),
  };
}

/**
 * Raise SPEC 1.5 if anything that matters is stale or missing.
 *
 * Throws on the first untolerated offender rather than collecting them all:
 * the outcome is the same whatever the count — the run skips — and the first
 * one names the problem.
 */
export function assertFresh(
  snapshots: readonly PriceSnapshot[],
  expected: readonly Ticker[],
  policy: FreshnessPolicy,
): FreshnessReport {
  const report = checkFreshness(snapshots, expected, policy);

  const offender = report.stale.find((entry) => !entry.tolerated);
  if (offender !== undefined) {
    throw new StaleDataError(
      `"${offender.ticker}" last traded ${offender.sessionDate}, before the expected session ${policy.expectedSessionOnOrAfter}`,
      {
        ticker: offender.ticker,
        expectedOnOrAfter: policy.expectedSessionOnOrAfter,
        observed: null,
      },
    );
  }

  const missing = report.missing.filter((ticker) => !(policy.toleratedStaleTickers ?? []).includes(ticker));
  const firstMissing = missing[0];
  if (firstMissing !== undefined) {
    throw new StaleDataError(
      `no quote came back for "${firstMissing}"${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ""}`,
      {
        ticker: firstMissing,
        expectedOnOrAfter: policy.expectedSessionOnOrAfter,
        observed: null,
      },
    );
  }

  return report;
}
