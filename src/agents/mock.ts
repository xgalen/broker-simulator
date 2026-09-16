/**
 * A scripted model provider, for tests and for running the agent offline.
 *
 * SPEC 2 says the domain core must be unit-testable with zero network access,
 * and phase 5 would quietly break the spirit of that for everything above it:
 * an agent whose only model is an HTTP client cannot be exercised in CI, and
 * an agent that cannot be exercised in CI is an agent whose schema gate, tool
 * caps, budget fallback and decision record are all untested until the evening
 * they are needed.
 *
 * So the model is a seam. `MockModel` is a real `Model` implementation that
 * plays a fixed script of turns and reports fixed token usage, which means the
 * tests exercise the **actual** Strands agent loop — the real tool executor,
 * the real structured-output tool, the real `limits` enforcement — and only
 * the HTTP call is replaced. A hand-rolled fake decider would have tested
 * none of that.
 *
 * The usage numbers are part of the script on purpose: token accounting and
 * the cost line are things the decision record claims, so a test has to be
 * able to make the model expensive.
 */
import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StopReason,
  type StreamOptions,
} from "@strands-agents/sdk";
import type { PortfolioId } from "../domain/types.js";
import type { AgentsConfig } from "../engine/config.js";
import type { TokenUsage } from "./cost.js";
import type { ModelFactory } from "./model.js";

/**
 * The tool name the SDK reserves for structured output.
 *
 * Hard-coded rather than imported: it is not exported from the package root,
 * and `test/agents/mock.test.ts` asserts that a real `Agent` configured with a
 * schema actually accepts what this constant produces — so a rename upstream
 * fails a test rather than silently turning every mocked run into a hold.
 */
export const STRUCTURED_OUTPUT_TOOL = "strands_structured_output";

/** One model turn in a script. */
export type MockTurn =
  /** Plain text, ending the turn. With a schema set this makes the SDK retry. */
  | { readonly kind: "text"; readonly text: string; readonly usage?: Partial<TokenUsage> }
  /** A call to one of the agent's tools. */
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly usage?: Partial<TokenUsage>;
    }
  /** The final answer, submitted through the structured-output tool. */
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: Partial<TokenUsage> }
  /** Anything else the provider might do: a refusal, a length stop. */
  | {
      readonly kind: "stop";
      readonly stopReason: StopReason;
      readonly text?: string;
      readonly usage?: Partial<TokenUsage>;
    }
  /** A provider failure, to prove the agent degrades to a HOLD rather than dying. */
  | { readonly kind: "error"; readonly message: string };

export interface MockModelOptions {
  readonly modelId?: string;
  /** Played in order. The last turn repeats if the loop asks for more. */
  readonly script: readonly MockTurn[];
  /** Usage reported for a turn that does not state its own. */
  readonly defaultUsage?: Partial<TokenUsage>;
}

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  totalTokens: 1_200,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

export class MockModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig;
  private turn = 0;

  /** Every call the loop made, so a test can assert on what was sent. */
  readonly calls: { readonly messages: number; readonly toolSpecs: readonly string[] }[] = [];

  constructor(private readonly options: MockModelOptions) {
    super();
    this.config = { modelId: options.modelId ?? "mock-model" };
    if (options.script.length === 0) {
      throw new Error("MockModel needs at least one scripted turn");
    }
  }

  /** How many turns have been played. Asserted against SPEC 7's turn cap. */
  get turnsPlayed(): number {
    return this.turn;
  }

  override updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push({
      messages: messages.length,
      toolSpecs: (options?.toolSpecs ?? []).map((spec) => spec.name),
    });

    // The last turn repeats. A script that runs out mid-loop should not throw
    // an off-by-one at the test author; a loop that will not stop is the
    // interesting case, and repeating the final turn is how you build one.
    const index = Math.min(this.turn, this.options.script.length - 1);
    const turn = this.options.script[index];
    this.turn += 1;
    if (turn === undefined) throw new Error("MockModel script is empty");

    if (turn.kind === "error") {
      throw new Error(turn.message);
    }

    const usage = { ...DEFAULT_USAGE, ...this.options.defaultUsage, ...(turn.usage ?? {}) };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;

    yield { type: "modelMessageStartEvent", role: "assistant" };

    switch (turn.kind) {
      case "text":
        yield* textBlock(turn.text);
        yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
        break;

      case "tool":
        yield* toolUseBlock(turn.name, turn.input, `mock-${this.turn}`);
        yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
        break;

      case "output":
        yield* toolUseBlock(STRUCTURED_OUTPUT_TOOL, turn.value, `mock-out-${this.turn}`);
        yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
        break;

      case "stop":
        yield* textBlock(turn.text ?? "");
        yield { type: "modelMessageStopEvent", stopReason: turn.stopReason };
        break;
    }

    yield { type: "modelMetadataEvent", usage, metrics: { latencyMs: 1 } };
  }
}

function* textBlock(text: string): Generator<ModelStreamEvent> {
  yield { type: "modelContentBlockStartEvent" };
  yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text } };
  yield { type: "modelContentBlockStopEvent" };
}

function* toolUseBlock(
  name: string,
  input: unknown,
  toolUseId: string,
): Generator<ModelStreamEvent> {
  yield {
    type: "modelContentBlockStartEvent",
    start: { type: "toolUseStart", name, toolUseId },
  };
  yield {
    type: "modelContentBlockDeltaEvent",
    delta: { type: "toolUseInputDelta", input: JSON.stringify(input ?? {}) },
  };
  yield { type: "modelContentBlockStopEvent" };
}

/**
 * A factory that builds a fresh `MockModel` per run.
 *
 * Freshness is the whole point: the turn counter is per-invocation, so a
 * factory that handed out one shared instance would play turn 0 on Monday,
 * turn 1 on Tuesday and the last turn forever after. Every session gets its
 * own model and its own script from the top, which is what makes a multi-day
 * replay reproducible.
 */
export function scriptedModelFactory(
  script:
    | readonly MockTurn[]
    | ((portfolio: PortfolioId, modelId: string, agents: AgentsConfig) => readonly MockTurn[]),
  options: { readonly kind?: string; readonly defaultUsage?: Partial<TokenUsage> } = {},
): ModelFactory {
  return {
    kind: options.kind ?? "mock",
    create(portfolio, modelId, agents) {
      return new MockModel({
        modelId,
        script: typeof script === "function" ? script(portfolio, modelId, agents) : script,
        ...(options.defaultUsage === undefined ? {} : { defaultUsage: options.defaultUsage }),
      });
    },
  };
}
