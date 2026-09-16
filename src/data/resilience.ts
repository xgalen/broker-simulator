/**
 * Retry and the circuit breaker (SPEC 6: "wrap it with retry, a rate limiter,
 * and a circuit breaker that triggers rule 5").
 *
 * Rate limiting is not here: `yahoo-finance2` ships its own request queue, and
 * a second limiter stacked on top of it would only make the timing harder to
 * reason about. See `yahooClient.ts`, which configures it.
 *
 * Nothing in this file reads the clock or sleeps on its own — both are
 * injected, so the tests exercise a breaker cooling down over an hour without
 * taking an hour.
 */
import type { Clock } from "../domain/clock.js";
import { MarketDataError, type CircuitPolicy, type CircuitState, type RetryPolicy } from "./port.js";

/** Suspends for `ms`. Injected so tests advance time instead of waiting. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A sleep that returns immediately, recording what it was asked to wait. */
export function recordingSleep(): Sleep & { waits: number[] } {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return Object.assign(sleep, { waits });
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitter: true,
};

export const DEFAULT_CIRCUIT: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 15 * 60_000,
  halfOpenProbes: 1,
};

/**
 * Exponential backoff, doubling from `baseDelayMs` and capped at `maxDelayMs`.
 *
 * `random` is a parameter rather than a call to `Math.random` so a test can
 * pin the jitter; the data layer stays as deterministic as the domain.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  if (!policy.jitter) return exponential;
  // Full jitter: anywhere in [0, exponential]. Retrying a whole universe of
  // symbols in lockstep is how a transient blip becomes a thundering herd.
  return Math.round(exponential * random());
}

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** Called before each wait, for logging and for the health counters. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Run `operation`, retrying only what is worth retrying.
 *
 * A `permanent` failure — an unknown symbol, a 4xx, a schema Yahoo changed —
 * is returned to the caller immediately. Retrying it three times just delays
 * the same answer and spends the rate limit doing it.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof MarketDataError ? error.retryable : false;
      const isLast = attempt === policy.attempts - 1;
      if (!retryable || isLast) throw error;
      const delay = backoffDelay(attempt, policy, random);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * A circuit breaker over one upstream.
 *
 * Closed, it passes calls through and counts consecutive transient failures.
 * At the threshold it opens, and every call then fails immediately with
 * `circuit_open` until the cooldown expires — which the daily run treats
 * exactly as SPEC 1.5 stale data: log SKIPPED, trade nothing, exit 0. One
 * probe is allowed through after the cooldown; if it succeeds the breaker
 * closes, if it fails the cooldown starts again.
 *
 * Only transient failures count. A run of unknown symbols is a bug in the
 * universe, not an outage, and must not take the breaker down with it.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probesInFlight = 0;
  private lastFailure: { at: string; message: string } | null = null;
  private requestCount = 0;

  constructor(
    private readonly clock: Clock,
    private readonly policy: CircuitPolicy = DEFAULT_CIRCUIT,
  ) {}

  get snapshot(): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailure: { at: string; message: string } | null;
    requests: number;
  } {
    return {
      state: this.currentState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailure: this.lastFailure,
      requests: this.requestCount,
    };
  }

  /** `open` decays to `half_open` once the cooldown has elapsed. */
  private currentState(): CircuitState {
    if (this.state !== "open") return this.state;
    const elapsed = this.clock.nowMs() - this.openedAtMs;
    return elapsed >= this.policy.cooldownMs ? "half_open" : "open";
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.currentState();

    if (state === "open") {
      const waitMs = this.policy.cooldownMs - (this.clock.nowMs() - this.openedAtMs);
      throw new MarketDataError(
        `circuit is open after ${this.consecutiveFailures} consecutive failures; ` +
          `${Math.ceil(waitMs / 1000)}s of cooldown remain`,
        "circuit_open",
        this.lastFailure,
      );
    }

    if (state === "half_open") {
      if (this.probesInFlight >= this.policy.halfOpenProbes) {
        throw new MarketDataError(
          "circuit is half-open and its probe is already in flight",
          "circuit_open",
          this.lastFailure,
        );
      }
      this.state = "half_open";
      this.probesInFlight += 1;
    }

    this.requestCount += 1;
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    } finally {
      if (state === "half_open") this.probesInFlight -= 1;
    }
  }

  private onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  private onFailure(error: unknown): void {
    this.lastFailure = {
      at: this.clock.nowIso(),
      message: error instanceof Error ? error.message : String(error),
    };

    // A permanent failure is information about one symbol, not about the
    // upstream's health, so it must not trip the breaker.
    const counts = error instanceof MarketDataError ? error.failure === "transient" : false;
    if (!counts) return;

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.policy.failureThreshold) {
      this.state = "open";
      this.openedAtMs = this.clock.nowMs();
    }
  }
}
