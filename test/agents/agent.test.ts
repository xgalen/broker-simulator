/**
 * The agent loop, end to end (SPEC 7).
 *
 * Every test here drives a real Strands `Agent` — real tool executor, real
 * structured-output tool, real `limits` enforcement — with `MockModel` in
 * place of the HTTP call. That is deliberate: the things phase 5 can get wrong
 * are the schema gate, the budget fallback, the archive and the cost line, and
 * a fake decider would exercise none of them.
 */
import { describe, expect, it } from "vitest";
import { splitOutcome } from "../../src/engine/decision.js";
import { STRUCTURED_OUTPUT_TOOL } from "../../src/agents/mock.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import {
  agentContext,
  fixtureSearch,
  mockAgent,
  mockBuy,
  mockHold,
  playbookOf,
} from "../helpers/agents.js";
import { portfolio } from "../helpers/engine.js";

const BARS = {
  "SAP.DE": [
    { date: "2026-03-03", open: 206, high: 209, low: 205, close: 208, adjClose: 208, volume: 11 },
    { date: "2026-03-04", open: 210, high: 213, low: 209, close: 212.4, adjClose: 212.4, volume: 12 },
  ],
};

const FUNDAMENTALS = {
  "SAP.DE": {
    ticker: "SAP.DE",
    currency: "EUR",
    marketCap: 250_000_000_000,
    trailingPe: 41.2,
    forwardPe: 19.4,
    priceToBook: 4.1,
    dividendYield: 0.011,
    returnOnEquity: 0.163,
    debtToEquity: 0.22,
    asOf: "2026-03-04T20:00:00.000Z",
  },
};

/** Read the agent block the decider contributes to the decision record. */
function meta(outcome: { readonly meta?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  return (outcome.meta?.["agent"] ?? {}) as Record<string, unknown>;
}

describe("a run that decides", () => {
  it("submits a decision through the structured-output tool and returns it", async () => {
    const { decider, model } = mockAgent({
      script: [{ kind: "output", value: mockBuy({ ticker: "SAP.DE", targetEur: 60 }) }],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("trade");
    expect(outcome.decision.orders[0]?.ticker).toBe("SAP.DE");
    expect(outcome.decision.orders[0]?.invalidation.length).toBeGreaterThan(0);
    expect(meta(outcome)["outcome"]).toBe("decided");

    // The SDK really did advertise the four tools plus the output tool.
    expect([...(model.calls[0]?.toolSpecs ?? [])].sort()).toEqual(
      ["getFundamentals", "getNewsForTicker", "getPriceHistory", "webSearch", STRUCTURED_OUTPUT_TOOL].sort(),
    );
  });

  it("runs the tools it asks for and records what came back", async () => {
    const market = new FixtureMarketData({ bars: BARS, fundamentals: FUNDAMENTALS });
    const { decider } = mockAgent({
      market,
      script: [
        { kind: "tool", name: "getFundamentals", input: { ticker: "SAP.DE" } },
        { kind: "tool", name: "getPriceHistory", input: { ticker: "SAP.DE", range: "1m" } },
        { kind: "output", value: mockHold("SAP at 19.4x forward is not cheap enough yet.") },
      ],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");

    const calls = meta(outcome)["toolCalls"] as { name: string; ok: boolean; summary: string }[];
    expect(calls.map((call) => call.name)).toEqual(["getFundamentals", "getPriceHistory"]);
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(calls[0]?.summary).toContain("forwardPe=19.4");
    expect(market.calls).toEqual(["getFundamentals(SAP.DE)", "getDailyBars(SAP.DE)"]);
    expect(meta(outcome)["toolCallsUsed"]).toBe(2);
  });

  it("archives searches into the decision record verbatim", async () => {
    const results = [
      {
        title: "SAP guides cloud backlog higher",
        url: "https://example.invalid/sap",
        snippet: "Current cloud backlog grew 28%, above the 25% guided in January.",
        publishedAt: "2026-03-01T08:00:00Z",
      },
    ];
    const { decider } = mockAgent({
      search: fixtureSearch({ "SAP cloud backlog guidance": results }),
      script: [
        { kind: "tool", name: "webSearch", input: { query: "SAP cloud backlog guidance" } },
        { kind: "output", value: mockHold() },
      ],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    const searches = meta(outcome)["searches"] as { query: string; results: unknown[] }[];
    expect(searches).toHaveLength(1);
    expect(searches[0]?.query).toBe("SAP cloud backlog guidance");
    expect(searches[0]?.results).toEqual(results);
    expect(meta(outcome)["searchProvider"]).toBe("fixture");
  });

  it("records the model, the tokens and the computed cost (SPEC 7)", async () => {
    const { decider } = mockAgent({
      script: [
        { kind: "tool", name: "getPriceHistory", input: { ticker: "SAP.DE", range: "5d" }, usage: { inputTokens: 4_000, outputTokens: 150 } },
        { kind: "output", value: mockHold(), usage: { inputTokens: 6_000, outputTokens: 400 } },
      ],
      market: new FixtureMarketData({ bars: BARS }),
    });

    const outcome = splitOutcome(await decider.decide(agentContext({ eurusd: 1.1 })));
    const agent = meta(outcome);

    expect(agent["model"]).toEqual({ id: "claude-sonnet-5", provider: "mock" });
    expect(agent["usage"]).toMatchObject({
      inputTokens: 10_000,
      outputTokens: 550,
      totalTokens: 10_550,
    });

    // claude-sonnet-5 at $2.00/MTok in and $10.00/MTok out, converted at the
    // brief's own EURUSD rate — the same rate every fill and mark uses.
    const cost = agent["cost"] as { usd: number; eur: number; usdPerEur: number };
    // Both figures are kept to the microdollar: a single cheap run costs a
    // fraction of a cent, and rounding it to the cent would make every day
    // read as free while the month's total is real money.
    expect(cost.usd).toBeCloseTo(10_000 * 2e-6 + 550 * 1e-5, 6);
    expect(cost.usdPerEur).toBe(1.1);
    expect(cost.eur).toBeCloseTo(cost.usd / 1.1, 6);
  });

  it("commits the whole prompt, and a hash of it and of the mandate", async () => {
    const { decider } = mockAgent({ script: [{ kind: "output", value: mockHold() }] });
    const outcome = splitOutcome(await decider.decide(agentContext()));
    const prompt = meta(outcome)["prompt"] as { system: string; user: string; hash: string };

    expect(prompt.system).toContain("## Your mandate");
    expect(prompt.user).toContain("## The daily brief");
    expect(prompt.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta(outcome)["mandateHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reports the limits it ran under, so a record explains its own shape", async () => {
    const { decider } = mockAgent({ script: [{ kind: "output", value: mockHold() }] });
    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(meta(outcome)["limits"]).toEqual({
      maxTurns: 15,
      maxToolCalls: 12,
      maxWebSearches: 5,
      maxTotalTokensPerRun: 200_000,
      maxOutputTokensPerRun: 24_000,
    });
  });
});

describe("SPEC 7: exceeding a budget writes a HOLD", () => {
  it("holds with `budget_exceeded` when the turn limit trips", async () => {
    // A model that calls a tool forever. The SDK's `limits.turns` is what stops
    // it, and the stop reason is what this turns into a recorded hold.
    const { decider } = mockAgent({
      market: new FixtureMarketData({ bars: BARS }),
      script: [{ kind: "tool", name: "getPriceHistory", input: { ticker: "SAP.DE", range: "5d" } }],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(outcome.decision.orders).toEqual([]);
    // The HOLD event's `reason` is this string verbatim, so the machine token
    // leads and the prose SPEC 1.7 asks for follows.
    expect(outcome.decision.rationale.startsWith("budget_exceeded:")).toBe(true);
    expect(meta(outcome)["outcome"]).toBe("budget_exceeded");
    expect(meta(outcome)["stopReason"]).toBe("limitTurns");
  });

  it("holds with `budget_exceeded` when the token budget trips", async () => {
    const { decider } = mockAgent({
      market: new FixtureMarketData({ bars: BARS }),
      script: [
        {
          kind: "tool",
          name: "getPriceHistory",
          input: { ticker: "SAP.DE", range: "5d" },
          usage: { inputTokens: 150_000, outputTokens: 60_000 },
        },
      ],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(outcome.decision.rationale).toMatch(/^budget_exceeded:/);
    // Turns, total tokens and output tokens all trip here; SPEC 7 only cares
    // that one of them did and that the outcome is a hold.
    expect(meta(outcome)["outcome"]).toBe("budget_exceeded");
    expect(String(meta(outcome)["stopReason"])).toMatch(/^limit/);
  });

  it("refuses the 13th tool call without ending the run", async () => {
    // The cap is not the abort: the agent is told the budget is gone and still
    // gets to write a real decision. The abort is the SDK limit above.
    const { decider } = mockAgent({
      market: new FixtureMarketData({ bars: BARS }),
      script: [
        ...Array.from({ length: 13 }, () => ({
          kind: "tool" as const,
          name: "getPriceHistory",
          input: { ticker: "SAP.DE", range: "5d" },
        })),
        { kind: "output" as const, value: mockHold("Out of tool budget; nothing found to act on.") },
      ],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(meta(outcome)["outcome"]).toBe("decided");
    expect(meta(outcome)["toolCallsUsed"]).toBe(12);
    expect(meta(outcome)["capReached"]).toBe(true);

    const calls = meta(outcome)["toolCalls"] as { ok: boolean }[];
    expect(calls).toHaveLength(13);
    expect(calls[12]?.ok).toBe(false);
  });
});

describe("a run that goes wrong holds rather than taking the session down", () => {
  it("holds when the provider throws", async () => {
    const { decider } = mockAgent({
      script: [{ kind: "error", message: "anthropic returned 529 overloaded" }],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(outcome.decision.rationale).toMatch(/^agent_error:/);
    expect(meta(outcome)["outcome"]).toBe("agent_error");
    expect(String(meta(outcome)["detail"])).toMatch(/529 overloaded/);
  });

  it("holds when the model will not produce valid output", async () => {
    // Plain text with a schema set makes the SDK force the tool; a model that
    // still refuses raises `StructuredOutputError`, which must not escape.
    const { decider } = mockAgent({ script: [{ kind: "text", text: "I would rather not." }] });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(["agent_error", "no_answer"]).toContain(meta(outcome)["outcome"]);
    expect(outcome.decision.rationale).toMatch(/No order was placed\./);
  });

  it("holds when the credential is missing, and says so", async () => {
    const { unavailableModelFactory } = await import("../../src/agents/model.js");
    const { StrandsAgentDecider } = await import("../../src/agents/agent.js");
    const { DisabledWebSearch } = await import("../../src/agents/search.js");

    const decider = new StrandsAgentDecider({
      portfolio: portfolio("value"),
      mandate: "# Mandate\n\nBuy cheap things.",
      models: unavailableModelFactory("ANTHROPIC_API_KEY is not set"),
      market: new FixtureMarketData({}),
      search: new DisabledWebSearch("no provider"),
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(outcome.decision.rationale).toMatch(/ANTHROPIC_API_KEY is not set/);
    // Nothing was spent, and the record says so rather than claiming zero cost
    // for a run that happened.
    expect(meta(outcome)["usage"]).toMatchObject({ totalTokens: 0 });
  });

  it("keeps a decision that breaks the contract out of the ledger", async () => {
    // `action: trade` with no orders passes the shape and fails the contract.
    // The SDK's own validation lets it through; `parseDecision` does not.
    const { decider } = mockAgent({
      script: [{ kind: "output", value: { ...mockHold(), action: "trade" } }],
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    expect(outcome.decision.action).toBe("hold");
    expect(meta(outcome)["outcome"]).toBe("agent_error");
    expect(String(meta(outcome)["detail"])).toMatch(/attached no orders/);
    // The rejected output is kept, so the failure is diagnosable tomorrow.
    expect(meta(outcome)["rejectedOutput"]).toMatchObject({ action: "trade" });
  });
});

describe("SPEC 10: a frozen agent never receives a playbook", () => {
  it("does not even ask the playbook port", async () => {
    const frozen = portfolio("news-frozen");
    let asked = false;
    const { decider } = mockAgent({
      portfolio: frozen,
      mandate: "# Mandate\n\nTrade catalysts.",
      script: [{ kind: "output", value: mockHold() }],
      playbooks: {
        rules: () => {
          asked = true;
          return [{ id: "pb-1", text: "A rule that must never appear.", status: "active" as const }];
        },
      },
    });

    const outcome = splitOutcome(await decider.decide(agentContext({ portfolio: frozen })));
    expect(asked).toBe(false);
    const prompt = meta(outcome)["prompt"] as { system: string; user: string };
    expect(`${prompt.system}${prompt.user}`).not.toContain("A rule that must never appear.");
  });

  it("injects an active rule for a learning agent", async () => {
    const { decider } = mockAgent({
      script: [{ kind: "output", value: mockHold() }],
      playbooks: playbookOf([
        { id: "pb-2", text: "Require a forward P/E below the five-year median.", status: "active" },
        { id: "pb-3", text: "A rule still on probation.", status: "probation" },
      ]),
    });

    const outcome = splitOutcome(await decider.decide(agentContext()));
    const prompt = meta(outcome)["prompt"] as { system: string };
    expect(prompt.system).toContain("Require a forward P/E below the five-year median.");
    expect(prompt.system).not.toContain("A rule still on probation.");
  });
});
