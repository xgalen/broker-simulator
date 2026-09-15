/**
 * The domain never reads the system clock. Anything that needs "now" takes a
 * Clock, and the composition root (CLI, workflow) is the only place allowed to
 * construct one that reads the host. That keeps `src/domain` deterministic and
 * lets tests pin any instant they like.
 */
export interface Clock {
  /** Current instant as epoch milliseconds, UTC. */
  nowMs(): number;
  /** Current instant as an ISO-8601 UTC timestamp. */
  nowIso(): string;
  /** Current UTC calendar date, `YYYY-MM-DD`. */
  today(): string;
}

/** A clock frozen at a given instant. The only Clock the domain ships with. */
export function fixedClock(instant: string | number | Date): Clock {
  const ms =
    instant instanceof Date
      ? instant.getTime()
      : typeof instant === "number"
        ? instant
        : Date.parse(instant);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`fixedClock: unparseable instant: ${String(instant)}`);
  }
  const iso = new Date(ms).toISOString();
  return {
    nowMs: () => ms,
    nowIso: () => iso,
    today: () => iso.slice(0, 10),
  };
}
