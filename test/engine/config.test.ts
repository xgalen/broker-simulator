/**
 * The committed configs, and the checks that keep them honest (SPEC 8).
 */
import { describe, expect, it } from "vitest";
import { ConfigError, parsePortfolios, parseSimulation } from "../../src/engine/config.js";
import { liveSimulation, livePortfolios, repoText } from "../helpers/engine.js";

describe("simulation.yaml", () => {
  it("carries SPEC 8's frictions verbatim", () => {
    expect(liveSimulation()).toMatchObject({
      initialDepositEur: 100,
      monthlyDepositEur: 50,
      feePerOrderEur: 1,
      fxSpreadBps: 25,
      minOrderEur: 5,
      dividendWithholdingPct: 15,
    });
  });

  it("refuses a minimum order no portfolio could ever reach", () => {
    const broken = repoText("config", "simulation.yaml").replace(
      "minOrderEur: 5.00",
      "minOrderEur: 60.00",
    );
    expect(() => parseSimulation(broken)).toThrow(/no portfolio could trade/);
  });

  it("refuses a fee the smallest allowed order could not cover", () => {
    const broken = repoText("config", "simulation.yaml").replace(
      "feePerOrderEur: 1.00",
      "feePerOrderEur: 5.00",
    );
    expect(() => parseSimulation(broken)).toThrow(/could not cover its own fee/);
  });
});

describe("portfolios.yaml", () => {
  const portfolios = livePortfolios();

  it("declares the full SPEC 5 cast: five agents and two controls", () => {
    expect(portfolios.keys).toEqual([
      "dca",
      "random",
      "news",
      "value",
      "contrarian",
      "macro",
      "news-frozen",
    ]);
    expect(portfolios.controls.map((p) => p.key)).toEqual(["dca", "random"]);
  });

  it("runs only the controls in phase 4", () => {
    expect(portfolios.activeKeys).toEqual(["dca", "random"]);
  });

  it("resolves guardrails against the defaults, overriding only what is stated", () => {
    const value = portfolios.get("value");
    expect(value?.guardrails).toEqual({
      maxTradesPerMonth: 4,
      minHoldDays: 3,
      maxPositionPct: 25,
      positionLimitsActiveAboveEur: 250,
      cashFloorEur: 0,
      allowShorting: false,
      allowLeverage: false,
      allowDerivatives: false,
    });
  });

  it("gives `news` and `news-frozen` SPEC 8's minHoldDays of 0, keeping every other default", () => {
    for (const key of ["news", "news-frozen"]) {
      const agent = portfolios.get(key);
      expect(agent?.guardrails.minHoldDays, key).toBe(0);
      expect(agent?.guardrails.maxTradesPerMonth, key).toBe(4);
    }
  });

  it("makes `news-frozen` identical to `news` except for learning", () => {
    const news = portfolios.get("news");
    const frozen = portfolios.get("news-frozen");
    expect(frozen?.mandate).toBe(news?.mandate);
    expect(frozen?.model).toBe(news?.model);
    expect(frozen?.guardrails).toEqual(news?.guardrails);
    expect(news?.learning).toBe("enabled");
    expect(frozen?.learning).toBe("frozen");
  });

  it("commits the random control's seed", () => {
    const random = portfolios.get("random");
    expect(random?.control).toEqual({ type: "random", seed: "broker-simulator/random/v1" });
  });

  it("lets the controls hold one concentrated position", () => {
    // A 25% cap on `dca` would make the benchmark a 75%-cash portfolio and
    // flatter every agent measured against it.
    for (const key of ["dca", "random"]) {
      expect(portfolios.get(key)?.guardrails.maxPositionPct, key).toBe(100);
    }
  });

  it("refuses shorting, leverage and derivatives, which the engine does not model", () => {
    const broken = repoText("config", "portfolios.yaml").replace(
      "    allowShorting: false\n    allowLeverage: false",
      "    allowShorting: true\n    allowLeverage: false",
    );
    expect(() => parsePortfolios(broken)).toThrow(ConfigError);
  });

  it("refuses a percentage cap that bites below minOrderEur at its own threshold", () => {
    // SPEC 8's worked example: a cap so tight that the smallest order it
    // permits is below the minimum order is a portfolio that can never act.
    const broken = repoText("config", "portfolios.yaml").replace(
      "    maxPositionPct: 25\n    positionLimitsActiveAboveEur: 250",
      "    maxPositionPct: 1\n    positionLimitsActiveAboveEur: 250",
    );
    expect(() => parsePortfolios(broken, { simulation: liveSimulation() })).toThrow(
      /below minOrderEur/,
    );
  });

  it("refuses a control with no behaviour and an agent with no mandate", () => {
    expect(() =>
      parsePortfolios(`
schemaVersion: 1
defaults:
  guardrails:
    maxTradesPerMonth: 4
    minHoldDays: 3
    maxPositionPct: 25
    positionLimitsActiveAboveEur: 250
    cashFloorEur: 0
    allowShorting: false
    allowLeverage: false
    allowDerivatives: false
portfolios:
  - { key: broken, kind: control, description: no control block }
`),
    ).toThrow(/no control block/);
  });
});
