/**
 * Headlines for the brief: deduplication and instrument tagging (SPEC 6 —
 * "deduplicated, each with source, timestamp, URL and instrument tags where
 * resolvable").
 *
 * Pure. Items in, headlines out, no clock and no network: the `asOf` instant
 * that bounds the window is a parameter, which is what lets the golden test
 * pin a day and get the same headline section forever.
 *
 * Both halves are conservative on purpose. The same wire story reaches the run
 * through four feeds, and four copies of it in a prompt reads to an agent as
 * four independent confirmations of the same fact — so duplicates are folded
 * into one item that says how many copies it stood for. And a tag is a claim
 * that a story is about an instrument the agent may trade; a wrong tag is
 * worse than no tag, so an alias that could mean two companies tags neither.
 */
import type { IsoTimestamp, Ticker } from "../domain/types.js";
import type { TaggingConfig } from "../data/feeds.js";
import type { Universe } from "../data/universe.js";
import type { Headline } from "./types.js";

/** A story as it arrived, before dedup and before tagging. */
export interface RawHeadline {
  readonly id: string;
  readonly title: string;
  /** Feed id from `feeds.yaml`, or `yahoo:<query>`. */
  readonly source: string;
  readonly url: string;
  readonly publishedAt: IsoTimestamp;
  /** Tickers the source itself asserted (Yahoo's `relatedTickers`). */
  readonly tickers: readonly Ticker[];
}

/** One story after dedup: the earliest copy, plus what the others contributed. */
export interface DedupedHeadline extends RawHeadline {
  readonly duplicates: number;
}

// --- Text -------------------------------------------------------------------

/**
 * Lowercase, unaccented, alphanumeric tokens.
 *
 * Diacritics are stripped rather than transliterated, so "Münchener" and
 * "Munchener" are the same token. That is how the wire writes them anyway:
 * publishers disagree with each other about the umlaut in the same story.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Corporate furniture, stripped from the tail of a name before it becomes an
 * alias: the wire writes "Allianz", not "Allianz SE", and "Alphabet", not
 * "Alphabet A".
 */
const NAME_SUFFIXES = new Set([
  "se", "ag", "nv", "sa", "plc", "inc", "incorporated", "corp", "corporation",
  "co", "kgaa", "ab", "asa", "oyj", "spa", "pref", "prefs", "class", "a", "b",
]);

function stripNameSuffixes(tokens: readonly string[]): string[] {
  const kept = [...tokens];
  while (kept.length > 1 && NAME_SUFFIXES.has(kept[kept.length - 1] as string)) {
    kept.pop();
  }
  return kept;
}

// --- Tagging ----------------------------------------------------------------

interface AliasEntry {
  readonly tokens: readonly string[];
  readonly ticker: Ticker;
}

/**
 * Aliases, indexed by their first token.
 *
 * Matching is on token sequences rather than substrings, which is what keeps
 * "SAP" out of "asap" and "Visa" out of "visa-free travel" — the tokens have
 * to line up, in order, at a word boundary, because the boundaries are where
 * the tokens were cut.
 */
export class AliasIndex {
  private readonly byFirstToken: ReadonlyMap<string, readonly AliasEntry[]>;

  constructor(entries: readonly AliasEntry[]) {
    const index = new Map<string, AliasEntry[]>();
    for (const entry of entries) {
      const first = entry.tokens[0];
      if (first === undefined) continue;
      const bucket = index.get(first);
      if (bucket === undefined) index.set(first, [entry]);
      else bucket.push(entry);
    }
    this.byFirstToken = index;
  }

  get size(): number {
    return [...this.byFirstToken.values()].reduce((total, bucket) => total + bucket.length, 0);
  }

  /** Every whitelisted instrument this text names, sorted and deduplicated. */
  match(text: string): Ticker[] {
    const tokens = tokenize(text);
    const found = new Set<Ticker>();
    for (let start = 0; start < tokens.length; start += 1) {
      for (const entry of this.byFirstToken.get(tokens[start] as string) ?? []) {
        if (entry.tokens.every((token, offset) => tokens[start + offset] === token)) {
          found.add(entry.ticker);
        }
      }
    }
    return [...found].sort();
  }
}

/**
 * Build the alias index from the whitelist and the tagging config.
 *
 * Three sources, with different amounts of trust:
 *
 *  - Explicit aliases in `feeds.yaml` are taken as written. A human listed
 *    "3M" and "IBM" knowing what they match; the length rule below would throw
 *    both away.
 *  - The ticker, and its bare symbol where the ticker carries a suffix
 *    ("SAP.DE" -> "SAP"), when long enough to be unambiguous.
 *  - The instrument's name, for equities only. ETF names are generic by
 *    construction — "iShares Core MSCI World" would tag every story about
 *    world equities with one particular share class.
 *
 * An alias that two instruments would both claim is dropped: SPEC 6 asks for
 * tags "where resolvable", and that one is not.
 */
export function buildAliasIndex(universe: Universe, tagging: TaggingConfig): AliasIndex {
  const stop = new Set(tagging.stopAliases.map((word) => tokenize(word).join(" ")));
  const claims = new Map<string, Set<Ticker>>();

  const claim = (tokens: readonly string[], ticker: Ticker): void => {
    if (tokens.length === 0) return;
    const key = tokens.join(" ");
    const holders = claims.get(key);
    if (holders === undefined) claims.set(key, new Set([ticker]));
    else holders.add(ticker);
  };

  const claimIfSpecific = (raw: string, ticker: Ticker): void => {
    const tokens = tokenize(raw);
    if (tokens.length === 0) return;
    if (tokens.every((token) => stop.has(token))) return;
    if (tokens.length === 1 && (tokens[0] as string).length < tagging.minAliasLength) return;
    claim(tokens, ticker);
  };

  for (const instrument of universe.document.instruments) {
    const { ticker } = instrument;
    for (const alias of tagging.aliases[ticker] ?? []) {
      claim(tokenize(alias), ticker);
    }
    claimIfSpecific(ticker, ticker);
    const bareSymbol = ticker.split(".")[0] ?? ticker;
    if (bareSymbol !== ticker) claimIfSpecific(bareSymbol, ticker);
    if (instrument.type === "equity") {
      claimIfSpecific(stripNameSuffixes(tokenize(instrument.name)).join(" "), ticker);
    }
  }

  const entries: AliasEntry[] = [];
  for (const [key, holders] of [...claims.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [only] = [...holders];
    // Two companies, one alias: tagging either would be a coin toss.
    if (holders.size !== 1 || only === undefined) continue;
    entries.push({ tokens: key.split(" "), ticker: only });
  }
  return new AliasIndex(entries);
}

// --- Deduplication ----------------------------------------------------------

/** Tracking parameters carried by everyone, meaning nothing to anyone. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|cmp$|smid$)/i;

/**
 * A URL reduced to the article it points at: no scheme difference, no `www.`,
 * no tracking parameters, no fragment, no trailing slash. Unparseable input is
 * returned trimmed and lowercased rather than thrown away — it is still a
 * usable dedup key even if it is not a usable link.
 */
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([key, value]) => `${key}=${value}`).join("&");
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}${query.length > 0 ? `?${query}` : ""}`;
}

/** The title, reduced to its words. Two feeds' punctuation rarely agrees. */
export function titleKey(title: string): string {
  return tokenize(title).join(" ");
}

function compareRaw(a: RawHeadline, b: RawHeadline): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold copies of the same story into one.
 *
 * Two keys, because the wire gives two kinds of duplicate: the same URL
 * syndicated with different tracking, and the same headline republished under
 * different URLs. The earliest copy wins the record — it is the one that
 * actually broke the story — and the later copies contribute their tickers and
 * their count.
 *
 * A story is joined to the first group either of its keys matches; it does not
 * merge two existing groups. That keeps the pass single-pass and its output
 * independent of arrival order, at the cost of occasionally leaving two groups
 * where a transitive merge would have made one.
 */
export function dedupeHeadlines(items: readonly RawHeadline[]): DedupedHeadline[] {
  interface Group {
    head: RawHeadline;
    tickers: Set<Ticker>;
    duplicates: number;
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();

  for (const item of [...items].sort(compareRaw)) {
    const keys = [`u:${canonicalUrl(item.url)}`, `t:${titleKey(item.title)}`];
    const existing = keys.map((key) => byKey.get(key)).find((group) => group !== undefined);
    const group = existing ?? { head: item, tickers: new Set<Ticker>(), duplicates: -1 };
    if (existing === undefined) groups.push(group);
    group.duplicates += 1;
    for (const ticker of item.tickers) group.tickers.add(ticker);
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, group);
  }

  return groups.map((group) => ({
    ...group.head,
    tickers: [...group.tickers].sort(),
    duplicates: group.duplicates,
  }));
}

// --- Selection --------------------------------------------------------------

/** A feed clock running fast should not cost a real story its place. */
const FUTURE_GRACE_MS = 60 * 60 * 1000;

export interface HeadlineSelection {
  readonly asOf: IsoTimestamp;
  readonly maxAgeHours: number;
  readonly maxHeadlines: number;
  readonly aliases: AliasIndex;
  readonly universe: Universe;
}

/**
 * Dedup, tag, bound and cap — the whole headline section in one pure step.
 *
 * Tags come from two places and are both filtered against the whitelist: what
 * the source asserted, and what the title says. A tag for something no
 * portfolio may trade is noise in a prompt that is already long.
 *
 * The cap keeps the newest, which is the only ordering that does not quietly
 * editorialise: ranking by tag count would hand every agent the same tilt
 * towards whatever the feeds happened to name, and SPEC 1.4 asks this file to
 * be a baseline rather than a view.
 */
export function selectHeadlines(
  items: readonly RawHeadline[],
  selection: HeadlineSelection,
): Headline[] {
  const asOfMs = Date.parse(selection.asOf);
  const oldestMs = asOfMs - selection.maxAgeHours * 3_600_000;

  const inWindow = items.filter((item) => {
    const ms = Date.parse(item.publishedAt);
    return Number.isFinite(ms) && ms >= oldestMs && ms <= asOfMs + FUTURE_GRACE_MS;
  });

  return dedupeHeadlines(inWindow)
    .map((item) => {
      const asserted = item.tickers.filter((ticker) => selection.universe.has(ticker));
      const resolved = new Set([...asserted, ...selection.aliases.match(item.title)]);
      return {
        id: item.id,
        title: item.title,
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt,
        tickers: [...resolved].sort(),
        duplicates: item.duplicates,
      };
    })
    .sort(newestFirst)
    .slice(0, selection.maxHeadlines);
}

/** Newest first, ties broken by source then id so the order is total. */
function newestFirst(a: Headline, b: Headline): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
