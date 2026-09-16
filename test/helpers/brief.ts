/**
 * Fixture wiring for the phase 3 tests.
 *
 * Everything the brief builder needs, recorded: a six-name universe, a feed
 * config, two feed documents and one market snapshot. No test in `test/brief`
 * reaches the network, and none of them reads the host clock.
 *
 * The recorded bars are daily for the last 30 sessions and weekly before that,
 * back thirteen months. That is enough for every window SPEC 6 asks for — the
 * 1d and 5d windows count sessions, the 1m/6m/1y windows take the last bar on
 * or before the anchor date — without committing 400 rows per instrument.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../../src/domain/clock.js";
import { parseFeeds, type FeedsDocument } from "../../src/data/feeds.js";
import { FixtureFeedReader, FixtureMarketData, type FixtureData } from "../../src/data/fixtures.js";
import type { FeedReaderPort } from "../../src/data/rss.js";
import { parseUniverse, type Universe } from "../../src/data/universe.js";
import { buildBrief, type BriefBuildResult, type BuildBriefOptions } from "../../src/brief/build.js";

const briefFixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "brief");

const read = (...parts: string[]): string => readFileSync(join(briefFixtures, ...parts), "utf8");

/** 22:30 CET on the session date: when SPEC 13 says the daily run happens. */
export const BRIEF_CLOCK = fixedClock("2026-09-15T20:30:00.000Z");
export const BRIEF_SESSION = "2026-09-15";

export function fixtureUniverse(): Universe {
  return parseUniverse(read("universe.yaml"));
}

export function fixtureFeeds(): FeedsDocument {
  return parseFeeds(read("feeds.yaml"), fixtureUniverse());
}

export function fixtureMarketData(): FixtureData {
  return JSON.parse(read("market.json")) as FixtureData;
}

export function fixtureFeedDocuments(): Record<string, string> {
  return {
    "markets-rss": read("feeds", "markets-rss.xml"),
    "europe-atom": read("feeds", "europe-atom.xml"),
    // `dead-feed` is absent on purpose: a feed that fails must cost its own
    // headlines and nothing else.
  };
}

export function fixtureFeedReader(): FeedReaderPort {
  return new FixtureFeedReader(fixtureFeedDocuments());
}

/** The whole phase 3 pipeline, offline, with anything you like overridden. */
export function buildFixtureBrief(
  overrides: Partial<BuildBriefOptions> = {},
): Promise<BriefBuildResult> {
  return buildBrief({
    universe: fixtureUniverse(),
    feeds: fixtureFeeds(),
    market: new FixtureMarketData(fixtureMarketData()),
    feedReader: fixtureFeedReader(),
    clock: BRIEF_CLOCK,
    ...overrides,
  });
}

export function goldenBrief(): string {
  return read("golden-2026-09-15.json");
}
