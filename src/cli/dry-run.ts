/**
 * `dry-run` — replay recorded price fixtures across simulated sessions.
 *
 * The daily run is, by design, a thing that happens once a day. That is an
 * awful feedback loop for the parts of it that only fire monthly: the first
 * trading day of a month, an order filling at the *next* open, a dividend
 * landing on a position opened six weeks earlier. Waiting three real weeks to
 * find out that the deposit rule is off by one session is not a development
 * process.
 *
 * So: the same engine, the same controls, the same ledger and the same
 * `verify`, driven session by session over a committed fixture with the clock
 * pinned to each session in turn. Everything lands in a scratch directory that
 * is not `data/`, and the run ends by replaying what it wrote and checking
 * every invariant — including that `state.json` rebuilds byte-identically.
 *
 * Nothing in this file is test-only scaffolding around the engine. It calls
 * `runDailyCli`, exactly as the workflow does; the only things swapped are the
 * two ports and the clock.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { fixedClock } from "../domain/clock.js";
import type { IsoDate } from "../domain/types.js";
import { FixtureFeedReader, FixtureMarketData } from "../data/fixtures.js";
import type { CorporateAction, DailyBar, PriceSnapshot } from "../data/port.js";
import { parseFeeds } from "../data/feeds.js";
import { parseUniverse } from "../data/universe.js";
import { parsePortfolios, parseSimulation } from "../engine/config.js";
import { readEvents } from "../engine/ledger.js";
import { scriptedModelFactory, type MockTurn } from "../agents/mock.js";
import { DisabledWebSearch } from "../agents/search.js";
import { loadMandates, type LoadedConfig } from "./context.js";
import type { AgentWiring } from "./run-daily.js";
import { rebuildStateCli } from "./rebuild-state.js";
import { runDailyCli } from "./run-daily.js";
import { verifyCli } from "./verify.js";

// --- The scenario format ----------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableNumber = z.number().finite().nullable();

const FixtureQuoteSchema = z.object({
  ticker: z.string().min(1),
  currency: z.string().min(1),
  exchange: z.string().default(""),
  open: nullableNumber,
  high: nullableNumber.default(null),
  low: nullableNumber.default(null),
  close: nullableNumber,
  previousClose: nullableNumber.default(null),
  volume: nullableNumber.default(null),
  /**
   * The session this print belongs to, when it is not the session being
   * replayed. That is how a regional market holiday is expressed: the rest of
   * the universe moves on and this instrument's newest close stays behind,
   * which must make it untradable (SPEC 1.5) without stopping the run.
   */
  sessionDate: isoDate.optional(),
});

const FixtureActionSchema = z.object({
  ticker: z.string().min(1),
  date: isoDate,
  kind: z.literal(["dividend", "split"]),
  amountLocal: nullableNumber.default(null),
  currency: z.string().nullable().default(null),
  ratio: nullableNumber.default(null),
});

const FixtureSessionSchema = z.object({
  date: isoDate,
  /** When the run happens. Defaults to 21:30 UTC, after the US close. */
  at: z.string().optional(),
  quotes: z.array(FixtureQuoteSchema).min(1),
  corporateActions: z.array(FixtureActionSchema).default([]),
  note: z.string().optional(),
});

export const ScenarioSchema = z.object({
  schemaVersion: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().default(""),
  /** Config files this scenario runs against, relative to the repo root. */
  config: z.object({
    universe: z.string().min(1),
    feeds: z.string().min(1),
    portfolios: z.string().min(1),
    simulation: z.string().min(1),
  }),
  sessions: z.array(FixtureSessionSchema).min(1),
});

export type Scenario = Readonly<z.infer<typeof ScenarioSchema>>;
export type FixtureSession = Readonly<z.infer<typeof FixtureSessionSchema>>;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export function parseScenario(json: string, file: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ScenarioError(`${file} is not readable JSON: ${(cause as Error).message}`);
  }
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    throw new ScenarioError(`${file} is not a valid scenario${where}: ${issue?.message ?? "unknown"}`);
  }

  const scenario = result.data;
  const dates = scenario.sessions.map((session) => session.date);
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1] ?? "";
    const current = dates[index] ?? "";
    if (current <= previous) {
      // The simulation is forward-only (SPEC 1.2). A scenario that went
      // backwards would be a backtest with extra steps.
      throw new ScenarioError(
        `${file}: session ${current} does not come after ${previous}; sessions must run forward`,
      );
    }
  }
  return scenario;
}

// --- Driving it -------------------------------------------------------------

export interface DryRunOptions {
  readonly scenarioFile: string;
  /** Where the simulated `data/` lands. Never the real one. */
  readonly outDir: string;
  readonly repoRoot: string;
  /** Keep whatever is already in `outDir` instead of starting clean. */
  readonly keep?: boolean;
  readonly log?: (line: string) => void;
}

export interface DryRunSessionResult {
  readonly date: IsoDate;
  readonly status: string;
  readonly summary: string;
  readonly portfolios: readonly {
    readonly portfolio: string;
    readonly totalValueEur: number;
    readonly filled: number;
    readonly placed: number;
    readonly depositedEur: number;
  }[];
}

export interface DryRunResult {
  readonly scenario: Scenario;
  readonly outDir: string;
  readonly sessions: readonly DryRunSessionResult[];
  readonly verified: boolean;
  readonly stateRebuildIdentical: boolean;
  readonly ok: boolean;
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/** Load the config files a scenario names. */
function loadScenarioConfig(scenario: Scenario, repoRoot: string): LoadedConfig {
  const read = (path: string): string =>
    readFileSync(resolveFrom(repoRoot, path), "utf8");

  const universe = parseUniverse(read(scenario.config.universe));
  const simulation = parseSimulation(read(scenario.config.simulation));
  const portfolios = parsePortfolios(read(scenario.config.portfolios), { simulation });
  return {
    universe,
    simulation,
    portfolios,
    feeds: parseFeeds(read(scenario.config.feeds)),
    mandates: loadMandates(portfolios.all, repoRoot),
  };
}

/**
 * The agent wiring for a dry run: a scripted model and no web search.
 *
 * The dry run must work with the network unplugged, so it cannot call
 * Anthropic — but running the agent leg against a *stub decider* would leave
 * the interesting half untested, because the interesting half is the Strands
 * loop itself: the tool executor, the structured-output tool, the schema gate,
 * the budget limits. `MockModel` replaces the HTTP call and nothing else, so
 * everything above it is the real thing.
 *
 * The script makes one real tool call — which exercises the look-ahead clamp
 * against the scenario's own bars — and then holds. It holds rather than
 * trading on purpose: the dry run exists to prove the *engine*, the controls
 * already drive fills and deposits through it, and an agent inventing trades
 * from a fixture would put numbers in the scratch ledger that mean nothing.
 * The agent's own trade path is proved in `test/agents/run.test.ts`.
 */
function dryRunAgents(scenario: Scenario, config: LoadedConfig): AgentWiring {
  const ticker = config.universe.document.dcaInstrument;
  const script: readonly MockTurn[] = [
    { kind: "tool", name: "getPriceHistory", input: { ticker, range: "1m" } },
    {
      kind: "output",
      value: {
        action: "hold",
        rationale:
          `Dry run against the "${scenario.name}" fixture: prices here are a synthetic ` +
          `random walk, not a market, so there is no valuation case to make. Read one ` +
          `month of ${ticker} to exercise the price tool and held.`,
        confidence: 1,
        orders: [],
        sourcesUsed: [],
      },
    },
  ];

  return {
    models: scriptedModelFactory(script, { kind: "mock" }),
    search: new DisabledWebSearch("dry-run: the network is not available"),
    // A fresh scratch directory each time, so the history port would find
    // nothing anyway — but saying so keeps the dry run independent of `data/`.
    history: { recent: () => [] },
  };
}

/** A fixture quote, as the data layer's `PriceSnapshot`. */
function toSnapshot(
  quote: FixtureSession["quotes"][number],
  session: FixtureSession,
): PriceSnapshot {
  const sessionDate = quote.sessionDate ?? session.date;
  return {
    ticker: quote.ticker,
    currency: quote.currency,
    exchange: quote.exchange,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    previousClose: quote.previousClose,
    volume: quote.volume,
    asOf: `${sessionDate}T20:00:00.000Z`,
    sessionDate,
  };
}

/**
 * Daily bars, synthesised from the sessions the scenario has already played.
 *
 * The brief's trailing returns need a price history, and inventing a separate
 * one would let the bars and the quotes disagree. Building it out of the
 * scenario's own closes keeps a single source of prices — and keeps the
 * history strictly in the past, which is the property that matters.
 */
function barsThrough(
  sessions: readonly FixtureSession[],
  upTo: number,
): Record<string, DailyBar[]> {
  const bars: Record<string, DailyBar[]> = {};
  for (let index = 0; index <= upTo; index += 1) {
    const session = sessions[index];
    if (session === undefined) continue;
    for (const quote of session.quotes) {
      const series = bars[quote.ticker] ?? (bars[quote.ticker] = []);
      series.push({
        date: quote.sessionDate ?? session.date,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        adjClose: quote.close,
        volume: quote.volume,
      });
    }
  }
  return bars;
}

function toActions(scenario: Scenario): CorporateAction[] {
  return scenario.sessions.flatMap((session) =>
    session.corporateActions.map((action) => ({
      ticker: action.ticker,
      date: action.date,
      kind: action.kind,
      amountLocal: action.amountLocal,
      currency: action.currency,
      ratio: action.ratio,
    })),
  );
}

/**
 * Replay a scenario, session by session.
 *
 * Each session gets a clock pinned to it and a market port that can answer for
 * that session and everything before it — never for one after. That is what
 * makes the dry run a real test of SPEC 1.1 rather than a rehearsal of it: an
 * order placed on session N is filled on session N+1 because the price it
 * needs does not exist yet on session N, not because the code politely waits.
 */
export async function dryRunCli(options: DryRunOptions): Promise<DryRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const scenarioPath = resolveFrom(options.repoRoot, options.scenarioFile);
  const scenario = parseScenario(readFileSync(scenarioPath, "utf8"), options.scenarioFile);
  const config = loadScenarioConfig(scenario, options.repoRoot);

  const outDir = resolveFrom(options.repoRoot, options.outDir);
  if (options.keep !== true && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  log(`dry-run: ${scenario.name}`);
  if (scenario.description.length > 0) log(`  ${scenario.description}`);
  log(
    `  ${scenario.sessions.length} session(s), ${config.portfolios.activeKeys.length} active portfolio(s): ${config.portfolios.activeKeys.join(", ")}`,
  );
  log(`  writing to ${outDir}`);
  log("");

  const actions = toActions(scenario);
  const agents = dryRunAgents(scenario, config);
  const results: DryRunSessionResult[] = [];

  for (const [index, session] of scenario.sessions.entries()) {
    const market = new FixtureMarketData({
      quotes: session.quotes.map((quote) => toSnapshot(quote, session)),
      bars: barsThrough(scenario.sessions, index),
      // Actions are filtered by the port to the window the engine asks for, so
      // handing it the whole list cannot leak a future dividend into today.
      corporateActions: actions,
    });

    const { run, commitMessage } = await runDailyCli({
      config,
      market,
      feedReader: new FixtureFeedReader({}),
      clock: fixedClock(session.at ?? `${session.date}T21:30:00.000Z`),
      dataRoot: outDir,
      sessionDate: session.date,
      agents,
      log: () => {},
    });

    const note = session.note === undefined ? "" : `  — ${session.note}`;
    log(`  ${commitMessage}${note}`);
    for (const line of run.notes) log(`      ${line}`);
    for (const portfolio of run.portfolios) {
      const moves = [
        portfolio.depositedEur > 0 ? `+${portfolio.depositedEur.toFixed(2)} EUR in` : null,
        portfolio.filled > 0 ? `${portfolio.filled} filled` : null,
        portfolio.placed > 0 ? `${portfolio.placed} queued` : null,
        portfolio.rejected > 0 ? `${portfolio.rejected} rejected` : null,
        portfolio.dividends > 0 ? `${portfolio.dividends} dividend(s)` : null,
        portfolio.splits > 0 ? `${portfolio.splits} split(s)` : null,
        portfolio.held ? "held" : null,
      ].filter((part): part is string => part !== null);
      log(
        `      ${portfolio.portfolio.padEnd(8)} ${portfolio.totalValueEur.toFixed(2).padStart(9)} EUR   ${moves.join(", ")}`,
      );
    }

    results.push({
      date: session.date,
      status: run.status,
      summary: commitMessage,
      portfolios: run.portfolios.map((portfolio) => ({
        portfolio: portfolio.portfolio,
        totalValueEur: portfolio.totalValueEur,
        filled: portfolio.filled,
        placed: portfolio.placed,
        depositedEur: portfolio.depositedEur,
      })),
    });
  }

  // --- The point of the exercise: does what it wrote actually hold up? -----
  log("");
  const verification = verifyCli({ dataRoot: outDir, universe: config.universe, log });
  const rebuild = rebuildStateCli({
    dataRoot: outDir,
    universe: config.universe,
    simulation: config.simulation,
    check: true,
    log,
  });

  log("");
  log(`  ${readEvents(outDir).length} event(s) written to ${join(outDir, "events.jsonl")}`);

  const ok = verification.ok && rebuild.ok;
  log(ok ? "dry-run: clean" : "dry-run: FAILED");

  return {
    scenario,
    outDir,
    sessions: results,
    verified: verification.ok,
    stateRebuildIdentical: rebuild.ok,
    ok,
  };
}

/** Where the default scenario lives, relative to the repo root. */
export const DEFAULT_SCENARIO = join("fixtures", "dry-run", "controls.json");

export function scenarioDir(repoRoot: string): string {
  return dirname(resolveFrom(repoRoot, DEFAULT_SCENARIO));
}
