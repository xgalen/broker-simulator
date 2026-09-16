/**
 * `webSearch` (SPEC 7), behind an interface.
 *
 * "pluggable provider behind an interface (Brave / Tavily / Exa; key in repo
 * secrets)". The interface is the point: the tool in `tools.ts` depends on
 * `WebSearchPort` and nothing else, so every agent test runs against a
 * recorded provider and no test can reach a search API by accident.
 *
 * This is the only module in `src/agents` allowed to touch the network, and
 * `test/agents/layering.test.ts` enforces that. The key is read in the CLI's
 * composition root, is never logged, and never appears in a decision record —
 * the *queries* and the *results* are archived verbatim (SPEC 7 requires it,
 * "without that archive the decision is unauditable"); the credential is not.
 */

/** One result, flattened to the fields a decision record needs to keep. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  /** The provider's snippet, verbatim and untruncated. */
  readonly snippet: string;
  readonly publishedAt: string | null;
}

export interface WebSearchOptions {
  readonly maxResults?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchPort {
  /** `brave`, `tavily`, `none`… recorded alongside every archived query. */
  readonly provider: string;
  search(query: string, options?: WebSearchOptions): Promise<readonly WebSearchResult[]>;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * The port when no key is configured.
 *
 * It fails rather than returning nothing. An empty result set reads to an
 * agent as "the web knows nothing about this", which is a different and much
 * worse claim than "this deployment has no search provider" — and the second
 * one belongs in the decision record where someone can see it.
 */
export class DisabledWebSearch implements WebSearchPort {
  readonly provider = "none";

  constructor(private readonly reason = "no web search provider is configured") {}

  async search(): Promise<readonly WebSearchResult[]> {
    throw new WebSearchError(this.reason, this.provider);
  }
}

/** A port over recorded results. Used by every test above this module. */
export class FixtureWebSearch implements WebSearchPort {
  readonly provider = "fixture";
  readonly queries: string[] = [];

  constructor(
    private readonly results: Readonly<Record<string, readonly WebSearchResult[]>> = {},
    private readonly failWith?: WebSearchError,
  ) {}

  async search(query: string): Promise<readonly WebSearchResult[]> {
    this.queries.push(query);
    if (this.failWith !== undefined) throw this.failWith;
    return this.results[query] ?? [];
  }
}

export interface HttpSearchOptions {
  readonly apiKey: string;
  /** Injected in tests; defaults to the runtime's own fetch. */
  readonly fetch?: typeof fetch;
  readonly maxResults?: number;
  readonly timeoutMs?: number;
}

/** https://api.search.brave.com — GET, key in a header. */
export class BraveWebSearch implements WebSearchPort {
  readonly provider = "brave";

  constructor(private readonly options: HttpSearchOptions) {
    if (options.apiKey.length === 0) {
      throw new WebSearchError("brave: empty API key", this.provider);
    }
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<readonly WebSearchResult[]> {
    const count = options.maxResults ?? this.options.maxResults ?? DEFAULT_MAX_RESULTS;
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const body = await this.get(url, options);
    const results = asArray(pick(body, "web", "results"));
    return results.slice(0, count).map((item) => ({
      title: str(pick(item, "title")),
      url: str(pick(item, "url")),
      snippet: str(pick(item, "description")),
      publishedAt: optionalStr(pick(item, "page_age")),
    }));
  }

  private async get(url: URL, options: WebSearchOptions): Promise<unknown> {
    const call = this.options.fetch ?? fetch;
    const response = await call(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.options.apiKey,
      },
      ...signalFor(this.options, options),
    });
    if (!response.ok) {
      // The URL carries the query but never the key — the key is a header.
      throw new WebSearchError(
        `brave returned ${response.status} ${response.statusText}`,
        this.provider,
      );
    }
    return await response.json();
  }
}

/** https://api.tavily.com — POST, key in the body. */
export class TavilyWebSearch implements WebSearchPort {
  readonly provider = "tavily";

  constructor(private readonly options: HttpSearchOptions) {
    if (options.apiKey.length === 0) {
      throw new WebSearchError("tavily: empty API key", this.provider);
    }
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<readonly WebSearchResult[]> {
    const count = options.maxResults ?? this.options.maxResults ?? DEFAULT_MAX_RESULTS;
    const call = this.options.fetch ?? fetch;
    const response = await call("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
      ...signalFor(this.options, options),
    });
    if (!response.ok) {
      throw new WebSearchError(
        `tavily returned ${response.status} ${response.statusText}`,
        this.provider,
      );
    }
    const body: unknown = await response.json();
    return asArray(pick(body, "results"))
      .slice(0, count)
      .map((item) => ({
        title: str(pick(item, "title")),
        url: str(pick(item, "url")),
        snippet: str(pick(item, "content")),
        publishedAt: optionalStr(pick(item, "published_date")),
      }));
  }
}

export interface WebSearchEnv {
  readonly WEB_SEARCH_PROVIDER?: string | undefined;
  readonly BRAVE_API_KEY?: string | undefined;
  readonly TAVILY_API_KEY?: string | undefined;
}

/**
 * Build the port the environment describes.
 *
 * Never throws for want of a key: a missing search key must not stop the daily
 * run, because SPEC 6's brief is the information baseline and search is an
 * extra. The run proceeds with a port that says, in the decision record, that
 * it was not configured.
 */
export function createWebSearch(
  env: WebSearchEnv,
  options: { readonly fetch?: typeof fetch } = {},
): WebSearchPort {
  const named = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  const brave = env.BRAVE_API_KEY?.trim() ?? "";
  const tavily = env.TAVILY_API_KEY?.trim() ?? "";
  const rest = options.fetch === undefined ? {} : { fetch: options.fetch };

  if (named === "none") return new DisabledWebSearch("web search is disabled by configuration");
  if (named === "brave" || (named === undefined && brave.length > 0)) {
    return brave.length > 0
      ? new BraveWebSearch({ apiKey: brave, ...rest })
      : new DisabledWebSearch("WEB_SEARCH_PROVIDER=brave but BRAVE_API_KEY is not set");
  }
  if (named === "tavily" || (named === undefined && tavily.length > 0)) {
    return tavily.length > 0
      ? new TavilyWebSearch({ apiKey: tavily, ...rest })
      : new DisabledWebSearch("WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set");
  }
  if (named !== undefined) {
    return new DisabledWebSearch(`unknown web search provider "${named}"`);
  }
  return new DisabledWebSearch("no web search key is set (BRAVE_API_KEY, TAVILY_API_KEY)");
}

// --- Reading someone else's JSON --------------------------------------------
//
// Search APIs change shape without warning and a missing field must not throw
// in the middle of an agent's run. Everything is read defensively and anything
// unreadable becomes an empty string, which the archive then records as such.

function signalFor(
  configured: HttpSearchOptions,
  perCall: WebSearchOptions,
): { signal: AbortSignal } {
  if (perCall.signal !== undefined) return { signal: perCall.signal };
  const timeoutMs = perCall.timeoutMs ?? configured.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return { signal: AbortSignal.timeout(timeoutMs) };
}

function pick(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
