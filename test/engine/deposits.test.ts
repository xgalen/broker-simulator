/**
 * Contributions (SPEC 5, SPEC 8 step 3).
 *
 * "Seeded with 100 EUR on day one, then 50 EUR on the first trading day of
 * every subsequent month."
 *
 * The cases that matter are the ones a calendar would get wrong: the 1st
 * falling on a weekend, a market holiday, a month the data source was down for
 * several days running, and a job that is retried twice on the same session.
 */
import { describe, expect, it } from "vitest";
import { depositFor, isContributionSession, monthOf } from "../../src/engine/deposits.js";
import { deposit, liveSimulation, mark, stateFrom } from "../helpers/engine.js";

const simulation = liveSimulation();

describe("depositFor", () => {
  it("seeds 100 EUR on the very first session", () => {
    const state = stateFrom("dca", []);
    expect(depositFor(state, "2026-01-29", simulation)).toMatchObject({
      amountEur: 100,
      kind: "seed",
    });
  });

  it("pays 50 EUR on the first session of the next month", () => {
    const state = stateFrom("dca", [deposit("dca", "2026-01-29", 100)]);
    expect(depositFor(state, "2026-02-02", simulation)).toMatchObject({
      amountEur: 50,
      kind: "monthly",
    });
  });

  it("pays nothing on a later session of the same month", () => {
    const state = stateFrom("dca", [
      deposit("dca", "2026-01-29", 100),
      deposit("dca", "2026-02-02", 50),
    ]);
    expect(depositFor(state, "2026-02-03", simulation)).toBeNull();
    expect(depositFor(state, "2026-02-27", simulation)).toBeNull();
  });

  it("pays on the first session that actually happens, not on the 1st", () => {
    // 2026-02-01 is a Sunday; 2026-03-01 is a Sunday too. Nothing in the rule
    // knows that, and nothing needs to: the first session the engine runs in a
    // new month is the first trading day of it by definition (SPEC 13).
    const state = stateFrom("dca", [deposit("dca", "2026-01-29", 100)]);
    expect(depositFor(state, "2026-02-02", simulation)?.amountEur).toBe(50);
  });

  it("pays once for a month, however many sessions were missed before it", () => {
    // Four days of SKIPPED runs at the turn of the month must not become four
    // contributions when the data source comes back.
    const state = stateFrom("dca", [deposit("dca", "2026-01-29", 100)]);
    const first = depositFor(state, "2026-02-06", simulation);
    expect(first?.amountEur).toBe(50);

    const after = stateFrom("dca", [
      deposit("dca", "2026-01-29", 100),
      deposit("dca", "2026-02-06", 50),
    ]);
    expect(depositFor(after, "2026-02-09", simulation)).toBeNull();
  });

  it("is idempotent when a session is rerun", () => {
    const state = stateFrom("dca", [deposit("dca", "2026-02-02", 100)]);
    expect(depositFor(state, "2026-02-02", simulation)).toBeNull();
    expect(depositFor(state, "2026-02-01", simulation)).toBeNull();
  });

  it("crosses a year boundary", () => {
    const state = stateFrom("dca", [deposit("dca", "2026-12-31", 50)]);
    expect(depositFor(state, "2027-01-04", simulation)?.kind).toBe("monthly");
  });

  it("reaches 100 + 50n after n further months", () => {
    const events = [deposit("dca", "2026-01-29", 100)];
    for (const date of ["2026-02-02", "2026-03-02", "2026-04-01"]) {
      const state = stateFrom("dca", events);
      const due = depositFor(state, date, simulation);
      expect(due, date).not.toBeNull();
      events.push(deposit("dca", date, due?.amountEur ?? 0));
    }
    expect(stateFrom("dca", events).contributedToDateEur).toBe(250);
  });
});

describe("isContributionSession", () => {
  it("is true exactly on the session a deposit landed", () => {
    const state = stateFrom("dca", [
      deposit("dca", "2026-01-29", 100),
      mark("dca", "2026-01-29", { cashEur: 100, contributedToDateEur: 100 }),
    ]);
    expect(isContributionSession(state, "2026-01-29")).toBe(true);
    expect(isContributionSession(state, "2026-01-30")).toBe(false);
  });
});

describe("monthOf", () => {
  it("is the YYYY-MM prefix", () => {
    expect(monthOf("2026-02-02")).toBe("2026-02");
  });
});
