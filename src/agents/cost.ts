/**
 * What a run cost (SPEC 7, SPEC 9, SPEC 11).
 *
 * "Record model ID, input/output tokens and computed cost in every decision
 * record, and surface cumulative LLM spend on the dashboard. This project has
 * a real running cost; make it visible."
 *
 * Anthropic bills in USD and this project is denominated in EUR, so both are
 * recorded: the USD figure is what the invoice will say, and its EUR value is
 * struck at the brief's own EURUSD rate — the same committed, point-in-time
 * rate every fill and every mark uses. Converting at "today's rate" from
 * somewhere else would put a number on the cost line that nothing else in the
 * ledger agrees with.
 *
 * A model with no entry in `simulation.yaml`'s pricing table produces a `null`
 * cost rather than a zero. Zero is a claim that the run was free.
 */
import { eur } from "../domain/money.js";
import type { AgentsConfig, ModelPrice } from "../engine/config.js";

/**
 * Token usage for one run, accumulated across every model call in the agent
 * loop.
 *
 * The field names are the SDK's (`Usage` in `@strands-agents/sdk`), and so are
 * the semantics: `inputTokens` excludes anything served from or written to the
 * prompt cache, which is counted separately and billed at a different rate.
 * `totalTokens` is therefore `input + output` and not the sum of all four.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/** Read a possibly-absent SDK `Usage` into the shape above. */
export function readUsage(usage: Partial<TokenUsage> | undefined | null): TokenUsage {
  if (usage === undefined || usage === null) return ZERO_USAGE;
  const inputTokens = finite(usage.inputTokens);
  const outputTokens = finite(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    // The SDK reports this too, but deriving it keeps the record internally
    // consistent when a provider omits it mid-stream.
    totalTokens: finite(usage.totalTokens) || inputTokens + outputTokens,
    cacheReadInputTokens: finite(usage.cacheReadInputTokens),
    cacheWriteInputTokens: finite(usage.cacheWriteInputTokens),
  };
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RunCost {
  readonly modelId: string;
  readonly usage: TokenUsage;
  /** `null` when the model has no entry in the pricing table. */
  readonly usd: number | null;
  /** `null` when the cost is unknown, or when the brief quoted no EURUSD. */
  readonly eur: number | null;
  /** USD per EUR, from the brief. `null` when the brief did not quote it. */
  readonly usdPerEur: number | null;
  /** Set when the cost could not be computed, so the gap explains itself. */
  readonly note: string | null;
}

const PER_MILLION = 1_000_000;

/**
 * Price one run's usage.
 *
 * `usdPerEur` is the brief's `EURUSD=X`: units of USD per one EUR, the same
 * convention `money.toEur` divides by.
 */
export function priceRun(
  modelId: string,
  usage: TokenUsage,
  agents: AgentsConfig,
  usdPerEur: number | null,
): RunCost {
  const price: ModelPrice | undefined = agents.pricing[modelId];
  if (price === undefined) {
    return {
      modelId,
      usage,
      usd: null,
      eur: null,
      usdPerEur,
      note: `no price for model "${modelId}" in simulation.yaml agents.pricing; cost not computed`,
    };
  }

  const usd =
    (usage.inputTokens * price.inputPerMTokUsd +
      usage.outputTokens * price.outputPerMTokUsd +
      usage.cacheReadInputTokens * price.cacheReadPerMTokUsd +
      usage.cacheWriteInputTokens * price.cacheWritePerMTokUsd) /
    PER_MILLION;

  // Rounded to the microdollar: a single cheap run costs a fraction of a cent,
  // and rounding it to the cent would make every day read as free while the
  // month's total is real money.
  const usdRounded = round(usd, 6);

  if (usdPerEur === null || !(usdPerEur > 0)) {
    return {
      modelId,
      usage,
      usd: usdRounded,
      eur: null,
      usdPerEur: null,
      note: "the brief quoted no EURUSD rate; the EUR cost was not struck",
    };
  }

  return {
    modelId,
    usage,
    usd: usdRounded,
    eur: round(usd / usdPerEur, 6),
    usdPerEur,
    note: null,
  };
}

/** Add two runs' usage. Used when a run makes more than one agent invocation. */
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
  };
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** The EUR cost, rounded to the cent, for a summary line. `eur` keeps the rest. */
export function costToCents(cost: RunCost): number | null {
  return cost.eur === null ? null : eur(cost.eur);
}
