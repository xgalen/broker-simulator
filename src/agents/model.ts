/**
 * Which model an agent talks to (SPEC 2, SPEC 7).
 *
 * "`@strands-agents/sdk` (Strands Agents TypeScript SDK), using the Anthropic
 * model provider directly — not Bedrock. API key from `ANTHROPIC_API_KEY`."
 *
 * The provider lives behind `@strands-agents/sdk/models/anthropic` rather than
 * the package root, and takes `@anthropic-ai/sdk` as an optional peer. Both are
 * facts about the installed version, read off its type declarations — this is
 * the one place in the project that knows either of them.
 *
 * `ModelFactory` exists so that the thing which is expensive, non-deterministic
 * and needs a credential is a parameter. The daily run passes the Anthropic
 * factory; every test passes a scripted one. Nothing else changes.
 */
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import type { Model } from "@strands-agents/sdk";
import type { PortfolioId } from "../domain/types.js";
import type { AgentsConfig } from "../engine/config.js";

/** Builds the model one portfolio runs on. */
export interface ModelFactory {
  /** Named in logs and in the decision record's cost block. */
  readonly kind: string;
  create(portfolio: PortfolioId, modelId: string, agents: AgentsConfig): Model;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

export interface AnthropicFactoryOptions {
  /** From `ANTHROPIC_API_KEY`. Read in the composition root, never logged. */
  readonly apiKey: string;
  /** For a gateway or a proxy. Omitted, the SDK's own default applies. */
  readonly baseURL?: string;
}

/**
 * The live provider.
 *
 * Prompt caching is left off. It is configured per model here and would cache
 * the tool definitions and the system prompt — but the daily run happens once
 * every twenty-four hours and the shortest cache TTL is five minutes, so every
 * run would write a cache nothing ever reads and pay 1.25x for the privilege.
 */
export function anthropicModelFactory(options: AnthropicFactoryOptions): ModelFactory {
  if (options.apiKey.trim().length === 0) {
    throw new ModelError(
      "ANTHROPIC_API_KEY is not set; the agents cannot run. Set it in the environment (SPEC 13: repo secrets, never logged, never committed).",
    );
  }
  return {
    kind: "anthropic",
    create(_portfolio, modelId, agents) {
      return new AnthropicModel({
        apiKey: options.apiKey,
        modelId,
        maxTokens: agents.maxTokens,
        ...(options.baseURL === undefined ? {} : { clientConfig: { baseURL: options.baseURL } }),
        // No `temperature` and no `topP`: the current Claude models reject the
        // sampling parameters outright, and a 400 here would take out the
        // whole session's agent leg.
      });
    },
  };
}

/** A factory that always returns the same already-built model. For tests. */
export function fixedModelFactory(model: Model, kind = "mock"): ModelFactory {
  return { kind, create: () => model };
}

/**
 * Read the key from the environment.
 *
 * Returns `null` rather than throwing: a deployment with no key should be able
 * to run its controls, which cost nothing, and skip the agents with a reason —
 * not fail the whole job at startup.
 */
export function anthropicKeyFrom(env: Readonly<Record<string, string | undefined>>): string | null {
  const key = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  return key.length > 0 ? key : null;
}

/**
 * A factory that refuses, with a reason.
 *
 * Used when an agent is enabled but its credential is missing. Refusing at
 * `create` rather than at startup is deliberate: the agent turns the refusal
 * into a recorded HOLD and the session completes, so the controls still get
 * their day, the ledger stays unbroken, and the reason is in
 * `data/decisions/` where someone will actually see it. A job that died
 * instead would leave a red repository and no evidence.
 */
export function unavailableModelFactory(reason: string, kind = "unavailable"): ModelFactory {
  return {
    kind,
    create() {
      throw new ModelError(reason);
    },
  };
}
