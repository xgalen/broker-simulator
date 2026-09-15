/**
 * `state.json` — a cache of the fold, never a source of truth (SPEC 1.3).
 *
 * SPEC 14: "Deleting `state.json` and rebuilding from `events.jsonl` produces
 * a byte-identical file." That is why `buildState` takes no clock and stamps
 * no generation time: the file is a function of the log and nothing else.
 * Key order is fixed, portfolios and positions are sorted, and every number
 * is already rounded by the fold.
 */
import { computeMetrics, type MetricsOptions, type PortfolioMetrics } from "./metrics.js";
import type { PortfolioState, ReplayResult, ValuationMark } from "./replay.js";
import type { InvariantViolation } from "./violations.js";
import type { Currency, IsoTimestamp, PortfolioId, Ticker } from "./types.js";

export const STATE_SCHEMA_VERSION = 1;

export interface StatePosition {
  readonly ticker: Ticker;
  readonly currency: Currency;
  readonly qty: number;
  readonly costBasisEur: number;
  readonly grossCostEur: number;
  readonly feesEur: number;
  readonly fxCostsEur: number;
  readonly openedTs: IsoTimestamp;
  readonly lastTradeTs: IsoTimestamp;
}

export interface StatePortfolio {
  readonly portfolio: PortfolioId;
  readonly cashEur: number;
  readonly contributedToDateEur: number;
  readonly realizedPnlEur: number;
  readonly realizedPricePnlEur: number;
  readonly realizedFxPnlEur: number;
  readonly feesPaidEur: number;
  readonly fxCostsPaidEur: number;
  readonly dividendsNetEur: number;
  readonly withholdingEur: number;
  readonly turnoverEur: number;
  readonly positions: readonly StatePosition[];
  readonly pendingOrderIds: readonly string[];
  readonly lastMark: ValuationMark | null;
  readonly counters: PortfolioState["counters"];
  readonly metrics: PortfolioMetrics;
}

export interface StateFile {
  readonly schemaVersion: number;
  readonly asOf: IsoTimestamp | null;
  readonly eventCount: number;
  readonly portfolios: readonly StatePortfolio[];
  readonly violations: readonly InvariantViolation[];
}

/** Project a replay result into the shape committed as `data/state.json`. */
export function buildState(
  result: ReplayResult,
  options: MetricsOptions = {},
): StateFile {
  const ids = [...result.portfolios.keys()].sort();
  const portfolios = ids.map((id) => {
    const state = result.portfolios.get(id);
    if (state === undefined) {
      throw new Error(`unreachable: portfolio "${id}" vanished from replay`);
    }
    return projectPortfolio(state, options);
  });

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    asOf: result.lastEventTs,
    eventCount: result.eventCount,
    portfolios,
    violations: result.violations,
  };
}

function projectPortfolio(
  state: PortfolioState,
  options: MetricsOptions,
): StatePortfolio {
  const positions = [...state.positions.values()]
    .filter((position) => position.qty > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
    .map((position) => ({
      ticker: position.ticker,
      currency: position.currency,
      qty: position.qty,
      costBasisEur: position.costBasisEur,
      grossCostEur: position.grossCostEur,
      feesEur: position.feesEur,
      fxCostsEur: position.fxCostsEur,
      openedTs: position.openedTs,
      lastTradeTs: position.lastTradeTs,
    }));

  return {
    portfolio: state.portfolio,
    cashEur: state.cashEur,
    contributedToDateEur: state.contributedToDateEur,
    realizedPnlEur: state.realizedPnlEur,
    realizedPricePnlEur: state.realizedPricePnlEur,
    realizedFxPnlEur: state.realizedFxPnlEur,
    feesPaidEur: state.feesPaidEur,
    fxCostsPaidEur: state.fxCostsPaidEur,
    dividendsNetEur: state.dividendsNetEur,
    withholdingEur: state.withholdingEur,
    turnoverEur: state.turnoverEur,
    positions,
    pendingOrderIds: [...state.pendingOrders.keys()].sort(),
    lastMark: state.marks.at(-1) ?? null,
    counters: state.counters,
    metrics: computeMetrics(state, options),
  };
}

/** Deterministic JSON for `data/state.json`, with a trailing newline. */
export function serializeState(state: StateFile): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
