/**
 * SPEC 7's output contract, as the model sees it.
 *
 * `engine/decision.ts` already defines this shape — it is what every decider,
 * control or agent, must return — and that schema stays the gate the ledger
 * sits behind. This file is not a second definition of the contract; it is the
 * same contract with the field documentation a model needs in order to fill it
 * in, because `zodSchemaToJsonSchema` turns `.describe()` into the JSON schema
 * the structured-output tool advertises.
 *
 * The two are checked against each other at the bottom of this file and again
 * in `test/agents/schema.test.ts`, so a field added to one and not the other is
 * a failure rather than a silent divergence. And whatever this schema accepts,
 * the value still goes through `parseDecision` before the engine sees it: the
 * model's output crosses exactly one trust boundary, and it is the existing
 * one.
 */
import { z } from "zod";
import type { Decision, ProposedOrder } from "../engine/decision.js";

export const AgentOrderSchema = z.object({
  ticker: z
    .string()
    .min(1)
    .describe(
      "Ticker exactly as it appears in the whitelist you were given. An order " +
        "for anything else is rejected before it reaches the ledger.",
    ),
  side: z.literal(["buy", "sell"]).describe("buy or sell. Shorting is not permitted."),
  targetEur: z
    .number()
    .finite()
    .positive()
    .describe(
      "How many EUR to deploy, not a share count. For a buy this is the total " +
        "cash leaving the portfolio, fee and FX spread included, so it may not " +
        "exceed the cash available to you. For a sell it is the EUR value of " +
        "the holding to dispose of; a target at or above the whole position " +
        "closes it.",
    ),
  thesis: z
    .string()
    .min(1)
    .describe(
      "Why this instrument, at this price, today. Cite the numbers you are " +
        "relying on and where they came from — a multiple, a return on " +
        "capital, a comparison. An assertion with no number behind it is not a " +
        "thesis.",
    ),
  invalidation: z
    .string()
    .min(1)
    .describe(
      "What would prove this thesis wrong: which measurable fact, moving which " +
        "way, over what period. Mandatory and non-empty. A price level is not " +
        "an invalidation — it describes the market, not the business. If you " +
        "cannot say what would falsify the thesis, hold instead of trading.",
    ),
});

export const AgentDecisionSchema = z
  .object({
    action: z
      .literal(["trade", "hold"])
      .describe(
        "`trade` if and only if `orders` is non-empty; `hold` if and only if " +
          "it is empty. Holding is a first-class outcome and needs no excuse.",
      ),
    rationale: z
      .string()
      .min(1)
      .describe(
        "Required for both outcomes. On a hold, say what you looked at and why " +
          "nothing cleared the bar — 'no compelling opportunities' is not a " +
          "rationale. This is written to the ledger verbatim.",
      ),
    confidence: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("1 (barely) to 5 (high conviction)."),
    orders: z
      .array(AgentOrderSchema)
      .describe("Empty on a hold. One entry per instrument; never two for the same ticker."),
    sourcesUsed: z
      .array(z.string())
      .describe(
        "Every URL, headline id or tool result you actually relied on, " +
          "including the brief hash if the brief informed the decision. This is " +
          "the audit trail: a source you did not read does not belong here, and " +
          "one you did read but omit makes the decision unauditable.",
      ),
  })
  .describe(
    "The decision for one portfolio for one session. Submit it exactly once, " +
      "as the final action of the run.",
  );

export type AgentOrder = Readonly<z.infer<typeof AgentOrderSchema>>;
export type AgentDecision = Readonly<z.infer<typeof AgentDecisionSchema>>;

// The model's contract and the engine's contract are the same contract. If a
// field is added to one and not the other, these lines stop compiling — which
// is the whole reason the describe()-laden copy is allowed to exist.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type ContractChecks = [
  Exact<AgentDecision, Decision>,
  Exact<AgentOrder, ProposedOrder>,
];
