/**
 * SPEC 14: "Deleting `state.json` and rebuilding from `events.jsonl` produces
 * a byte-identical file."
 */
import { describe, expect, it } from "vitest";
import { parseEventLog } from "../src/domain/events.js";
import { replay } from "../src/domain/replay.js";
import { buildState, serializeState } from "../src/domain/state.js";
import { fixtureEvents, fixtureText, UNIVERSE } from "./helpers/fixtures.js";

function rebuild(): string {
  // Exactly what `pnpm rebuild-state` will do: read the log, fold, serialise.
  const events = parseEventLog(fixtureText("ledger-clean.jsonl"));
  return serializeState(buildState(replay(events, { universe: UNIVERSE })));
}

describe("state.json", () => {
  it("is byte-identical when rebuilt from the log", () => {
    expect(rebuild()).toBe(rebuild());
  });

  it("survives a JSON round trip unchanged", () => {
    const serialized = rebuild();
    expect(`${JSON.stringify(JSON.parse(serialized), null, 2)}\n`).toBe(serialized);
  });

  it("ends with a newline so the commit diffs cleanly", () => {
    expect(rebuild().endsWith("}\n")).toBe(true);
  });

  it("sorts portfolios and positions so the file never churns", () => {
    const state = buildState(
      replay(fixtureEvents("ledger-clean.jsonl"), { universe: UNIVERSE }),
    );
    expect(state.portfolios.map((p) => p.portfolio)).toEqual(["dca", "value"]);
    const mid = buildState(
      replay(
        fixtureEvents("ledger-clean.jsonl").filter(
          (event) => event.ts <= "2026-09-17T20:30:03Z",
        ),
        { universe: UNIVERSE },
      ),
    );
    expect(
      mid.portfolios
        .find((p) => p.portfolio === "value")
        ?.positions.map((p) => p.ticker),
    ).toEqual(["AAPL", "SAP.DE"]);
  });

  it("carries the cache of everything the dashboard needs", () => {
    const state = buildState(
      replay(fixtureEvents("ledger-clean.jsonl"), { universe: UNIVERSE }),
      { riskFreeAnnual: 0.02 },
    );
    expect(state.asOf).toBe("2026-09-21T20:30:05Z");
    expect(state.eventCount).toBe(28);
    expect(state.violations).toEqual([]);

    const value = state.portfolios.find((p) => p.portfolio === "value");
    expect(value?.cashEur).toBe(44.54);
    expect(value?.positions).toHaveLength(1);
    expect(value?.lastMark?.totalValueEur).toBe(105.34);
    expect(value?.metrics.timeWeightedReturn).toBe(0.0534);
    expect(value?.pendingOrderIds).toEqual([]);
  });

  it("is derived, not authoritative: violations travel with it", () => {
    const state = buildState(
      replay(fixtureEvents("ledger-negative-cash.jsonl"), { universe: UNIVERSE }),
    );
    expect(state.violations.map((v) => v.code)).toEqual(["CASH_NEGATIVE"]);
  });
});
