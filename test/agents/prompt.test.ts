/**
 * What the agent is shown (SPEC 7, SPEC 10, SPEC 14).
 *
 * Two of SPEC 14's acceptance checks are literally assertions on a serialized
 * prompt — "a `probation` rule never appears in a daily agent prompt; assert
 * on the serialized prompt" and "`news-frozen` prompts contain no playbook
 * content in any month" — and they are the reason `buildPrompt` returns a
 * value instead of calling a model. The rest of this file checks that every
 * input SPEC 7 promises an agent actually arrives.
 */
import { describe, expect, it } from "vitest";
import { buildPrompt, type PlaybookRule } from "../../src/agents/prompt.js";
import { buildDecisionRecord } from "../../src/engine/decision.js";
import type { DecisionRecord } from "../../src/engine/decision.js";
import {
  AGENT_QUOTES,
  AGENT_SESSION,
  agentContext,
  liveMandates,
} from "../helpers/agents.js";
import { deposit, filled, placed, portfolio, stateFrom } from "../helpers/engine.js";

const MANDATE = liveMandates().get("value") ?? "";

function promptFor(
  overrides: {
    readonly playbook?: readonly PlaybookRule[];
    readonly decisionHistory?: readonly DecisionRecord[];
    readonly portfolioKey?: string;
    readonly mandate?: string;
  } = {},
) {
  const config = portfolio(overrides.portfolioKey ?? "value");
  const context = agentContext({ portfolio: config, tradesThisMonth: 1, availableCashEur: 87.5 });
  return buildPrompt({
    portfolio: config,
    mandate: overrides.mandate ?? MANDATE,
    state: context.state,
    brief: context.brief,
    prices: context.prices,
    universe: context.universe,
    simulation: context.simulation,
    sessionDate: context.sessionDate,
    availableCashEur: context.availableCashEur,
    depositedTodayEur: context.depositedTodayEur,
    tradesThisMonth: context.tradesThisMonth,
    decisionHistory: overrides.decisionHistory ?? [],
    ...(overrides.playbook === undefined ? {} : { playbook: overrides.playbook }),
  });
}

const PROBATION: PlaybookRule = {
  id: "pb-001",
  text: "Never add to a position that has fallen more than 20% since entry.",
  status: "probation",
};
const ACTIVE: PlaybookRule = {
  id: "pb-002",
  text: "Require a forward P/E below the five-year median before buying.",
  status: "active",
};
const RETIRED: PlaybookRule = {
  id: "pb-003",
  text: "Prefer names that have reported within the last month.",
  status: "retired",
};

describe("SPEC 7: everything the agent is given", () => {
  it("carries the mandate verbatim", () => {
    const prompt = promptFor();
    expect(prompt.system).toContain(MANDATE.trim());
    expect(MANDATE.length).toBeGreaterThan(500);
  });

  it("states the guardrails as hard limits, with the numbers from config", () => {
    const prompt = promptFor();
    const guardrails = portfolio("value").guardrails;
    expect(prompt.system).toContain(`at most ${guardrails.maxTradesPerMonth}`);
    expect(prompt.system).toContain(`Used so far: 1`);
    expect(prompt.system).toContain(`Remaining: ${guardrails.maxTradesPerMonth - 1}`);
    expect(prompt.system).toContain(`${guardrails.minHoldDays} day(s)`);
    expect(prompt.system).toContain(`${guardrails.maxPositionPct}%`);
    expect(prompt.system).toMatch(/No shorting, no leverage, no derivatives/);
  });

  it("puts the whole brief in front of it, hash included", () => {
    const context = agentContext();
    const prompt = promptFor();
    expect(prompt.user).toContain(context.brief.briefHash);
    for (const quote of AGENT_QUOTES) {
      expect(prompt.user, quote.ticker).toContain(quote.ticker);
    }
    expect(prompt.user).toContain("EURUSD=X");
    expect(prompt.user).toContain(AGENT_SESSION);
  });

  it("reports cash, positions, cost basis and unrealized P&L", () => {
    const config = portfolio("value");
    const state = stateFrom("value", [
      deposit("value", "2026-03-02", 100),
      placed("value", "2026-03-02", { ticker: "SAP.DE", side: "buy", targetEur: 60 }),
      filled("value", "2026-03-03", {
        orderId: "2026-03-02/value/ord/1",
        ticker: "SAP.DE",
        side: "buy",
        qty: 0.281,
        priceLocal: 210,
      }),
    ]);
    const context = agentContext({ portfolio: config, state, availableCashEur: 40.99 });
    const prompt = buildPrompt({
      portfolio: config,
      mandate: MANDATE,
      state,
      brief: context.brief,
      prices: context.prices,
      universe: context.universe,
      simulation: context.simulation,
      sessionDate: context.sessionDate,
      availableCashEur: context.availableCashEur,
      depositedTodayEur: 0,
      tradesThisMonth: 1,
      decisionHistory: [],
    });

    expect(prompt.user).toContain("SAP.DE");
    expect(prompt.user).toContain("0.281");
    expect(prompt.user).toMatch(/Cash you may actually deploy today: \*\*40\.99 EUR\*\*/);
    expect(prompt.user).toMatch(/Unrealized P&L/);
    // SPEC 4: the FX contribution is never allowed to pass as stock picking,
    // so it is broken out here too rather than folded into one number.
    expect(prompt.user).toMatch(/price [-+][\d.]+, FX [-+][\d.]+/);
  });

  it("says plainly when the portfolio cannot afford any order at all", () => {
    const config = portfolio("value");
    const context = agentContext({ portfolio: config, availableCashEur: 3 });
    const prompt = buildPrompt({
      portfolio: config,
      mandate: MANDATE,
      state: context.state,
      brief: context.brief,
      prices: context.prices,
      universe: context.universe,
      simulation: context.simulation,
      sessionDate: context.sessionDate,
      availableCashEur: 3,
      depositedTodayEur: 0,
      tradesThisMonth: 0,
      decisionHistory: [],
    });
    expect(prompt.user).toContain("**You cannot buy today.**");
  });

  it("replays its own last 30 days, rationales and invalidations included", () => {
    const record = buildDecisionRecord({
      decisionId: "2026-03-03/value/dec",
      portfolio: portfolio("value"),
      date: "2026-03-03",
      decidedAt: "2026-03-03T21:00:00.000Z",
      briefHash: "sha256:" + "0".repeat(64),
      decision: {
        action: "trade",
        rationale: "SAP at 19x forward against a 24x five-year median.",
        confidence: 4,
        orders: [],
        sourcesUsed: [],
      },
      outcomes: [
        {
          orderId: "2026-03-03/value/ord/1",
          ticker: "SAP.DE",
          side: "buy",
          targetEur: 60,
          thesis: "Cheap against its own history.",
          invalidation: "Cloud backlog growth falls below 15% for two quarters.",
          status: "placed",
          reasonCode: null,
          detail: null,
        },
      ],
    });

    const prompt = promptFor({ decisionHistory: [record] });
    expect(prompt.user).toContain("SAP at 19x forward against a 24x five-year median.");
    expect(prompt.user).toContain("Cloud backlog growth falls below 15% for two quarters.");
    expect(prompt.user).toContain("2026-03-03");
  });

  it("says so when there is no history rather than leaving a blank", () => {
    expect(promptFor().user).toContain("Nothing yet. This is your first recorded session.");
  });

  it("tells the agent its tool and search budgets", () => {
    const prompt = promptFor();
    const agents = agentContext().simulation.agents;
    expect(prompt.system).toContain(`**${agents.maxToolCalls} tool calls**`);
    expect(prompt.system).toContain(`**${agents.maxWebSearches}**`);
  });
});

describe("SPEC 10 and SPEC 14: the playbook rules of engagement", () => {
  it("never puts a probation rule in a daily prompt", () => {
    // "A rule enters at `probation` and is not injected into the daily prompt.
    // It appears on the dashboard only."
    const prompt = promptFor({ playbook: [PROBATION, ACTIVE, RETIRED] });
    expect(prompt.serialized).not.toContain(PROBATION.text);
    expect(prompt.serialized).not.toContain(PROBATION.id);
    expect(prompt.serialized).toContain(ACTIVE.text);
  });

  it("never puts a retired rule in one either", () => {
    const prompt = promptFor({ playbook: [RETIRED] });
    expect(prompt.serialized).not.toContain(RETIRED.text);
    expect(prompt.serialized).not.toContain("## Your playbook");
  });

  it("omits the playbook section entirely when nothing is active", () => {
    expect(promptFor({ playbook: [] }).serialized).not.toContain("## Your playbook");
    expect(promptFor().serialized).not.toContain("## Your playbook");
  });

  it("gives a frozen portfolio no playbook content in any month", () => {
    // SPEC 5: `news-frozen` is "the control for learning itself". A playbook
    // leaking into its prompt destroys the only comparison this project makes.
    const frozen = portfolio("news-frozen");
    expect(frozen.learning).toBe("frozen");
    const context = agentContext({ portfolio: frozen });
    const prompt = buildPrompt({
      portfolio: frozen,
      mandate: "# Mandate\n\nTrade catalysts.",
      state: context.state,
      brief: context.brief,
      prices: context.prices,
      universe: context.universe,
      simulation: context.simulation,
      sessionDate: context.sessionDate,
      availableCashEur: 100,
      depositedTodayEur: 0,
      tradesThisMonth: 0,
      decisionHistory: [],
      // Handed a playbook on purpose: the guarantee has to survive a caller
      // that gets it wrong, not merely a caller that gets it right.
      playbook: [ACTIVE, PROBATION],
    });
    expect(prompt.serialized).not.toContain("## Your playbook");
    expect(prompt.serialized).not.toContain(ACTIVE.text);
    expect(prompt.serialized).not.toContain(PROBATION.text);
  });
});

describe("determinism", () => {
  it("builds the same prompt twice from the same inputs", () => {
    // SPEC 1.4: the brief is built once and handed unchanged to every agent.
    // A prompt that varied run to run would also make the recorded prompt hash
    // meaningless.
    expect(promptFor().serialized).toBe(promptFor().serialized);
  });

  it("dates everything from the session, never from the host", () => {
    // Every date in the prompt comes from the brief or the session, both of
    // which are values pinned by the fixture. A `new Date()` that crept into
    // the builder would print a date after the session and fail here;
    // `layering.test.ts` makes the structural version of the same claim.
    const dates = promptFor().serialized.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(dates.length).toBeGreaterThan(0);
    for (const date of new Set(dates)) {
      expect(date <= AGENT_SESSION, date).toBe(true);
    }
  });
});
