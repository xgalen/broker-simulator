/**
 * The composition root.
 *
 * Everything impure in this project is constructed here and nowhere else: the
 * system clock, the Yahoo client, the HTTP transport. `src/domain` is forbidden
 * from reading a clock at all (there is a test for it) and `src/engine` takes
 * every one of these as a parameter, which is what lets the whole daily
 * sequence be driven across simulated months with nothing plugged in.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Clock } from "../domain/clock.js";
import { createHttpGet } from "../data/http.js";
import { HttpFeedReader, type FeedReaderPort } from "../data/rss.js";
import { parseFeeds, type FeedsDocument } from "../data/feeds.js";
import { parseUniverse, type Universe } from "../data/universe.js";
import { createYahooClient } from "../data/yahooClient.js";
import { YahooMarketData } from "../data/yahoo.js";
import type { MarketDataPort } from "../data/port.js";
import {
  parsePortfolios,
  parseSimulation,
  type PortfolioConfig,
  type Portfolios,
  type SimulationConfig,
} from "../engine/config.js";
import { anthropicKeyFrom, anthropicModelFactory, type ModelFactory } from "../agents/model.js";
import { createWebSearch, DisabledWebSearch, type WebSearchPort } from "../agents/search.js";
import { mandatePaths } from "../agents/index.js";
import type { PortfolioId } from "../domain/types.js";

/**
 * A clock that reads the host. The only one in the codebase, and deliberately
 * not exported from `src/domain`: the purity test asserts the domain ships
 * `fixedClock` and nothing else.
 */
export function systemClock(): Clock {
  return {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    today: () => new Date().toISOString().slice(0, 10),
  };
}

export interface LoadedConfig {
  readonly universe: Universe;
  readonly feeds: FeedsDocument;
  readonly simulation: SimulationConfig;
  readonly portfolios: Portfolios;
  /**
   * Mandate text for every enabled agent, by key (SPEC 10).
   *
   * Read once, here, and passed down as a string. There is no handle to the
   * file anywhere below this line, which is the cheapest possible way to keep
   * SPEC 14's "a mandate file is never modified by any code path" true: no
   * code path below the composition root can even name one.
   */
  readonly mandates: ReadonlyMap<PortfolioId, string>;
}

/**
 * Read and validate every config file.
 *
 * All four are parsed before any of them is used, so a typo in
 * `portfolios.yaml` fails in the first second of the job rather than after the
 * price fetch has already happened.
 */
export function loadConfig(configDir: string): LoadedConfig {
  const read = (name: string): string => readFileSync(join(configDir, name), "utf8");

  const universe = parseUniverse(read("universe.yaml"));
  const simulation = parseSimulation(read("simulation.yaml"));
  const portfolios = parsePortfolios(read("portfolios.yaml"), { simulation });
  return {
    universe,
    simulation,
    portfolios,
    feeds: parseFeeds(read("feeds.yaml"), universe),
    mandates: loadMandates(portfolios.all, dirname(configDir)),
  };
}

/**
 * Read each enabled agent's mandate.
 *
 * `portfolios.yaml` names them repo-relative (`config/mandates/value.md`), so
 * they resolve against the repository root rather than the config directory —
 * which is what lets `--config` point somewhere else in a test without the
 * mandate paths quietly following it.
 */
export function loadMandates(
  portfolios: readonly PortfolioConfig[],
  repoRoot: string,
): ReadonlyMap<PortfolioId, string> {
  const mandates = new Map<PortfolioId, string>();
  for (const [key, path] of mandatePaths(portfolios)) {
    const file = isAbsolute(path) ? path : resolve(repoRoot, path);
    if (!existsSync(file)) {
      throw new Error(`agent "${key}" names mandate "${path}", which does not exist at ${file}`);
    }
    mandates.set(key, readFileSync(file, "utf8"));
  }
  return mandates;
}

export interface LivePorts {
  readonly market: MarketDataPort;
  readonly feedReader: FeedReaderPort;
}

/** The live adapters, wired with SPEC 6's retry, rate limit and breaker. */
export function createLivePorts(clock: Clock, feeds: FeedsDocument): LivePorts {
  return {
    market: new YahooMarketData(createYahooClient(), { clock }),
    feedReader: new HttpFeedReader(createHttpGet(), feeds.defaults),
  };
}

/**
 * The agent side of the composition root (SPEC 7, SPEC 13).
 *
 * Both credentials are read here and nowhere else, and neither is ever logged
 * or written to `data/`. A missing search key is survivable — the brief is the
 * information baseline and search is an extra, so the run proceeds with a port
 * that records why it could not search. A missing `ANTHROPIC_API_KEY` is not:
 * an enabled agent with no key would hold every day for a reason that is a
 * deployment mistake rather than a view on the market, so the CLI is told
 * plainly and can decide what to do about it.
 */
export interface AgentPorts {
  readonly models: ModelFactory | null;
  readonly search: WebSearchPort;
  /** Why `models` is null, when it is. */
  readonly unavailable: string | null;
}

export function createAgentPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentPorts {
  const search = createWebSearch(env);
  const key = anthropicKeyFrom(env);
  if (key === null) {
    return {
      models: null,
      search,
      unavailable:
        "ANTHROPIC_API_KEY is not set, so no agent can run. Set it as a repo secret (SPEC 13); it is never logged and never committed.",
    };
  }
  const baseURL = env["ANTHROPIC_BASE_URL"]?.trim();
  return {
    models: anthropicModelFactory({
      apiKey: key,
      ...(baseURL === undefined || baseURL.length === 0 ? {} : { baseURL }),
    }),
    search,
    unavailable: null,
  };
}

/** Ports for a run with no model and no search: used by `dry-run`. */
export function offlineAgentPorts(reason: string): AgentPorts {
  return { models: null, search: new DisabledWebSearch(reason), unavailable: reason };
}
