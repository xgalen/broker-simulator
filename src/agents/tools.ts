/**
 * The tools an agent may call (SPEC 7).
 *
 *   getPriceHistory(ticker, range)
 *   getFundamentals(ticker)
 *   getNewsForTicker(ticker)
 *   webSearch(query)
 *
 * Three things happen in this module besides plumbing, and they are the
 * reasons it exists rather than the agent calling the port directly:
 *
 *  1. **The look-ahead guard.** Every price this toolbox can return is clamped
 *     to the session the brief describes. SPEC 1.1 is enforced in the engine
 *     by pricing fills from the *next* session, but an agent that could ask
 *     for tomorrow's bar would make that enforcement decorative. The clamp is
 *     here, at the only place an agent can ask for a price at all.
 *  2. **The caps.** SPEC 7 allows 12 tool calls and 5 searches per run. The
 *     13th call and the 6th search are refused by the counter below, with a
 *     message telling the agent to decide with what it has. They are refused
 *     rather than fatal: the SDK's own `limits` are the hard abort that turns
 *     into a HOLD (SPEC 7), and an agent that is merely out of budget should
 *     still get to write down a real decision.
 *  3. **The archive.** "Archive every query and every returned snippet into
 *     the decision record verbatim. Without that archive the decision is
 *     unauditable." Every call — its input, its outcome, and for a search its
 *     full results — is recorded here and lands in the decision record.
 *
 * The toolbox is per-run, not per-agent: the counters are the run's.
 */
import { z } from "zod";
import { tool } from "@strands-agents/sdk";
import type { IsoDate, Ticker } from "../domain/types.js";
import type { MarketDataPort } from "../data/port.js";
import type { Universe } from "../data/universe.js";
import type { AgentsConfig } from "../engine/config.js";
import { WebSearchError, type WebSearchPort, type WebSearchResult } from "./search.js";

/** The windows `getPriceHistory` accepts, in calendar days back from the session. */
const RANGES = {
  "5d": 7,
  "1m": 31,
  "3m": 92,
  "6m": 183,
  "1y": 366,
  "2y": 731,
} as const;

export type PriceRange = keyof typeof RANGES;

// --- The archive ------------------------------------------------------------

/** One tool call, as the decision record keeps it. */
export interface ToolCallRecord {
  /** 1-based, in call order, across every tool. */
  readonly seq: number;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  /** One line describing what came back. Never the payload itself. */
  readonly summary: string;
  readonly error: string | null;
}

/**
 * One search, archived verbatim (SPEC 7).
 *
 * `results` is the provider's own text, untruncated: the point of the archive
 * is that someone can later read exactly what the agent read.
 */
export interface SearchRecord {
  readonly seq: number;
  readonly provider: string;
  readonly query: string;
  readonly ok: boolean;
  readonly results: readonly WebSearchResult[];
  readonly error: string | null;
}

export interface ToolboxTranscript {
  readonly calls: readonly ToolCallRecord[];
  readonly searches: readonly SearchRecord[];
  readonly toolCallsUsed: number;
  readonly searchesUsed: number;
  /** True when a call was refused because a cap was already spent. */
  readonly capReached: boolean;
}

export interface ToolboxOptions {
  readonly market: MarketDataPort;
  readonly universe: Universe;
  readonly search: WebSearchPort;
  readonly agents: AgentsConfig;
  /** The session the brief describes. Nothing after it is reachable. */
  readonly sessionDate: IsoDate;
}

/**
 * The tools for one agent run, plus the transcript they produced.
 *
 * Errors are returned to the model as text rather than thrown. A thrown tool
 * error ends the invocation; a returned one lets the agent notice it asked for
 * something that does not exist and carry on — and either way the failure is
 * in the archive.
 */
export class AgentToolbox {
  private readonly callRecords: ToolCallRecord[] = [];
  private readonly searchRecords: SearchRecord[] = [];
  private calls = 0;
  private searches = 0;
  private capped = false;

  constructor(private readonly options: ToolboxOptions) {}

  get transcript(): ToolboxTranscript {
    return {
      calls: [...this.callRecords],
      searches: [...this.searchRecords],
      toolCallsUsed: this.calls,
      searchesUsed: this.searches,
      capReached: this.capped,
    };
  }

  /** Every tool, ready to hand to `new Agent({ tools })`. */
  build(): readonly ReturnType<typeof tool>[] {
    return [
      this.priceHistoryTool(),
      this.fundamentalsTool(),
      this.newsTool(),
      this.webSearchTool(),
    ];
  }

  // --- Budget ---------------------------------------------------------------

  /**
   * Spend one call against the run's budget.
   *
   * Returns the refusal text when the budget is gone, so the caller can hand
   * it straight back to the model. The refusal names the cap and says what to
   * do next: a model told only "error" tends to try again.
   */
  private spend(): string | null {
    if (this.calls >= this.options.agents.maxToolCalls) {
      this.capped = true;
      return (
        `Tool budget spent: ${this.options.agents.maxToolCalls} calls is the limit for one run. ` +
        `No further tool calls will be answered. Decide on what you already have — ` +
        `holding is a valid decision and needs only a rationale.`
      );
    }
    this.calls += 1;
    return null;
  }

  private record(
    name: string,
    input: Readonly<Record<string, unknown>>,
    outcome: { readonly ok: boolean; readonly summary: string; readonly error?: string },
  ): void {
    this.callRecords.push({
      seq: this.callRecords.length + 1,
      name,
      input,
      ok: outcome.ok,
      summary: outcome.summary,
      error: outcome.error ?? null,
    });
  }

  /** A refusal is archived too: a cap that fires invisibly is a cap nobody debugs. */
  private refuse(
    name: string,
    input: Readonly<Record<string, unknown>>,
    message: string,
  ): { readonly error: string } {
    this.record(name, input, { ok: false, summary: "refused", error: message });
    return { error: message };
  }

  /** SPEC 1.6: an agent may only research what it may trade. */
  private checkTicker(ticker: string): string | null {
    if (this.options.universe.has(ticker)) return null;
    if (this.options.universe.isReference(ticker)) {
      return `"${ticker}" is a reference index, not a tradable instrument. It is context only.`;
    }
    return `"${ticker}" is not in the whitelist. Only the instruments listed in your prompt can be researched or traded.`;
  }

  // --- The tools ------------------------------------------------------------

  private priceHistoryTool(): ReturnType<typeof tool> {
    return tool({
      name: "getPriceHistory",
      description:
        "Daily open/high/low/close/volume for one whitelisted instrument, ending at " +
        "the session in your prompt. Nothing after that session exists yet.",
      inputSchema: z.object({
        ticker: z.string().min(1).describe("A ticker from the whitelist."),
        range: z
          .literal(["5d", "1m", "3m", "6m", "1y", "2y"])
          .describe("How far back to read, ending at the current session."),
      }),
      callback: async ({ ticker, range }) => {
        const input = { ticker, range };
        const refusal = this.spend();
        if (refusal !== null) return this.refuse("getPriceHistory", input, refusal);

        const bad = this.checkTicker(ticker);
        if (bad !== null) return this.refuse("getPriceHistory", input, bad);

        const to = this.options.sessionDate;
        const from = shiftDate(to, -RANGES[range]);
        try {
          const bars = await this.options.market.getDailyBars(ticker, { from, to });
          // Clamped again on the way out. The port is asked for a window, but
          // "asked politely" is not an invariant: SPEC 1.1 says a decision may
          // not see a price struck after the close it is deciding on, and this
          // is the line that makes it so.
          const visible = bars
            .filter((bar) => bar.date <= to)
            .map((bar) => ({
              date: bar.date,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            }));
          this.record("getPriceHistory", input, {
            ok: true,
            summary: `${visible.length} bar(s) ${visible[0]?.date ?? "-"}..${visible.at(-1)?.date ?? "-"}`,
          });
          return { ticker, range, from, to, bars: visible };
        } catch (error) {
          const message = describe(error);
          this.record("getPriceHistory", input, { ok: false, summary: "failed", error: message });
          return { error: `price history for "${ticker}" is unavailable: ${message}` };
        }
      },
    });
  }

  private fundamentalsTool(): ReturnType<typeof tool> {
    return tool({
      name: "getFundamentals",
      description:
        "Valuation multiples and balance-sheet figures for one whitelisted instrument: " +
        "market cap, trailing and forward P/E, price/book, dividend yield, return on " +
        "equity, debt/equity. Fields the source does not publish come back null.",
      inputSchema: z.object({
        ticker: z.string().min(1).describe("A ticker from the whitelist."),
      }),
      callback: async ({ ticker }) => {
        const input = { ticker };
        const refusal = this.spend();
        if (refusal !== null) return this.refuse("getFundamentals", input, refusal);

        const bad = this.checkTicker(ticker);
        if (bad !== null) return this.refuse("getFundamentals", input, bad);

        try {
          const found = await this.options.market.getFundamentals(ticker);
          this.record("getFundamentals", input, {
            ok: true,
            summary: `trailingPe=${fmt(found.trailingPe)} forwardPe=${fmt(found.forwardPe)} pb=${fmt(found.priceToBook)} roe=${fmt(found.returnOnEquity)}`,
          });
          return { ...found };
        } catch (error) {
          const message = describe(error);
          this.record("getFundamentals", input, { ok: false, summary: "failed", error: message });
          return { error: `fundamentals for "${ticker}" are unavailable: ${message}` };
        }
      },
    });
  }

  private newsTool(): ReturnType<typeof tool> {
    return tool({
      name: "getNewsForTicker",
      description:
        "Recent news items for one whitelisted instrument, from the market data " +
        "provider. Returns the headline, publisher, URL and timestamp — not the article.",
      inputSchema: z.object({
        ticker: z.string().min(1).describe("A ticker from the whitelist."),
      }),
      callback: async ({ ticker }) => {
        const input = { ticker };
        const refusal = this.spend();
        if (refusal !== null) return this.refuse("getNewsForTicker", input, refusal);

        const bad = this.checkTicker(ticker);
        if (bad !== null) return this.refuse("getNewsForTicker", input, bad);

        try {
          const items = await this.options.market.getNewsForTicker(ticker);
          this.record("getNewsForTicker", input, {
            ok: true,
            summary: `${items.length} item(s)`,
          });
          return {
            ticker,
            items: items.map((item) => ({
              id: item.id,
              title: item.title,
              publisher: item.publisher,
              url: item.url,
              publishedAt: item.publishedAt,
            })),
          };
        } catch (error) {
          const message = describe(error);
          this.record("getNewsForTicker", input, { ok: false, summary: "failed", error: message });
          return { error: `news for "${ticker}" is unavailable: ${message}` };
        }
      },
    });
  }

  private webSearchTool(): ReturnType<typeof tool> {
    const cap = this.options.agents.maxWebSearches;
    return tool({
      name: "webSearch",
      description:
        `Search the web. Capped at ${cap} searches for the whole run; every query and ` +
        "every returned snippet is archived in the decision record verbatim, so search " +
        "for things you will actually cite.",
      inputSchema: z.object({
        query: z.string().min(1).describe("The search query, as you would type it."),
      }),
      callback: async ({ query }) => {
        const input = { query };
        if (this.searches >= cap) {
          this.capped = true;
          return this.refuse(
            "webSearch",
            input,
            `Search budget spent: ${cap} searches is the limit for one run. Decide on what you have.`,
          );
        }
        const refusal = this.spend();
        if (refusal !== null) return this.refuse("webSearch", input, refusal);

        this.searches += 1;
        const seq = this.searchRecords.length + 1;
        const provider = this.options.search.provider;
        try {
          const results = await this.options.search.search(query);
          // Verbatim, untruncated, before anything is summarised for the model.
          this.searchRecords.push({ seq, provider, query, ok: true, results: [...results], error: null });
          this.record("webSearch", input, {
            ok: true,
            summary: `${results.length} result(s) from ${provider}`,
          });
          return {
            query,
            provider,
            results: results.map((result) => ({ ...result })),
          };
        } catch (error) {
          const message =
            error instanceof WebSearchError ? error.message : describe(error);
          this.searchRecords.push({ seq, provider, query, ok: false, results: [], error: message });
          this.record("webSearch", input, { ok: false, summary: "failed", error: message });
          return {
            error: `web search is unavailable (${message}). Work from the brief and the market data tools.`,
          };
        }
      },
    });
  }
}

// --- Helpers ----------------------------------------------------------------

/** Shift a `YYYY-MM-DD` by whole days, in UTC. No host clock is read. */
export function shiftDate(date: IsoDate, days: number): IsoDate {
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`"${date}" is not a calendar date`);
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

function fmt(value: number | null): string {
  return value === null ? "-" : String(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tickers the toolbox will answer for, for the prompt's whitelist block. */
export function researchableTickers(universe: Universe): readonly Ticker[] {
  return universe.tickers;
}
