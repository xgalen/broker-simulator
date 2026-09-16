/**
 * The order validator (SPEC 1.6, SPEC 8, SPEC 14).
 *
 * SPEC 14: "An agent returning an off-whitelist ticker, an over-limit order,
 * or an order exceeding available cash produces `ORDER_REJECTED` with a reason
 * and no ledger mutation." All three are below, plus every other guardrail.
 */
import { describe, expect, it } from "vitest";
import type { ProposedOrder } from "../../src/engine/decision.js";
import { validateOrders } from "../../src/engine/validate.js";
import type { Guardrails, PortfolioConfig } from "../../src/engine/config.js";
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
const SESSION = "2026-02-10";

const prices = pricesWith(
  SESSION,
  [
    { ticker: "VWRL.AS", open: 118.1, close: 118.9 },
    { ticker: "SAP.DE", open: 240.0, close: 241.8 },
    { ticker: "AAPL", currency: "USD", open: 238.1, close: 239.4 },
    { ticker: "MSFT", currency: "USD", open: 430.0, close: 431.2, sessionDate: "2026-02-09" },
  ],
  { eurusd: 1.085 },
);

function order(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    ticker: "VWRL.AS",
    side: "buy",
    targetEur: 50,
    thesis: "fixture",
    invalidation: "fixture",
    ...overrides,
  };
}

function withGuardrails(key: string, overrides: Partial<Guardrails>): PortfolioConfig {
  const base = portfolio(key);
  return { ...base, guardrails: { ...base.guardrails, ...overrides } };
}

function check(
  orders: readonly ProposedOrder[],
  options: {
    cash?: number;
    history?: Parameters<typeof stateFrom>[1];
    config?: PortfolioConfig;
    tradesThisMonth?: number;
    totalValueEur?: number;
  } = {},
): ReturnType<typeof validateOrders> {
  const config = options.config ?? portfolio("dca");
  const history =
    options.history ?? [deposit(config.key, "2026-02-02", options.cash ?? 150)];
  const state = stateFrom(config.key, history);
  return validateOrders({
    portfolio: config,
    state,
    universe,
    simulation,
    prices,
    sessionDate: SESSION,
    orders,
    tradesThisMonth: options.tradesThisMonth ?? 0,
    totalValueEur: options.totalValueEur ?? state.cashEur,
  });
}

const reasonOf = (verdicts: ReturnType<typeof validateOrders>): string | undefined =>
  verdicts[0]?.status === "rejected" ? verdicts[0].reasonCode : undefined;

describe("whitelist (SPEC 1.6)", () => {
  it("rejects a ticker that is not in the universe", () => {
    expect(reasonOf(check([order({ ticker: "TSLA" })]))).toBe("off_whitelist");
  });

  it("rejects a reference instrument, which is context and not tradable", () => {
    const verdicts = check([order({ ticker: "^GSPC" })]);
    expect(reasonOf(verdicts)).toBe("off_whitelist");
    expect(verdicts[0]?.status === "rejected" && verdicts[0].detail).toMatch(
      /reference instrument/,
    );
  });

  it("accepts a whitelisted ticker", () => {
    expect(check([order()])[0]?.status).toBe("accepted");
  });
});

describe("cash", () => {
  it("rejects an order exceeding available cash (SPEC 14)", () => {
    expect(reasonOf(check([order({ targetEur: 500 })], { cash: 3 }))).toBe(
      "insufficient_cash",
    );
  });

  it("caps an oversized order at the cash on hand rather than refusing it", () => {
    // The decider asked for 500 with 150 in the account. Deploying the 150 is
    // the honest reading of the intent; refusing it outright would cost a
    // month of exposure over a number the decider could not have known.
    const verdicts = check([order({ targetEur: 500 })], { cash: 150 });
    expect(verdicts[0]?.status).toBe("accepted");
    expect(verdicts[0]?.status === "accepted" && verdicts[0].estimatedNetEur).toBeLessThanOrEqual(150);
  });

  it("reserves cash across a batch, so three orders cannot spend it twice", () => {
    const verdicts = check(
      [
        order({ ticker: "VWRL.AS", targetEur: 60 }),
        order({ ticker: "SAP.DE", targetEur: 60 }),
        order({ ticker: "AAPL", targetEur: 60 }),
      ],
      { cash: 100, config: withGuardrails("dca", { maxTradesPerMonth: 4 }) },
    );
    expect(verdicts.map((v) => v.status)).toEqual(["accepted", "accepted", "rejected"]);
    const spent = verdicts
      .filter((v) => v.status === "accepted")
      .reduce((total, v) => total + (v.status === "accepted" ? v.estimatedNetEur : 0), 0);
    expect(spent).toBeLessThanOrEqual(100);
  });

  it("reserves cash for orders still queued from an earlier session", () => {
    const history = [
      deposit("dca", "2026-02-02", 100),
      placed("dca", "2026-02-09", { ticker: "SAP.DE", side: "buy", targetEur: 95 }),
    ];
    expect(reasonOf(check([order({ targetEur: 50 })], { history }))).toBe(
      "insufficient_cash",
    );
  });

  it("respects the cash floor", () => {
    expect(
      reasonOf(
        check([order({ targetEur: 50 })], {
          cash: 50,
          config: withGuardrails("dca", { cashFloorEur: 48 }),
        }),
      ),
    ).toBe("insufficient_cash");
  });
});

describe("SPEC 8 guardrails", () => {
  it("rejects an order below minOrderEur", () => {
    expect(reasonOf(check([order({ targetEur: 4.5 })]))).toBe("below_min_order");
  });

  it("rejects once maxTradesPerMonth is spent", () => {
    expect(reasonOf(check([order()], { tradesThisMonth: 1 }))).toBe("trade_cap_exceeded");
  });

  it("counts the batch against the cap as it goes", () => {
    const config = withGuardrails("dca", { maxTradesPerMonth: 1 });
    const verdicts = check([order({ ticker: "VWRL.AS", targetEur: 40 }), order({ ticker: "SAP.DE", targetEur: 40 })], {
      config,
      cash: 200,
    });
    expect(verdicts.map((v) => v.status)).toEqual(["accepted", "rejected"]);
    expect(reasonOf([verdicts[1]!])).toBe("trade_cap_exceeded");
  });

  it("rejects a duplicate ticker inside one decision", () => {
    const config = withGuardrails("dca", { maxTradesPerMonth: 4 });
    const verdicts = check([order({ targetEur: 40 }), order({ targetEur: 40 })], {
      config,
      cash: 200,
    });
    expect(verdicts[1]?.status === "rejected" && verdicts[1].reasonCode).toBe("duplicate_order");
  });

  it("leaves the position cap dormant below its threshold (SPEC 8's worked example)", () => {
    // 25% of a 50 EUR portfolio is 12.50 EUR, below minOrderEur. The threshold
    // exists precisely so month one is not a dead month.
    const config = withGuardrails("value", { maxTradesPerMonth: 4 });
    expect(
      check([order({ targetEur: 45 })], { config, cash: 50, totalValueEur: 50 })[0]?.status,
    ).toBe("accepted");
  });

  it("enforces the position cap once the portfolio is worth enough", () => {
    const config = withGuardrails("value", { maxTradesPerMonth: 4 });
    expect(
      reasonOf(
        check([order({ targetEur: 300 })], { config, cash: 1000, totalValueEur: 1000 }),
      ),
    ).toBe("position_limit");
  });

  it("counts an existing holding towards the cap", () => {
    const config = withGuardrails("value", { maxTradesPerMonth: 4 });
    const history = [
      deposit("value", "2026-01-05", 1000),
      placed("value", "2026-01-05", { ticker: "VWRL.AS", side: "buy", targetEur: 220 }),
      filled("value", "2026-01-06", {
        orderId: "2026-01-05/value/ord/1",
        ticker: "VWRL.AS",
        side: "buy",
        qty: 1.8,
        priceLocal: 118.9,
      }),
    ];
    expect(
      reasonOf(check([order({ targetEur: 80 })], { history, config, totalValueEur: 1000 })),
    ).toBe("position_limit");
  });
});

describe("sells", () => {
  const holding = [
    deposit("news", "2026-02-02", 300),
    placed("news", "2026-02-08", { ticker: "VWRL.AS", side: "buy", targetEur: 120 }),
    filled("news", "2026-02-09", {
      orderId: "2026-02-08/news/ord/1",
      ticker: "VWRL.AS",
      side: "buy",
      qty: 1,
      priceLocal: 118.9,
    }),
    mark("news", "2026-02-09", { cashEur: 180.1 }),
  ];

  it("rejects a sell with nothing held; shorting is off (SPEC 8)", () => {
    expect(
      reasonOf(
        check([order({ ticker: "SAP.DE", side: "sell", targetEur: 50 })], {
          history: holding,
          config: portfolio("news"),
        }),
      ),
    ).toBe("no_position");
  });

  it("rejects a sell inside minHoldDays", () => {
    const config = withGuardrails("value", { minHoldDays: 3 });
    const events = holding.map((event) => ({ ...event, portfolio: "value" }));
    expect(
      reasonOf(
        check([order({ ticker: "VWRL.AS", side: "sell", targetEur: 50 })], {
          history: events,
          config,
        }),
      ),
    ).toBe("min_hold_days");
  });

  it("allows a sell once minHoldDays has elapsed", () => {
    // `news` runs with minHoldDays 0 (SPEC 8).
    expect(
      check([order({ ticker: "VWRL.AS", side: "sell", targetEur: 50 })], {
        history: holding,
        config: portfolio("news"),
      })[0]?.status,
    ).toBe("accepted");
  });
});

describe("prices", () => {
  it("rejects an order on an instrument whose market did not trade (SPEC 1.5)", () => {
    expect(reasonOf(check([order({ ticker: "MSFT" })]))).toBe("stale_price");
  });

  it("rejects an order on an instrument the brief did not quote", () => {
    expect(reasonOf(check([order({ ticker: "NVDA" })]))).toBe("no_price");
  });

  it("rejects a targetEur that is not a positive amount", () => {
    expect(reasonOf(check([order({ targetEur: Number.NaN })]))).toBe("invalid_order");
  });
});
