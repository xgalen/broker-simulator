/**
 * The agent inside the daily sequence (SPEC 8, SPEC 1.1, SPEC 1.6, SPEC 7).
 *
 * `test/agents/agent.test.ts` proves the agent produces a decision. This
 * proves the engine treats that decision exactly as it treats a control's: it
 * goes through the same validator, becomes the same ORDER_PLACED, fills at the
 * same next open, and is refused by the same guardrails.
 *
 * That the engine cannot tell the two apart is the load-bearing claim of phase
 * 4 and the reason phase 5 needed no new path through the ledger.
 */
import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../../src/domain/events.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import { deciders, mockBuy, mockHold } from "../helpers/agents.js";
import { dryRunUniverse, runSession, type QuoteSpec } from "../helpers/engine.js";

/** Three sessions in the dry-run universe, so an order has a next open. */
const SESSIONS: readonly { readonly date: string; readonly quotes: readonly QuoteSpec[] }[] = [
  {
    date: "2026-03-02",
    quotes: [
      { ticker: "VWRL.AS", open: 119.0, close: 120.0, previousClose: 118.5 },
      { ticker: "SAP.DE", open: 205.0, close: 206.0, previousClose: 204.0 },
    ],
  },
  {
    date: "2026-03-03",
    quotes: [
      { ticker: "VWRL.AS", open: 120.2, close: 121.0, previousClose: 120.0 },
      { ticker: "SAP.DE", open: 206.5, close: 208.0, previousClose: 206.0 },
    ],
  },
  {
    date: "2026-03-04",
    quotes: [
      { ticker: "VWRL.AS", open: 121.1, close: 121.5, previousClose: 121.0 },
      { ticker: "SAP.DE", open: 209.0, close: 212.4, previousClose: 208.0 },
    ],
  },
];

const BARS = {
  "SAP.DE": SESSIONS.map((session) => ({
    date: session.date,
    open: session.quotes[1]?.open ?? null,
    high: session.quotes[1]?.close ?? null,
    low: session.quotes[1]?.open ?? null,
    close: session.quotes[1]?.close ?? null,
    adjClose: session.quotes[1]?.close ?? null,
    volume: 1_000,
  })),
};

const valueEvents = (events: readonly LedgerEvent[]) =>
  events.filter((event) => event.portfolio === "value");

describe("an agent order goes through the same pipeline as a control's", () => {
  it("queues on the deciding session and fills at the next open (SPEC 1.1)", async () => {
    const history: LedgerEvent[] = [];
    const market = new FixtureMarketData({ bars: BARS });

    // Session 0: the 100 EUR seed lands and the agent buys with 60 of it.
    const first = await runSession({
      sessions: SESSIONS,
      index: 0,
      history,
      deciders: deciders({
        market,
        script: [
          { kind: "tool", name: "getPriceHistory", input: { ticker: "SAP.DE", range: "1m" } },
          { kind: "output", value: mockBuy({ ticker: "SAP.DE", targetEur: 60 }) },
        ],
      }),
    });
    history.push(...first.events);

    const placed = valueEvents(first.events).filter((event) => event.type === "ORDER_PLACED");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: "SAP.DE", side: "buy", targetEur: 60 });
    // Nothing filled on the deciding session: that is the whole rule.
    expect(valueEvents(first.events).some((event) => event.type === "ORDER_FILLED")).toBe(false);

    // Session 1: it fills at that session's open, not at the close it decided on.
    const second = await runSession({
      sessions: SESSIONS,
      index: 1,
      history,
      deciders: deciders({ market, script: [{ kind: "output", value: mockHold() }] }),
    });
    history.push(...second.events);

    const fills = valueEvents(second.events).filter((event) => event.type === "ORDER_FILLED");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ ticker: "SAP.DE", priceLocal: 206.5 });
    // 206.5 is session 1's open. 206.0 was session 0's close — the price the
    // agent could see when it decided, and the one it must never be given.
    expect(fills[0]?.type === "ORDER_FILLED" && fills[0].priceLocal).not.toBe(206.0);

    const report = verifyLedger(history, { universe: dryRunUniverse().tickers });
    expect(report.violations).toEqual([]);
  });

  it("rejects an off-whitelist ticker from an agent, with a reason (SPEC 1.6)", async () => {
    const run = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: [],
      deciders: deciders({
        script: [{ kind: "output", value: mockBuy({ ticker: "TSLA", targetEur: 50 }) }],
      }),
    });

    const rejected = valueEvents(run.events).filter((event) => event.type === "ORDER_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reasonCode: "off_whitelist" });
    expect(valueEvents(run.events).some((event) => event.type === "ORDER_PLACED")).toBe(false);

    // SPEC 14: the intent is recorded next to the refusal, so the decision
    // stays auditable even though nothing reached a balance.
    const record = run.decisions.find((entry) => entry.portfolio === "value");
    expect(record?.orders[0]).toMatchObject({ ticker: "TSLA", status: "rejected" });
    expect(record?.rationale.length).toBeGreaterThan(0);
  });

  it("sizes an oversized order down to the cash available, never past it", async () => {
    // The validator treats `targetEur` as "deploy up to this much" and clamps
    // it to the cash above the floor. That is the engine's existing contract
    // (see `test/engine/rejection.test.ts`, where a *second* order with
    // nothing left is what gets refused), and the agent gets no exception to
    // it: what matters is that cash never goes negative (SPEC 4).
    const history: LedgerEvent[] = [];
    const first = await runSession({
      sessions: SESSIONS,
      index: 0,
      history,
      deciders: deciders({
        script: [{ kind: "output", value: mockBuy({ ticker: "SAP.DE", targetEur: 5_000 }) }],
      }),
    });
    history.push(...first.events);

    const placed = valueEvents(first.events).filter((event) => event.type === "ORDER_PLACED");
    expect(placed[0]).toMatchObject({ targetEur: 5_000 });

    const second = await runSession({
      sessions: SESSIONS,
      index: 1,
      history,
      deciders: deciders({ script: [{ kind: "output", value: mockHold() }] }),
    });
    history.push(...second.events);

    const fill = valueEvents(second.events).find((event) => event.type === "ORDER_FILLED");
    expect(fill?.type === "ORDER_FILLED" && fill.netEur).toBeLessThanOrEqual(100);

    const report = verifyLedger(history, { universe: dryRunUniverse().tickers });
    expect(report.violations).toEqual([]);
  });

  it("writes a HOLD with the agent's own rationale (SPEC 1.7)", async () => {
    const rationale =
      "SAP at 19.4x forward is the only name with fresh fundamentals today, and that is dearer than its own five-year median. The contribution stays in cash.";
    const run = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: [],
      deciders: deciders({ script: [{ kind: "output", value: mockHold(rationale) }] }),
    });

    const holds = valueEvents(run.events).filter((event) => event.type === "HOLD");
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ reason: rationale });
  });
});

describe("the decision record the run commits", () => {
  it("carries the agent's model, tokens, cost, prompt and searches", async () => {
    const run = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: [],
      deciders: deciders({ script: [{ kind: "output", value: mockHold() }] }),
    });

    const record = run.decisions.find((entry) => entry.portfolio === "value");
    expect(record?.kind).toBe("agent");
    const agent = record?.meta["agent"] as Record<string, unknown>;

    expect(agent["model"]).toMatchObject({ id: "claude-sonnet-5" });
    expect(agent["usage"]).toMatchObject({ totalTokens: expect.any(Number) });
    expect(agent["cost"]).toHaveProperty("usd");
    expect(agent["prompt"]).toHaveProperty("hash");
    expect(agent["searches"]).toEqual([]);
    // The engine's own numbers survive the merge: a decider cannot overwrite
    // the account of what it was actually given.
    expect(record?.meta["availableCashEur"]).toBe(100);
  });

  it("leaves the controls' records untouched by any of it", async () => {
    const run = await runSession({
      sessions: SESSIONS,
      index: 0,
      history: [],
      deciders: deciders({ script: [{ kind: "output", value: mockHold() }] }),
    });

    const dca = run.decisions.find((entry) => entry.portfolio === "dca");
    expect(dca?.kind).toBe("control");
    expect(dca?.meta["agent"]).toBeUndefined();
  });
});

describe("SPEC 1.5 still wins over the agents", () => {
  it("never calls a model on a session it skipped", async () => {
    const { MarketDataError } = await import("../../src/data/port.js");
    let created = 0;
    const failing = new FixtureMarketData(
      {},
      { failWith: new MarketDataError("yahoo is down", "transient") },
    );

    const roster = deciders({ script: [{ kind: "output", value: mockHold() }] });
    const agent = roster.get("value");
    if (agent === undefined) throw new Error("no value agent");
    roster.set("value", {
      portfolio: "value",
      decide: (context) => {
        created += 1;
        return agent.decide(context);
      },
    });

    const run = await runSession({ sessions: SESSIONS, index: 0, history: [], market: failing, deciders: roster });

    expect(run.status).toBe("skipped");
    // The brief is the price fetch, and it fails before any decider runs. An
    // agent invoked here would be reasoning about prices the run has already
    // decided it cannot trust — and would be billed for it.
    expect(created).toBe(0);
    expect(run.events.every((event) => event.type === "SKIPPED")).toBe(true);
  });
});
