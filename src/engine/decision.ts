/**
 * The decision contract (SPEC 7, SPEC 1.7).
 *
 * Both halves of the cast produce one of these per portfolio per day: the
 * deterministic controls of phase 4 and the Strands agents of phases 5-6. They
 * share the type deliberately — the engine must not be able to tell them
 * apart, or the controls stop being a control of the pipeline and become a
 * second pipeline that happens to run alongside it.
 *
 * "Every decision is recorded, including decisions to do nothing" (SPEC 1.7),
 * so `rationale` is required on a hold exactly as it is on a trade, and the
 * record is written before the orders are validated — a decision that produces
 * only rejections still happened and still has to be auditable.
 */
import { z } from "zod";
import type { PortfolioState } from "../domain/replay.js";
import type { IsoDate, IsoTimestamp, PortfolioId, Ticker } from "../domain/types.js";
import type { Universe } from "../data/universe.js";
import type { BriefDocument } from "../brief/types.js";
import type { PortfolioConfig, SimulationConfig } from "./config.js";
import type { SessionPrices } from "./pricing.js";

/** SPEC 7's output contract, minus the fields only an LLM can fill. */
export const ProposedOrderSchema = z.object({
  ticker: z.string().min(1),
  side: z.literal(["buy", "sell"]),
  /** EUR to deploy, not a share count (SPEC 7). */
  targetEur: z.number().finite().positive(),
  thesis: z.string().min(1),
  /** SPEC 7: mandatory and non-empty. An agent that cannot falsify holds. */
  invalidation: z.string().min(1),
});

export const DecisionSchema = z.object({
  action: z.literal(["trade", "hold"]),
  /** Required for both outcomes. */
  rationale: z.string().min(1),
  confidence: z.number().int().min(1).max(5),
  orders: z.array(ProposedOrderSchema),
  sourcesUsed: z.array(z.string()),
});

export type ProposedOrder = Readonly<z.infer<typeof ProposedOrderSchema>>;
export type Decision = Readonly<z.infer<typeof DecisionSchema>>;

/**
 * Everything a decider is given. Deliberately a value, not a handle: a control
 * or an agent can read this but cannot reach back into the ledger, so the only
 * way to move money is to return orders and let the validator judge them.
 */
export interface DecisionContext {
  readonly portfolio: PortfolioConfig;
  /** State after this session's fills, corporate actions and deposit. */
  readonly state: PortfolioState;
  readonly brief: BriefDocument;
  /**
   * The brief's prices, indexed. Closes only, from the session just ended —
   * the same numbers the brief prints, reachable without re-parsing it.
   * There is no path from here to a later session's prices (SPEC 1.1).
   */
  readonly prices: SessionPrices;
  readonly universe: Universe;
  readonly simulation: SimulationConfig;
  /** The session the brief describes. Orders from it fill the next one. */
  readonly sessionDate: IsoDate;
  /** Cash above the guardrail floor, which is what an order may actually use. */
  readonly availableCashEur: number;
  /** Credited this session, 0 on any day that is not a contribution day. */
  readonly depositedTodayEur: number;
  /** Trades already used this month against `maxTradesPerMonth`. */
  readonly tradesThisMonth: number;
}

/** A control or an agent. Async so phase 5 can drop a Strands agent in as-is. */
export interface Decider {
  readonly portfolio: PortfolioId;
  decide(context: DecisionContext): Promise<Decision> | Decision;
}

// --- The committed record ---------------------------------------------------

/**
 * What each proposed order actually became. Recording the rejection next to
 * the intent is the point: a decision record that showed only the orders that
 * survived would make the validator invisible, and SPEC 14 asks for exactly
 * this evidence — an off-whitelist ticker produces a rejection with a reason.
 */
export const OrderOutcomeSchema = z.object({
  orderId: z.string().min(1),
  ticker: z.string(),
  side: z.literal(["buy", "sell"]),
  targetEur: z.number().finite(),
  thesis: z.string(),
  invalidation: z.string(),
  status: z.literal(["placed", "rejected"]),
  reasonCode: z.string().nullable(),
  detail: z.string().nullable(),
});

export const DecisionRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  decisionId: z.string().min(1),
  portfolio: z.string().min(1),
  /** The session the decision was taken on; it fills on the next one. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decidedAt: z.string(),
  /** SPEC 6: every decision record stores the hash of the brief it saw. */
  briefHash: z.string(),
  /** `control` or `agent`, so the dashboard never mixes the two up. */
  kind: z.literal(["control", "agent"]),
  action: z.literal(["trade", "hold"]),
  rationale: z.string().min(1),
  confidence: z.number().int().min(1).max(5),
  orders: z.array(OrderOutcomeSchema),
  sourcesUsed: z.array(z.string()),
  /**
   * Free-form, deterministic detail from the decider: the RNG draw that chose
   * a ticker, the cash it had to work with. Phase 5 adds model id, tokens and
   * cost here (SPEC 7).
   */
  meta: z.record(z.string(), z.unknown()),
});

export type OrderOutcome = Readonly<z.infer<typeof OrderOutcomeSchema>>;
export type DecisionRecord = Readonly<z.infer<typeof DecisionRecordSchema>>;

export const DECISION_SCHEMA_VERSION = 1;

/** A hold, with the reason that made it one. */
export function hold(rationale: string, confidence = 3): Decision {
  return { action: "hold", rationale, confidence, orders: [], sourcesUsed: [] };
}

/** A single-order trade decision, which is all either control ever produces. */
export function trade(
  rationale: string,
  order: ProposedOrder,
  options: { readonly confidence?: number; readonly sourcesUsed?: readonly string[] } = {},
): Decision {
  return {
    action: "trade",
    rationale,
    confidence: options.confidence ?? 3,
    orders: [order],
    sourcesUsed: [...(options.sourcesUsed ?? [])],
  };
}

/**
 * Validate whatever a decider returned before the engine acts on it.
 *
 * Controls are typed and cannot really fail this; agents are a model's JSON
 * and absolutely can. Running both through the same gate means phase 5 adds no
 * new trust boundary — this one is already load-bearing and already tested.
 */
export function parseDecision(input: unknown, portfolio: PortfolioId): Decision {
  const result = DecisionSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    throw new DecisionError(
      `"${portfolio}" returned an invalid decision${where}: ${issue?.message ?? "unknown error"}`,
    );
  }
  const decision = result.data;
  if (decision.action === "hold" && decision.orders.length > 0) {
    throw new DecisionError(`"${portfolio}" held but attached ${decision.orders.length} order(s)`);
  }
  if (decision.action === "trade" && decision.orders.length === 0) {
    // A "trade" with nothing in it is a hold that would vanish from the ledger.
    throw new DecisionError(`"${portfolio}" chose to trade but attached no orders`);
  }
  return decision;
}

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

/** Where `data/decisions/` keeps one portfolio's record for one session. */
export function decisionRecordPath(date: IsoDate, portfolio: PortfolioId): string {
  return `decisions/${date}/${portfolio}.json`;
}

export interface BuildRecordInput {
  readonly decisionId: string;
  readonly portfolio: PortfolioConfig;
  readonly date: IsoDate;
  readonly decidedAt: IsoTimestamp;
  readonly briefHash: string;
  readonly decision: Decision;
  readonly outcomes: readonly OrderOutcome[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export function buildDecisionRecord(input: BuildRecordInput): DecisionRecord {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    decisionId: input.decisionId,
    portfolio: input.portfolio.key,
    date: input.date,
    decidedAt: input.decidedAt,
    briefHash: input.briefHash,
    kind: input.portfolio.kind,
    action: input.decision.action,
    rationale: input.decision.rationale,
    confidence: input.decision.confidence,
    orders: [...input.outcomes],
    sourcesUsed: [...input.decision.sourcesUsed],
    meta: { ...(input.meta ?? {}) },
  };
}

/** The tickers a decision wants to touch, for logging and the dry-run summary. */
export function touchedTickers(decision: Decision): readonly Ticker[] {
  return [...new Set(decision.orders.map((order) => order.ticker))].sort();
}
