/**
 * `config/feeds.yaml` (SPEC 6). These run against the real file, so the config
 * that decides what every agent reads is covered by CI rather than by trust.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FeedsError, enabledFeeds, parseFeeds } from "../../src/data/feeds.js";
import { parseUniverse } from "../../src/data/universe.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const realFeeds = readFileSync(join(repoRoot, "config", "feeds.yaml"), "utf8");
const realUniverse = parseUniverse(readFileSync(join(repoRoot, "config", "universe.yaml"), "utf8"));

const minimal = `
schemaVersion: 1
defaults: { maxItemsPerFeed: 10, timeoutMs: 5000 }
window: { maxAgeHours: 48, maxHeadlines: 50 }
feeds:
  - { id: wire, name: Wire, url: https://example.test/rss, region: US, category: markets }
yahoo: { maxItemsPerQuery: 5, queries: [stock market] }
tagging: { minAliasLength: 4, stopAliases: [group], aliases: {} }
`;

describe("config/feeds.yaml", () => {
  const feeds = parseFeeds(realFeeds, realUniverse);

  it("parses against the real universe", () => {
    expect(feeds.schemaVersion).toBe(1);
    expect(feeds.feeds.length).toBeGreaterThan(5);
  });

  it("covers both regions and macro policy, which the mandates need", () => {
    const categories = new Set(feeds.feeds.map((feed) => feed.category));
    const regions = new Set(feeds.feeds.map((feed) => feed.region));
    expect(categories).toContain("macro");
    expect(regions).toContain("EU");
    expect(regions).toContain("US");
  });

  it("serves headlines from something, even with every feed disabled", () => {
    expect(feeds.yahoo.queries.length).toBeGreaterThan(0);
  });

  it("caps the headline section so the brief stays a prompt input", () => {
    expect(feeds.window.maxHeadlines).toBeLessThanOrEqual(200);
    expect(feeds.window.maxAgeHours).toBeLessThanOrEqual(72);
  });

  it("aliases only tickers that are actually tradable", () => {
    for (const ticker of Object.keys(feeds.tagging.aliases)) {
      expect(realUniverse.has(ticker), `${ticker} is aliased but not whitelisted`).toBe(true);
    }
  });
});

describe("parseFeeds", () => {
  it("defaults a feed to enabled", () => {
    expect(enabledFeeds(parseFeeds(minimal))).toHaveLength(1);
  });

  it("rejects a duplicate feed id, which would double every story it carries", () => {
    const doubled = minimal.replace(
      "yahoo: {",
      "  - { id: wire, name: Wire Again, url: https://example.test/rss2, region: US, category: markets }\nyahoo: {",
    );
    expect(() => parseFeeds(doubled)).toThrow(/duplicate feed id "wire"/);
  });

  it("rejects a url that is not http(s)", () => {
    expect(() => parseFeeds(minimal.replace("https://example.test/rss", "file:///etc/passwd"))).toThrow(
      FeedsError,
    );
  });

  it("rejects a config that would produce no headlines at all", () => {
    const silent = minimal
      .replace("category: markets }", "category: markets, enabled: false }")
      .replace("queries: [stock market]", "queries: []");
    expect(() => parseFeeds(silent)).toThrow(/no Yahoo queries/);
  });

  it("rejects an alias for a ticker outside the whitelist", () => {
    const stray = minimal.replace("aliases: {}", "aliases: { NOPE: [Nope] }");
    expect(() => parseFeeds(stray, realUniverse)).toThrow(/not in the universe/);
  });

  it("names the field when the file is malformed", () => {
    expect(() => parseFeeds(minimal.replace("maxAgeHours: 48", "maxAgeHours: -1"))).toThrow(
      /window.maxAgeHours/,
    );
  });

  it("rejects text that is not YAML at all", () => {
    expect(() => parseFeeds("feeds: [")).toThrow(FeedsError);
  });
});
