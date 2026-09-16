/**
 * The two deterministic controls (SPEC 5).
 *
 * "The controls exist because '+3.2%' is meaningless on its own." What has to
 * be true of them: they behave identically every time they are run, they buy
 * monthly and never sell, and `random`'s picks are reproducible from the
 * committed seed alone.
 */
import { describe, expect, it } from "vitest";
import { DcaControl } from "../../src/controls/dca.js";
import { RandomControl } from "../../src/controls/random.js";
import { createControl, createControls, ControlError } from "../../src/controls/index.js";
import { fnv1a32, mulberry32, nextIndex, streamFor } from "../../src/controls/rng.js";
import type { DecisionContext } from "../../src/engine/decision.js";
import { parseDecision } from "../../src/engine/decision.js";
import {
  briefWith,
  deposit,
  dryRunUniverse,
  liveSimulation,
  livePortfolios,
  mark,
  portfolio,
  pricesWith,
  stateFrom,
} from "../helpers/engine.js";
import type { LedgerEvent } from "../../src/domain/events.js";

const simulation = liveSimulation();
const universe = dryRunUniverse();

const QUOTES = [
  { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
  { ticker: "MEUD.PA", open: 261.0, close: 262.1 },
  { ticker: "VUSA.AS", open: 105.2, close: 105.75 },
  { ticker: "SAP.DE", open: 240.0, close: 241.8 },
  { ticker: "ASML.AS", open: 710.0, close: 712.5 },
  { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
  { ticker: "MSFT", currency: "USD", open: 430.0, close: 431.2 },
  { ticker: "NVDA", currency: "USD", open: 170.0, close: 172.4 },
];

function contextFor(
  key: string,
  sessionDate: string,
  history: readonly LedgerEvent[],
): DecisionContext {
  const config = portfolio(key);
  const state = stateFrom(key, history);
  return {
    portfolio: config,
    state,
    brief: briefWith(sessionDate, QUOTES, { eurusd: 1.085 }),
    prices: pricesWith(sessionDate, QUOTES, { eurusd: 1.085 }),
    universe,
    simulation,
    sessionDate,
    availableCashEur: state.cashEur - config.guardrails.cashFloorEur,
    depositedTodayEur: 50,
    tradesThisMonth: 0,
  };
}

/** A contribution session: the deposit landed today. */
const contributionDay = (key: string, date: string): readonly LedgerEvent[] => [
  deposit(key, "2026-01-29", 100),
  mark(key, "2026-01-29", { cashEur: 100, contributedToDateEur: 100 }),
  deposit(key, date, 50),
];

describe("dca (SPEC 5)", () => {
  const control = new DcaControl("dca");

  it("buys the universe's dcaInstrument on a contribution session", () => {
    const decision = control.decide(contextFor("dca", "2026-02-02", contributionDay("dca", "2026-02-02")));
    expect(decision.action).toBe("trade");
    expect(decision.orders[0]?.ticker).toBe(universe.document.dcaInstrument);
    expect(decision.orders[0]?.side).toBe("buy");
  });

  it("deploys every available euro, not only the contribution", () => {
    // Fees and 4dp rounding leave a few cents behind each month. A control
    // that let those pile up would drift into a cash-and-ETF portfolio.
    const context = contextFor("dca", "2026-02-02", contributionDay("dca", "2026-02-02"));
    const decision = control.decide(context);
    expect(decision.orders[0]?.targetEur).toBe(context.availableCashEur);
  });

  it("holds, with a reason, on every other session", () => {
    const history = [...contributionDay("dca", "2026-02-02"), mark("dca", "2026-02-02", { cashEur: 0 })];
    const decision = control.decide(contextFor("dca", "2026-02-03", history));
    expect(decision.action).toBe("hold");
    expect(decision.rationale).toMatch(/not a contribution session/);
  });

  it("never sells", () => {
    for (const date of ["2026-02-02", "2026-02-03", "2026-03-02"]) {
      const decision = control.decide(contextFor("dca", date, contributionDay("dca", date)));
      expect(decision.orders.every((order) => order.side === "buy"), date).toBe(true);
    }
  });

  it("holds rather than queueing an order it cannot afford", () => {
    const context = {
      ...contextFor("dca", "2026-02-02", contributionDay("dca", "2026-02-02")),
      availableCashEur: 2,
    };
    expect(control.decide(context).action).toBe("hold");
  });

  it("produces a decision that passes the SPEC 7 output contract", () => {
    const decision = control.decide(contextFor("dca", "2026-02-02", contributionDay("dca", "2026-02-02")));
    expect(() => parseDecision(decision, "dca")).not.toThrow();
    // SPEC 7: the invalidation field is mandatory and non-empty, for a control
    // as much as for an agent.
    expect(decision.orders[0]?.invalidation.length).toBeGreaterThan(0);
  });
});

describe("random (SPEC 5)", () => {
  const seed = "broker-simulator/random/v1";
  const control = new RandomControl("random", seed);

  it("picks from the whitelist and buys on a contribution session", () => {
    const decision = control.decide(
      contextFor("random", "2026-02-02", contributionDay("random", "2026-02-02")),
    );
    expect(decision.action).toBe("trade");
    expect(universe.has(decision.orders[0]?.ticker ?? "")).toBe(true);
  });

  it("is reproducible: the same month always draws the same instrument", () => {
    const context = contextFor("random", "2026-02-02", contributionDay("random", "2026-02-02"));
    const picks = Array.from({ length: 20 }, () => control.draw(context)?.ticker);
    expect(new Set(picks).size).toBe(1);
  });

  it("carries no state between runs: a fresh control draws the same thing", () => {
    const context = contextFor("random", "2026-02-02", contributionDay("random", "2026-02-02"));
    const first = new RandomControl("random", seed).draw(context)?.ticker;
    const second = new RandomControl("random", seed).draw(context)?.ticker;
    expect(first).toBe(second);
  });

  it("draws independently across months", () => {
    const picks = ["2026-01-29", "2026-02-02", "2026-03-02", "2026-04-01", "2026-05-04"].map(
      (date) => control.draw(contextFor("random", date, contributionDay("random", date)))?.ticker,
    );
    // Not a uniformity proof — five draws from eight names. Just that the
    // stream is keyed by month rather than fixed for all time.
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it("is sensitive to the seed", () => {
    const context = contextFor("random", "2026-02-02", contributionDay("random", "2026-02-02"));
    const other = new RandomControl("random", "a different seed").draw(context)?.ticker;
    const mine = control.draw(context)?.ticker;
    // Both are valid tickers; they need not differ on any one month, but the
    // whole sequence must.
    const mineSeq = ["2026-01", "2026-02", "2026-03", "2026-04"].map((m) =>
      universe.tickers[nextIndex(streamFor(seed, m), universe.size)],
    );
    const otherSeq = ["2026-01", "2026-02", "2026-03", "2026-04"].map((m) =>
      universe.tickers[nextIndex(streamFor("a different seed", m), universe.size)],
    );
    expect(mineSeq).not.toEqual(otherSeq);
    expect(universe.has(other ?? "")).toBe(true);
    expect(universe.has(mine ?? "")).toBe(true);
  });

  it("re-draws past an instrument with no usable close, deterministically", () => {
    const date = "2026-02-02";
    const config = portfolio("random");
    const state = stateFrom("random", contributionDay("random", date));
    // Only two names quote today; every draw must land on one of them.
    const thin = [
      { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
      { ticker: "SAP.DE", open: 240.0, close: 241.8 },
    ];
    const context: DecisionContext = {
      portfolio: config,
      state,
      brief: briefWith(date, thin),
      prices: pricesWith(date, thin),
      universe,
      simulation,
      sessionDate: date,
      availableCashEur: state.cashEur,
      depositedTodayEur: 50,
      tradesThisMonth: 0,
    };
    const picked = control.draw(context);
    expect(["VWRL.AS", "SAP.DE"]).toContain(picked?.ticker);
    expect(control.draw(context)?.ticker).toBe(picked?.ticker);
  });

  it("holds, with a reason, on every other session", () => {
    const history = [...contributionDay("random", "2026-02-02"), mark("random", "2026-02-02", { cashEur: 0 })];
    const decision = control.decide(contextFor("random", "2026-02-03", history));
    expect(decision.action).toBe("hold");
    expect(decision.rationale.length).toBeGreaterThan(0);
  });

  it("archives the draw in its rationale, so the pick is auditable", () => {
    const decision = control.decide(
      contextFor("random", "2026-02-02", contributionDay("random", "2026-02-02")),
    );
    expect(decision.rationale).toMatch(/Uniform draw over 8 whitelisted instruments/);
    expect(decision.rationale).toContain(seed);
  });
});

describe("the RNG", () => {
  it("hashes deterministically", () => {
    expect(fnv1a32("broker-simulator/random/v1|2026-02")).toBe(
      fnv1a32("broker-simulator/random/v1|2026-02"),
    );
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
  });

  it("produces values in [0, 1)", () => {
    const random = mulberry32(12345);
    for (let index = 0; index < 5000; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("covers the whole range of a uniform draw", () => {
    const seen = new Set<number>();
    for (let month = 1; month <= 400; month += 1) {
      seen.add(nextIndex(streamFor("seed", `m${month}`), 8));
    }
    expect(seen.size).toBe(8);
  });

  it("never returns an out-of-range index", () => {
    const random = mulberry32(7);
    for (let index = 0; index < 5000; index += 1) {
      const drawn = nextIndex(random, 8);
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(8);
    }
  });
});

describe("the control factory", () => {
  it("builds every enabled control in the committed roster", () => {
    const deciders = createControls(livePortfolios().all);
    expect([...deciders.keys()].sort()).toEqual(["dca", "random"]);
  });

  it("refuses a control with no behaviour", () => {
    const { control: _dropped, ...withoutBehaviour } = portfolio("dca");
    expect(() => createControl(withoutBehaviour)).toThrow(ControlError);
  });
});
