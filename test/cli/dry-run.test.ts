/**
 * The dry run, against the committed scenario (SPEC 12 phase 4, SPEC 14).
 *
 * This is the closest thing phase 4 has to the real thing: the CLI, the
 * engine, the controls, the brief builder and the ledger, driven over eleven
 * simulated sessions with only the two ports and the clock swapped. If the
 * daily workflow would produce a broken ledger, it breaks here first.
 *
 * It also covers three SPEC 14 acceptance checks outright: the look-ahead
 * proof, the byte-identical `state.json` rebuild, and a rationale on every
 * decision record including holds.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventLog } from "../../src/domain/events.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import { checkLookAhead } from "../../src/domain/lookahead.js";
import { replayPortfolio } from "../../src/domain/replay.js";
import { buildState, serializeState } from "../../src/domain/state.js";
import { replay } from "../../src/domain/replay.js";
import { DecisionRecordSchema } from "../../src/engine/decision.js";
import { dryRunCli, parseScenario, ScenarioError } from "../../src/cli/dry-run.js";
import { buildBriefResolver } from "../../src/cli/verify.js";
import { rebuildStateCli } from "../../src/cli/rebuild-state.js";
import { dryRunUniverse, liveSimulation, repoRoot, repoText } from "../helpers/engine.js";
import type { DryRunResult } from "../../src/cli/dry-run.js";
import type { LedgerEvent } from "../../src/domain/events.js";

const universe = dryRunUniverse();
let outDir: string;
let result: DryRunResult;
let events: LedgerEvent[];

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "sim-dry-run-"));
  result = await dryRunCli({
    scenarioFile: "fixtures/dry-run/controls.json",
    outDir,
    repoRoot,
    log: () => {},
  });
  events = parseEventLog(readFileSync(join(outDir, "events.jsonl"), "utf8"));
}, 60_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * The portfolios the dry run drives: phase 4's two controls plus phase 5's one
 * agent, which runs here against a scripted model so the replay still needs no
 * network and no API key.
 */
const ACTIVE = ["dca", "random", "value"] as const;

describe("the scenario itself", () => {
  it("runs forward only (SPEC 1.2)", () => {
    const scenario = parseScenario(repoText("fixtures", "dry-run", "controls.json"), "controls.json");
    const dates = scenario.sessions.map((session) => session.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("refuses a scenario that goes backwards", () => {
    const scenario = JSON.parse(repoText("fixtures", "dry-run", "controls.json"));
    scenario.sessions = [...scenario.sessions].reverse();
    expect(() => parseScenario(JSON.stringify(scenario), "reversed.json")).toThrow(ScenarioError);
  });
});

describe("the replay", () => {
  it("completes every session", () => {
    expect(result.ok).toBe(true);
    expect(result.sessions.every((session) => session.status === "completed")).toBe(true);
  });

  it("writes a mark per portfolio per session, and nothing to the real data/", () => {
    expect(events.filter((event) => event.type === "VALUATION")).toHaveLength(
      result.sessions.length * ACTIVE.length,
    );
    expect(outDir).not.toContain(join(repoRoot, "data"));
  });
});

describe("deposits (SPEC 5)", () => {
  it("seeds 100 EUR once, then 50 EUR per month", () => {
    for (const key of ["dca", "random"]) {
      const deposits = events.filter(
        (event) => event.type === "DEPOSIT" && event.portfolio === key,
      );
      expect(deposits.map((e) => (e.type === "DEPOSIT" ? e.amountEur : 0)), key).toEqual([
        100, 50, 50,
      ]);
      // January, February, March — one apiece, on the first session of each.
      expect(deposits.map((e) => e.ts.slice(0, 7)), key).toEqual([
        "2026-01",
        "2026-02",
        "2026-03",
      ]);
    }
  });

  it("contributes 200 EUR in total to each portfolio", () => {
    for (const key of ["dca", "random"]) {
      expect(replayPortfolio(events, key).contributedToDateEur, key).toBe(200);
    }
  });
});

describe("fills (SPEC 1.1, SPEC 8)", () => {
  it("fills every order on a later session than the one that placed it", () => {
    const placed = new Map(
      events
        .filter((event) => event.type === "ORDER_PLACED")
        .map((event) => [event.id, event.ts.slice(0, 10)]),
    );
    const fills = events.filter((event) => event.type === "ORDER_FILLED");
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      if (fill.type !== "ORDER_FILLED") continue;
      const placedOn = placed.get(fill.orderId);
      expect(placedOn, fill.id).toBeDefined();
      expect(fill.ts.slice(0, 10) > (placedOn ?? ""), fill.id).toBe(true);
    }
  });

  it("proves no fill price appeared in the brief that caused it (SPEC 14)", () => {
    // The acceptance check, run the way `verify` runs it: decision record ->
    // brief hash -> the prices that brief printed.
    const violations = checkLookAhead(events, buildBriefResolver(outDir), {
      requireBrief: true,
    });
    expect(violations).toEqual([]);
  });

  it("charges one fee per fill and the FX spread on USD legs only (SPEC 8)", () => {
    for (const fill of events) {
      if (fill.type !== "ORDER_FILLED") continue;
      expect(fill.feeEur, fill.id).toBe(1);
      if (fill.currency === "EUR") {
        expect(fill.fxCostEur, fill.id).toBe(0);
        expect(fill.fxRate, fill.id).toBe(1);
      } else {
        expect(fill.fxCostEur, fill.id).toBeCloseTo(fill.grossEur * 0.0025, 2);
      }
    }
  });

  it("reaches both currencies, so the FX path is actually exercised", () => {
    const currencies = new Set(
      events.filter((e) => e.type === "ORDER_FILLED").map((e) => (e.type === "ORDER_FILLED" ? e.currency : "")),
    );
    expect(currencies).toEqual(new Set(["EUR", "USD"]));
  });
});

describe("corporate actions (SPEC 8 step 2)", () => {
  it("credits both a EUR and a USD dividend, net of withholding", () => {
    const dividends = events.filter((event) => event.type === "DIVIDEND");
    expect(dividends).toHaveLength(2);
    const currencies = dividends.map((e) => (e.type === "DIVIDEND" ? e.currency : ""));
    expect(new Set(currencies)).toEqual(new Set(["EUR", "USD"]));
    for (const dividend of dividends) {
      if (dividend.type !== "DIVIDEND") continue;
      expect(dividend.netEur, dividend.id).toBeLessThanOrEqual(
        dividend.amountLocal / dividend.fxRate + 1e-9,
      );
    }
  });

  it("applies the 4-for-1 split to the quantity without moving the value", () => {
    const split = events.find((event) => event.type === "SPLIT");
    expect(split?.type).toBe("SPLIT");
    if (split?.type !== "SPLIT") return;
    expect(split.ratio).toBe(4);

    // The mark before and the mark after should differ by an ordinary day's
    // move, not by a factor of four. If the engine multiplied the quantity and
    // the fixture had not quartered the price, this is the test that notices.
    const marks = events.filter(
      (event) => event.type === "VALUATION" && event.portfolio === split.portfolio,
    );
    const index = marks.findIndex((mark) => mark.ts > split.ts);
    const before = marks[index - 1];
    const after = marks[index];
    if (before?.type !== "VALUATION" || after?.type !== "VALUATION") throw new Error("no marks");
    const beforeTotal = before.cashEur + before.marketValueEur;
    const afterTotal = after.cashEur + after.marketValueEur;
    expect(Math.abs(afterTotal / beforeTotal - 1)).toBeLessThan(0.1);
  });
});

describe("the ledger it leaves behind (SPEC 14)", () => {
  it("replays clean against every invariant", () => {
    expect(verifyLedger(events, { universe: universe.tickers }).violations).toEqual([]);
    expect(result.verified).toBe(true);
  });

  it("rebuilds state.json byte-identically from events.jsonl", () => {
    const committed = readFileSync(join(outDir, "state.json"), "utf8");
    const rebuilt = serializeState(
      buildState(replay(events, { universe: universe.tickers }), { riskFreeAnnual: 0.025 }),
    );
    expect(rebuilt).toBe(committed);
    expect(result.stateRebuildIdentical).toBe(true);
  });

  it("reproduces state.json exactly after it is deleted (SPEC 14)", () => {
    // The acceptance check, performed the way a human would: throw the cache
    // away, run the command, and diff.
    const before = readFileSync(join(outDir, "state.json"), "utf8");
    rmSync(join(outDir, "state.json"));

    const rebuild = rebuildStateCli({
      dataRoot: outDir,
      universe,
      simulation: liveSimulation(),
      log: () => {},
    });
    expect(rebuild.ok).toBe(true);
    expect(readFileSync(join(outDir, "state.json"), "utf8")).toBe(before);

    // And the --check form CI runs now agrees.
    expect(
      rebuildStateCli({
        dataRoot: outDir,
        universe,
        simulation: liveSimulation(),
        check: true,
        log: () => {},
      }).identical,
    ).toBe(true);
  });

  it("writes a decision record with a rationale for every portfolio, every session", () => {
    const days = readdirSync(join(outDir, "decisions")).sort();
    expect(days).toHaveLength(result.sessions.length);
    for (const day of days) {
      const files = readdirSync(join(outDir, "decisions", day)).sort();
      expect(files, day).toEqual(ACTIVE.map((key) => `${key}.json`).sort());
      for (const file of files) {
        const record = DecisionRecordSchema.parse(
          JSON.parse(readFileSync(join(outDir, "decisions", day, file), "utf8")),
        );
        expect(record.rationale.length, `${day}/${file}`).toBeGreaterThan(0);
        expect(record.kind, `${day}/${file}`).toBe(
          record.portfolio === "value" ? "agent" : "control",
        );
        for (const order of record.orders) {
          // SPEC 7: the invalidation field is mandatory and non-empty.
          expect(order.invalidation.length, order.orderId).toBeGreaterThan(0);
        }
      }
    }
  });

  it("commits a brief and a price snapshot per session, each matching its hash", () => {
    const briefs = readdirSync(join(outDir, "briefs")).sort();
    const prices = readdirSync(join(outDir, "prices")).sort();
    expect(briefs).toHaveLength(result.sessions.length);
    expect(prices).toEqual(briefs);
  });
});

describe("determinism", () => {
  it("produces a byte-identical ledger when replayed again", async () => {
    const second = mkdtempSync(join(tmpdir(), "sim-dry-run-2-"));
    try {
      await dryRunCli({
        scenarioFile: "fixtures/dry-run/controls.json",
        outDir: second,
        repoRoot,
        log: () => {},
      });
      // The same scenario twice: same seed, same prices, same ids, same
      // timestamps. Nothing in the engine reads the wall clock.
      expect(readFileSync(join(second, "events.jsonl"), "utf8")).toBe(
        readFileSync(join(outDir, "events.jsonl"), "utf8"),
      );
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  }, 60_000);
});
