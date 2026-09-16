/**
 * Deduplication and instrument tagging (SPEC 6).
 *
 * The two failure modes these exist to prevent: four copies of one wire story
 * reading to an agent as four confirmations, and a tag that says a story is
 * about a company it never mentions.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeeds } from "../../src/data/feeds.js";
import { parseUniverse } from "../../src/data/universe.js";
import {
  AliasIndex,
  buildAliasIndex,
  canonicalUrl,
  dedupeHeadlines,
  selectHeadlines,
  titleKey,
  tokenize,
  type RawHeadline,
} from "../../src/brief/headlines.js";
import { fixtureFeeds, fixtureUniverse } from "../helpers/brief.js";

const universe = fixtureUniverse();
const aliases = buildAliasIndex(universe, fixtureFeeds().tagging);

const headline = (overrides: Partial<RawHeadline> & { id: string }): RawHeadline => ({
  title: "A headline",
  source: "wire",
  url: `https://example.test/${overrides.id}`,
  publishedAt: "2026-09-15T12:00:00.000Z",
  tickers: [],
  ...overrides,
});

describe("tokenize", () => {
  it("strips diacritics, because publishers disagree about them", () => {
    expect(tokenize("Münchener Rück")).toEqual(["munchener", "ruck"]);
  });

  it("cuts on punctuation, so AT&T is two tokens and so is its possessive", () => {
    expect(tokenize("AT&T's quarter")).toEqual(["at", "t", "s", "quarter"]);
  });
});

describe("canonicalUrl", () => {
  it("drops tracking parameters and the www, keeping real query state", () => {
    expect(canonicalUrl("https://www.Example.test/a/b/?utm_source=rss&id=7&fbclid=x")).toBe(
      "example.test/a/b?id=7",
    );
  });

  it("ignores the scheme, the fragment and a trailing slash", () => {
    expect(canonicalUrl("http://example.test/story/#top")).toBe(canonicalUrl("https://example.test/story"));
  });

  it("still produces a key for something that is not a URL", () => {
    expect(canonicalUrl(" Not A Url ")).toBe("not a url");
  });
});

describe("buildAliasIndex", () => {
  it("tags a company named in the headline", () => {
    expect(aliases.match("Apple unveils a new iPhone")).toEqual(["AAPL"]);
  });

  it("matches on word boundaries, so SAP is not found inside ASAP", () => {
    expect(aliases.match("Regulators want a decision ASAP")).toEqual([]);
    expect(aliases.match("SAP raises guidance")).toEqual(["SAP.DE"]);
  });

  it("finds every instrument a headline names", () => {
    expect(aliases.match("Microsoft and SAP expand their cloud partnership")).toEqual([
      "MSFT",
      "SAP.DE",
    ]);
  });

  it("takes the ticker itself when it is long enough to be unambiguous", () => {
    expect(aliases.match("AAPL leads the tape")).toEqual(["AAPL"]);
  });

  it("does not tag ETFs from their generic names", () => {
    expect(aliases.match("iShares Core MSCI World funds saw inflows")).toEqual([]);
  });

  it("drops an alias two instruments would both claim", () => {
    const ambiguous = parseUniverse(`
schemaVersion: 1
currencies: [EUR]
markets: { XETR: { name: Xetra, country: DE, currency: EUR, timezone: Europe/Berlin } }
benchmarks: { default: { EU: AAA.DE }, sector: {} }
dcaInstrument: AAA.DE
instruments:
  - { ticker: AAA.DE, name: Northern Lights, market: XETR, currency: EUR, region: EU, sector: energy, type: equity }
  - { ticker: BBB.DE, name: Northern Lights, market: XETR, currency: EUR, region: EU, sector: energy, type: equity }
`);
    const index = buildAliasIndex(ambiguous, {
      minAliasLength: 4,
      stopAliases: [],
      aliases: {},
    });
    expect(index.match("Northern Lights doubles its dividend")).toEqual([]);
    // The shared name resolves to neither; each ticker still resolves to itself.
    expect(index.match("AAA.DE reports")).toEqual(["AAA.DE"]);
  });

  it("honours an explicit alias even when it is shorter than the length rule", () => {
    const index = buildAliasIndex(universe, {
      minAliasLength: 9,
      stopAliases: [],
      aliases: { "SAP.DE": ["SAP"] },
    });
    expect(index.match("SAP raises guidance")).toEqual(["SAP.DE"]);
    expect(index.match("Apple unveils a new iPhone")).toEqual([]);
  });

  it("refuses a stop word as an alias on its own", () => {
    const index = buildAliasIndex(universe, {
      minAliasLength: 3,
      stopAliases: ["holding"],
      aliases: {},
    });
    expect(index.match("A holding company filed")).toEqual([]);
  });

  it("strips corporate furniture from names before matching", () => {
    // "SAP SE" in universe.yaml; the wire writes "SAP".
    const index = buildAliasIndex(universe, { minAliasLength: 3, stopAliases: [], aliases: {} });
    expect(index.match("SAP beats estimates")).toEqual(["SAP.DE"]);
  });

  it("is empty for a text that names nothing", () => {
    expect(new AliasIndex([]).match("anything at all")).toEqual([]);
  });
});

describe("dedupeHeadlines", () => {
  it("folds the same URL published with different tracking", () => {
    const folded = dedupeHeadlines([
      headline({ id: "a", url: "https://example.test/story?utm_source=rss", publishedAt: "2026-09-15T10:00:00.000Z" }),
      headline({ id: "b", url: "https://www.example.test/story/", title: "Different wording", publishedAt: "2026-09-15T11:00:00.000Z" }),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ id: "a", duplicates: 1 });
  });

  it("folds the same headline republished under another URL", () => {
    const folded = dedupeHeadlines([
      headline({ id: "a", title: "Chip stocks rally", url: "https://one.test/x" }),
      headline({ id: "b", title: "Chip  stocks, rally!", url: "https://two.test/y" }),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.duplicates).toBe(1);
  });

  it("keeps the earliest copy, which is the one that broke the story", () => {
    const folded = dedupeHeadlines([
      headline({ id: "late", source: "b", title: "Same story", publishedAt: "2026-09-15T18:00:00.000Z", url: "https://one.test/x" }),
      headline({ id: "early", source: "a", title: "Same story", publishedAt: "2026-09-15T09:00:00.000Z", url: "https://two.test/y" }),
    ]);
    expect(folded[0]).toMatchObject({ id: "early", publishedAt: "2026-09-15T09:00:00.000Z" });
  });

  it("merges the tickers the copies asserted", () => {
    const folded = dedupeHeadlines([
      headline({ id: "a", title: "Same story", url: "https://one.test/x", tickers: ["AAPL"] }),
      headline({ id: "b", title: "Same story", url: "https://two.test/y", tickers: ["MSFT", "AAPL"] }),
    ]);
    expect(folded[0]?.tickers).toEqual(["AAPL", "MSFT"]);
  });

  it("does not depend on the order the sources answered in", () => {
    const items = [
      headline({ id: "a", title: "One", url: "https://one.test/a" }),
      headline({ id: "b", title: "One", url: "https://two.test/b" }),
      headline({ id: "c", title: "Two", url: "https://three.test/c" }),
    ];
    const forwards = dedupeHeadlines(items);
    const backwards = dedupeHeadlines([...items].reverse());
    expect(backwards).toEqual(forwards);
  });

  it("leaves genuinely different stories alone", () => {
    expect(
      dedupeHeadlines([
        headline({ id: "a", title: "One thing happened", url: "https://one.test/a" }),
        headline({ id: "b", title: "Another thing happened", url: "https://one.test/b" }),
      ]),
    ).toHaveLength(2);
  });
});

describe("titleKey", () => {
  it("ignores punctuation and case, which two desks never agree on", () => {
    expect(titleKey("Chip stocks rally — again!")).toBe(titleKey("chip stocks rally again"));
  });
});

describe("selectHeadlines", () => {
  const selection = {
    asOf: "2026-09-15T20:30:00.000Z",
    maxAgeHours: 48,
    maxHeadlines: 3,
    aliases,
    universe,
  };

  it("drops anything outside the window", () => {
    const selected = selectHeadlines(
      [
        headline({ id: "fresh", url: "https://a.test/1", publishedAt: "2026-09-15T08:00:00.000Z" }),
        headline({ id: "stale", url: "https://a.test/2", title: "Old", publishedAt: "2026-09-01T08:00:00.000Z" }),
      ],
      selection,
    );
    expect(selected.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("drops a story dated beyond the grace period, whatever the feed's clock says", () => {
    const selected = selectHeadlines(
      [headline({ id: "future", url: "https://a.test/3", publishedAt: "2026-09-16T09:00:00.000Z" })],
      selection,
    );
    expect(selected).toEqual([]);
  });

  it("keeps the newest when the cap bites", () => {
    const selected = selectHeadlines(
      [1, 2, 3, 4, 5].map((n) =>
        headline({
          id: `h${n}`,
          title: `Story ${n}`,
          url: `https://a.test/${n}`,
          publishedAt: `2026-09-15T1${n}:00:00.000Z`,
        }),
      ),
      selection,
    );
    expect(selected.map((item) => item.id)).toEqual(["h5", "h4", "h3"]);
  });

  it("keeps only whitelisted tickers from what a source asserted", () => {
    const [selected] = selectHeadlines(
      [headline({ id: "a", url: "https://a.test/4", tickers: ["AAPL", "NVDA"] })],
      selection,
    );
    expect(selected?.tickers).toEqual(["AAPL"]);
  });

  it("combines asserted tags with tags read from the title", () => {
    const [selected] = selectHeadlines(
      [headline({ id: "a", url: "https://a.test/5", title: "SAP and the cloud", tickers: ["MSFT"] })],
      selection,
    );
    expect(selected?.tickers).toEqual(["MSFT", "SAP.DE"]);
  });
});

describe("the real tagging config", () => {
  it("resolves the companies its aliases name, against the real universe", () => {
    const repoUniverse = parseUniverse(readConfig("universe.yaml"));
    const repoFeeds = parseFeeds(readConfig("feeds.yaml"), repoUniverse);
    const index = buildAliasIndex(repoUniverse, repoFeeds.tagging);
    expect(index.match("Deutsche Telekom raises its dividend")).toEqual(["DTE.DE"]);
    expect(index.match("Berkshire Hathaway trims its Apple stake")).toEqual(["AAPL", "BRK-B"]);
    expect(index.match("3M settles")).toEqual(["MMM"]);
    // The stop list and the length rule between them keep the noise out.
    expect(index.match("A global energy group said")).toEqual([]);
    expect(index.match("Visa-free travel expands")).toEqual(["V"]);
  });
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readConfig(name: string): string {
  return readFileSync(join(repoRoot, "config", name), "utf8");
}
