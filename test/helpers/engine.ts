/**
 * Fixture wiring for the phase 4 tests.
 *
 * The engine takes its configs as text and its ports as parameters, so nothing
 * here needs a filesystem beyond reading the committed config files — and the
 * dry-run scenario, which is itself the fixture the engine is exercised
 * against.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUniverse, type Universe } from "../../src/data/universe.js";
import type { LedgerEvent } from "../../src/domain/events.js";
import { eur } from "../../src/domain/money.js";
import { replayPortfolio, type PortfolioState } from "../../src/domain/replay.js";
import { parseFeeds, type FeedsDocument } from "../../src/data/feeds.js";
import { FixtureFeedReader, FixtureMarketData } from "../../src/data/fixtures.js";
import type { CorporateAction, DailyBar, PriceSnapshot } from "../../src/data/port.js";
import { fixedClock } from "../../src/domain/clock.js";
import { createControls } from "../../src/controls/index.js";
import { runDaily, type RunDailyResult } from "../../src/engine/run.js";
import type { Decider } from "../../src/engine/decision.js";
import {
  parsePortfolios,
  parseSimulation,
  type PortfolioConfig,
  type Portfolios,
  type SimulationConfig,
} from "../../src/engine/config.js";
import { SessionPrices } from "../../src/engine/pricing.js";
import type { BriefDocument, InstrumentBrief } from "../../src/brief/types.js";
import { sealBrief } from "../../src/brief/hash.js";
import { BRIEF_SCHEMA_VERSION } from "../../src/brief/types.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function repoText(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), "utf8");
}

export function liveUniverse(): Universe {
  return parseUniverse(repoText("config", "universe.yaml"));
}

export function liveSimulation(): SimulationConfig {
  return parseSimulation(repoText("config", "simulation.yaml"));
}

export function livePortfolios(): Portfolios {
  return parsePortfolios(repoText("config", "portfolios.yaml"), {
    simulation: liveSimulation(),
  });
}

export function liveFeeds(): FeedsDocument {
  return parseFeeds(repoText("config", "feeds.yaml"), liveUniverse());
}

export function dryRunUniverse(): Universe {
  return parseUniverse(repoText("fixtures", "dry-run", "universe.yaml"));
}

export function portfolio(key: string): PortfolioConfig {
  const found = livePortfolios().get(key);
  if (found === undefined) throw new Error(`no portfolio "${key}" in config`);
  return found;
}

// --- A brief, built by hand ------------------------------------------------

export interface QuoteSpec {
  readonly ticker: string;
  readonly currency?: string;
  readonly open?: number | null;
  readonly close?: number | null;
  readonly previousClose?: number | null;
  /** Set to an older date to make this instrument stale (SPEC 1.5). */
  readonly sessionDate?: string;
}

/**
 * The smallest brief the engine will accept, so a test can state exactly the
 * three prices it cares about instead of threading a whole build through.
 */
export function briefWith(
  date: string,
  quotes: readonly QuoteSpec[],
  options: { readonly eurusd?: number } = {},
): BriefDocument {
  const instruments: Record<string, InstrumentBrief> = {};
  for (const quote of quotes) {
    const close = quote.close ?? null;
    instruments[quote.ticker] = {
      ticker: quote.ticker,
      name: quote.ticker,
      market: "TEST",
      currency: quote.currency ?? "EUR",
      region: "EU",
      type: "equity",
      sector: "technology",
      exposure: null,
      open: quote.open ?? null,
      high: close,
      low: close,
      close,
      previousClose: quote.previousClose ?? null,
      volume: null,
      sessionDate: quote.sessionDate ?? date,
      asOf: `${quote.sessionDate ?? date}T20:00:00.000Z`,
      returns: { d1: null, d5: null, m1: null, m6: null, y1: null },
    };
  }

  const stale = quotes
    .filter((quote) => quote.sessionDate !== undefined && quote.sessionDate !== date)
    .map((quote) => quote.ticker)
    .sort();

  return sealBrief({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    date,
    generatedAt: `${date}T20:30:00.000Z`,
    fx: [
      {
        pair: "EURUSD=X",
        base: "EUR",
        quote: "USD",
        rate: options.eurusd ?? 1.1,
        asOf: `${date}T20:00:00.000Z`,
      },
    ],
    instruments,
    references: [],
    headlines: [],
    earnings: [],
    gaps: { stale, missing: [] },
    sources: [],
  });
}

export function pricesWith(
  date: string,
  quotes: readonly QuoteSpec[],
  options: { readonly eurusd?: number } = {},
): SessionPrices {
  return new SessionPrices(briefWith(date, quotes, options));
}

// --- Ledger state, built from synthetic events ------------------------------

/**
 * Replay a handful of hand-written events into a `PortfolioState`.
 *
 * Tests state the history they want as events rather than constructing a state
 * object, because a state object built by hand can express things the fold
 * cannot produce — and then the test passes against a situation that can never
 * occur.
 */
export function stateFrom(
  portfolio: string,
  events: readonly LedgerEvent[],
): PortfolioState {
  return replayPortfolio(events, portfolio);
}

/** A DEPOSIT, for histories that need cash. */
export function deposit(
  portfolio: string,
  date: string,
  amountEur: number,
): LedgerEvent {
  return {
    id: `${date}/${portfolio}/dep/1`,
    ts: `${date}T09:30:00.000Z`,
    portfolio,
    type: "DEPOSIT",
    amountEur,
  };
}

/** An ORDER_PLACED, queued and waiting for the next open. */
export function placed(
  portfolio: string,
  date: string,
  order: { ticker: string; side: "buy" | "sell"; targetEur: number; sequence?: number },
): LedgerEvent {
  const sequence = order.sequence ?? 1;
  return {
    id: `${date}/${portfolio}/ord/${sequence}`,
    ts: `${date}T21:00:00.000Z`,
    portfolio,
    type: "ORDER_PLACED",
    decisionId: `${date}/${portfolio}/dec`,
    ticker: order.ticker,
    side: order.side,
    targetEur: order.targetEur,
    reason: "fixture",
  };
}

/** An ORDER_FILLED consistent with what the sizing code would have produced. */
export function filled(
  portfolio: string,
  date: string,
  fill: {
    orderId: string;
    ticker: string;
    side: "buy" | "sell";
    qty: number;
    priceLocal: number;
    currency?: string;
    fxRate?: number;
    feeEur?: number;
    sequence?: number;
  },
): LedgerEvent {
  const fxRate = fill.fxRate ?? 1;
  const feeEur = fill.feeEur ?? 1;
  const grossEur = eur((fill.qty * fill.priceLocal) / fxRate);
  const fxCostEur = fill.currency === "USD" ? eur(grossEur * 0.0025) : 0;
  return {
    id: `${date}/${portfolio}/fil/${fill.sequence ?? 1}`,
    ts: `${date}T08:00:00.000Z`,
    portfolio,
    type: "ORDER_FILLED",
    orderId: fill.orderId,
    ticker: fill.ticker,
    side: fill.side,
    qty: fill.qty,
    priceLocal: fill.priceLocal,
    currency: fill.currency ?? "EUR",
    fxRate,
    grossEur,
    feeEur,
    fxCostEur,
    netEur: eur(
      fill.side === "buy" ? grossEur + feeEur + fxCostEur : grossEur - feeEur - fxCostEur,
    ),
  };
}

/** A VALUATION mark. Only the fields the engine reads back are meaningful. */
export function mark(
  portfolio: string,
  date: string,
  values: { cashEur: number; marketValueEur?: number; contributedToDateEur?: number },
): LedgerEvent {
  return {
    id: `${date}/${portfolio}/val/1`,
    ts: `${date}T22:00:00.000Z`,
    portfolio,
    type: "VALUATION",
    cashEur: values.cashEur,
    positions: [],
    marketValueEur: values.marketValueEur ?? 0,
    fxEffectEur: 0,
    contributedToDateEur: values.contributedToDateEur ?? 0,
  };
}

// --- Driving whole sessions -------------------------------------------------

/**
 * A market port answering for one session, from `QuoteSpec`s.
 *
 * Bars are the closes of the sessions handed in, which keeps the brief's
 * trailing returns consistent with its quotes and, more importantly, keeps the
 * history strictly in the past.
 */
export function marketFor(
  sessions: readonly { readonly date: string; readonly quotes: readonly QuoteSpec[] }[],
  upTo: number,
  options: { readonly eurusd?: number; readonly actions?: readonly CorporateAction[] } = {},
): FixtureMarketData {
  const session = sessions[upTo];
  if (session === undefined) throw new Error(`no session at index ${upTo}`);
  const eurusd = options.eurusd ?? 1.085;

  const quotes: PriceSnapshot[] = session.quotes.map((quote) => {
    const sessionDate = quote.sessionDate ?? session.date;
    return {
      ticker: quote.ticker,
      currency: quote.currency ?? "EUR",
      exchange: "TEST",
      open: quote.open ?? null,
      high: quote.close ?? null,
      low: quote.close ?? null,
      close: quote.close ?? null,
      previousClose: quote.previousClose ?? null,
      volume: null,
      asOf: `${sessionDate}T20:00:00.000Z`,
      sessionDate,
    };
  });
  quotes.push({
    ticker: "EURUSD=X",
    currency: "USD",
    exchange: "CCY",
    open: eurusd,
    high: eurusd,
    low: eurusd,
    close: eurusd,
    previousClose: eurusd,
    volume: null,
    asOf: `${session.date}T20:00:00.000Z`,
    sessionDate: session.date,
  });

  const bars: Record<string, DailyBar[]> = {};
  for (let index = 0; index <= upTo; index += 1) {
    const past = sessions[index];
    if (past === undefined) continue;
    for (const quote of past.quotes) {
      (bars[quote.ticker] ??= []).push({
        date: quote.sessionDate ?? past.date,
        open: quote.open ?? null,
        high: quote.close ?? null,
        low: quote.close ?? null,
        close: quote.close ?? null,
        adjClose: quote.close ?? null,
        volume: null,
      });
    }
  }

  return new FixtureMarketData({
    quotes,
    bars,
    ...(options.actions ? { corporateActions: options.actions } : {}),
  });
}

/** `runDaily` over the dry-run universe, with the controls as deciders. */
export function runSession(
  options: {
    readonly sessions: readonly { readonly date: string; readonly quotes: readonly QuoteSpec[] }[];
    readonly index: number;
    readonly history: readonly LedgerEvent[];
    readonly eurusd?: number;
    readonly actions?: readonly CorporateAction[];
    readonly market?: FixtureMarketData;
    /** Replace the controls, e.g. with a decider that misbehaves on purpose. */
    readonly deciders?: ReadonlyMap<string, Decider>;
    /** Replace the roster, to isolate one guardrail from the others. */
    readonly portfolios?: Portfolios;
  },
): Promise<RunDailyResult> {
  const session = options.sessions[options.index];
  if (session === undefined) throw new Error("no such session");
  const universe = dryRunUniverse();
  const portfolios = options.portfolios ?? livePortfolios();
  return runDaily({
    universe,
    portfolios,
    simulation: liveSimulation(),
    feeds: parseFeeds(repoText("fixtures", "dry-run", "feeds.yaml")),
    market:
      options.market ??
      marketFor(options.sessions, options.index, {
        ...(options.eurusd === undefined ? {} : { eurusd: options.eurusd }),
        ...(options.actions ? { actions: options.actions } : {}),
      }),
    feedReader: new FixtureFeedReader({}),
    clock: fixedClock(`${session.date}T21:30:00.000Z`),
    deciders: options.deciders ?? createControls(portfolios.all),
    history: options.history,
    sessionDate: session.date,
  });
}
