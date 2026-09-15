/**
 * Every invariant SPEC 4 asks `pnpm verify` to assert, one fixture each:
 * cash never negative, quantity never negative, no position outside the
 * whitelist, every ORDER_FILLED has a preceding ORDER_PLACED, and every fill
 * date is strictly after its decision date.
 */
import { describe, expect, it } from "vitest";
import {
  assertLedgerValid,
  formatViolations,
  verifyLedger,
} from "../src/domain/invariants.js";
import type { ViolationCode } from "../src/domain/violations.js";
import { fixtureEvents, UNIVERSE } from "./helpers/fixtures.js";

function verify(fixture: string) {
  return verifyLedger(fixtureEvents(fixture), { universe: UNIVERSE });
}

function codes(fixture: string): ViolationCode[] {
  return [...new Set(verify(fixture).violations.map((v) => v.code))].sort();
}

describe("ledger invariants (SPEC 4)", () => {
  it("passes a clean ledger", () => {
    const report = verify("ledger-clean.jsonl");
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(() => assertLedgerValid(report)).not.toThrow();
  });

  it("catches cash going negative", () => {
    const report = verify("ledger-negative-cash.jsonl");
    expect(codes("ledger-negative-cash.jsonl")).toContain("CASH_NEGATIVE");
    expect(report.result.portfolios.get("broke")?.cashEur).toBe(-50);
    expect(report.byCode.get("CASH_NEGATIVE")?.[0]?.eventId).toBe("n-003");
  });

  it("catches quantity going negative", () => {
    expect(codes("ledger-oversold.jsonl")).toContain("QTY_NEGATIVE");
    const report = verify("ledger-oversold.jsonl");
    const violation = report.byCode.get("QTY_NEGATIVE")?.[0];
    expect(violation?.message).toMatch(/sold 2 of "SAP.DE" while holding 1/);
    // The book is clamped at zero rather than going short.
    expect(report.result.portfolios.get("oversold")?.positions.size).toBe(0);
  });

  it("catches a position outside the whitelist (SPEC 1.6)", () => {
    const found = codes("ledger-off-whitelist.jsonl");
    expect(found).toContain("ORDER_OFF_WHITELIST");
    expect(found).toContain("POSITION_OFF_WHITELIST");
    const report = verify("ledger-off-whitelist.jsonl");
    expect(report.byCode.get("ORDER_OFF_WHITELIST")).toHaveLength(2); // placed and filled
  });

  it("does not check the whitelist when no universe is supplied", () => {
    const report = verifyLedger(fixtureEvents("ledger-off-whitelist.jsonl"));
    expect(report.ok).toBe(true);
  });

  it("catches a fill with no preceding ORDER_PLACED", () => {
    expect(codes("ledger-orphan-fill.jsonl")).toContain("FILL_WITHOUT_ORDER");
    const report = verify("ledger-orphan-fill.jsonl");
    expect(report.byCode.get("FILL_WITHOUT_ORDER")?.[0]?.message).toMatch(
      /never placed/,
    );
  });

  it("catches a fill dated on the decision day (SPEC 1.1)", () => {
    expect(codes("ledger-same-day-fill.jsonl")).toContain(
      "FILL_NOT_AFTER_DECISION",
    );
    const report = verify("ledger-same-day-fill.jsonl");
    expect(report.byCode.get("FILL_NOT_AFTER_DECISION")?.[0]?.message).toMatch(
      /not strictly after the decision of 2026-09-15/,
    );
  });

  it("catches a written mark that disagrees with the replay", () => {
    expect(codes("ledger-bad-mark.jsonl")).toContain("VALUATION_MISMATCH");
    const report = verify("ledger-bad-mark.jsonl");
    const messages = (report.byCode.get("VALUATION_MISMATCH") ?? []).map(
      (v) => v.message,
    );
    expect(messages).toContainEqual(
      expect.stringMatching(/mark says cash 120, replay says 100/),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(/mark lists "SAP.DE", which the replay does not hold/),
    );
  });

  it("catches a duplicated event id", () => {
    const events = fixtureEvents("ledger-clean.jsonl");
    const first = events[0];
    if (first === undefined) throw new Error("empty fixture");
    const report = verifyLedger([...events, first], { universe: UNIVERSE });
    expect(report.byCode.has("DUPLICATE_EVENT_ID")).toBe(true);
  });

  it("catches a portfolio's events running backwards", () => {
    const events = fixtureEvents("ledger-clean.jsonl");
    const reversed = [...events].reverse();
    const report = verifyLedger(reversed, { universe: UNIVERSE });
    expect(report.byCode.has("EVENTS_OUT_OF_ORDER")).toBe(true);
  });

  it("catches a fill whose own arithmetic does not add up", () => {
    const events = fixtureEvents("ledger-clean.jsonl").map((event) =>
      event.id === "v-004" && event.type === "ORDER_FILLED"
        ? { ...event, netEur: 55.0 }
        : event,
    );
    const report = verifyLedger(events, { universe: UNIVERSE });
    expect(report.byCode.has("FILL_AMOUNTS_INCONSISTENT")).toBe(true);
  });

  it("reports every breach rather than stopping at the first", () => {
    const report = verify("ledger-off-whitelist.jsonl");
    expect(report.violations.length).toBeGreaterThan(1);
    expect(formatViolations(report.violations)).toMatch(/ORDER_OFF_WHITELIST \[rogue\]/);
  });

  it("assertLedgerValid throws with every breach listed", () => {
    const report = verify("ledger-negative-cash.jsonl");
    expect(() => assertLedgerValid(report)).toThrow(/ledger failed 1 invariant/);
  });
});
