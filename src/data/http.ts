/**
 * The HTTP transport for RSS.
 *
 * The second and last module in `src/data` allowed to touch the network — the
 * first is `yahooClient.ts`, and `layering.test.ts` enforces that the list
 * stops there. Everything else, this file included, is reachable through a
 * function type: `HttpFeedReader` takes an `HttpGet`, so the feed pipeline is
 * tested against recorded XML with no transport in the picture at all.
 *
 * Deliberately thin. There is no retry here: a feed that fails costs its own
 * headlines (see `rss.ts`), and hammering a publisher's CDN for a story we can
 * do without is not a trade worth making.
 */
import type { HttpGet } from "./rss.js";

/** Publishers block unidentified clients, and rightly so. */
export const USER_AGENT =
  "investor-simulator/0.1 (+https://github.com/xgalen/broker-simulator; research simulation)";

export interface HttpGetOptions {
  readonly userAgent?: string;
  /** Injected in tests; defaults to the runtime's own fetch. */
  readonly fetch?: typeof fetch;
}

/** An `HttpGet` over the platform fetch, with a timeout and a text body. */
export function createHttpGet(options: HttpGetOptions = {}): HttpGet {
  const agent = options.userAgent ?? USER_AGENT;
  const call = options.fetch ?? fetch;
  return async (url, { timeoutMs }) => {
    const response = await call(url, {
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8", "user-agent": agent },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
    }
    return await response.text();
  };
}
