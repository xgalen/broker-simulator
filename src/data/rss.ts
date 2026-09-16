/**
 * The feed reader (SPEC 3: "feed readers" live in the data layer; SPEC 6:
 * "Headlines from `config/feeds.yaml`").
 *
 * Two halves, deliberately separated:
 *
 *  - `parseFeed` is pure. XML text in, items out. It is what the tests
 *    exercise, against recorded feeds, with nothing plugged in.
 *  - `HttpFeedReader` is the I/O half, and it takes its transport as a
 *    parameter. That is what keeps `fetch` out of this file and lets the
 *    golden brief test run the whole pipeline offline.
 *
 * Publishers are not consistent, so the parser is forgiving: RSS 2.0 and Atom,
 * CDATA or escaped text, `<link>` as an element or as an `href` attribute,
 * namespaced date elements. Anything it cannot make sense of is dropped and
 * counted rather than guessed at — a headline with an invented timestamp would
 * be indistinguishable from a real one in the committed brief.
 *
 * A feed that fails costs its own headlines and nothing else. SPEC 1.5 — the
 * rule that stops the whole run — is about prices: trading on a stale price is
 * a false trade, while missing one publisher's stories is a thinner brief. The
 * per-feed outcome is reported so the thinning is visible rather than silent.
 */
import type { IsoTimestamp } from "../domain/types.js";
import type { FeedSource } from "./feeds.js";

/** One story, as the feed published it. Tagging happens later, in the brief. */
export interface FeedItem {
  /** `id` of the feed in `config/feeds.yaml`. */
  readonly feedId: string;
  /** The publisher's guid where there is one, the URL otherwise. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: IsoTimestamp;
}

/** What one feed produced this run, including how it failed if it did. */
export interface FeedFetchResult {
  readonly feedId: string;
  readonly items: readonly FeedItem[];
  /** Items the parser refused: no title, no link, or no usable date. */
  readonly dropped: number;
  /** Feed-level failure. The other feeds still ran. */
  readonly error: string | null;
}

/** Implemented by `HttpFeedReader` live and by a fixture reader in tests. */
export interface FeedReaderPort {
  read(feeds: readonly FeedSource[]): Promise<readonly FeedFetchResult[]>;
}

/** The transport. Injected, so this module performs no I/O of its own. */
export type HttpGet = (url: string, options: { timeoutMs: number }) => Promise<string>;

// --- Parsing ----------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `&amp;`, `&#39;`, `&#x2019;` -> the characters they stand for. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** CDATA out, entities decoded, whitespace collapsed. */
function cleanText(value: string): string {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Some publishers embed markup in <title>; the brief quotes plain text.
  const withoutTags = withoutCdata.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/** First `<tag>` in `block`, namespace prefix allowed, as clean text. */
function element(block: string, tag: string): string | null {
  const match = new RegExp(`<(?:[A-Za-z0-9._-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${tag}\\s*>`, "i").exec(block);
  if (match?.[1] === undefined) return null;
  const value = cleanText(match[1]);
  return value.length > 0 ? value : null;
}

/**
 * The item's link.
 *
 * RSS puts it in the element body; Atom puts it in an `href` attribute and may
 * offer several, of which only `rel="alternate"` (or no `rel` at all) is the
 * story itself — `rel="self"` would point the agent at the feed.
 */
function link(block: string): string | null {
  for (const match of block.matchAll(/<(?:[A-Za-z0-9._-]+:)?link\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.toLowerCase();
    if (rel !== undefined && rel !== "alternate") continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    if (href !== undefined && href.length > 0) return decodeEntities(href).trim();
  }
  const body = element(block, "link");
  return body;
}

/**
 * `pubDate`, `published`, `updated` or `dc:date`, in that order of preference,
 * normalised to an ISO instant. RFC-822 and ISO-8601 both parse; anything else
 * returns null and costs the item its place.
 */
function publishedAt(block: string): IsoTimestamp | null {
  for (const tag of ["pubDate", "published", "updated", "date"]) {
    const raw = element(block, tag);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export interface ParsedFeed {
  readonly items: readonly FeedItem[];
  readonly dropped: number;
}

/**
 * Parse one feed document. Pure: no network, no clock, no config.
 *
 * `feedId` is stamped onto every item because it becomes the `source` of the
 * headline in the committed brief, and therefore part of the audit trail of
 * what an agent read on a given day.
 */
export function parseFeed(feedId: string, xml: string): ParsedFeed {
  const items: FeedItem[] = [];
  let dropped = 0;

  for (const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const block = match[2] ?? "";
    const title = element(block, "title");
    const url = link(block);
    const ts = publishedAt(block);
    if (title === null || url === null || ts === null) {
      dropped += 1;
      continue;
    }
    items.push({
      feedId,
      id: element(block, "guid") ?? element(block, "id") ?? url,
      title,
      url,
      publishedAt: ts,
    });
  }

  return { items, dropped };
}

// --- Reading ----------------------------------------------------------------

export interface FeedReaderOptions {
  readonly maxItemsPerFeed: number;
  readonly timeoutMs: number;
}

/**
 * Fetch and parse every configured feed, one at a time.
 *
 * Sequential on purpose: ten feeds is not a throughput problem, and a fixed
 * order keeps a run reproducible from its logs. Each feed is capped after
 * sorting newest first, so a publisher with a 200-item backlog contributes its
 * most recent `maxItemsPerFeed` rather than whatever order it happened to
 * serialise them in.
 */
export class HttpFeedReader implements FeedReaderPort {
  constructor(
    private readonly get: HttpGet,
    private readonly options: FeedReaderOptions,
  ) {}

  async read(feeds: readonly FeedSource[]): Promise<readonly FeedFetchResult[]> {
    const results: FeedFetchResult[] = [];
    for (const feed of feeds) {
      results.push(await this.readOne(feed));
    }
    return results;
  }

  private async readOne(feed: FeedSource): Promise<FeedFetchResult> {
    try {
      const xml = await this.get(feed.url, { timeoutMs: this.options.timeoutMs });
      const parsed = parseFeed(feed.id, xml);
      const newestFirst = [...parsed.items].sort(compareFeedItems);
      return {
        feedId: feed.id,
        items: newestFirst.slice(0, this.options.maxItemsPerFeed),
        dropped: parsed.dropped,
        error: null,
      };
    } catch (cause) {
      return {
        feedId: feed.id,
        items: [],
        dropped: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
}

/** Newest first, ties broken by id so the order never depends on input order. */
export function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
