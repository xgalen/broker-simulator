/**
 * `pnpm verify` (SPEC 4, SPEC 14): replay the whole log and assert every
 * invariant. This module is the pure half; the CLI supplies the file I/O and
 * the exit code.
 */
import type { LedgerEvent } from "./events.js";
import { replay, type ReplayOptions, type ReplayResult } from "./replay.js";
import type { InvariantViolation, ViolationCode } from "./violations.js";

export interface VerifyReport {
  readonly ok: boolean;
  readonly violations: readonly InvariantViolation[];
  readonly byCode: ReadonlyMap<ViolationCode, readonly InvariantViolation[]>;
  readonly result: ReplayResult;
}

/** Replay `events` and collect every invariant breach. */
export function verifyLedger(
  events: readonly LedgerEvent[],
  options: ReplayOptions = {},
): VerifyReport {
  const result = replay(events, options);
  const byCode = new Map<ViolationCode, InvariantViolation[]>();
  for (const violation of result.violations) {
    const bucket = byCode.get(violation.code);
    if (bucket === undefined) {
      byCode.set(violation.code, [violation]);
    } else {
      bucket.push(violation);
    }
  }
  return {
    ok: result.violations.length === 0,
    violations: result.violations,
    byCode,
    result,
  };
}

/** One line per violation, for logs and CI output. */
export function formatViolations(
  violations: readonly InvariantViolation[],
): string {
  return violations
    .map((violation) => {
      const where = [violation.ts, violation.eventId]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const suffix = where.length > 0 ? ` (${where})` : "";
      return `${violation.code} [${violation.portfolio}] ${violation.message}${suffix}`;
    })
    .join("\n");
}

/** Throw if the ledger is not clean. Used by `pnpm verify`. */
export function assertLedgerValid(report: VerifyReport): void {
  if (report.ok) return;
  throw new Error(
    `ledger failed ${report.violations.length} invariant check(s):\n${formatViolations(report.violations)}`,
  );
}
