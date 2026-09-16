/**
 * One Strands agent, as a `Decider` (SPEC 7, SPEC 12 phase 5).
 *
 * The engine cannot tell this apart from `DcaControl`. That is the payoff of
 * having built the controls first: the fills, the deposits, the validator, the
 * guardrails and the ledger were all proved by something free and repeatable,
 * and an agent is a decider like any other — it returns orders and the
 * validator judges them. There is no path from here to a balance.
 *
 * Four things this class is responsible for, and they are the reasons it is
 * more than twenty lines of SDK glue:
 *
 *  1. **The schema gate.** SPEC 7: "Structured output, validated with zod
 *     before anything touches the ledger." It is validated twice — once by the
 *     SDK's structured-output tool, which hands the model its own validation
 *     errors to retry against, and again here by `parseDecision`, the same
 *     function every control goes through.
 *  2. **The caps.** SPEC 7 gives a run 12 tool calls and a token budget, and
 *     says exceeding either "aborts the agent and writes a HOLD event with
 *     `reason: 'budget_exceeded'`". The SDK enforces both as `limits` and
 *     reports which one tripped; this turns that into the HOLD.
 *  3. **Never taking the run down.** An agent that throws would abort the
 *     session for every other portfolio, and an unattended job that dies
 *     leaves no ledger at all. Anything that goes wrong — a provider outage, a
 *     model that will not produce valid output, a refusal — becomes a recorded
 *     hold with the failure in the decision record, and the run continues.
 *  4. **The record.** Prompt, sources, searches, tool calls, tokens and cost,
 *     all of it, because SPEC 7 asks for the first five and SPEC 11 puts the
 *     sixth on the dashboard: "it may well exceed the gains, and that is itself
 *     a finding worth showing".
 *
 * On the shape of a budget hold: the `rationale` becomes the HOLD event's
 * `reason` verbatim, and SPEC 1.7 wants a real one, so it is written as
 * `budget_exceeded: <what happened>`. The bare machine token is the prefix —
 * greppable in `events.jsonl` — and `meta.agent.abort` carries the structured
 * version for the dashboard.
 */
import { Agent, type AgentResult, type Model } from "@strands-agents/sdk";
import { sha256Hex } from "../brief/hash.js";
import type { PortfolioId } from "../domain/types.js";
import type { MarketDataPort } from "../data/port.js";
import type { AgentsConfig, PortfolioConfig } from "../engine/config.js";
import {
  hold,
  parseDecision,
  type Decider,
  type Decision,
  type DecisionContext,
  type DecisionOutcome,
  type DecisionRecord,
} from "../engine/decision.js";
import { addUsage, priceRun, readUsage, ZERO_USAGE, type RunCost, type TokenUsage } from "./cost.js";
import type { ModelFactory } from "./model.js";
import { buildPrompt, type PlaybookRule } from "./prompt.js";
import { AgentDecisionSchema } from "./schema.js";
import type { WebSearchPort } from "./search.js";
import { AgentToolbox, type ToolboxTranscript } from "./tools.js";

export const AGENT_META_VERSION = 1;

/** Why a run ended the way it did. */
export type AgentOutcomeKind =
  /** The model produced a valid decision. */
  | "decided"
  /** SPEC 7: a turn or token cap tripped. */
  | "budget_exceeded"
  /** The model stopped without answering: a refusal, a content filter. */
  | "no_answer"
  /** Output that never passed the schema, or a provider/tool failure. */
  | "agent_error";

/** Decision records read back for SPEC 7's "last 30 days" block. */
export interface DecisionHistoryPort {
  recent(
    portfolio: PortfolioId,
    sessionDate: string,
    days: number,
  ): Promise<readonly DecisionRecord[]> | readonly DecisionRecord[];
}

/** A history port with nothing in it. The first month, and most tests. */
export const NO_HISTORY: DecisionHistoryPort = { recent: () => [] };

/** Playbooks arrive in phase 8; until then every agent is handed none. */
export interface PlaybookPort {
  rules(portfolio: PortfolioId): Promise<readonly PlaybookRule[]> | readonly PlaybookRule[];
}

export const NO_PLAYBOOK: PlaybookPort = { rules: () => [] };

export interface StrandsAgentOptions {
  readonly portfolio: PortfolioConfig;
  /** The mandate file's text, read once at startup. Never written to. */
  readonly mandate: string;
  readonly models: ModelFactory;
  readonly market: MarketDataPort;
  readonly search: WebSearchPort;
  readonly history?: DecisionHistoryPort;
  readonly playbooks?: PlaybookPort;
  /** Surfaces what the agent did while it did it. Defaults to silence. */
  readonly log?: (line: string) => void;
}

export class StrandsAgentDecider implements Decider {
  readonly portfolio: PortfolioId;

  constructor(private readonly options: StrandsAgentOptions) {
    this.portfolio = options.portfolio.key;
    if (options.portfolio.kind !== "agent") {
      throw new Error(`"${this.portfolio}" is not an agent portfolio`);
    }
  }

  async decide(context: DecisionContext): Promise<DecisionOutcome> {
    const log = this.options.log ?? (() => {});
    const agents = context.simulation.agents;
    const modelId = this.options.portfolio.model ?? "";
    if (modelId.length === 0) {
      return this.failed(
        context,
        "agent_error",
        `"${this.portfolio}" names no model in portfolios.yaml`,
        null,
        null,
      );
    }

    // --- What it will see ---------------------------------------------------
    const playbook = await this.playbookFor(agents);
    const history = await this.historyFor(context, agents);
    const prompt = buildPrompt({
      portfolio: this.options.portfolio,
      mandate: this.options.mandate,
      state: context.state,
      brief: context.brief,
      prices: context.prices,
      universe: context.universe,
      simulation: context.simulation,
      sessionDate: context.sessionDate,
      availableCashEur: context.availableCashEur,
      depositedTodayEur: context.depositedTodayEur,
      tradesThisMonth: context.tradesThisMonth,
      decisionHistory: history,
      playbook,
    });

    const toolbox = new AgentToolbox({
      market: this.options.market,
      universe: context.universe,
      search: this.options.search,
      agents,
      sessionDate: context.sessionDate,
    });

    // --- The run ------------------------------------------------------------
    let model: Model;
    try {
      model = this.options.models.create(this.portfolio, modelId, agents);
    } catch (error) {
      return this.failed(context, "agent_error", describe(error), prompt, toolbox.transcript);
    }

    const agent = new Agent({
      name: `${this.portfolio}-agent`,
      model,
      tools: [...toolbox.build()],
      systemPrompt: prompt.system,
      structuredOutputSchema: AgentDecisionSchema,
      // The printer writes the model's stream to stdout. In a cron job that is
      // noise in the workflow log; the decision record is the output.
      printer: false,
    });

    let result: AgentResult;
    try {
      result = await agent.invoke(prompt.user, {
        limits: {
          turns: agents.maxTurns,
          totalTokens: agents.maxTotalTokensPerRun,
          outputTokens: agents.maxOutputTokensPerRun,
        },
      });
    } catch (error) {
      log(`[${this.portfolio}] model call failed: ${describe(error)}`);
      return this.failed(
        context,
        "agent_error",
        describe(error),
        prompt,
        toolbox.transcript,
        usageFrom(agent),
      );
    }

    const usage = readUsage(result.metrics?.accumulatedUsage);
    const transcript = toolbox.transcript;
    const cost = this.price(context, modelId, usage);
    const turns = result.metrics?.cycleCount ?? 0;

    // --- SPEC 7's budget abort ----------------------------------------------
    if (isBudgetStop(result.stopReason)) {
      const detail = budgetDetail(result.stopReason, agents, turns, usage);
      log(`[${this.portfolio}] ${detail}`);
      return this.outcome(
        context,
        hold(`budget_exceeded: ${detail}`, 1),
        {
          kind: "budget_exceeded",
          stopReason: result.stopReason,
          detail,
          modelId,
          usage,
          cost,
          turns,
          prompt,
          transcript,
        },
      );
    }

    // --- The schema gate ----------------------------------------------------
    if (result.structuredOutput === undefined) {
      const detail = `the model stopped with "${result.stopReason}" without submitting a decision`;
      log(`[${this.portfolio}] ${detail}`);
      return this.outcome(
        context,
        hold(`no_answer: ${detail}. No order was placed.`, 1),
        {
          kind: "no_answer",
          stopReason: result.stopReason,
          detail,
          modelId,
          usage,
          cost,
          turns,
          prompt,
          transcript,
        },
      );
    }

    let decision: Decision;
    try {
      // The SDK validated this against the same schema before handing it back.
      // Parsing again is not paranoia about the SDK: it is the guarantee that
      // *whatever* produced a decision, the ledger only ever sees output that
      // passed the one gate — and that gate lives in the engine, not here.
      decision = parseDecision(result.structuredOutput, this.portfolio);
    } catch (error) {
      log(`[${this.portfolio}] invalid decision: ${describe(error)}`);
      return this.outcome(
        context,
        hold(
          `agent_error: the decision did not pass validation (${describe(error)}). No order was placed.`,
          1,
        ),
        {
          kind: "agent_error",
          stopReason: result.stopReason,
          detail: describe(error),
          modelId,
          usage,
          cost,
          turns,
          prompt,
          transcript,
          rejectedOutput: result.structuredOutput,
        },
      );
    }

    log(
      `[${this.portfolio}] ${decision.action} (confidence ${decision.confidence}) — ` +
        `${turns} turn(s), ${transcript.toolCallsUsed} tool call(s), ${transcript.searchesUsed} search(es), ` +
        `${usage.totalTokens} tokens, ${formatCost(cost)}`,
    );

    return this.outcome(context, decision, {
      kind: "decided",
      stopReason: result.stopReason,
      detail: null,
      modelId,
      usage,
      cost,
      turns,
      prompt,
      transcript,
    });
  }

  // --- Inputs ---------------------------------------------------------------

  private async playbookFor(agents: AgentsConfig): Promise<readonly PlaybookRule[]> {
    // SPEC 5 and SPEC 10: a frozen portfolio "never receives a playbook". The
    // prompt builder drops it too; refusing to even fetch it means there is no
    // path by which one could arrive.
    if (this.options.portfolio.learning === "frozen") return [];
    void agents;
    const port = this.options.playbooks ?? NO_PLAYBOOK;
    try {
      return await port.rules(this.portfolio);
    } catch {
      return [];
    }
  }

  private async historyFor(
    context: DecisionContext,
    agents: AgentsConfig,
  ): Promise<readonly DecisionRecord[]> {
    const port = this.options.history ?? NO_HISTORY;
    try {
      return await port.recent(this.portfolio, context.sessionDate, agents.decisionHistoryDays);
    } catch {
      // A missing history thins the prompt; it does not stop the agent. The
      // gap shows up as "Nothing yet" in the prompt, which the record keeps.
      return [];
    }
  }

  // --- Output ---------------------------------------------------------------

  private price(context: DecisionContext, modelId: string, usage: TokenUsage): RunCost {
    const usdPerEur =
      context.brief.fx.find((pair) => pair.base === "EUR" && pair.quote === "USD")?.rate ?? null;
    return priceRun(modelId, usage, context.simulation.agents, usdPerEur);
  }

  /** A failure before the model was ever called. */
  private failed(
    context: DecisionContext,
    kind: AgentOutcomeKind,
    detail: string,
    prompt: ReturnType<typeof buildPrompt> | null,
    transcript: ToolboxTranscript | null,
    usage: TokenUsage = ZERO_USAGE,
  ): DecisionOutcome {
    const modelId = this.options.portfolio.model ?? "(none)";
    return this.outcome(
      context,
      hold(`${kind}: ${detail}. No order was placed.`, 1),
      {
        kind,
        stopReason: null,
        detail,
        modelId,
        usage,
        cost: this.price(context, modelId, usage),
        turns: 0,
        prompt,
        transcript,
      },
    );
  }

  private outcome(
    context: DecisionContext,
    decision: Decision,
    run: {
      readonly kind: AgentOutcomeKind;
      readonly stopReason: string | null;
      readonly detail: string | null;
      readonly modelId: string;
      readonly usage: TokenUsage;
      readonly cost: RunCost;
      readonly turns: number;
      readonly prompt: ReturnType<typeof buildPrompt> | null;
      readonly transcript: ToolboxTranscript | null;
      readonly rejectedOutput?: unknown;
    },
  ): DecisionOutcome {
    const agents = context.simulation.agents;
    return {
      decision,
      meta: {
        agent: {
          metaVersion: AGENT_META_VERSION,
          outcome: run.kind,
          stopReason: run.stopReason,
          detail: run.detail,
          // SPEC 7: "Record model ID, input/output tokens and computed cost in
          // every decision record."
          model: { id: run.modelId, provider: this.options.models.kind },
          usage: run.usage,
          cost: {
            usd: run.cost.usd,
            eur: run.cost.eur,
            usdPerEur: run.cost.usdPerEur,
            note: run.cost.note,
          },
          turns: run.turns,
          limits: {
            maxTurns: agents.maxTurns,
            maxToolCalls: agents.maxToolCalls,
            maxWebSearches: agents.maxWebSearches,
            maxTotalTokensPerRun: agents.maxTotalTokensPerRun,
            maxOutputTokensPerRun: agents.maxOutputTokensPerRun,
          },
          // SPEC 7: "Archive every query and every returned snippet into the
          // decision record verbatim."
          toolCalls: run.transcript?.calls ?? [],
          searches: run.transcript?.searches ?? [],
          toolCallsUsed: run.transcript?.toolCallsUsed ?? 0,
          searchesUsed: run.transcript?.searchesUsed ?? 0,
          searchProvider: this.options.search.provider,
          capReached: run.transcript?.capReached ?? false,
          // The whole prompt, so the decision's inputs are recoverable rather
          // than reconstructible-in-principle. The hashes make it cheap to ask
          // "was this the same mandate?" without diffing the prose.
          prompt: {
            system: run.prompt?.system ?? null,
            user: run.prompt?.user ?? null,
            hash:
              run.prompt === null ? null : `sha256:${sha256Hex(run.prompt.serialized)}`,
          },
          mandateHash: `sha256:${sha256Hex(this.options.mandate)}`,
          playbookInjected: this.options.portfolio.learning === "frozen" ? false : null,
          ...(run.rejectedOutput === undefined ? {} : { rejectedOutput: run.rejectedOutput }),
        },
      },
    };
  }
}

// --- Budget ------------------------------------------------------------------

/** The stop reasons the SDK reports when one of `limits` trips. */
const BUDGET_STOPS = new Set(["limitTurns", "limitTotalTokens", "limitOutputTokens"]);

export function isBudgetStop(stopReason: string): boolean {
  return BUDGET_STOPS.has(stopReason);
}

function budgetDetail(
  stopReason: string,
  agents: AgentsConfig,
  turns: number,
  usage: TokenUsage,
): string {
  switch (stopReason) {
    case "limitTurns":
      return `the ${agents.maxTurns}-turn limit was reached after ${turns} turn(s) without a decision`;
    case "limitTotalTokens":
      return `the ${agents.maxTotalTokensPerRun}-token budget was spent (${usage.totalTokens} used) without a decision`;
    case "limitOutputTokens":
      return `the ${agents.maxOutputTokensPerRun}-output-token budget was spent (${usage.outputTokens} used) without a decision`;
    default:
      return `the run hit a budget limit (${stopReason})`;
  }
}

// --- Helpers ------------------------------------------------------------------

/** Usage the agent accumulated before it threw, if any is reachable. */
function usageFrom(agent: Agent): TokenUsage {
  try {
    return readUsage(agent.metrics.accumulatedUsage);
  } catch {
    return ZERO_USAGE;
  }
}

/** Sum usage across invocations. Exported for the review pass in phase 8. */
export function totalUsage(runs: readonly TokenUsage[]): TokenUsage {
  return runs.reduce(addUsage, ZERO_USAGE);
}

function formatCost(cost: RunCost): string {
  if (cost.usd === null) return "cost unknown";
  const eur = cost.eur === null ? "" : ` / ${cost.eur.toFixed(4)} EUR`;
  return `$${cost.usd.toFixed(4)}${eur}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
