/**
 * A day that skips and is later re-run successfully (SPEC 1 rule 5, SPEC 4).
 *
 * This happened for real on the first live session: the run skipped with
 * `data_fetch_failed`, the cause was fixed, the same date was re-dispatched
 * and succeeded — and `verify` rejected the result, because the skip had been
 * stamped at 22:30 and the deposit that superseded it at 09:30. The ledger
 * replayed out of order and the workflow refused to commit it.
 *
 * Skips are routine (holidays, outages, a bad symbol), and re-running the day
 * after fixing the cause is the obvious human response, so this pairing will
 * recur. The stamps are ordering devices rather than instants, so the skip now
 * sorts at the head of its day.
 */
import { describe, expect, it } from "vitest";
import { parseEvent } from "../../src/domain/events.js";
import { verifyLedger } from "../../src/domain/invariants.js";
import type { LedgerEvent } from "../../src/domain/events.js";

const DATE = "2026-09-16";

const skip = (at: string): LedgerEvent =>
  parseEvent({
    id: `${DATE}/dca/skp/1`,
    ts: `${DATE}T${at}`,
    portfolio: "dca",
    type: "SKIPPED",
    reason: "data_fetch_failed",
  });

const deposit = (): LedgerEvent =>
  parseEvent({
    id: `${DATE}/dca/dep/1`,
    ts: `${DATE}T09:30:00.000Z`,
    portfolio: "dca",
    type: "DEPOSIT",
    amountEur: 100,
  });

const mark = (): LedgerEvent =>
  parseEvent({
    id: `${DATE}/dca/val/1`,
    ts: `${DATE}T22:00:00.000Z`,
    portfolio: "dca",
    type: "VALUATION",
    cashEur: 100,
    positions: [],
    marketValueEur: 0,
    fxEffectEur: 0,
    contributedToDateEur: 100,
  });

describe("a skipped day that is later re-run", () => {
  it("replays in order when the skip is stamped at the head of its day", () => {
    const report = verifyLedger([skip("00:30:00.000Z"), deposit(), mark()]);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("is what the old 22:30 stamp broke — the exact live failure", () => {
    const report = verifyLedger([skip("22:30:00.000Z"), deposit(), mark()]);
    const codes = report.violations.map((violation) => violation.code);
    expect(codes).toContain("EVENTS_OUT_OF_ORDER");
  });

  it("keeps a skip-only day valid", () => {
    expect(verifyLedger([skip("00:30:00.000Z")]).violations).toEqual([]);
  });

  it("orders a skip after the previous day's close", () => {
    const yesterday = parseEvent({
      id: "2026-09-15/dca/val/1",
      ts: "2026-09-15T22:00:00.000Z",
      portfolio: "dca",
      type: "VALUATION",
      // Nothing funded yet, so the mark must agree with a replay of nothing.
      cashEur: 0,
      positions: [],
      marketValueEur: 0,
      fxEffectEur: 0,
      contributedToDateEur: 0,
    });
    expect(verifyLedger([yesterday, skip("00:30:00.000Z")]).violations).toEqual([]);
  });
});
