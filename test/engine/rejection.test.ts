/**
 * SPEC 14: "An agent returning an off-whitelist ticker, an over-limit order, or
 * an order exceeding available cash produces `ORDER_REJECTED` with a reason and
 * no ledger mutation."
 *
 * The controls never misbehave — that is the point of them — so this drives the
 * engine with a decider built to return exactly the three things SPEC 14 names.
 * The check that matters is the second half of the sentence: *no ledger
 * mutation*. A rejection must leave cash, positions and the queue untouched.
 */
import { describe, expect, it } from "vitest";
import { replayPortfolio } from "../../src/domain/replay.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import type { LedgerEvent } from "../../src/domain/events.js";
import type { Decider, Decision, DecisionContext, ProposedOrder } from "../../src/engine/decision.js";
import { Portfolios } from "../../src/engine/config.js";
import { dryRunUniverse, livePortfolios, runSession, type QuoteSpec } from "../helpers/engine.js";

const QUOTES: QuoteSpec[] = [
  { ticker: "VWRL.AS", open: 117.7, close: 117.84 },
  { ticker: "MEUD.PA", open: 261.0, close: 262.1 },
  { ticker: "VUSA.AS", open: 105.2, close: 105.75 },
  { ticker: "SAP.DE", open: 240.0, close: 241.8 },
  { ticker: "ASML.AS", open: 710.0, close: 712.5 },
  { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
  { ticker: "MSFT", currency: "USD", open: 430.0, close: 431.2 },
  { ticker: "NVDA", currency: "USD", open: 170.0, close: 172.4 },
  { ticker: "^GSPC", currency: "USD", open: 6100, close: 6180 },
];

const SESSIONS = [{ date: "2026-01-29", quotes: QUOTES }];

/** Returns whatever it is told to, so the validator can be aimed at it. */
class RogueDecider implements Decider {
  constructor(
    readonly portfolio: string,
    private readonly orders: readonly ProposedOrder[],
  ) {}

  decide(_context: DecisionContext): Decision {
    return {
      action: "trade",
      rationale: "deliberately invalid, to exercise the validator",
      confidence: 1,
      orders: [...this.orders],
      sourcesUsed: [],
    };
  }
}

function order(overrides: Partial<ProposedOrder>): ProposedOrder {
  return {
    ticker: "VWRL.AS",
    side: "buy",
    targetEur: 50,
    thesis: "fixture",
    invalidation: "fixture",
    ...overrides,
  };
}

/**
 * The live roster with one guardrail relaxed.
 *
 * `dca` allows a single trade a month, so a two-order decision hits the trade
 * cap before anything else can be reached. Raising just that one number is
 * what lets the cash guardrail be tested on its own.
 */
function rosterWithTradeCap(maxTradesPerMonth: number): Portfolios {
  return new Portfolios(
    livePortfolios().all.map((entry) =>
      entry.key === "dca"
        ? { ...entry, guardrails: { ...entry.guardrails, maxTradesPerMonth } }
        : entry,
    ),
  );
}

async function runWith(
  orders: readonly ProposedOrder[],
  portfolios?: Portfolios,
) {
  const deciders = new Map<string, Decider>([
    ["dca", new RogueDecider("dca", orders)],
    ["random", new RogueDecider("random", [])],
  ]);
  // `random` and `value` get an empty order list, which would fail the decision
  // contract, so give them a hold instead. Only `dca` is under test here.
  for (const key of ["random", "value"]) {
    deciders.set(key, {
      portfolio: key,
      decide: () => ({
        action: "hold" as const,
        rationale: "not under test",
        confidence: 1,
        orders: [],
        sourcesUsed: [],
      }),
    });
  }
  return runSession({
    sessions: SESSIONS,
    index: 0,
    history: [],
    deciders,
    ...(portfolios ? { portfolios } : {}),
  });
}

function rejections(events: readonly LedgerEvent[]) {
  return events.filter((event) => event.type === "ORDER_REJECTED");
}

describe("rejections reach the ledger with a reason", () => {
  it("rejects an off-whitelist ticker (SPEC 1.6)", async () => {
    const run = await runWith([order({ ticker: "TSLA" })]);
    const rejected = rejections(run.events);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.type === "ORDER_REJECTED" && rejected[0].reasonCode).toBe("off_whitelist");
    expect(rejected[0]?.type === "ORDER_REJECTED" && rejected[0].detail.length).toBeGreaterThan(0);
  });

  it("rejects an order exceeding available cash", async () => {
    // The seed is 100 EUR and the first order takes all of it, so the second
    // has nothing left to spend. The trade cap is lifted so that cash, and not
    // the cap, is what refuses it.
    const run = await runWith(
      [order({ ticker: "VWRL.AS", targetEur: 100 }), order({ ticker: "SAP.DE", targetEur: 100 })],
      rosterWithTradeCap(4),
    );
    const rejected = rejections(run.events);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.type === "ORDER_REJECTED" && rejected[0].reasonCode).toBe(
      "insufficient_cash",
    );
  });

  it("rejects an over-limit order", async () => {
    // `dca` allows one trade a month; a second is over the limit.
    const run = await runWith([
      order({ ticker: "VWRL.AS", targetEur: 30 }),
      order({ ticker: "SAP.DE", targetEur: 30 }),
    ]);
    const codes = rejections(run.events).map((e) =>
      e.type === "ORDER_REJECTED" ? e.reasonCode : "",
    );
    expect(codes).toContain("trade_cap_exceeded");
  });

  it("mutates nothing: cash, positions and the queue are untouched", async () => {
    const run = await runWith([order({ ticker: "TSLA", targetEur: 90 })]);
    const state = replayPortfolio(run.events, "dca");
    expect(state.cashEur).toBe(100); // the seed, entire
    expect(state.positions.size).toBe(0);
    expect(state.pendingOrders.size).toBe(0);
    expect(run.events.some((event) => event.type === "ORDER_PLACED")).toBe(false);
  });

  it("records the intent alongside the refusal, so the decision stays auditable", async () => {
    const run = await runWith([order({ ticker: "TSLA" })]);
    const record = run.decisions.find((decision) => decision.portfolio === "dca");
    expect(record?.orders).toHaveLength(1);
    expect(record?.orders[0]).toMatchObject({
      ticker: "TSLA",
      status: "rejected",
      reasonCode: "off_whitelist",
    });
    expect(record?.rationale.length).toBeGreaterThan(0);
  });

  it("leaves a ledger that still replays clean", async () => {
    const run = await runWith([order({ ticker: "TSLA" }), order({ ticker: "^GSPC" })]);
    expect(
      verifyLedger(run.events, { universe: dryRunUniverse().tickers }).violations,
    ).toEqual([]);
  });
});
