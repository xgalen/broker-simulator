/**
 * The web search port (SPEC 7, SPEC 13).
 *
 * "pluggable provider behind an interface (Brave / Tavily / Exa; key in repo
 * secrets)". Both concrete providers take their transport as a parameter, so
 * these tests exercise the real request shape and the real response parsing
 * without a key and without the network.
 *
 * SPEC 13: "Secrets: ... Never logged, never committed." The key is asserted
 * on directly here, because a credential that leaks into an error message ends
 * up in a public Actions log.
 */
import { describe, expect, it } from "vitest";
import {
  BraveWebSearch,
  createWebSearch,
  DisabledWebSearch,
  TavilyWebSearch,
  WebSearchError,
} from "../../src/agents/search.js";

const KEY = "sk-secret-do-not-leak";

/** A `fetch` that answers with one JSON body and records what it was sent. */
function jsonFetch(body: unknown): {
  readonly fetch: typeof fetch;
  readonly requests: { url: string; init: RequestInit | undefined }[];
} {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const call = (async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: call, requests };
}

describe("Brave", () => {
  it("sends the query and the key in a header, and reads the results", async () => {
    const { fetch: call, requests } = jsonFetch({
      web: {
        results: [
          {
            title: "SAP raises guidance",
            url: "https://example.invalid/sap",
            description: "Cloud backlog grew 28% year on year.",
            page_age: "2026-03-01T08:00:00Z",
          },
        ],
      },
    });

    const provider = new BraveWebSearch({ apiKey: KEY, fetch: call });
    const results = await provider.search("SAP guidance", { maxResults: 3 });

    expect(provider.provider).toBe("brave");
    expect(results).toEqual([
      {
        title: "SAP raises guidance",
        url: "https://example.invalid/sap",
        snippet: "Cloud backlog grew 28% year on year.",
        publishedAt: "2026-03-01T08:00:00Z",
      },
    ]);

    const request = requests[0];
    expect(request?.url).toContain("q=SAP+guidance");
    expect(request?.url).toContain("count=3");
    // The key travels in a header, never in the URL — URLs end up in logs.
    expect(request?.url).not.toContain(KEY);
    expect((request?.init?.headers as Record<string, string>)["x-subscription-token"]).toBe(KEY);
  });

  it("reads a response whose shape has drifted, without throwing", async () => {
    const { fetch: call } = jsonFetch({ web: { results: [{ url: 42 }] } });
    const results = await new BraveWebSearch({ apiKey: KEY, fetch: call }).search("anything");
    expect(results).toEqual([{ title: "", url: "", snippet: "", publishedAt: null }]);
  });

  it("refuses an empty key rather than sending an unauthenticated request", () => {
    expect(() => new BraveWebSearch({ apiKey: "" })).toThrow(WebSearchError);
  });
});

describe("Tavily", () => {
  it("posts the query and reads the results", async () => {
    const { fetch: call, requests } = jsonFetch({
      results: [
        {
          title: "ASML order book",
          url: "https://example.invalid/asml",
          content: "Bookings came in at EUR 7.1bn.",
          published_date: "2026-02-28",
        },
      ],
    });

    const provider = new TavilyWebSearch({ apiKey: KEY, fetch: call });
    const results = await provider.search("ASML bookings");

    expect(provider.provider).toBe("tavily");
    expect(results[0]?.snippet).toBe("Bookings came in at EUR 7.1bn.");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(String(requests[0]?.init?.body)).toContain("ASML bookings");
    expect(requests[0]?.url).not.toContain(KEY);
  });
});

describe("when a provider fails", () => {
  it("never puts the key in the error a decision record will keep", async () => {
    const failing = (async () =>
      new Response("nope", { status: 429, statusText: "Too Many Requests" })) as unknown as typeof fetch;

    for (const provider of [
      new BraveWebSearch({ apiKey: KEY, fetch: failing }),
      new TavilyWebSearch({ apiKey: KEY, fetch: failing }),
    ]) {
      const error = await provider.search("anything").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WebSearchError);
      expect((error as Error).message).toMatch(/429/);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).stack ?? "").not.toContain(KEY);
    }
  });
});

describe("choosing a provider from the environment", () => {
  it("picks whichever key is set", () => {
    expect(createWebSearch({ BRAVE_API_KEY: KEY }).provider).toBe("brave");
    expect(createWebSearch({ TAVILY_API_KEY: KEY }).provider).toBe("tavily");
    expect(createWebSearch({ WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: KEY }).provider).toBe(
      "tavily",
    );
  });

  it("degrades to a port that explains itself instead of throwing", () => {
    // A missing search key must not stop the daily run: the brief is the
    // information baseline (SPEC 1.4) and search is an extra. But the agent has
    // to be told the difference between "no results" and "no provider".
    const none = createWebSearch({});
    expect(none.provider).toBe("none");
    expect(none).toBeInstanceOf(DisabledWebSearch);
    return expect(none.search("anything")).rejects.toThrow(/no web search key is set/);
  });

  it("says so when a named provider has no key", () => {
    const provider = createWebSearch({ WEB_SEARCH_PROVIDER: "brave" });
    expect(provider.provider).toBe("none");
    return expect(provider.search("x")).rejects.toThrow(/BRAVE_API_KEY is not set/);
  });

  it("can be switched off on purpose", () => {
    const provider = createWebSearch({ WEB_SEARCH_PROVIDER: "none", BRAVE_API_KEY: KEY });
    expect(provider.provider).toBe("none");
    return expect(provider.search("x")).rejects.toThrow(/disabled by configuration/);
  });

  it("names an unknown provider rather than silently falling back", () => {
    const provider = createWebSearch({ WEB_SEARCH_PROVIDER: "altavista" });
    return expect(provider.search("x")).rejects.toThrow(/unknown web search provider "altavista"/);
  });
});
