/**
 * SPEC 1.1 / SPEC 14: "Write a test that fails if any fill price equals a
 * price present in the brief that triggered it."
 */
import { describe, expect, it } from "vitest";
import { checkLookAhead } from "../src/domain/lookahead.js";
import { fixtureEvents, briefResolver } from "./helpers/fixtures.js";

const CLEAN_BRIEFS = [
  "brief-2026-09-15.json",
  "brief-2026-09-16.json",
  "brief-2026-09-18.json",
];

describe("no look-ahead", () => {
  it("passes a ledger whose fills all happened after the brief they read", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-clean.jsonl"),
      briefResolver(CLEAN_BRIEFS),
    );
    expect(violations).toEqual([]);
  });

  it("fails when a fill price is a price printed in that brief", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-lookahead.jsonl"),
      briefResolver(["brief-lookahead.json"]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("FILL_PRICE_VISIBLE_IN_BRIEF");
    expect(violations[0]?.ticker).toBe("SAP.DE");
    expect(violations[0]?.message).toMatch(/145.8.*already printed in brief/);
  });

  it("catches every visible price, not just the close", () => {
    // 144.10 is the brief's low; an agent could see it just as easily.
    const events = fixtureEvents("ledger-lookahead.jsonl").map((event) =>
      event.type === "ORDER_FILLED"
        ? { ...event, priceLocal: 144.1, grossEur: 57.64, netEur: 58.64 }
        : event,
    );
    const violations = checkLookAhead(events, briefResolver(["brief-lookahead.json"]));
    expect(violations.map((v) => v.code)).toEqual(["FILL_PRICE_VISIBLE_IN_BRIEF"]);
  });

  it("fails when a fill is dated on the day of its own brief", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-same-day-fill.jsonl"),
      () => ({
        briefHash: "sha256:test",
        date: "2026-09-15",
        pricesByTicker: new Map([["SAP.DE", [145.0, 146.2, 144.1, 145.8, 144.5]]]),
      }),
    );
    expect(violations.map((v) => v.code)).toEqual(["FILL_NOT_AFTER_BRIEF"]);
  });

  it("treats an unresolvable brief as a violation: unauditable is not clean", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-clean.jsonl"),
      () => undefined,
    );
    expect(violations).toHaveLength(4); // one per fill
    expect(new Set(violations.map((v) => v.code))).toEqual(
      new Set(["BRIEF_NOT_RESOLVED"]),
    );
  });

  it("can be relaxed to skip fills with no brief on record", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-clean.jsonl"),
      () => undefined,
      { requireBrief: false },
    );
    expect(violations).toEqual([]);
  });

  it("flags a fill that has no order at all", () => {
    const violations = checkLookAhead(
      fixtureEvents("ledger-orphan-fill.jsonl"),
      briefResolver(CLEAN_BRIEFS),
    );
    expect(violations.map((v) => v.code)).toEqual(["FILL_WITHOUT_ORDER"]);
  });

  it("does not flag a price that merely rounds near a brief price", () => {
    const events = fixtureEvents("ledger-lookahead.jsonl").map((event) =>
      event.type === "ORDER_FILLED"
        ? { ...event, priceLocal: 145.85, grossEur: 58.34, netEur: 59.34 }
        : event,
    );
    expect(checkLookAhead(events, briefResolver(["brief-lookahead.json"]))).toEqual([]);
  });
});
