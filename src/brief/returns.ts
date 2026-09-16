/**
 * Trailing returns for the brief (SPEC 6: "plus 1d/5d/1m/6m/1y returns").
 *
 * Pure, and computed from the daily bars rather than asked of a quote endpoint:
 * the windows then mean the same thing for every instrument, and the brief can
 * be rebuilt from the committed bars without a second opinion from Yahoo.
 *
 * Two choices worth stating:
 *
 *  - Returns are computed on adjusted closes where the source provides them, so
 *    a split or a dividend does not read as a 50% crash. `close` is the
 *    fallback, which is what an unadjusted series gives you anyway.
 *  - The day windows count trading days (the previous bar, five bars back) and
 *    the month/year windows count calendar time (the last bar on or before the
 *    anchor date). That is what "1d" and "1y" mean to the person reading them:
 *    one session ago, one year ago.
 */
import { roundTo } from "../domain/money.js";
import type { IsoDate } from "../domain/types.js";
import type { DailyBar } from "../data/port.js";
import type { ReturnWindows } from "./types.js";

/** Returns carry more precision than money: 6dp is a tenth of a basis point. */
const RETURN_DP = 6;

export const EMPTY_RETURNS: ReturnWindows = {
  d1: null,
  d5: null,
  m1: null,
  m6: null,
  y1: null,
};

interface PricePoint {
  readonly date: IsoDate;
  readonly price: number;
}

/**
 * Shift an ISO date by whole months, clamping to the end of the target month:
 * one month before 2026-03-31 is 2026-02-28, not 2026-03-03.
 */
export function shiftMonths(date: IsoDate, months: number): IsoDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  // Day 0 of the following month is the last day of the target month.
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInMonth);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1, 2)}-${pad(targetDay, 2)}`;
}

/** Usable closes, oldest first, deduplicated by date. */
function pricePoints(bars: readonly DailyBar[], asOf: IsoDate): PricePoint[] {
  const byDate = new Map<IsoDate, number>();
  for (const bar of bars) {
    if (bar.date > asOf) continue;
    const price = bar.adjClose ?? bar.close;
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    byDate.set(bar.date, price);
  }
  return [...byDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Index of the last point on or before `date`, or -1. */
function indexOnOrBefore(points: readonly PricePoint[], date: IsoDate): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if ((points[index] as PricePoint).date <= date) return index;
  }
  return -1;
}

function change(from: number, to: number): number {
  return roundTo(to / from - 1, RETURN_DP);
}

/**
 * The five windows SPEC 6 asks for, as of `asOf`.
 *
 * Every window that cannot be computed is `null`: too little history, a gap in
 * the series, or a bar whose close never arrived. A newly listed instrument
 * reaches the agents with four nulls and a 1d return, which is the truth about
 * what is known of it.
 */
export function computeReturns(bars: readonly DailyBar[], asOf: IsoDate): ReturnWindows {
  const points = pricePoints(bars, asOf);
  const latestIndex = points.length - 1;
  const latest = points[latestIndex];
  if (latest === undefined) return EMPTY_RETURNS;

  const backBars = (count: number): number | null => {
    const point = points[latestIndex - count];
    return point === undefined ? null : change(point.price, latest.price);
  };

  const backMonths = (months: number): number | null => {
    const index = indexOnOrBefore(points, shiftMonths(latest.date, -months));
    if (index < 0 || index === latestIndex) return null;
    return change((points[index] as PricePoint).price, latest.price);
  };

  return {
    d1: backBars(1),
    d5: backBars(5),
    m1: backMonths(1),
    m6: backMonths(6),
    y1: backMonths(12),
  };
}
