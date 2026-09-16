/**
 * Retry and the circuit breaker (SPEC 6). No test here waits on real time:
 * the clock and the sleep are both injected, so a fifteen-minute cooldown is
 * exercised in microseconds.
 */
import { describe, expect, it } from "vitest";
import { fixedClock, type Clock } from "../../src/domain/clock.js";
import { MarketDataError } from "../../src/data/port.js";
import {
  CircuitBreaker,
  backoffDelay,
  recordingSleep,
  withRetry,
} from "../../src/data/resilience.js";

const transient = (): MarketDataError => new MarketDataError("upstream hiccup", "transient");
const permanent = (): MarketDataError => new MarketDataError("no such symbol", "permanent");

/** A clock the test advances by hand. */
function movableClock(startIso: string): Clock & { advance(ms: number): void } {
  let ms = Date.parse(startIso);
  return {
    nowMs: () => ms,
    nowIso: () => new Date(ms).toISOString(),
    today: () => new Date(ms).toISOString().slice(0, 10),
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

describe("retry", () => {
  const policy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: false };

  it("returns the first success without sleeping", async () => {
    const sleep = recordingSleep();
    const result = await withRetry(() => Promise.resolve("ok"), { policy, sleep });
    expect(result).toBe("ok");
    expect(sleep.waits).toEqual([]);
  });

  it("retries a transient failure and succeeds", async () => {
    const sleep = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(transient()) : Promise.resolve("ok");
      },
      { policy, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep.waits).toEqual([100, 200]);
  });

  it("does not retry a permanent failure: the answer will not change", async () => {
    const sleep = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(permanent());
        },
        { policy, sleep },
      ),
    ).rejects.toThrow(/no such symbol/);
    expect(calls).toBe(1);
    expect(sleep.waits).toEqual([]);
  });

  it("gives up after the configured number of attempts", async () => {
    const sleep = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(transient());
        },
        { policy, sleep },
      ),
    ).rejects.toThrow(/upstream hiccup/);
    expect(calls).toBe(3);
    expect(sleep.waits).toHaveLength(2);
  });

  it("does not retry an error that is not a MarketDataError", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new TypeError("bug in the mapper"));
        },
        { policy, sleep: recordingSleep() },
      ),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  it("counts every retry for the health report", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(transient()) : Promise.resolve(1);
      },
      { policy, sleep: recordingSleep(), onRetry: (attempt) => seen.push(attempt) },
    );
    expect(seen).toEqual([1, 2]);
  });
});

describe("backoff", () => {
  const policy = { attempts: 5, baseDelayMs: 500, maxDelayMs: 8000, jitter: false };

  it("doubles", () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, policy))).toEqual([500, 1000, 2000, 4000]);
  });

  it("caps rather than growing without bound", () => {
    expect(backoffDelay(10, policy)).toBe(8000);
  });

  it("jitters within [0, exponential] so retries do not stampede", () => {
    const jittered = { ...policy, jitter: true };
    expect(backoffDelay(2, jittered, () => 0)).toBe(0);
    expect(backoffDelay(2, jittered, () => 1)).toBe(2000);
    expect(backoffDelay(2, jittered, () => 0.5)).toBe(1000);
  });
});

describe("circuit breaker", () => {
  const policy = { failureThreshold: 3, cooldownMs: 60_000, halfOpenProbes: 1 };

  it("passes calls through while closed", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    await expect(breaker.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(breaker.snapshot.state).toBe("closed");
  });

  it("opens after the threshold of consecutive transient failures", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    }
    expect(breaker.snapshot.state).toBe("open");
  });

  it("fails fast while open, without attempting the call (SPEC 1.5)", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    }
    let attempted = false;
    await expect(
      breaker.execute(() => {
        attempted = true;
        return Promise.resolve("ok");
      }),
    ).rejects.toMatchObject({ failure: "circuit_open" });
    expect(attempted).toBe(false);
  });

  it("does not trip on permanent failures: a bad symbol is not an outage", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.execute(() => Promise.reject(permanent()))).rejects.toThrow();
    }
    expect(breaker.snapshot.state).toBe("closed");
  });

  it("resets its count on any success", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    await breaker.execute(() => Promise.resolve("ok"));
    expect(breaker.snapshot.consecutiveFailures).toBe(0);
    await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    expect(breaker.snapshot.state).toBe("closed");
  });

  it("half-opens once the cooldown has elapsed, and closes on a good probe", async () => {
    const clock = movableClock("2026-09-15T20:00:00Z");
    const breaker = new CircuitBreaker(clock, policy);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    }
    expect(breaker.snapshot.state).toBe("open");

    clock.advance(59_000);
    expect(breaker.snapshot.state).toBe("open");

    clock.advance(2_000);
    expect(breaker.snapshot.state).toBe("half_open");
    await expect(breaker.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(breaker.snapshot.state).toBe("closed");
  });

  it("re-opens when the probe fails, starting the cooldown again", async () => {
    const clock = movableClock("2026-09-15T20:00:00Z");
    const breaker = new CircuitBreaker(clock, policy);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    }
    clock.advance(61_000);
    await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    expect(breaker.snapshot.state).toBe("open");
  });

  it("reports what the dashboard shows about its health", async () => {
    const breaker = new CircuitBreaker(fixedClock("2026-09-15T20:00:00Z"), policy);
    await expect(breaker.execute(() => Promise.reject(transient()))).rejects.toThrow();
    expect(breaker.snapshot.requests).toBe(1);
    expect(breaker.snapshot.lastFailure?.message).toBe("upstream hiccup");
    expect(breaker.snapshot.lastFailure?.at).toBe("2026-09-15T20:00:00.000Z");
  });
});
