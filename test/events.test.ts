import { describe, expect, it } from "vitest";
import {
  EventParseError,
  parseEvent,
  parseEventLog,
} from "../src/domain/events.js";
import { fixtureEvents, fixtureText } from "./helpers/fixtures.js";

describe("event log parsing", () => {
  it("parses every event type in the fixture ledger", () => {
    const events = fixtureEvents("ledger-clean.jsonl");
    expect(events).toHaveLength(28);
    const types = new Set(events.map((event) => event.type));
    expect([...types].sort()).toEqual([
      "DEPOSIT",
      "DIVIDEND",
      "HOLD",
      "ORDER_FILLED",
      "ORDER_PLACED",
      "SPLIT",
      "VALUATION",
    ]);
  });

  it("carries id, ts, portfolio and type on every event (SPEC 4)", () => {
    for (const event of fixtureEvents("ledger-clean.jsonl")) {
      expect(event.id).toBeTruthy();
      expect(event.portfolio).toBeTruthy();
      expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(event.type).toBeTruthy();
    }
  });

  it("ignores blank lines so the log can be appended to", () => {
    const text = `${fixtureText("ledger-skipped.jsonl")}\n\n`;
    expect(parseEventLog(text)).toHaveLength(4);
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseEvent({ id: "x", ts: "2026-09-15T20:30:00Z", portfolio: "value", type: "TRANSFER" }),
    ).toThrow(/unknown event type "TRANSFER"/);
  });

  it("rejects a missing payload field", () => {
    expect(() =>
      parseEvent({ id: "x", ts: "2026-09-15T20:30:00Z", portfolio: "value", type: "DEPOSIT" }),
    ).toThrow(/missing field "amountEur"/);
  });

  it("rejects a non-UTC timestamp", () => {
    expect(() =>
      parseEvent({ id: "x", ts: "2026-09-15 20:30:00+02:00", portfolio: "value", type: "SKIPPED", reason: "r" }),
    ).toThrow(/ISO-8601 UTC/);
  });

  it("rejects a hold with no reason (SPEC 1.7: every decision is recorded)", () => {
    expect(() =>
      parseEvent({ id: "x", ts: "2026-09-15T20:30:00Z", portfolio: "value", type: "HOLD", decisionId: "d", reason: "" }),
    ).toThrow(/must not be empty/);
  });

  it("rejects a non-positive fx rate", () => {
    expect(() =>
      parseEvent({
        id: "x", ts: "2026-09-15T20:30:00Z", portfolio: "value", type: "DIVIDEND",
        ticker: "AAPL", amountLocal: 1, currency: "USD", fxRate: 0, withholdingEur: 0, netEur: 1,
      }),
    ).toThrow(/fxRate/);
  });

  it("reports the line number of a bad line", () => {
    const text = '{"id":"a","ts":"2026-09-15T20:30:00Z","portfolio":"p","type":"SKIPPED","reason":"r"}\nnot json\n';
    expect(() => parseEventLog(text)).toThrow(EventParseError);
    expect(() => parseEventLog(text)).toThrow(/line 2/);
  });
});
