/**
 * The cost line (SPEC 7, SPEC 9, SPEC 11).
 *
 * "Record model ID, input/output tokens and computed cost in every decision
 * record, and surface cumulative LLM spend on the dashboard. This project has
 * a real running cost; make it visible." — and SPEC 11 adds that the cost "may
 * well exceed the gains, and that is itself a finding worth showing".
 *
 * Which makes these numbers a published claim, not a diagnostic. The tests
 * below are mostly about the ways a cost line can lie: a missing price
 * reported as free, a cheap run rounded away to nothing, cached tokens billed
 * at the full rate.
 */
import { describe, expect, it } from "vitest";
import { addUsage, priceRun, readUsage, ZERO_USAGE } from "../../src/agents/cost.js";
import { liveSimulation } from "../helpers/engine.js";

const AGENTS = liveSimulation().agents;

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0,
) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cacheReadInputTokens: cacheRead,
  cacheWriteInputTokens: cacheWrite,
});

describe("pricing a run", () => {
  it("bills input and output at the configured rates", () => {
    // claude-sonnet-5: $2.00/MTok in, $10.00/MTok out.
    const cost = priceRun("claude-sonnet-5", usage(1_000_000, 100_000), AGENTS, null);
    expect(cost.usd).toBeCloseTo(2.0 + 1.0, 6);
  });

  it("bills cached tokens at their own rates, and never twice", () => {
    // The SDK reports `inputTokens` net of cache reads and writes, so the four
    // buckets are disjoint and a naive sum would over-bill every cached run.
    const cost = priceRun(
      "claude-sonnet-5",
      usage(1_000_000, 0, 1_000_000, 1_000_000),
      AGENTS,
      null,
    );
    expect(cost.usd).toBeCloseTo(2.0 + 0.2 + 2.5, 6);
  });

  it("converts to EUR at the brief's own rate", () => {
    // SPEC 4 keeps FX visible rather than baked in; the same rate the fills and
    // the mark used is the one the cost line uses.
    const cost = priceRun("claude-sonnet-5", usage(1_000_000, 0), AGENTS, 1.25);
    expect(cost.usd).toBeCloseTo(2.0, 6);
    expect(cost.eur).toBeCloseTo(1.6, 6);
    expect(cost.usdPerEur).toBe(1.25);
    expect(cost.note).toBeNull();
  });

  it("reports an unknown model as unknown, not as free", () => {
    // A zero here would read on the dashboard as a run that cost nothing,
    // which is a stronger and more wrong claim than "we did not price it".
    const cost = priceRun("some-future-model", usage(100_000, 10_000), AGENTS, 1.1);
    expect(cost.usd).toBeNull();
    expect(cost.eur).toBeNull();
    expect(cost.note).toMatch(/no price for model "some-future-model"/);
    // The tokens are still recorded: they are what makes the gap fixable later.
    expect(cost.usage.totalTokens).toBe(110_000);
  });

  it("keeps the USD figure when the brief quoted no EURUSD", () => {
    const cost = priceRun("claude-sonnet-5", usage(1_000_000, 0), AGENTS, null);
    expect(cost.usd).toBeCloseTo(2.0, 6);
    expect(cost.eur).toBeNull();
    expect(cost.note).toMatch(/quoted no EURUSD rate/);
  });

  it("keeps a single cheap run from rounding away to zero", () => {
    // A daily run costs a fraction of a cent. Rounded to the cent every day
    // reads as free, while the month is real money.
    const cost = priceRun("claude-sonnet-5", usage(3_000, 400), AGENTS, 1.1);
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.usd).toBeLessThan(0.02);
    expect(cost.eur).toBeGreaterThan(0);
  });

  it("prices the models the config actually names", () => {
    // If a model in `portfolios.yaml` has no entry here, every one of its
    // decision records carries a null cost — which is exactly the silent gap
    // this assertion exists to catch.
    for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]) {
      expect(AGENTS.pricing[model], model).toBeDefined();
    }
  });
});

describe("reading usage off the SDK", () => {
  it("survives a provider that reports nothing", () => {
    expect(readUsage(undefined)).toEqual(ZERO_USAGE);
    expect(readUsage(null)).toEqual(ZERO_USAGE);
    expect(readUsage({})).toEqual(ZERO_USAGE);
  });

  it("derives the total when a provider omits it mid-stream", () => {
    expect(readUsage({ inputTokens: 10, outputTokens: 5 }).totalTokens).toBe(15);
  });

  it("ignores nonsense rather than propagating it into a price", () => {
    const read = readUsage({
      inputTokens: Number.NaN,
      outputTokens: -5,
      cacheReadInputTokens: Number.POSITIVE_INFINITY,
    });
    expect(read).toEqual(ZERO_USAGE);
    expect(priceRun("claude-sonnet-5", read, AGENTS, 1.1).usd).toBe(0);
  });

  it("adds up across invocations", () => {
    expect(addUsage(usage(10, 2), usage(5, 3))).toEqual(usage(15, 5));
  });
});
