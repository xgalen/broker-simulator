/**
 * The composition root.
 *
 * Everything impure in this project is constructed here and nowhere else: the
 * system clock, the Yahoo client, the HTTP transport. `src/domain` is forbidden
 * from reading a clock at all (there is a test for it) and `src/engine` takes
 * every one of these as a parameter, which is what lets the whole daily
 * sequence be driven across simulated months with nothing plugged in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  type Portfolios,
  type SimulationConfig,
} from "../engine/config.js";

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
  return {
    universe,
    simulation,
    feeds: parseFeeds(read("feeds.yaml"), universe),
    portfolios: parsePortfolios(read("portfolios.yaml"), { simulation }),
  };
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
