/**
 * `config/feeds.yaml`, parsed and checked (SPEC 6).
 *
 * Same shape of module as `universe.ts`: pure, text in and a checked document
 * out, so the config can be exercised without a filesystem. The cross-field
 * checks catch the mistakes that would otherwise show up as a silently empty
 * headline section — a duplicate feed id, an alias pinned to a ticker that is
 * not in the whitelist, a URL that is not http(s).
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Ticker } from "../domain/types.js";
import type { Universe } from "./universe.js";

const text = z.string().min(1);

const FeedSchema = z.object({
  id: text,
  name: text,
  url: text,
  region: z.enum(["EU", "US", "GLOBAL"]),
  category: z.enum(["markets", "companies", "macro"]),
  enabled: z.boolean().default(true),
});

const TaggingSchema = z.object({
  minAliasLength: z.number().int().positive(),
  stopAliases: z.array(text).default([]),
  aliases: z.record(z.string(), z.array(text)).default({}),
});

export const FeedsSchema = z.object({
  schemaVersion: z.number().int().positive(),
  defaults: z.object({
    maxItemsPerFeed: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  window: z.object({
    maxAgeHours: z.number().positive(),
    maxHeadlines: z.number().int().positive(),
  }),
  feeds: z.array(FeedSchema).min(1),
  yahoo: z.object({
    maxItemsPerQuery: z.number().int().positive(),
    queries: z.array(text).default([]),
  }),
  tagging: TaggingSchema,
});

export type FeedSource = Readonly<z.infer<typeof FeedSchema>>;
export type TaggingConfig = Readonly<z.infer<typeof TaggingSchema>>;
export type FeedsDocument = Readonly<z.infer<typeof FeedsSchema>>;

export class FeedsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedsError";
  }
}

/** The feeds the daily run will actually fetch, in file order. */
export function enabledFeeds(document: FeedsDocument): readonly FeedSource[] {
  return document.feeds.filter((feed) => feed.enabled);
}

/**
 * Parse and check `feeds.yaml`.
 *
 * `universe` is optional so the config can be validated on its own, but the
 * daily run passes it: an alias for a ticker that was removed from the
 * whitelist is dead weight that would tag headlines with an instrument no
 * agent is allowed to trade.
 */
export function parseFeeds(yamlText: string, universe?: Universe): FeedsDocument {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new FeedsError(`feeds.yaml is not valid YAML: ${(cause as Error).message}`);
  }

  const result = FeedsSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    throw new FeedsError(
      `feeds.yaml is malformed${where}: ${issue?.message ?? "unknown error"}`,
    );
  }

  const doc = result.data;
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const feed of doc.feeds) {
    if (seen.has(feed.id)) problems.push(`duplicate feed id "${feed.id}"`);
    seen.add(feed.id);
    if (!/^https?:\/\//.test(feed.url)) {
      problems.push(`feed "${feed.id}" has a non-http(s) url: ${feed.url}`);
    }
  }

  if (enabledFeeds(doc).length === 0 && doc.yahoo.queries.length === 0) {
    problems.push("every feed is disabled and no Yahoo queries are configured: the brief would carry no headlines");
  }

  if (universe !== undefined) {
    for (const ticker of Object.keys(doc.tagging.aliases)) {
      if (!universe.has(ticker)) {
        problems.push(`tagging alias for "${ticker}", which is not in the universe`);
      }
    }
  }

  if (problems.length > 0) {
    throw new FeedsError(
      `feeds.yaml failed ${problems.length} check(s):\n  ${problems.join("\n  ")}`,
    );
  }

  return doc;
}

/** Explicit aliases for one ticker, or none. */
export function aliasesFor(document: FeedsDocument, ticker: Ticker): readonly string[] {
  return document.tagging.aliases[ticker] ?? [];
}
