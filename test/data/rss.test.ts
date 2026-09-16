/**
 * The feed reader (SPEC 6). Publishers disagree about nearly everything in an
 * RSS document, so these cover the disagreements that actually show up: Atom
 * versus RSS, CDATA, escaped entities, `rel="self"` links, namespaced dates,
 * and items with no timestamp at all.
 */
import { describe, expect, it } from "vitest";
import { HttpFeedReader, decodeEntities, parseFeed, type HttpGet } from "../../src/data/rss.js";
import type { FeedSource } from "../../src/data/feeds.js";
import { fixtureFeedDocuments } from "../helpers/brief.js";

const documents = fixtureFeedDocuments();
const rss = documents["markets-rss"] as string;
const atom = documents["europe-atom"] as string;

const feed = (id: string): FeedSource => ({
  id,
  name: id,
  url: `https://example.test/${id}`,
  region: "GLOBAL",
  category: "markets",
  enabled: true,
});

describe("decodeEntities", () => {
  it("handles named, decimal and hex references", () => {
    expect(decodeEntities("AT&amp;T&#39;s &#x201c;quarter&#x201d;")).toBe("AT&T's “quarter”");
  });

  it("leaves anything it does not recognise alone", () => {
    expect(decodeEntities("&notanentity; 5 &lt; 6")).toBe("&notanentity; 5 < 6");
  });
});

describe("parseFeed", () => {
  it("reads RSS 2.0 items, stamping the feed id onto each", () => {
    const parsed = parseFeed("markets-rss", rss);
    expect(parsed.items.map((item) => item.id)).toEqual([
      "mw-1001",
      "mw-1002",
      "mw-1003",
      "mw-1004",
      "mw-1005",
    ]);
    expect(parsed.items.every((item) => item.feedId === "markets-rss")).toBe(true);
  });

  it("normalises RFC-822 dates to ISO instants", () => {
    const [first] = parseFeed("markets-rss", rss).items;
    expect(first?.publishedAt).toBe("2026-09-15T20:10:00.000Z");
  });

  it("drops an item with no usable timestamp rather than inventing one", () => {
    const parsed = parseFeed("markets-rss", rss);
    expect(parsed.dropped).toBe(1);
    expect(parsed.items.map((item) => item.title)).not.toContain(
      "Undated wire copy that should never reach a brief",
    );
  });

  it("decodes entities inside CDATA, which publishers double-escape", () => {
    const [first] = parseFeed("europe-atom", atom).items;
    expect(first?.title).toBe("ASML's order book swells as EUV demand returns");
  });

  it("takes the Atom alternate link, never the feed's own rel=self", () => {
    const [first] = parseFeed("europe-atom", atom).items;
    expect(first?.url).toBe("https://europe.example.test/2026/09/15/asml-order-book");
  });

  it("prefers published over updated when both are present", () => {
    const [first] = parseFeed("europe-atom", atom).items;
    expect(first?.publishedAt).toBe("2026-09-15T16:20:00.000Z");
  });

  it("strips markup and collapses whitespace out of titles", () => {
    const parsed = parseFeed("x", `<rss><channel><item>
      <title>Shares  rise   on <b>strong</b>
        guidance</title>
      <link>https://example.test/a</link>
      <pubDate>2026-09-15T10:00:00Z</pubDate>
    </item></channel></rss>`);
    expect(parsed.items[0]?.title).toBe("Shares rise on strong guidance");
  });

  it("reads a namespaced date element", () => {
    const parsed = parseFeed("x", `<rdf:RDF><item>
      <title>Something happened</title>
      <link>https://example.test/b</link>
      <dc:date>2026-09-14T06:00:00Z</dc:date>
    </item></rdf:RDF>`);
    expect(parsed.items[0]?.publishedAt).toBe("2026-09-14T06:00:00.000Z");
  });

  it("falls back to the url when the publisher gives no guid", () => {
    const parsed = parseFeed("x", `<rss><channel><item>
      <title>No guid here</title>
      <link>https://example.test/c</link>
      <pubDate>2026-09-15T10:00:00Z</pubDate>
    </item></channel></rss>`);
    expect(parsed.items[0]?.id).toBe("https://example.test/c");
  });

  it("returns nothing at all for a document that is not a feed", () => {
    expect(parseFeed("x", "<html><body>404 Not Found</body></html>").items).toEqual([]);
  });
});

describe("HttpFeedReader", () => {
  const options = { maxItemsPerFeed: 3, timeoutMs: 1000 };

  it("fetches each configured feed once, in order", async () => {
    const seen: string[] = [];
    const get: HttpGet = async (url) => {
      seen.push(url);
      return rss;
    };
    const results = await new HttpFeedReader(get, options).read([feed("a"), feed("b")]);
    expect(seen).toEqual(["https://example.test/a", "https://example.test/b"]);
    expect(results.map((r) => r.feedId)).toEqual(["a", "b"]);
  });

  it("keeps the newest items when a feed overruns the cap", async () => {
    const get: HttpGet = async () => rss;
    const [result] = await new HttpFeedReader(get, options).read([feed("markets-rss")]);
    expect(result?.items.map((item) => item.id)).toEqual(["mw-1001", "mw-1003", "mw-1002"]);
  });

  it("degrades one feed without touching the others", async () => {
    const get: HttpGet = async (url) => {
      if (url.endsWith("dead")) throw new Error("GET returned 404 Not Found");
      return atom;
    };
    const results = await new HttpFeedReader(get, options).read([feed("dead"), feed("alive")]);
    expect(results[0]).toMatchObject({ feedId: "dead", items: [], error: "GET returned 404 Not Found" });
    expect(results[1]?.items.length).toBeGreaterThan(0);
    expect(results[1]?.error).toBeNull();
  });

  it("passes the configured timeout down to the transport", async () => {
    let seen = 0;
    const get: HttpGet = async (_url, opts) => {
      seen = opts.timeoutMs;
      return rss;
    };
    await new HttpFeedReader(get, options).read([feed("a")]);
    expect(seen).toBe(1000);
  });
});
