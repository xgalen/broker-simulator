/**
 * Trailing returns (SPEC 6: "plus 1d/5d/1m/6m/1y returns").
 *
 * Comparisons are to six decimals because that is the precision the brief
 * carries — a tenth of a basis point, which is finer than any decision in this
 * project turns on.
 */
import { describe, expect, it } from "vitest";
import type { DailyBar } from "../../src/data/port.js";
import { EMPTY_RETURNS, computeReturns, shiftMonths } from "../../src/brief/returns.js";

/** `days` consecutive daily bars ending on 2026-09-15, price rising by 1/day. */
function series(count: number, start = 100): DailyBar[] {
  const bars: DailyBar[] = [];
  let day = new Date(Date.UTC(2026, 8, 15));
  for (let index = 0; index < count; index += 1) {
    bars.unshift({
      date: day.toISOString().slice(0, 10),
      open: null,
      high: null,
      low: null,
      close: start + (count - index),
      adjClose: start + (count - index),
      volume: null,
    });
    day = new Date(day.getTime() - 86_400_000);
  }
  return bars;
}

describe("shiftMonths", () => {
  it("walks whole months backwards", () => {
    expect(shiftMonths("2026-09-15", -1)).toBe("2026-08-15");
    expect(shiftMonths("2026-09-15", -12)).toBe("2025-09-15");
  });

  it("clamps to the end of a shorter month", () => {
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonths("2024-03-31", -1)).toBe("2024-02-29");
  });

  it("crosses the year boundary", () => {
    expect(shiftMonths("2026-01-15", -6)).toBe("2025-07-15");
  });
});

describe("computeReturns", () => {
  it("returns nulls when there is no history at all", () => {
    expect(computeReturns([], "2026-09-15")).toEqual(EMPTY_RETURNS);
  });

  it("counts sessions for the day windows", () => {
    const returns = computeReturns(series(10), "2026-09-15");
    // Closes run ...109, 110 over consecutive bars.
    expect(returns.d1).toBeCloseTo(110 / 109 - 1, 6);
    expect(returns.d5).toBeCloseTo(110 / 105 - 1, 6);
  });

  it("leaves a window null when the history is too short for it", () => {
    const returns = computeReturns(series(3), "2026-09-15");
    expect(returns.d1).not.toBeNull();
    expect(returns.d5).toBeNull();
    expect(returns.y1).toBeNull();
  });

  it("takes the last bar on or before the calendar anchor", () => {
    const bars: DailyBar[] = [
      { date: "2025-09-12", open: null, high: null, low: null, close: 50, adjClose: 50, volume: null },
      { date: "2026-03-13", open: null, high: null, low: null, close: 80, adjClose: 80, volume: null },
      { date: "2026-08-14", open: null, high: null, low: null, close: 95, adjClose: 95, volume: null },
      { date: "2026-09-15", open: null, high: null, low: null, close: 100, adjClose: 100, volume: null },
    ];
    const returns = computeReturns(bars, "2026-09-15");
    expect(returns.m1).toBeCloseTo(100 / 95 - 1, 6);
    expect(returns.m6).toBeCloseTo(100 / 80 - 1, 6);
    expect(returns.y1).toBeCloseTo(100 / 50 - 1, 6);
  });

  it("prefers the adjusted close, so a split does not read as a crash", () => {
    const bars: DailyBar[] = [
      { date: "2026-09-14", open: null, high: null, low: null, close: 200, adjClose: 100, volume: null },
      { date: "2026-09-15", open: null, high: null, low: null, close: 101, adjClose: 101, volume: null },
    ];
    expect(computeReturns(bars, "2026-09-15").d1).toBeCloseTo(0.01, 6);
  });

  it("ignores bars after the session being briefed, which nobody may see yet", () => {
    const bars = [
      ...series(2),
      { date: "2026-09-16", open: null, high: null, low: null, close: 999, adjClose: 999, volume: null },
    ];
    expect(computeReturns(bars, "2026-09-15").d1).toBeCloseTo(102 / 101 - 1, 6);
  });

  it("skips bars with no usable close instead of treating them as zero", () => {
    const bars: DailyBar[] = [
      { date: "2026-09-11", open: null, high: null, low: null, close: 100, adjClose: 100, volume: null },
      { date: "2026-09-14", open: null, high: null, low: null, close: null, adjClose: null, volume: null },
      { date: "2026-09-15", open: null, high: null, low: null, close: 110, adjClose: 110, volume: null },
    ];
    expect(computeReturns(bars, "2026-09-15").d1).toBeCloseTo(0.1, 6);
  });

  it("is order-independent: the same bars shuffled give the same answer", () => {
    const bars = series(8);
    const shuffled = [bars[3], bars[7], bars[0], bars[5], bars[1], bars[6], bars[2], bars[4]] as DailyBar[];
    expect(computeReturns(shuffled, "2026-09-15")).toEqual(computeReturns(bars, "2026-09-15"));
  });
});
