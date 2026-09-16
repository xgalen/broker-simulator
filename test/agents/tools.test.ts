/**
 * The tools (SPEC 7, SPEC 1.1, SPEC 1.6).
 *
 * The toolbox is the only surface through which an agent can reach the outside
 * world, so it is where three guarantees are actually enforced: no price after
 * the deciding session, nothing outside the whitelist, and the call and search
 * budgets. The archive is checked here too, because SPEC 7 is explicit that
 * "without that archive the decision is unauditable".
 */
import { describe, expect, it } from "vitest";
import { AgentToolbox, shiftDate } from "../../src/agents/tools.js";
import { FixtureWebSearch, WebSearchError } from "../../src/agents/search.js";
import { MarketDataError } from "../../src/data/port.js";
import { FixtureMarketData } from "../../src/data/fixtures.js";
import { dryRunUniverse, liveSimulation } from "../helpers/engine.js";

const SESSION = "2026-03-04";

/** Bars either side of the session, so the clamp has something to clamp. */
const BARS = {
  "SAP.DE": [
    { date: "2026-03-02", open: 205, high: 207, low: 204, close: 206, adjClose: 206, volume: 10 },
    { date: "2026-03-03", open: 206, high: 209, low: 205, close: 208, adjClose: 208, volume: 11 },
    { date: SESSION, open: 210, high: 213, low: 209, close: 212.4, adjClose: 212.4, volume: 12 },
    // The next session's bar. It exists in the source and must never come back.
    { date: "2026-03-05", open: 214, high: 219, low: 213, close: 218, adjClose: 218, volume: 13 },
  ],
};

function toolboxWith(
  options: {
    readonly market?: FixtureMarketData;
    readonly search?: FixtureWebSearch;
    readonly maxToolCalls?: number;
    readonly maxWebSearches?: number;
  } = {},
) {
  const simulation = liveSimulation();
  return new AgentToolbox({
    market: options.market ?? new FixtureMarketData({ bars: BARS }),
    universe: dryRunUniverse(),
    search: options.search ?? new FixtureWebSearch({}),
    agents: {
      ...simulation.agents,
      ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
      ...(options.maxWebSearches === undefined ? {} : { maxWebSearches: options.maxWebSearches }),
    },
    sessionDate: SESSION,
  });
}

/** Call one tool the way the agent loop would. */
async function call(
  toolbox: AgentToolbox,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = toolbox.build().find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`no tool "${name}"`);
  return (await tool.invoke(input as never)) as Record<string, unknown>;
}

describe("SPEC 1.1: no look-ahead through a tool", () => {
  it("never returns a bar after the deciding session", async () => {
    const toolbox = toolboxWith();
    const result = await call(toolbox, "getPriceHistory", { ticker: "SAP.DE", range: "1m" });
    const bars = result["bars"] as { date: string; close: number }[];

    expect(bars.map((bar) => bar.date)).toEqual(["2026-03-02", "2026-03-03", SESSION]);
    // The bar that must not be here is the one the fill will be priced from.
    expect(bars.some((bar) => bar.date === "2026-03-05")).toBe(false);
    expect(bars.some((bar) => bar.close === 218)).toBe(false);
    expect(result["to"]).toBe(SESSION);
  });

  it("clamps on the way out, not just on the way in", async () => {
    // A port that ignores the window — as a caching adapter or a sloppy vendor
    // client might — must not be able to leak tomorrow into the prompt.
    const sloppy = new FixtureMarketData({ bars: BARS });
    sloppy.getDailyBars = async (ticker) =>
      (BARS as Record<string, (typeof BARS)["SAP.DE"]>)[ticker] ?? [];

    const result = await call(toolboxWith({ market: sloppy }), "getPriceHistory", {
      ticker: "SAP.DE",
      range: "1y",
    });
    const bars = result["bars"] as { date: string }[];
    expect(bars.every((bar) => bar.date <= SESSION)).toBe(true);
  });

  it("asks for a window that ends at the session", async () => {
    const market = new FixtureMarketData({ bars: BARS });
    await call(toolboxWith({ market }), "getPriceHistory", { ticker: "SAP.DE", range: "6m" });
    expect(market.calls).toEqual(["getDailyBars(SAP.DE)"]);
    expect(shiftDate(SESSION, -183)).toBe("2025-09-02");
  });
});

describe("SPEC 1.6: the whitelist bounds research too", () => {
  it("refuses a ticker outside the universe, on every instrument tool", async () => {
    for (const name of ["getPriceHistory", "getFundamentals", "getNewsForTicker"]) {
      const toolbox = toolboxWith();
      const result = await call(toolbox, name, { ticker: "TSLA", range: "1m" });
      expect(result["error"], name).toMatch(/not in the whitelist/);
      expect(toolbox.transcript.calls[0]?.ok, name).toBe(false);
    }
  });

  it("explains that a reference index is context, not an instrument", async () => {
    const result = await call(toolboxWith(), "getPriceHistory", { ticker: "^GSPC", range: "1m" });
    expect(result["error"]).toMatch(/reference index, not a tradable instrument/);
  });
});

describe("SPEC 7: the budgets", () => {
  it("answers 12 calls and refuses the 13th", async () => {
    const toolbox = toolboxWith();
    const answered: boolean[] = [];
    for (let index = 0; index < 13; index += 1) {
      const result = await call(toolbox, "getPriceHistory", { ticker: "SAP.DE", range: "5d" });
      answered.push(result["error"] === undefined);
    }

    expect(answered.filter(Boolean)).toHaveLength(12);
    expect(answered[12]).toBe(false);
    expect(toolbox.transcript.toolCallsUsed).toBe(12);
    expect(toolbox.transcript.capReached).toBe(true);
  });

  it("tells the agent to decide rather than merely erroring", async () => {
    // A model handed a bare "error" retries. One that is told the budget is
    // gone and that holding is valid does the useful thing instead.
    const toolbox = toolboxWith({ maxToolCalls: 1 });
    await call(toolbox, "getFundamentals", { ticker: "SAP.DE" });
    const refused = await call(toolbox, "getFundamentals", { ticker: "SAP.DE" });
    expect(refused["error"]).toMatch(/Tool budget spent/);
    expect(refused["error"]).toMatch(/holding is a valid decision/);
  });

  it("caps searches at five, separately from the call budget", async () => {
    const search = new FixtureWebSearch({});
    const toolbox = toolboxWith({ search });
    const outcomes: boolean[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await call(toolbox, "webSearch", { query: `q${index}` });
      outcomes.push(result["error"] === undefined);
    }

    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(search.queries).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    expect(toolbox.transcript.searchesUsed).toBe(5);
    // The refusal costs no call budget: it never reached the provider.
    expect(toolbox.transcript.toolCallsUsed).toBe(5);
  });
});

describe("SPEC 7: the archive", () => {
  it("keeps every query and every snippet verbatim", async () => {
    const results = [
      {
        title: "SAP raises cloud backlog guidance",
        url: "https://example.invalid/sap-guidance",
        snippet:
          "SAP said current cloud backlog grew 28% year on year, above the 25% it guided to in January.",
        publishedAt: "2026-03-01T08:00:00Z",
      },
    ];
    const toolbox = toolboxWith({ search: new FixtureWebSearch({ "SAP cloud backlog": results }) });
    await call(toolbox, "webSearch", { query: "SAP cloud backlog" });

    const archived = toolbox.transcript.searches;
    expect(archived).toHaveLength(1);
    expect(archived[0]?.query).toBe("SAP cloud backlog");
    expect(archived[0]?.provider).toBe("fixture");
    expect(archived[0]?.ok).toBe(true);
    // Verbatim and untruncated: the point is that a reader can see exactly
    // what the agent read.
    expect(archived[0]?.results).toEqual(results);
  });

  it("archives a failed search as a failure, not as an empty result", async () => {
    const toolbox = toolboxWith({
      search: new FixtureWebSearch({}, new WebSearchError("brave returned 429", "brave")),
    });
    const result = await call(toolbox, "webSearch", { query: "anything" });

    expect(result["error"]).toMatch(/brave returned 429/);
    expect(toolbox.transcript.searches[0]?.ok).toBe(false);
    expect(toolbox.transcript.searches[0]?.error).toMatch(/429/);
    expect(toolbox.transcript.searches[0]?.results).toEqual([]);
  });

  it("archives the refusals too, so a cap that fired is visible", async () => {
    const toolbox = toolboxWith({ maxToolCalls: 1 });
    await call(toolbox, "getFundamentals", { ticker: "SAP.DE" });
    await call(toolbox, "getFundamentals", { ticker: "SAP.DE" });
    expect(toolbox.transcript.calls).toHaveLength(2);
    expect(toolbox.transcript.calls[1]?.summary).toBe("refused");
  });

  it("numbers calls in order and records what each one asked for", async () => {
    const toolbox = toolboxWith();
    await call(toolbox, "getPriceHistory", { ticker: "SAP.DE", range: "1m" });
    await call(toolbox, "getNewsForTicker", { ticker: "ASML.AS" });

    expect(toolbox.transcript.calls.map((entry) => [entry.seq, entry.name])).toEqual([
      [1, "getPriceHistory"],
      [2, "getNewsForTicker"],
    ]);
    expect(toolbox.transcript.calls[0]?.input).toEqual({ ticker: "SAP.DE", range: "1m" });
  });
});

describe("failures come back as text, not as thrown errors", () => {
  it("turns a data-source failure into something the agent can read", async () => {
    const failing = new FixtureMarketData(
      {},
      { failWith: new MarketDataError("yahoo is down", "transient") },
    );
    const toolbox = toolboxWith({ market: failing });
    const result = await call(toolbox, "getFundamentals", { ticker: "SAP.DE" });

    expect(result["error"]).toMatch(/fundamentals for "SAP.DE" are unavailable: yahoo is down/);
    expect(toolbox.transcript.calls[0]?.error).toMatch(/yahoo is down/);
  });

  it("says a search provider is not configured rather than returning nothing", async () => {
    // An empty result set reads to an agent as "the web knows nothing about
    // this", which is a very different claim from "this deployment has no key".
    const { DisabledWebSearch } = await import("../../src/agents/search.js");
    const toolbox = new AgentToolbox({
      market: new FixtureMarketData({}),
      universe: dryRunUniverse(),
      search: new DisabledWebSearch("no web search provider is configured"),
      agents: liveSimulation().agents,
      sessionDate: SESSION,
    });
    const result = await call(toolbox, "webSearch", { query: "anything" });
    expect(result["error"]).toMatch(/no web search provider is configured/);
    expect(result["error"]).toMatch(/Work from the brief/);
  });
});

describe("shiftDate", () => {
  it("shifts in UTC and crosses month and year boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("refuses something that is not a date", () => {
    expect(() => shiftDate("not-a-date", -1)).toThrow(/not a calendar date/);
  });
});
