/**
 * `replay` — the one derivation in the system (SPEC 1.3, SPEC 4).
 *
 * All state is a left fold over the immutable event log. Nothing mutates a
 * balance in place; `state.json` is a cache of this function's output and can
 * always be thrown away and rebuilt.
 *
 * Replay is total: a malformed *value* is rejected at parse time, but a
 * ledger that breaks an invariant still replays to the end and reports every
 * breach it found, so `pnpm verify` can show all of them at once rather than
 * dying on the first.
 *
 * Replay takes no clock. It is a function of the events alone, which is what
 * makes rebuilding `state.json` byte-identical.
 */
import { eur, eurEquals, qty as roundQty, toEur } from "./money.js";
import type {
  DividendEvent,
  LedgerEvent,
  OrderFilledEvent,
  OrderPlacedEvent,
  ValuationEvent,
} from "./events.js";
import { dateOf } from "./types.js";
import type {
  Currency,
  IsoDate,
  IsoTimestamp,
  OrderId,
  PortfolioId,
  Ticker,
} from "./types.js";
import type { InvariantViolation, ViolationCode } from "./violations.js";

/** An open holding, carried at all-in EUR cost. */
export interface Position {
  readonly ticker: Ticker;
  readonly currency: Currency;
  /** Shares held, 4dp. */
  readonly qty: number;
  /** All-in EUR cost of the open quantity: price plus fees plus FX cost. */
  readonly costBasisEur: number;
  /** EUR cost of the open quantity at entry FX, excluding fees and FX cost. */
  readonly grossCostEur: number;
  /** Cost of the open quantity in local currency (qty x entry price). */
  readonly localCostBasis: number;
  /** Fees and FX costs paid to acquire the open quantity. */
  readonly feesEur: number;
  readonly fxCostsEur: number;
  readonly openedTs: IsoTimestamp;
  readonly lastTradeTs: IsoTimestamp;
}

/** A closed (or partially closed) position, with P&L attribution. */
export interface RealizedTrade {
  readonly ticker: Ticker;
  readonly qty: number;
  readonly openedTs: IsoTimestamp;
  readonly closedTs: IsoTimestamp;
  readonly holdingDays: number;
  /** All-in EUR cost removed from the position. */
  readonly costEur: number;
  /** Net EUR proceeds credited to cash. */
  readonly proceedsEur: number;
  /** proceeds - cost. Equals pricePnlEur + fxPnlEur - feesEur. */
  readonly realizedPnlEur: number;
  /** Move in the local-currency price, held at entry FX. */
  readonly pricePnlEur: number;
  /** Move in FX, held at the exit price (SPEC 4: never let FX pass as stock picking). */
  readonly fxPnlEur: number;
  /** Fees and FX costs attributed to this round trip, both legs. */
  readonly feesEur: number;
  readonly closedByOrderId: OrderId;
}

/** A daily equity mark taken from a VALUATION event. */
export interface ValuationMark {
  readonly date: IsoDate;
  readonly ts: IsoTimestamp;
  readonly cashEur: number;
  readonly marketValueEur: number;
  /** cash + positions. The number the equity curve plots. */
  readonly totalValueEur: number;
  readonly fxEffectEur: number;
  readonly contributedToDateEur: number;
}

/** An external flow: a deposit closes one TWR sub-period and opens the next. */
export interface CashFlow {
  readonly date: IsoDate;
  readonly ts: IsoTimestamp;
  readonly amountEur: number;
}

/** An order that has been queued but not yet filled or rejected. */
export interface PendingOrder {
  readonly order: OrderPlacedEvent;
}

export interface PortfolioCounters {
  readonly ordersPlaced: number;
  readonly ordersFilled: number;
  readonly ordersRejected: number;
  readonly holds: number;
  readonly skips: number;
  readonly deposits: number;
  readonly splits: number;
  readonly dividends: number;
}

/** Everything derivable about one portfolio from the log. */
export interface PortfolioState {
  readonly portfolio: PortfolioId;
  readonly cashEur: number;
  /** Open positions, keyed by ticker. */
  readonly positions: ReadonlyMap<Ticker, Position>;
  readonly contributedToDateEur: number;
  readonly realizedPnlEur: number;
  readonly realizedPricePnlEur: number;
  readonly realizedFxPnlEur: number;
  readonly feesPaidEur: number;
  readonly fxCostsPaidEur: number;
  readonly dividendsNetEur: number;
  readonly withholdingEur: number;
  /** Gross EUR notional traded, both sides. Feeds turnover. */
  readonly turnoverEur: number;
  readonly pendingOrders: ReadonlyMap<OrderId, PendingOrder>;
  readonly realizedTrades: readonly RealizedTrade[];
  readonly marks: readonly ValuationMark[];
  readonly flows: readonly CashFlow[];
  readonly counters: PortfolioCounters;
  readonly firstEventTs: IsoTimestamp | null;
  readonly lastEventTs: IsoTimestamp | null;
}

export interface ReplayOptions {
  /**
   * The whitelist from `config/universe.yaml`. When supplied, fills and
   * positions outside it are reported (SPEC 1.6). When omitted, the whitelist
   * invariant is simply not checked.
   */
  readonly universe?: Iterable<Ticker>;
  /** Tolerance in EUR for arithmetic cross-checks. Default one cent. */
  readonly eurTolerance?: number;
}

export interface ReplayResult {
  readonly portfolios: ReadonlyMap<PortfolioId, PortfolioState>;
  readonly violations: readonly InvariantViolation[];
  readonly eventCount: number;
  readonly firstEventTs: IsoTimestamp | null;
  readonly lastEventTs: IsoTimestamp | null;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  return Math.round(
    (Date.parse(`${dateOf(to)}T00:00:00Z`) -
      Date.parse(`${dateOf(from)}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

/** Mutable working copy of a portfolio, collapsed into a PortfolioState at the end. */
interface Draft {
  portfolio: PortfolioId;
  cashEur: number;
  positions: Map<Ticker, Position>;
  contributedToDateEur: number;
  realizedPnlEur: number;
  realizedPricePnlEur: number;
  realizedFxPnlEur: number;
  feesPaidEur: number;
  fxCostsPaidEur: number;
  dividendsNetEur: number;
  withholdingEur: number;
  turnoverEur: number;
  pendingOrders: Map<OrderId, PendingOrder>;
  placedOrders: Map<OrderId, OrderPlacedEvent>;
  realizedTrades: RealizedTrade[];
  marks: ValuationMark[];
  flows: CashFlow[];
  counters: {
    ordersPlaced: number;
    ordersFilled: number;
    ordersRejected: number;
    holds: number;
    skips: number;
    deposits: number;
    splits: number;
    dividends: number;
  };
  firstEventTs: IsoTimestamp | null;
  lastEventTs: IsoTimestamp | null;
}

function newDraft(portfolio: PortfolioId): Draft {
  return {
    portfolio,
    cashEur: 0,
    positions: new Map(),
    contributedToDateEur: 0,
    realizedPnlEur: 0,
    realizedPricePnlEur: 0,
    realizedFxPnlEur: 0,
    feesPaidEur: 0,
    fxCostsPaidEur: 0,
    dividendsNetEur: 0,
    withholdingEur: 0,
    turnoverEur: 0,
    pendingOrders: new Map(),
    placedOrders: new Map(),
    realizedTrades: [],
    marks: [],
    flows: [],
    counters: {
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersRejected: 0,
      holds: 0,
      skips: 0,
      deposits: 0,
      splits: 0,
      dividends: 0,
    },
    firstEventTs: null,
    lastEventTs: null,
  };
}

/**
 * Fold the log into per-portfolio state.
 *
 * Every portfolio in the log gets its own state; they never share cash and
 * never see each other (SPEC 5).
 */
export function replay(
  events: readonly LedgerEvent[],
  options: ReplayOptions = {},
): ReplayResult {
  const universe = options.universe ? new Set(options.universe) : null;
  const tolerance = options.eurTolerance ?? 0.01;
  const drafts = new Map<PortfolioId, Draft>();
  const violations: InvariantViolation[] = [];
  const seenIds = new Set<string>();
  let firstEventTs: IsoTimestamp | null = null;
  let lastEventTs: IsoTimestamp | null = null;

  const flag = (
    code: ViolationCode,
    event: LedgerEvent,
    message: string,
  ): void => {
    violations.push({
      code,
      message,
      portfolio: event.portfolio,
      eventId: event.id,
      ts: event.ts,
    });
  };

  for (const event of events) {
    if (seenIds.has(event.id)) {
      flag("DUPLICATE_EVENT_ID", event, `event id "${event.id}" appears twice`);
    }
    seenIds.add(event.id);
    firstEventTs ??= event.ts;
    lastEventTs = event.ts;

    let draft = drafts.get(event.portfolio);
    if (draft === undefined) {
      draft = newDraft(event.portfolio);
      drafts.set(event.portfolio, draft);
    }
    // Ordering is checked per portfolio: that is where causality lives (an
    // order before its fill). The engine is free to write a day's events
    // portfolio by portfolio rather than strictly interleaved by timestamp.
    if (draft.lastEventTs !== null && event.ts < draft.lastEventTs) {
      flag(
        "EVENTS_OUT_OF_ORDER",
        event,
        `ts ${event.ts} precedes this portfolio's previous event ts ${draft.lastEventTs}`,
      );
    }
    draft.firstEventTs ??= event.ts;
    draft.lastEventTs = event.ts;

    switch (event.type) {
      case "DEPOSIT": {
        draft.cashEur = eur(draft.cashEur + event.amountEur);
        draft.contributedToDateEur = eur(
          draft.contributedToDateEur + event.amountEur,
        );
        draft.flows.push({
          date: dateOf(event.ts),
          ts: event.ts,
          amountEur: eur(event.amountEur),
        });
        draft.counters.deposits += 1;
        break;
      }
      case "ORDER_PLACED": {
        draft.pendingOrders.set(event.id, { order: event });
        draft.placedOrders.set(event.id, event);
        draft.counters.ordersPlaced += 1;
        if (universe && !universe.has(event.ticker)) {
          flag(
            "ORDER_OFF_WHITELIST",
            event,
            `order for "${event.ticker}", which is not in the universe`,
          );
        }
        break;
      }
      case "ORDER_FILLED": {
        applyFill(draft, event, flag, universe, tolerance);
        break;
      }
      case "ORDER_REJECTED": {
        // A rejected order never reaches a balance (SPEC 1.6); it only clears
        // any queue entry and is kept for audit.
        draft.pendingOrders.delete(event.orderId);
        draft.counters.ordersRejected += 1;
        break;
      }
      case "HOLD": {
        draft.counters.holds += 1;
        break;
      }
      case "DIVIDEND": {
        applyDividend(draft, event, flag, tolerance);
        break;
      }
      case "SPLIT": {
        const position = draft.positions.get(event.ticker);
        if (position !== undefined && position.qty > 0) {
          draft.positions.set(event.ticker, {
            ...position,
            qty: roundQty(position.qty * event.ratio),
            lastTradeTs: position.lastTradeTs,
          });
        }
        draft.counters.splits += 1;
        break;
      }
      case "VALUATION": {
        checkValuation(draft, event, flag, tolerance);
        draft.marks.push({
          date: dateOf(event.ts),
          ts: event.ts,
          cashEur: eur(event.cashEur),
          marketValueEur: eur(event.marketValueEur),
          totalValueEur: eur(event.cashEur + event.marketValueEur),
          fxEffectEur: eur(event.fxEffectEur),
          contributedToDateEur: eur(event.contributedToDateEur),
        });
        break;
      }
      case "SKIPPED": {
        draft.counters.skips += 1;
        break;
      }
    }

    if (draft.cashEur < -tolerance) {
      flag(
        "CASH_NEGATIVE",
        event,
        `cash fell to ${draft.cashEur.toFixed(2)} EUR`,
      );
    }
  }

  if (universe) {
    for (const draft of drafts.values()) {
      for (const position of draft.positions.values()) {
        if (position.qty > 0 && !universe.has(position.ticker)) {
          violations.push({
            code: "POSITION_OFF_WHITELIST",
            message: `holds ${position.qty} of "${position.ticker}", which is not in the universe`,
            portfolio: draft.portfolio,
          });
        }
      }
    }
  }

  const portfolios = new Map<PortfolioId, PortfolioState>();
  for (const [id, draft] of drafts) {
    portfolios.set(id, freeze(draft));
  }

  return {
    portfolios,
    violations,
    eventCount: events.length,
    firstEventTs,
    lastEventTs,
  };
}

/** Replay a single portfolio's slice of the log (SPEC 4's `replay(events)`). */
export function replayPortfolio(
  events: readonly LedgerEvent[],
  portfolio: PortfolioId,
  options: ReplayOptions = {},
): PortfolioState {
  const result = replay(
    events.filter((event) => event.portfolio === portfolio),
    options,
  );
  return result.portfolios.get(portfolio) ?? freeze(newDraft(portfolio));
}

type Flag = (code: ViolationCode, event: LedgerEvent, message: string) => void;

function applyFill(
  draft: Draft,
  event: OrderFilledEvent,
  flag: Flag,
  universe: Set<Ticker> | null,
  tolerance: number,
): void {
  draft.counters.ordersFilled += 1;

  const placed = draft.placedOrders.get(event.orderId);
  if (placed === undefined) {
    flag(
      "FILL_WITHOUT_ORDER",
      event,
      `fill references orderId "${event.orderId}", which was never placed`,
    );
  } else {
    if (!draft.pendingOrders.delete(event.orderId)) {
      flag(
        "FILL_WITHOUT_ORDER",
        event,
        `order "${event.orderId}" was already filled or rejected`,
      );
    }
    // SPEC 1.1: a decision taken on day T may only be filled on day T+1.
    if (dateOf(event.ts) <= dateOf(placed.ts)) {
      flag(
        "FILL_NOT_AFTER_DECISION",
        event,
        `fill on ${dateOf(event.ts)} is not strictly after the decision of ${dateOf(placed.ts)}`,
      );
    }
    if (placed.ticker !== event.ticker || placed.side !== event.side) {
      flag(
        "FILL_AMOUNTS_INCONSISTENT",
        event,
        `fill ${event.side} ${event.ticker} does not match order ${placed.side} ${placed.ticker}`,
      );
    }
  }

  if (universe && !universe.has(event.ticker)) {
    flag(
      "ORDER_OFF_WHITELIST",
      event,
      `fill for "${event.ticker}", which is not in the universe`,
    );
  }

  const grossExpected = toEur(event.qty * event.priceLocal, event.fxRate);
  if (!eurEquals(grossExpected, event.grossEur, tolerance)) {
    flag(
      "FILL_AMOUNTS_INCONSISTENT",
      event,
      `grossEur ${event.grossEur} != qty x priceLocal / fxRate (${grossExpected.toFixed(4)})`,
    );
  }
  const netExpected =
    event.side === "buy"
      ? event.grossEur + event.feeEur + event.fxCostEur
      : event.grossEur - event.feeEur - event.fxCostEur;
  if (!eurEquals(netExpected, event.netEur, tolerance)) {
    flag(
      "FILL_AMOUNTS_INCONSISTENT",
      event,
      `netEur ${event.netEur} != gross ${event.side === "buy" ? "+" : "-"} costs (${netExpected.toFixed(4)})`,
    );
  }

  draft.feesPaidEur = eur(draft.feesPaidEur + event.feeEur);
  draft.fxCostsPaidEur = eur(draft.fxCostsPaidEur + event.fxCostEur);
  draft.turnoverEur = eur(draft.turnoverEur + event.grossEur);

  const existing = draft.positions.get(event.ticker);
  if (existing !== undefined && existing.currency !== event.currency) {
    flag(
      "FILL_CURRENCY_MISMATCH",
      event,
      `fill in ${event.currency} but position is held in ${existing.currency}`,
    );
  }

  if (event.side === "buy") {
    draft.cashEur = eur(draft.cashEur - event.netEur);
    const base: Position = existing ?? {
      ticker: event.ticker,
      currency: event.currency,
      qty: 0,
      costBasisEur: 0,
      grossCostEur: 0,
      localCostBasis: 0,
      feesEur: 0,
      fxCostsEur: 0,
      openedTs: event.ts,
      lastTradeTs: event.ts,
    };
    draft.positions.set(event.ticker, {
      ...base,
      qty: roundQty(base.qty + event.qty),
      costBasisEur: eur(base.costBasisEur + event.netEur),
      grossCostEur: eur(base.grossCostEur + event.grossEur),
      localCostBasis: base.localCostBasis + event.qty * event.priceLocal,
      feesEur: eur(base.feesEur + event.feeEur),
      fxCostsEur: eur(base.fxCostsEur + event.fxCostEur),
      openedTs: base.qty > 0 ? base.openedTs : event.ts,
      lastTradeTs: event.ts,
    });
    return;
  }

  // Sell.
  draft.cashEur = eur(draft.cashEur + event.netEur);
  if (existing === undefined || existing.qty <= 0) {
    flag(
      "QTY_NEGATIVE",
      event,
      `sold ${event.qty} of "${event.ticker}" while holding none`,
    );
    return;
  }
  if (event.qty > existing.qty + 1e-9) {
    flag(
      "QTY_NEGATIVE",
      event,
      `sold ${event.qty} of "${event.ticker}" while holding ${existing.qty}`,
    );
  }

  const soldQty = Math.min(event.qty, existing.qty);
  const fraction = existing.qty === 0 ? 0 : soldQty / existing.qty;
  const costRemoved = eur(existing.costBasisEur * fraction);
  const grossCostRemoved = existing.grossCostEur * fraction;
  const localCostRemoved = existing.localCostBasis * fraction;
  const entryFeesRemoved = eur(
    (existing.feesEur + existing.fxCostsEur) * fraction,
  );

  // Exact decomposition: price P&L is held at the entry FX rate, FX P&L at the
  // exit price, and the two sum to the gross EUR move (SPEC 4).
  const entryPriceLocal = soldQty === 0 ? 0 : localCostRemoved / soldQty;
  const entryFxRate =
    grossCostRemoved === 0 ? event.fxRate : localCostRemoved / grossCostRemoved;
  const pricePnl = toEur(
    soldQty * (event.priceLocal - entryPriceLocal),
    entryFxRate,
  );
  const fxPnl =
    soldQty * event.priceLocal * (1 / event.fxRate - 1 / entryFxRate);
  const proceeds = event.netEur;
  const realized = eur(proceeds - costRemoved);

  draft.realizedPnlEur = eur(draft.realizedPnlEur + realized);
  draft.realizedPricePnlEur = eur(draft.realizedPricePnlEur + pricePnl);
  draft.realizedFxPnlEur = eur(draft.realizedFxPnlEur + fxPnl);
  draft.realizedTrades.push({
    ticker: event.ticker,
    qty: roundQty(soldQty),
    openedTs: existing.openedTs,
    closedTs: event.ts,
    holdingDays: daysBetween(existing.openedTs, event.ts),
    costEur: costRemoved,
    proceedsEur: eur(proceeds),
    realizedPnlEur: realized,
    pricePnlEur: eur(pricePnl),
    fxPnlEur: eur(fxPnl),
    feesEur: eur(entryFeesRemoved + event.feeEur + event.fxCostEur),
    closedByOrderId: event.orderId,
  });

  const remainingQty = roundQty(existing.qty - soldQty);
  if (remainingQty <= 0) {
    draft.positions.delete(event.ticker);
    return;
  }
  draft.positions.set(event.ticker, {
    ...existing,
    qty: remainingQty,
    costBasisEur: eur(existing.costBasisEur - costRemoved),
    grossCostEur: eur(existing.grossCostEur - grossCostRemoved),
    localCostBasis: existing.localCostBasis - localCostRemoved,
    feesEur: eur(existing.feesEur * (1 - fraction)),
    fxCostsEur: eur(existing.fxCostsEur * (1 - fraction)),
    lastTradeTs: event.ts,
  });
}

function applyDividend(
  draft: Draft,
  event: DividendEvent,
  flag: Flag,
  tolerance: number,
): void {
  const grossEur = toEur(event.amountLocal, event.fxRate);
  const netExpected = grossEur - event.withholdingEur;
  if (!eurEquals(netExpected, event.netEur, tolerance)) {
    flag(
      "FILL_AMOUNTS_INCONSISTENT",
      event,
      `dividend netEur ${event.netEur} != gross ${grossEur.toFixed(4)} - withholding ${event.withholdingEur}`,
    );
  }
  draft.cashEur = eur(draft.cashEur + event.netEur);
  draft.dividendsNetEur = eur(draft.dividendsNetEur + event.netEur);
  draft.withholdingEur = eur(draft.withholdingEur + event.withholdingEur);
  draft.counters.dividends += 1;
}

/**
 * Cross-check a written mark against the replayed state. A VALUATION event is
 * a cache line: if it disagrees with the fold, the cache is wrong, not the fold.
 */
function checkValuation(
  draft: Draft,
  event: ValuationEvent,
  flag: Flag,
  tolerance: number,
): void {
  if (!eurEquals(event.cashEur, draft.cashEur, tolerance)) {
    flag(
      "VALUATION_MISMATCH",
      event,
      `mark says cash ${event.cashEur}, replay says ${draft.cashEur}`,
    );
  }
  if (!eurEquals(event.contributedToDateEur, draft.contributedToDateEur, tolerance)) {
    flag(
      "VALUATION_MISMATCH",
      event,
      `mark says contributed ${event.contributedToDateEur}, replay says ${draft.contributedToDateEur}`,
    );
  }

  let sum = 0;
  for (const line of event.positions) {
    const expected = toEur(line.qty * line.priceLocal, line.fxRate);
    if (!eurEquals(expected, line.valueEur, tolerance)) {
      flag(
        "VALUATION_MISMATCH",
        event,
        `${line.ticker}: valueEur ${line.valueEur} != qty x price / fx (${expected.toFixed(4)})`,
      );
    }
    sum += line.valueEur;
    const held = draft.positions.get(line.ticker);
    if (held === undefined) {
      flag(
        "VALUATION_MISMATCH",
        event,
        `mark lists "${line.ticker}", which the replay does not hold`,
      );
    } else if (Math.abs(held.qty - line.qty) > 1e-4) {
      flag(
        "VALUATION_MISMATCH",
        event,
        `${line.ticker}: mark says ${line.qty} shares, replay says ${held.qty}`,
      );
    }
  }
  for (const held of draft.positions.values()) {
    if (held.qty > 0 && !event.positions.some((p) => p.ticker === held.ticker)) {
      flag(
        "VALUATION_MISMATCH",
        event,
        `replay holds "${held.ticker}", which the mark omits`,
      );
    }
  }
  if (!eurEquals(sum, event.marketValueEur, tolerance)) {
    flag(
      "VALUATION_MISMATCH",
      event,
      `marketValueEur ${event.marketValueEur} != sum of position values (${sum.toFixed(4)})`,
    );
  }
}

function freeze(draft: Draft): PortfolioState {
  return {
    portfolio: draft.portfolio,
    cashEur: draft.cashEur,
    positions: new Map(draft.positions),
    contributedToDateEur: draft.contributedToDateEur,
    realizedPnlEur: draft.realizedPnlEur,
    realizedPricePnlEur: draft.realizedPricePnlEur,
    realizedFxPnlEur: draft.realizedFxPnlEur,
    feesPaidEur: draft.feesPaidEur,
    fxCostsPaidEur: draft.fxCostsPaidEur,
    dividendsNetEur: draft.dividendsNetEur,
    withholdingEur: draft.withholdingEur,
    turnoverEur: draft.turnoverEur,
    pendingOrders: new Map(draft.pendingOrders),
    realizedTrades: [...draft.realizedTrades],
    marks: [...draft.marks],
    flows: [...draft.flows],
    counters: { ...draft.counters },
    firstEventTs: draft.firstEventTs,
    lastEventTs: draft.lastEventTs,
  };
}
