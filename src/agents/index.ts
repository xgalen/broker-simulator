/**
 * The agent roster (SPEC 5, SPEC 12 phases 5-6).
 *
 * `createControls` builds the deterministic half of the cast; this builds the
 * LLM half, and the daily run merges the two into one map of deciders it
 * cannot tell apart. Phase 5 enables `value` alone — SPEC 12 says one agent
 * proves the wiring, the tools, the schema gate and the decision record before
 * five of them start spending money every evening — and phase 6 needs no
 * change here beyond flipping `enabled` in `portfolios.yaml`.
 *
 * Nothing in this module reads a file or a clock. The mandates are handed in
 * as text, already read by the composition root, for the same reason the rest
 * of the engine takes its ports as parameters: an agent must be constructible
 * in a test with nothing plugged in.
 */
import type { PortfolioId } from "../domain/types.js";
import type { MarketDataPort } from "../data/port.js";
import type { PortfolioConfig } from "../engine/config.js";
import type { Decider } from "../engine/decision.js";
import { StrandsAgentDecider, type DecisionHistoryPort, type PlaybookPort } from "./agent.js";
import type { ModelFactory } from "./model.js";
import type { WebSearchPort } from "./search.js";

export * from "./agent.js";
export * from "./cost.js";
export * from "./mock.js";
export * from "./model.js";
export * from "./prompt.js";
export * from "./schema.js";
export * from "./search.js";
export * from "./tools.js";

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export interface CreateAgentsOptions {
  readonly portfolios: readonly PortfolioConfig[];
  /**
   * Mandate text by portfolio key (SPEC 10: read-only to the system). The
   * caller reads them; nothing downstream has a handle that could write one.
   */
  readonly mandates: ReadonlyMap<PortfolioId, string>;
  readonly models: ModelFactory;
  readonly market: MarketDataPort;
  readonly search: WebSearchPort;
  readonly history?: DecisionHistoryPort;
  readonly playbooks?: PlaybookPort;
  readonly log?: (line: string) => void;
}

/** Every enabled agent in the roster, as deciders. */
export function createAgents(options: CreateAgentsOptions): Map<PortfolioId, Decider> {
  const deciders = new Map<PortfolioId, Decider>();

  for (const portfolio of options.portfolios) {
    if (portfolio.kind !== "agent" || !portfolio.enabled) continue;

    const mandate = options.mandates.get(portfolio.key);
    if (mandate === undefined || mandate.trim().length === 0) {
      // An agent with no mandate has no strategy, and would trade on whatever
      // the model felt like — which is a portfolio that measures nothing.
      throw new AgentConfigError(
        `agent "${portfolio.key}" has no mandate text; ${portfolio.mandate ?? "config/mandates/<agent>.md"} is missing or empty`,
      );
    }

    deciders.set(
      portfolio.key,
      new StrandsAgentDecider({
        portfolio,
        mandate,
        models: options.models,
        market: options.market,
        search: options.search,
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.playbooks === undefined ? {} : { playbooks: options.playbooks }),
        ...(options.log === undefined ? {} : { log: options.log }),
      }),
    );
  }

  return deciders;
}

/** The mandate files the enabled agents need, as repo-relative paths. */
export function mandatePaths(
  portfolios: readonly PortfolioConfig[],
): ReadonlyMap<PortfolioId, string> {
  const paths = new Map<PortfolioId, string>();
  for (const portfolio of portfolios) {
    if (portfolio.kind !== "agent" || !portfolio.enabled) continue;
    if (portfolio.mandate === undefined) {
      throw new AgentConfigError(`agent "${portfolio.key}" names no mandate file`);
    }
    paths.set(portfolio.key, portfolio.mandate);
  }
  return paths;
}
