/**
 * Fixture wiring for the phase 5 tests.
 *
 * Everything here builds a **real** `StrandsAgentDecider` over a real Strands
 * `Agent`, with only the HTTP call replaced by `MockModel`. That is the whole
 * point of the mocked-model mode: a hand-rolled fake decider would prove the
 * engine can call something, and prove nothing about the tool executor, the
 * structured-output tool, the schema gate or the budget limits — which are the
 * parts of phase 5 that can actually be wrong.
 *
 * No test in `test/agents` reaches the network, reads the host clock, or needs
 * `ANTHROPIC_API_KEY`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgents,
  FixtureWebSearch,
  MockModel,
  scriptedModelFactory,
  StrandsAgentDecider,
  type DecisionHistoryPort,
  type MockTurn,
  type PlaybookPort,
  type WebSearchPort,
  type WebSearchResult,
} from "../../src/agents/index.js";
import { DisabledWebSearch } from "../../src/agents/search.js";
import { fixedModelFactory } from "../../src/agents/model.js";
import type { PlaybookRule } from "../../src/agents/prompt.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import type { MarketDataPort } from "../../src/data/port.js";
import type { PortfolioId } from "../../src/domain/types.js";
import type { PortfolioConfig } from "../../src/engine/config.js";
import type { Decider, DecisionRecord } from "../../src/engine/decision.js";
import { createControls } from "../../src/controls/index.js";
import type { DecisionContext } from "../../src/engine/decision.js";
import type { PortfolioState } from "../../src/domain/replay.js";
import {
  briefWith,
  dryRunUniverse,
  liveSimulation,
  livePortfolios,
  portfolio,
  repoRoot,
  stateFrom,
  type QuoteSpec,
} from "./engine.js";
import { SessionPrices } from "../../src/engine/pricing.js";

/** The committed mandates, read the way the composition root reads them. */
export function liveMandates(): Map<PortfolioId, string> {
  const mandates = new Map<PortfolioId, string>();
  for (const config of livePortfolios().all) {
    if (config.kind !== "agent" || config.mandate === undefined) continue;
    try {
      mandates.set(config.key, readFileSync(join(repoRoot, config.mandate), "utf8"));
    } catch {
      continue;
    }
  }
  return mandates;
}

/** A decision the mocked model can submit. Defaults to a plausible hold. */
export function mockHold(rationale = "Nothing in the brief clears the valuation bar today."): {
  readonly action: "hold";
  readonly rationale: string;
  readonly confidence: number;
  readonly orders: readonly never[];
  readonly sourcesUsed: readonly string[];
} {
  return { action: "hold", rationale, confidence: 3, orders: [], sourcesUsed: [] };
}

export function mockBuy(options: {
  readonly ticker: string;
  readonly targetEur: number;
  readonly rationale?: string;
  readonly thesis?: string;
  readonly invalidation?: string;
  readonly sourcesUsed?: readonly string[];
}): Record<string, unknown> {
  return {
    action: "trade",
    rationale: options.rationale ?? `Deploying ${options.targetEur.toFixed(2)} EUR into ${options.ticker}.`,
    confidence: 4,
    orders: [
      {
        ticker: options.ticker,
        side: "buy",
        targetEur: options.targetEur,
        thesis: options.thesis ?? `${options.ticker} trades below its own five-year median multiple.`,
        invalidation:
          options.invalidation ??
          `Return on equity stays below 8% through the next two reported quarters.`,
      },
    ],
    sourcesUsed: [...(options.sourcesUsed ?? [])],
  };
}

export interface MockAgentOptions {
  readonly portfolio?: PortfolioConfig;
  readonly mandate?: string;
  readonly script?: readonly MockTurn[];
  readonly market?: MarketDataPort;
  readonly search?: WebSearchPort;
  readonly history?: DecisionHistoryPort;
  readonly playbooks?: PlaybookPort;
  readonly log?: (line: string) => void;
}

/**
 * One agent over a scripted model, plus the model itself so a test can read
 * back what the loop actually sent.
 */
export function mockAgent(options: MockAgentOptions = {}): {
  readonly decider: StrandsAgentDecider;
  readonly model: MockModel;
} {
  const config = options.portfolio ?? portfolio("value");
  const model = new MockModel({
    modelId: config.model ?? "claude-sonnet-5",
    script: options.script ?? [{ kind: "output", value: mockHold() }],
  });
  const decider = new StrandsAgentDecider({
    portfolio: config,
    mandate: options.mandate ?? liveMandates().get(config.key) ?? "# Mandate\n\nBuy cheap things.",
    models: fixedModelFactory(model),
    market: options.market ?? new FixtureMarketData({}),
    search: options.search ?? new DisabledWebSearch("tests do not search the web"),
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.playbooks === undefined ? {} : { playbooks: options.playbooks }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { decider, model };
}

/**
 * Controls plus every enabled agent, as the daily run assembles them.
 *
 * This is what `runSession` uses by default, so the engine tests drive the
 * real agent leg rather than a roster that quietly excludes it. The script
 * holds: an engine test is about fills, deposits and guardrails, and an agent
 * inventing trades on top of that would make those assertions about two things
 * at once.
 */
export function deciders(
  options: {
    readonly script?: readonly MockTurn[];
    readonly market?: MarketDataPort;
    readonly search?: WebSearchPort;
    readonly history?: DecisionHistoryPort;
  } = {},
): Map<string, Decider> {
  const portfolios = livePortfolios();
  const all = new Map<string, Decider>(createControls(portfolios.all));
  for (const [key, agent] of createAgents({
    portfolios: portfolios.all,
    mandates: liveMandates(),
    models: scriptedModelFactory(options.script ?? [{ kind: "output", value: mockHold() }]),
    market: options.market ?? new FixtureMarketData({}),
    search: options.search ?? new DisabledWebSearch("tests do not search the web"),
    ...(options.history === undefined ? {} : { history: options.history }),
  })) {
    all.set(key, agent);
  }
  return all;
}

/** Recorded search results, for the archive assertions. */
export function fixtureSearch(
  results: Readonly<Record<string, readonly WebSearchResult[]>>,
): FixtureWebSearch {
  return new FixtureWebSearch(results);
}

/** A history port over records handed in directly. */
export function historyOf(records: readonly DecisionRecord[]): DecisionHistoryPort {
  return { recent: () => records };
}

/** A playbook port over rules handed in directly. */
export function playbookOf(rules: readonly PlaybookRule[]): PlaybookPort {
  return { rules: () => rules };
}

// --- A decision context, built by hand ---------------------------------------

/** The dry-run universe at one session, which is what the agent tests price against. */
export const AGENT_SESSION = "2026-03-04";

export const AGENT_QUOTES: readonly QuoteSpec[] = [
  { ticker: "VWRL.AS", open: 120.5, close: 121.0, previousClose: 120.1 },
  { ticker: "SAP.DE", open: 210.0, close: 212.4, previousClose: 209.8 },
  { ticker: "ASML.AS", open: 640.0, close: 651.5, previousClose: 638.0 },
  { ticker: "AAPL", currency: "USD", open: 188.0, close: 190.25, previousClose: 187.4 },
];

export interface ContextOptions {
  readonly portfolio?: PortfolioConfig;
  readonly sessionDate?: string;
  readonly quotes?: readonly QuoteSpec[];
  readonly state?: PortfolioState;
  readonly availableCashEur?: number;
  readonly depositedTodayEur?: number;
  readonly tradesThisMonth?: number;
  readonly eurusd?: number;
}

export function agentContext(options: ContextOptions = {}): DecisionContext {
  const config = options.portfolio ?? portfolio("value");
  const date = options.sessionDate ?? AGENT_SESSION;
  const quotes = options.quotes ?? AGENT_QUOTES;
  const brief = briefWith(date, quotes, {
    ...(options.eurusd === undefined ? {} : { eurusd: options.eurusd }),
  });
  return {
    portfolio: config,
    state: options.state ?? stateFrom(config.key, []),
    brief,
    prices: new SessionPrices(brief),
    universe: dryRunUniverse(),
    simulation: liveSimulation(),
    sessionDate: date,
    availableCashEur: options.availableCashEur ?? 100,
    depositedTodayEur: options.depositedTodayEur ?? 0,
    tradesThisMonth: options.tradesThisMonth ?? 0,
  };
}

/** Bars for the price-history tool, one per session in the window. */
export function barsFor(
  ticker: string,
  dates: readonly string[],
): Record<string, { date: string; open: number; high: number; low: number; close: number; adjClose: number; volume: number }[]> {
  return {
    [ticker]: dates.map((date, index) => ({
      date,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      adjClose: 100.5 + index,
      volume: 1_000 + index,
    })),
  };
}
