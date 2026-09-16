/**
 * Fill simulation (SPEC 8 step 1, SPEC 1.1).
 *
 * The rule under test is the first hard rule in the spec: "a decision made
 * using data up to the close of day T may only be filled at the next open of
 * day T+1... Never fill at a price the agent could see when deciding."
 */
import { describe, expect, it } from "vitest";
import type { OrderPlacedEvent } from "../../src/domain/events.js";
import { fillOrder, sessionsSincePlaced } from "../../src/engine/fills.js";
import {
  deposit,
  dryRunUniverse,
  filled,
  liveSimulation,
  mark,
  placed,
  portfolio,
  pricesWith,
  stateFrom,
} from "../helpers/engine.js";

const simulation = liveSimulation();
const universe = dryRunUniverse();
const guardrails = portfolio("dca").guardrails;

const SESSION = "2026-02-10";
const prices = pricesWith(
  SESSION,
  [
    { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
    { ticker: "SAP.DE", open: 240.0, close: 241.8 },
    { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
    { ticker: "MSFT", currency: "USD", open: null, close: 431.2 },
    { ticker: "NVDA", currency: "USD", open: 170.0, close: 172.4, sessionDate: "2026-02-09" },
  ],
  { eurusd: 1.085 },
);

function orderOf(event: ReturnType<typeof placed>): OrderPlacedEvent {
  if (event.type !== "ORDER_PLACED") throw new Error("not an order");
  return event;
}

function attempt(
  order: OrderPlacedEvent,
  history: readonly ReturnType<typeof placed>[],
  sessionDate = SESSION,
) {
  return fillOrder({
    order,
    state: stateFrom("dca", history),
    prices,
    universe,
    simulation,
    guardrails,
    sessionDate,
  });
}

const cashHistory = [deposit("dca", "2026-02-02", 150)];

describe("no look-ahead (SPEC 1.1)", () => {
  it("fills at this session's open, never at the deciding session's close", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "buy", targetEur: 100 }));
    const outcome = attempt(order, [...cashHistory, order]);
    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.terms.priceLocal).toBe(118.1); // today's open
    expect(outcome.terms.priceLocal).not.toBe(118.9); // today's close
  });

  it("refuses to fill an order on the session it was placed", () => {
    const order = orderOf(placed("dca", SESSION, { ticker: "VWRL.AS", side: "buy", targetEur: 100 }));
    const outcome = attempt(order, [...cashHistory, order]);
    expect(outcome.kind).toBe("deferred");
  });

  it("refuses an instrument whose market did not open today", () => {
    // NVDA's newest print is yesterday's. Reaching for it would be filling at
    // a price the decision could already see.
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "NVDA", side: "buy", targetEur: 100 }));
    expect(attempt(order, [...cashHistory, order]).kind).toBe("deferred");
  });
});

describe("frictions (SPEC 8)", () => {
  it("charges one fee per order and the FX spread on a USD fill", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "AAPL", side: "buy", targetEur: 100 }));
    const outcome = attempt(order, [...cashHistory, order]);
    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.terms.feeEur).toBe(1);
    expect(outcome.terms.fxCostEur).toBeCloseTo(outcome.terms.grossEur * 0.0025, 2);
    expect(outcome.terms.currency).toBe("USD");
    expect(outcome.terms.fxRate).toBe(1.085);
  });

  it("charges no FX spread on an EUR fill", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "buy", targetEur: 100 }));
    const outcome = attempt(order, [...cashHistory, order]);
    expect(outcome.kind === "filled" && outcome.terms.fxCostEur).toBe(0);
  });

  it("never spends more cash than the portfolio has at the open", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "buy", targetEur: 500 }));
    const outcome = attempt(order, [deposit("dca", "2026-02-02", 60), order]);
    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.terms.netEur).toBeLessThanOrEqual(60);
  });
});

describe("rejections at the open", () => {
  it("rejects a buy the portfolio can no longer afford", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "buy", targetEur: 100 }));
    const outcome = attempt(order, [deposit("dca", "2026-02-02", 2), order]);
    expect(outcome.kind === "rejected" && outcome.reasonCode).toBe("insufficient_cash");
  });

  it("rejects a sell of a position that is no longer there", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "sell", targetEur: 50 }));
    expect(attempt(order, [...cashHistory, order]).kind === "rejected").toBe(true);
  });

  it("rejects a ticker that left the universe while the order waited", () => {
    const order = orderOf(placed("dca", "2026-02-09", { ticker: "DELISTED.AS", side: "buy", targetEur: 50 }));
    const outcome = attempt(order, [...cashHistory, order]);
    expect(outcome.kind === "rejected" && outcome.reasonCode).toBe("off_whitelist");
  });

  it("defers an order with no usable open, then expires it", () => {
    const order = orderOf(placed("dca", "2026-02-02", { ticker: "MSFT", side: "buy", targetEur: 50 }));
    // One session has closed since: still worth waiting.
    const young = [...cashHistory, order, mark("dca", "2026-02-09", { cashEur: 150 })];
    expect(attempt(order, young).kind).toBe("deferred");

    // Five sessions: the thesis is stale, and the order says so rather than
    // sitting in the queue forever.
    const old = [
      ...cashHistory,
      order,
      ...["2026-02-03", "2026-02-04", "2026-02-05", "2026-02-06", "2026-02-09"].map((date) =>
        mark("dca", date, { cashEur: 150 }),
      ),
    ];
    const outcome = attempt(order, old);
    expect(outcome.kind === "rejected" && outcome.reasonCode).toBe("order_expired");
  });
});

describe("sessionsSincePlaced", () => {
  it("counts marks, not calendar days, so a long weekend ages nothing", () => {
    const order = orderOf(placed("dca", "2026-02-06", { ticker: "VWRL.AS", side: "buy", targetEur: 50 }));
    const state = stateFrom("dca", [
      ...cashHistory,
      order,
      mark("dca", "2026-02-06", { cashEur: 150 }),
      mark("dca", "2026-02-09", { cashEur: 150 }),
    ]);
    // Friday to Monday is three calendar days and one session.
    expect(sessionsSincePlaced(state, order)).toBe(1);
  });
});

describe("selling", () => {
  it("credits proceeds net of costs and closes the position", () => {
    const history = [
      deposit("dca", "2026-02-02", 300),
      placed("dca", "2026-02-05", { ticker: "VWRL.AS", side: "buy", targetEur: 120 }),
      filled("dca", "2026-02-06", {
        orderId: "2026-02-05/dca/ord/1",
        ticker: "VWRL.AS",
        side: "buy",
        qty: 1,
        priceLocal: 117.0,
      }),
    ];
    const sell = orderOf(
      placed("dca", "2026-02-09", { ticker: "VWRL.AS", side: "sell", targetEur: 1000, sequence: 2 }),
    );
    const outcome = attempt(sell, [...history, sell]);
    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.terms.qty).toBe(1);
    expect(outcome.terms.netEur).toBeCloseTo(118.1 - 1, 2);
  });
});
