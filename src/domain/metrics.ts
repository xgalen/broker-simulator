/**
 * Performance metrics (SPEC 9).
 *
 * Two returns, computed and labelled separately because they answer different
 * questions:
 *
 *  - Time-weighted return, chained *daily*, with every deposit treated as an
 *    external flow that closes one sub-period and opens the next. This is what
 *    ranks the portfolios, and daily chaining is precisely what stops a 50 EUR
 *    deposit from registering as a 50 EUR gain.
 *  - Money-weighted return (XIRR) for "what did this actually earn on the
 *    money put in".
 *
 * Both are derived from the VALUATION marks and DEPOSIT flows already in the
 * log, so metrics never need prices of their own.
 */
import { eur, roundTo } from "./money.js";
import type { PortfolioState } from "./replay.js";
import type { IsoDate } from "./types.js";

/** Trading days per year, used to annualise daily statistics. */
export const TRADING_DAYS_PER_YEAR = 252;

/** One day of the equity curve, with the flow that opened it. */
export interface DailyPoint {
  readonly date: IsoDate;
  /** Cash + positions at the close of this day. */
  readonly totalValueEur: number;
  /** Deposits credited at the start of this day (SPEC 8: deposits precede the mark). */
  readonly externalFlowEur: number;
  readonly contributedToDateEur: number;
  /** Value minus money put in: the curve that does not jump on deposit days. */
  readonly pnlEur: number;
  /** Sub-period return: V_t / (V_{t-1} + F_t) - 1. */
  readonly dailyReturn: number;
  /** Chained growth of 1 unit since inception. */
  readonly twrIndex: number;
}

export interface PortfolioMetrics {
  readonly portfolio: string;
  readonly firstDate: IsoDate | null;
  readonly lastDate: IsoDate | null;
  readonly days: number;
  readonly totalValueEur: number;
  readonly contributedToDateEur: number;
  readonly pnlEur: number;
  /** Chained daily time-weighted return, as a fraction (0.032 = +3.2%). */
  readonly timeWeightedReturn: number;
  readonly annualizedTimeWeightedReturn: number;
  /** Money-weighted return (XIRR), annualised. `null` when it cannot be solved. */
  readonly moneyWeightedReturn: number | null;
  /** Deepest peak-to-trough fall of the TWR index, as a negative fraction. */
  readonly maxDrawdown: number;
  readonly annualizedVolatility: number;
  readonly sharpe: number | null;
  /** Share of closed round trips with positive realized P&L. */
  readonly hitRate: number | null;
  readonly closedTrades: number;
  readonly averageHoldingDays: number | null;
  /** Gross traded notional over average equity. */
  readonly turnover: number | null;
  readonly cumulativeFeesEur: number;
  /** Fees as a share of everything contributed. At 50 EUR/month a 1 EUR fee is 2%. */
  readonly feeDragPct: number | null;
  readonly cumulativeFxEffectEur: number;
  readonly realizedPricePnlEur: number;
  readonly realizedFxPnlEur: number;
}

/**
 * Merge the daily marks with the deposit flows into one series.
 *
 * A deposit is attributed to the first mark on or after its date: the engine
 * credits deposits before writing the mark (SPEC 8), so the money is present
 * in that day's closing value and must be netted out of that day's return.
 */
export function buildDailySeries(state: PortfolioState): DailyPoint[] {
  const flows = [...state.flows].sort((a, b) => a.ts.localeCompare(b.ts));
  const points: DailyPoint[] = [];
  let flowIndex = 0;
  let previousValue = 0;
  let index = 1;

  for (const mark of state.marks) {
    // Deposits dated on or before this mark (a deposit made while the market
    // was shut lands in the next session's opening balance).
    let flow = 0;
    while (flowIndex < flows.length) {
      const next = flows[flowIndex];
      if (next === undefined || next.date > mark.date) break;
      flow += next.amountEur;
      flowIndex += 1;
    }

    const start = previousValue + flow;
    const dailyReturn = start > 0 ? mark.totalValueEur / start - 1 : 0;
    index *= 1 + dailyReturn;
    points.push({
      date: mark.date,
      totalValueEur: mark.totalValueEur,
      externalFlowEur: eur(flow),
      contributedToDateEur: mark.contributedToDateEur,
      pnlEur: eur(mark.totalValueEur - mark.contributedToDateEur),
      dailyReturn,
      twrIndex: index,
    });
    previousValue = mark.totalValueEur;
  }

  return points;
}

/** Chained daily time-weighted return over the whole series. */
export function timeWeightedReturn(series: readonly DailyPoint[]): number {
  const last = series.at(-1);
  return last === undefined ? 0 : last.twrIndex - 1;
}

/** Deepest peak-to-trough fall of the TWR index, as a negative fraction. */
export function maxDrawdown(series: readonly DailyPoint[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const point of series) {
    peak = Math.max(peak, point.twrIndex);
    if (peak > 0) {
      worst = Math.min(worst, point.twrIndex / peak - 1);
    }
  }
  return worst;
}

/** Annualised standard deviation of the daily time-weighted returns. */
export function annualizedVolatility(series: readonly DailyPoint[]): number {
  const returns = series.map((point) => point.dailyReturn);
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Net present value of dated cash flows at an annual rate, ACT/365.
 * Deposits are negative (money in), the terminal value positive.
 */
function npv(
  rate: number,
  flows: readonly { date: IsoDate; amountEur: number }[],
  from: IsoDate,
): number {
  const base = Date.parse(`${from}T00:00:00Z`);
  let total = 0;
  for (const flow of flows) {
    const years =
      (Date.parse(`${flow.date}T00:00:00Z`) - base) / (365 * 86_400_000);
    total += flow.amountEur / (1 + rate) ** years;
  }
  return total;
}

/**
 * Money-weighted return (XIRR): the annual rate that makes the deposits and
 * the terminal value net to zero. Newton first, bisection as a guaranteed
 * fallback. Returns `null` when no rate brackets a sign change.
 */
export function xirr(
  flows: readonly { date: IsoDate; amountEur: number }[],
  { tolerance = 1e-9, maxIterations = 128 } = {},
): number | null {
  if (flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  if (first === undefined) return null;
  const hasPositive = sorted.some((f) => f.amountEur > 0);
  const hasNegative = sorted.some((f) => f.amountEur < 0);
  if (!hasPositive || !hasNegative) return null;
  if (first.date === sorted.at(-1)?.date) return null;

  let rate = 0.1;
  for (let i = 0; i < maxIterations; i += 1) {
    const value = npv(rate, sorted, first.date);
    if (Math.abs(value) < tolerance) return rate;
    const step = 1e-6;
    const derivative =
      (npv(rate + step, sorted, first.date) - value) / step;
    if (!Number.isFinite(derivative) || derivative === 0) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - rate) < tolerance) return next;
    rate = next;
  }

  let low = -0.999999;
  let high = 1000;
  let lowValue = npv(low, sorted, first.date);
  let highValue = npv(high, sorted, first.date);
  if (lowValue * highValue > 0) return null;
  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (low + high) / 2;
    const value = npv(mid, sorted, first.date);
    if (Math.abs(value) < tolerance || high - low < tolerance) return mid;
    if (value * lowValue <= 0) {
      high = mid;
      highValue = value;
    } else {
      low = mid;
      lowValue = value;
    }
  }
  return (low + high) / 2;
}

/** XIRR over a portfolio's deposits and its final mark. */
export function moneyWeightedReturn(state: PortfolioState): number | null {
  const last = state.marks.at(-1);
  if (last === undefined) return null;
  const flows = state.flows.map((flow) => ({
    date: flow.date,
    amountEur: -flow.amountEur,
  }));
  flows.push({ date: last.date, amountEur: last.totalValueEur });
  return xirr(flows);
}

export interface MetricsOptions {
  /** EUR risk-free rate, annual fraction (from `config/simulation.yaml`). */
  readonly riskFreeAnnual?: number;
}

/** Everything SPEC 9 asks for, per portfolio. */
export function computeMetrics(
  state: PortfolioState,
  options: MetricsOptions = {},
): PortfolioMetrics {
  const series = buildDailySeries(state);
  const riskFree = options.riskFreeAnnual ?? 0;
  const last = series.at(-1);
  const first = series[0];
  const twr = timeWeightedReturn(series);
  const days = series.length;
  const annualizedTwr =
    days > 0 ? (1 + twr) ** (TRADING_DAYS_PER_YEAR / days) - 1 : 0;
  const volatility = annualizedVolatility(series);
  const closed = state.realizedTrades;
  const averageValue =
    days > 0
      ? series.reduce((acc, point) => acc + point.totalValueEur, 0) / days
      : 0;

  return {
    portfolio: state.portfolio,
    firstDate: first?.date ?? null,
    lastDate: last?.date ?? null,
    days,
    totalValueEur: last?.totalValueEur ?? 0,
    contributedToDateEur: state.contributedToDateEur,
    pnlEur: eur((last?.totalValueEur ?? 0) - state.contributedToDateEur),
    timeWeightedReturn: roundTo(twr, 6),
    annualizedTimeWeightedReturn: roundTo(annualizedTwr, 6),
    moneyWeightedReturn: round6OrNull(moneyWeightedReturn(state)),
    maxDrawdown: roundTo(maxDrawdown(series), 6),
    annualizedVolatility: roundTo(volatility, 6),
    sharpe:
      volatility > 0 ? roundTo((annualizedTwr - riskFree) / volatility, 6) : null,
    hitRate:
      closed.length > 0
        ? roundTo(
            closed.filter((trade) => trade.realizedPnlEur > 0).length /
              closed.length,
            6,
          )
        : null,
    closedTrades: closed.length,
    averageHoldingDays:
      closed.length > 0
        ? roundTo(
            closed.reduce((acc, trade) => acc + trade.holdingDays, 0) /
              closed.length,
            2,
          )
        : null,
    turnover: averageValue > 0 ? roundTo(state.turnoverEur / averageValue, 6) : null,
    cumulativeFeesEur: eur(state.feesPaidEur + state.fxCostsPaidEur),
    feeDragPct:
      state.contributedToDateEur > 0
        ? roundTo(
            (100 * (state.feesPaidEur + state.fxCostsPaidEur)) /
              state.contributedToDateEur,
            4,
          )
        : null,
    cumulativeFxEffectEur: eur(state.marks.at(-1)?.fxEffectEur ?? 0),
    realizedPricePnlEur: state.realizedPricePnlEur,
    realizedFxPnlEur: state.realizedFxPnlEur,
  };
}

function round6OrNull(value: number | null): number | null {
  return value === null ? null : roundTo(value, 6);
}
