/**
 * The daily run (SPEC 8).
 *
 * The sequence, in the order SPEC 8 states it:
 *
 *   1. Fill pending orders from the previous run, at today's open.
 *   2. Apply corporate actions — dividends net of withholding, splits.
 *   3. Apply deposits — 100 EUR on the very first run, 50 EUR on the first
 *      trading day of each subsequent month.
 *   4. Build the brief.
 *   5. Run the controls, then the agents.
 *   6. Validate and queue the resulting orders.
 *   7. Write the valuation mark.
 *
 * (4 happens first in wall-clock terms, because the brief *is* the price fetch
 * and nothing can be filled or marked without it. The ledger still records the
 * seven steps in SPEC 8's order, which is the order that matters.)
 *
 * This function performs no file I/O. It takes the existing log and returns
 * the events the session produced; the CLI appends them, writes the brief and
 * commits. That is what lets the whole engine — deposits, fills, guardrails,
 * corporate actions — be driven across a hundred simulated sessions in a unit
 * test with nothing plugged in.
 *
 * **State is never computed here.** After every event it emits, the engine
 * re-derives the portfolio by replaying its log (SPEC 1.3). It is a little
 * wasteful and completely worth it: there is exactly one implementation of
 * what a fill does to a balance, and `pnpm verify` checks the same one.
 */
import type { Clock } from "../domain/clock.js";
import type { LedgerEvent } from "../domain/events.js";
import { eur } from "../domain/money.js";
import { replayPortfolio, type PortfolioState } from "../domain/replay.js";
import { dateOf } from "../domain/types.js";
import type { IsoDate, IsoTimestamp, PortfolioId, Ticker } from "../domain/types.js";
import { buildValuationPayload, valuePortfolio } from "../domain/valuation.js";
import type { FeedsDocument } from "../data/feeds.js";
import type { CorporateAction, MarketDataPort } from "../data/port.js";
import type { FeedReaderPort } from "../data/rss.js";
import { isSkipCondition, skipReasonFor } from "../data/skip.js";
import type { Universe } from "../data/universe.js";
import { buildBrief } from "../brief/build.js";
import type { BriefDocument, PriceSnapshotFile } from "../brief/types.js";
import { applyCorporateActions, actionWindow } from "./corporate.js";
import type { PortfolioConfig, Portfolios, SimulationConfig } from "./config.js";
import {
  buildDecisionRecord,
  parseDecision,
  splitOutcome,
  type Decider,
  type DecisionContext,
  type DecisionRecord,
  type OrderOutcome,
} from "./decision.js";
import { depositFor } from "./deposits.js";
import { fillOrder } from "./fills.js";
import { SessionPrices } from "./pricing.js";
import { validateOrders } from "./validate.js";
import { decisionId, IdSequencer } from "./ids.js";

/**
 * Deterministic times-of-day for each stage, UTC.
 *
 * Events are stamped from the *session* rather than from the wall clock. The
 * ledger's causality is about which session an event belongs to, and pinning
 * the timestamps to the session makes a rerun of a day byte-identical to the
 * first run of it — which is what SPEC 14's "rebuilding from `events.jsonl`
 * produces a byte-identical file" asks for, and what stops a retried Actions
 * job from producing a second, slightly different copy of the day.
 *
 * The real instants are not lost: the brief carries `generatedAt` and every
 * decision record carries `decidedAt`.
 */
const STAGE_TIME = {
  /**
   * A skip is stamped at the *start* of its day, before every other stage.
   *
   * It reads backwards — the run that skips happens in the evening — but these
   * are ordering devices, not instants, and ordering is the whole job here. A
   * day that skips and is later re-run successfully (the data source came
   * back, a bug was fixed) would otherwise have its deposit at 09:30 land
   * behind a skip already recorded at 22:30, and the log would replay out of
   * order. Stamped first, the skip simply precedes the session that
   * superseded it, and the ledger honestly shows both.
   */
  skipped: "00:30:00.000Z",
  fill: "08:00:00.000Z",
  corporate: "09:00:00.000Z",
  deposit: "09:30:00.000Z",
  decision: "21:00:00.000Z",
  valuation: "22:00:00.000Z",
} as const;

type Stage = keyof typeof STAGE_TIME;

function stamp(date: IsoDate, stage: Stage): IsoTimestamp {
  return `${date}T${STAGE_TIME[stage]}`;
}

export type RunStatus =
  /** The session ran and produced a mark for every active portfolio. */
  | "completed"
  /** SPEC 1.5: data failure or stale prices. SKIPPED for every portfolio. */
  | "skipped"
  /** SPEC 13: no new close, so the market was shut. Nothing was written. */
  | "no_new_session"
  /** This session is already in the log. A retried job writes nothing twice. */
  | "already_recorded";

export interface RunDailyOptions {
  readonly universe: Universe;
  readonly portfolios: Portfolios;
  readonly simulation: SimulationConfig;
  readonly feeds: FeedsDocument;
  readonly market: MarketDataPort;
  readonly feedReader: FeedReaderPort;
  readonly clock: Clock;
  /** One decider per active portfolio, by key. */
  readonly deciders: ReadonlyMap<PortfolioId, Decider>;
  /** The whole existing `events.jsonl`. */
  readonly history: readonly LedgerEvent[];
  /** Pin the session instead of deriving it from the quotes. Tests and replays. */
  readonly sessionDate?: IsoDate;
}

export interface PortfolioRunSummary {
  readonly portfolio: PortfolioId;
  readonly filled: number;
  readonly rejected: number;
  readonly placed: number;
  readonly held: boolean;
  readonly deferred: number;
  readonly depositedEur: number;
  readonly dividends: number;
  readonly splits: number;
  readonly totalValueEur: number;
}

export interface RunDailyResult {
  readonly status: RunStatus;
  readonly sessionDate: IsoDate | null;
  /** Events this session produced, in the order they must be appended. */
  readonly events: readonly LedgerEvent[];
  readonly brief: BriefDocument | null;
  readonly prices: PriceSnapshotFile | null;
  readonly decisions: readonly DecisionRecord[];
  readonly portfolios: readonly PortfolioRunSummary[];
  /** Why the run skipped, when it did. */
  readonly skipReason: string | null;
  readonly notes: readonly string[];
}

/**
 * A portfolio's slice of the log, with state re-derived on every append.
 *
 * The engine holds no balances of its own. `state` is always the result of
 * replaying everything written so far, so the numbers the validator sees are
 * exactly the numbers `pnpm verify` will re-derive from the committed file.
 */
class PortfolioLedger {
  private events: LedgerEvent[];
  state: PortfolioState;

  constructor(
    readonly portfolio: PortfolioId,
    history: readonly LedgerEvent[],
    private readonly universe: Universe,
  ) {
    this.events = history.filter((event) => event.portfolio === portfolio);
    this.state = this.derive();
  }

  /** Events this session added, in append order. */
  readonly appended: LedgerEvent[] = [];

  append(event: LedgerEvent): void {
    this.events.push(event);
    this.appended.push(event);
    this.state = this.derive();
  }

  private derive(): PortfolioState {
    return replayPortfolio(this.events, this.portfolio, {
      universe: this.universe.tickers,
    });
  }
}

/** Run one session. Returns what to write; writes nothing itself. */
export async function runDaily(options: RunDailyOptions): Promise<RunDailyResult> {
  const { universe, portfolios, market, clock } = options;
  const active = portfolios.active;
  const notes: string[] = [];

  // --- Step 4, hoisted: the brief is the price fetch -----------------------
  let brief: BriefDocument;
  let priceFile: PriceSnapshotFile;
  try {
    const built = await buildBrief({
      universe,
      feeds: options.feeds,
      market,
      feedReader: options.feedReader,
      clock,
      ...(options.sessionDate ? { sessionDate: options.sessionDate } : {}),
    });
    brief = built.brief;
    priceFile = built.prices;
  } catch (error) {
    if (!isSkipCondition(error)) throw error;
    // SPEC 1.5: "the run logs a SKIPPED event for every portfolio and exits 0".
    return skippedRun(options, skipReasonFor(error), (error as Error).message);
  }

  const sessionDate = brief.date;
  const prices = new SessionPrices(brief);

  // --- SPEC 13: a market holiday is "no new close", not a hardcoded calendar
  const lastRecorded = lastSessionIn(options.history);
  if (lastRecorded !== null && sessionDate <= lastRecorded) {
    if (hasSessionFor(options.history, sessionDate, active)) {
      return {
        status: "already_recorded",
        sessionDate,
        events: [],
        brief,
        prices: priceFile,
        decisions: [],
        portfolios: [],
        skipReason: null,
        notes: [`${sessionDate} is already in the ledger; nothing was written`],
      };
    }
    return {
      status: "no_new_session",
      sessionDate,
      events: [],
      brief,
      prices: priceFile,
      decisions: [],
      portfolios: [],
      skipReason: "no_new_close",
      notes: [
        `newest close is ${sessionDate}, not after the last recorded session ${lastRecorded}: the market was shut`,
      ],
    };
  }

  // --- Corporate actions, fetched once for every ticker anyone holds -------
  let actionsByTicker: ReadonlyMap<Ticker, readonly CorporateAction[]>;
  try {
    actionsByTicker = await fetchCorporateActions(options, sessionDate);
  } catch (error) {
    if (!isSkipCondition(error)) throw error;
    // A dividend that cannot be fetched is a dividend that would be lost: the
    // window closes behind the mark this session would write. Skipping keeps
    // it in the window for the next run.
    return skippedRun(options, skipReasonFor(error), (error as Error).message);
  }

  const ids = new IdSequencer(sessionDate);
  const events: LedgerEvent[] = [];
  const decisions: DecisionRecord[] = [];
  const summaries: PortfolioRunSummary[] = [];

  for (const portfolio of active) {
    const summary = await runPortfolio({
      portfolio,
      options,
      brief,
      prices,
      sessionDate,
      ids,
      actionsByTicker,
      decisions,
      events,
      notes,
    });
    summaries.push(summary);
  }

  return {
    status: "completed",
    sessionDate,
    events,
    brief,
    prices: priceFile,
    decisions,
    portfolios: summaries,
    skipReason: null,
    notes,
  };
}

interface PortfolioRunInput {
  readonly portfolio: PortfolioConfig;
  readonly options: RunDailyOptions;
  readonly brief: BriefDocument;
  readonly prices: SessionPrices;
  readonly sessionDate: IsoDate;
  readonly ids: IdSequencer;
  readonly actionsByTicker: ReadonlyMap<Ticker, readonly CorporateAction[]>;
  readonly decisions: DecisionRecord[];
  readonly events: LedgerEvent[];
  readonly notes: string[];
}

async function runPortfolio(input: PortfolioRunInput): Promise<PortfolioRunSummary> {
  const { portfolio, options, brief, prices, sessionDate, ids, events, notes } = input;
  const { universe, simulation } = options;
  const key = portfolio.key;
  const ledger = new PortfolioLedger(key, options.history, universe);

  let filled = 0;
  let rejected = 0;
  let deferred = 0;

  // --- 1. Fill pending orders at today's open ------------------------------
  //
  // Sorted by order id, which sorts by date then sequence: the queue is served
  // oldest first, so an order that has waited does not lose its cash to one
  // placed yesterday.
  const pending = [...ledger.state.pendingOrders.values()]
    .map((entry) => entry.order)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const order of pending) {
    const outcome = fillOrder({
      order,
      state: ledger.state,
      prices,
      universe,
      simulation,
      guardrails: portfolio.guardrails,
      sessionDate,
    });

    if (outcome.kind === "deferred") {
      deferred += 1;
      notes.push(`[${key}] ${order.id} deferred: ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "rejected") {
      rejected += 1;
      ledger.append({
        id: ids.next(key, "rejection"),
        ts: stamp(sessionDate, "fill"),
        portfolio: key,
        type: "ORDER_REJECTED",
        orderId: order.id,
        reasonCode: outcome.reasonCode,
        detail: outcome.detail,
      });
      continue;
    }

    filled += 1;
    ledger.append({
      id: ids.next(key, "fill"),
      ts: stamp(sessionDate, "fill"),
      portfolio: key,
      type: "ORDER_FILLED",
      orderId: order.id,
      ticker: order.ticker,
      side: order.side,
      qty: outcome.terms.qty,
      priceLocal: outcome.terms.priceLocal,
      currency: outcome.terms.currency,
      fxRate: outcome.terms.fxRate,
      grossEur: outcome.terms.grossEur,
      feeEur: outcome.terms.feeEur,
      fxCostEur: outcome.terms.fxCostEur,
      netEur: outcome.terms.netEur,
    });
  }

  // --- 2. Corporate actions ------------------------------------------------
  const window = actionWindow(ledger.state, sessionDate);
  const relevant: CorporateAction[] = [];
  for (const ticker of ledger.state.positions.keys()) {
    for (const action of input.actionsByTicker.get(ticker) ?? []) {
      if (action.date >= window.from && action.date <= window.to) relevant.push(action);
    }
  }
  const corporate = applyCorporateActions(ledger.state, relevant, prices, simulation);
  for (const skip of corporate.skipped) {
    notes.push(`[${key}] ${skip.action.kind} on ${skip.action.ticker} skipped: ${skip.reason}`);
  }
  for (const dividend of corporate.dividends) {
    ledger.append({
      id: ids.next(key, "dividend"),
      ts: stamp(sessionDate, "corporate"),
      portfolio: key,
      type: "DIVIDEND",
      ticker: dividend.ticker,
      amountLocal: dividend.amountLocal,
      currency: dividend.currency,
      fxRate: dividend.fxRate,
      withholdingEur: dividend.withholdingEur,
      netEur: dividend.netEur,
    });
  }
  for (const split of corporate.splits) {
    ledger.append({
      id: ids.next(key, "split"),
      ts: stamp(sessionDate, "corporate"),
      portfolio: key,
      type: "SPLIT",
      ticker: split.ticker,
      ratio: split.ratio,
    });
  }

  // --- 3. Deposits ---------------------------------------------------------
  const deposit = depositFor(ledger.state, sessionDate, simulation);
  if (deposit !== null) {
    ledger.append({
      id: ids.next(key, "deposit"),
      ts: stamp(sessionDate, "deposit"),
      portfolio: key,
      type: "DEPOSIT",
      amountEur: deposit.amountEur,
    });
  }

  // --- 5/6. Decide, validate, queue ---------------------------------------
  const decisionKey = decisionId(sessionDate, key);
  const closingQuotes = prices.closingQuotes(ledger.state.positions.keys());
  const valuationBeforeOrders = valuePortfolio(ledger.state, closingQuotes);

  const context: DecisionContext = {
    portfolio,
    state: ledger.state,
    brief,
    prices,
    universe,
    simulation,
    sessionDate,
    availableCashEur: eur(ledger.state.cashEur - portfolio.guardrails.cashFloorEur),
    depositedTodayEur: deposit?.amountEur ?? 0,
    tradesThisMonth: tradesInMonth(options.history, key, sessionDate),
  };

  const decider = options.deciders.get(key);
  if (decider === undefined) {
    throw new Error(`no decider registered for active portfolio "${key}"`);
  }
  const outcome = splitOutcome(await decider.decide(context));

  // Every decider's output goes through the same zod gate before the engine
  // acts on it (SPEC 7: "validated with zod before anything touches the
  // ledger"). A control cannot really fail this and an agent absolutely can —
  // which is the point of there being exactly one gate rather than a lenient
  // path for the code we wrote and a strict one for the code we did not.
  const decision = parseDecision(outcome.decision, key);

  const verdicts = validateOrders({
    portfolio,
    state: ledger.state,
    universe,
    simulation,
    prices,
    sessionDate,
    orders: decision.orders,
    tradesThisMonth: context.tradesThisMonth,
    totalValueEur: valuationBeforeOrders.totalValueEur,
  });

  const outcomes: OrderOutcome[] = [];
  let placed = 0;
  for (const verdict of verdicts) {
    const order = verdict.order;
    if (verdict.status === "rejected") {
      // SPEC 1.6: rejected, logged with the reason, never reaching a balance.
      const id = ids.next(key, "order");
      rejected += 1;
      outcomes.push({
        orderId: id,
        ticker: order.ticker,
        side: order.side,
        targetEur: order.targetEur,
        thesis: order.thesis,
        invalidation: order.invalidation,
        status: "rejected",
        reasonCode: verdict.reasonCode,
        detail: verdict.detail,
      });
      ledger.append({
        id: ids.next(key, "rejection"),
        ts: stamp(sessionDate, "decision"),
        portfolio: key,
        type: "ORDER_REJECTED",
        orderId: id,
        reasonCode: verdict.reasonCode,
        detail: verdict.detail,
      });
      continue;
    }

    const id = ids.next(key, "order");
    placed += 1;
    outcomes.push({
      orderId: id,
      ticker: order.ticker,
      side: order.side,
      targetEur: order.targetEur,
      thesis: order.thesis,
      invalidation: order.invalidation,
      status: "placed",
      reasonCode: null,
      detail: null,
    });
    ledger.append({
      id,
      ts: stamp(sessionDate, "decision"),
      portfolio: key,
      type: "ORDER_PLACED",
      decisionId: decisionKey,
      ticker: order.ticker,
      side: order.side,
      targetEur: order.targetEur,
      reason: order.thesis,
    });
  }

  const held = decision.action === "hold";
  if (held) {
    ledger.append({
      id: ids.next(key, "hold"),
      ts: stamp(sessionDate, "decision"),
      portfolio: key,
      type: "HOLD",
      decisionId: decisionKey,
      reason: decision.rationale,
    });
  }

  input.decisions.push(
    buildDecisionRecord({
      decisionId: decisionKey,
      portfolio,
      date: sessionDate,
      decidedAt: options.clock.nowIso(),
      briefHash: brief.briefHash,
      decision,
      outcomes,
      meta: {
        availableCashEur: context.availableCashEur,
        depositedTodayEur: context.depositedTodayEur,
        tradesThisMonth: context.tradesThisMonth,
        portfolioValueEur: valuationBeforeOrders.totalValueEur,
        // Whatever the decider itself wants on the record: the RNG draw for
        // `random`, the model, tokens, cost, prompt and search archive for an
        // agent (SPEC 7). Spread last so a decider can never overwrite the
        // engine's own numbers with its own account of them.
        ...outcome.meta,
      },
    }),
  );

  // --- 7. The daily mark ---------------------------------------------------
  //
  // Written every trading day, including days with no activity (SPEC 4). The
  // quotes are re-read after the day's events because a split changes the
  // share count the mark is taken on.
  const finalQuotes = prices.closingQuotes(ledger.state.positions.keys());
  const valuation = valuePortfolio(ledger.state, finalQuotes);
  if (valuation.missingQuotes.length > 0) {
    // A held instrument with no price at all would be silently dropped from the
    // mark, and the mark would then disagree with the replay. Better to fail
    // the run loudly than to commit a ledger that cannot be verified.
    throw new Error(
      `[${key}] no price for held instrument(s) ${valuation.missingQuotes.join(", ")} on ${sessionDate}; the mark would not match the ledger`,
    );
  }
  ledger.append({
    id: ids.next(key, "valuation"),
    ts: stamp(sessionDate, "valuation"),
    portfolio: key,
    type: "VALUATION",
    ...buildValuationPayload(valuation),
  });

  events.push(...ledger.appended);

  return {
    portfolio: key,
    filled,
    rejected,
    placed,
    held,
    deferred,
    depositedEur: deposit?.amountEur ?? 0,
    dividends: corporate.dividends.length,
    splits: corporate.splits.length,
    totalValueEur: valuation.totalValueEur,
  };
}

// --- Helpers ----------------------------------------------------------------

/** SPEC 1.5: one SKIPPED per portfolio, and the run exits 0. */
function skippedRun(
  options: RunDailyOptions,
  reason: string,
  detail: string,
): RunDailyResult {
  const date = options.sessionDate ?? options.clock.today();
  const ids = new IdSequencer(date);
  const events: LedgerEvent[] = [];
  const existing = new Set(options.history.map((event) => event.id));

  for (const portfolio of options.portfolios.active) {
    const id = ids.next(portfolio.key, "skipped");
    // A retried run on the same day must not append a second skip.
    if (existing.has(id)) continue;
    events.push({
      id,
      ts: stamp(date, "skipped"),
      portfolio: portfolio.key,
      type: "SKIPPED",
      reason,
    });
  }

  return {
    status: "skipped",
    sessionDate: null,
    events,
    brief: null,
    prices: null,
    decisions: [],
    portfolios: [],
    skipReason: reason,
    notes: [detail],
  };
}

/** The newest session any portfolio has a mark for. */
function lastSessionIn(history: readonly LedgerEvent[]): IsoDate | null {
  let latest: IsoDate | null = null;
  for (const event of history) {
    if (event.type !== "VALUATION") continue;
    const date = dateOf(event.ts);
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/** Whether every active portfolio already has a mark for this session. */
function hasSessionFor(
  history: readonly LedgerEvent[],
  sessionDate: IsoDate,
  active: readonly PortfolioConfig[],
): boolean {
  const marked = new Set<PortfolioId>();
  for (const event of history) {
    if (event.type === "VALUATION" && dateOf(event.ts) === sessionDate) {
      marked.add(event.portfolio);
    }
  }
  return active.every((portfolio) => marked.has(portfolio.key));
}

/** ORDER_PLACED events already recorded this calendar month (SPEC 8 caps). */
function tradesInMonth(
  history: readonly LedgerEvent[],
  portfolio: PortfolioId,
  sessionDate: IsoDate,
): number {
  const month = sessionDate.slice(0, 7);
  return history.filter(
    (event) =>
      event.type === "ORDER_PLACED" &&
      event.portfolio === portfolio &&
      dateOf(event.ts).slice(0, 7) === month,
  ).length;
}

/**
 * Dividends and splits for every instrument any portfolio holds.
 *
 * Fetched once per ticker over the widest window any portfolio needs, then
 * filtered per portfolio: seven portfolios holding the same ETF must not cost
 * seven round trips at an unofficial endpoint.
 */
async function fetchCorporateActions(
  options: RunDailyOptions,
  sessionDate: IsoDate,
): Promise<ReadonlyMap<Ticker, readonly CorporateAction[]>> {
  const held = new Set<Ticker>();
  let earliest = sessionDate;

  for (const portfolio of options.portfolios.active) {
    const state = replayPortfolio(options.history, portfolio.key, {
      universe: options.universe.tickers,
    });
    for (const [ticker, position] of state.positions) {
      if (position.qty > 0) held.add(ticker);
    }
    const window = actionWindow(state, sessionDate);
    if (window.from < earliest) earliest = window.from;
  }

  const byTicker = new Map<Ticker, readonly CorporateAction[]>();
  for (const ticker of [...held].sort()) {
    byTicker.set(
      ticker,
      await options.market.getCorporateActions(ticker, { from: earliest, to: sessionDate }),
    );
  }
  return byTicker;
}
