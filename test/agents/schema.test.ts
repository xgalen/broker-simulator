/**
 * The output contract (SPEC 7).
 *
 * "Structured output, validated with zod before anything touches the ledger."
 * These are the assertions that keep that sentence true: that the schema the
 * model is shown and the schema the engine enforces are the same schema, and
 * that the things SPEC 7 calls mandatory are actually refused when missing.
 */
import { describe, expect, it } from "vitest";
import { AgentDecisionSchema, AgentOrderSchema } from "../../src/agents/schema.js";
import { DecisionSchema, parseDecision } from "../../src/engine/decision.js";
import { mockBuy, mockHold } from "../helpers/agents.js";

const buy = mockBuy({ ticker: "SAP.DE", targetEur: 40 });

describe("the agent output contract", () => {
  it("accepts a well-formed trade and a well-formed hold", () => {
    expect(AgentDecisionSchema.safeParse(buy).success).toBe(true);
    expect(AgentDecisionSchema.safeParse(mockHold()).success).toBe(true);
  });

  it("is the same contract the engine enforces", () => {
    // The describe()-laden copy exists so the model gets field documentation in
    // its JSON schema. If the two ever disagree, a decision could pass the
    // model's gate and fail the ledger's — so they are checked against each
    // other on real values, in both directions, as well as at the type level.
    for (const value of [buy, mockHold()]) {
      expect(AgentDecisionSchema.safeParse(value).success).toBe(
        DecisionSchema.safeParse(value).success,
      );
      expect(AgentDecisionSchema.parse(value)).toEqual(DecisionSchema.parse(value));
    }
    expect(Object.keys(AgentDecisionSchema.shape).sort()).toEqual(
      Object.keys(DecisionSchema.shape).sort(),
    );
    expect(Object.keys(AgentOrderSchema.shape).sort()).toEqual(
      Object.keys(DecisionSchema.shape.orders.element.shape).sort(),
    );
  });

  it("refuses an order with no invalidation (SPEC 7)", () => {
    // "The `invalidation` field is mandatory and non-empty. An agent that
    // cannot say what would falsify its thesis should be holding."
    const empty = structuredClone(buy) as { orders: { invalidation: string }[] };
    empty.orders[0]!.invalidation = "";
    expect(AgentDecisionSchema.safeParse(empty).success).toBe(false);

    const missing = structuredClone(buy) as { orders: Record<string, unknown>[] };
    delete missing.orders[0]!["invalidation"];
    expect(AgentDecisionSchema.safeParse(missing).success).toBe(false);
  });

  it("refuses a decision with no rationale, on a hold as much as on a trade", () => {
    // SPEC 1.7: every decision is recorded, including decisions to do nothing.
    expect(AgentDecisionSchema.safeParse({ ...mockHold(), rationale: "" }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ ...buy, rationale: "" }).success).toBe(false);
  });

  it("refuses a confidence outside 1..5, and a fractional one", () => {
    for (const confidence of [0, 6, 2.5, -1]) {
      expect(AgentDecisionSchema.safeParse({ ...mockHold(), confidence }).success, `${confidence}`).toBe(
        false,
      );
    }
  });

  it("refuses a target that is not a positive, finite EUR amount", () => {
    for (const targetEur of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const order = mockBuy({ ticker: "SAP.DE", targetEur: 1 }) as { orders: { targetEur: number }[] };
      order.orders[0]!.targetEur = targetEur;
      expect(AgentDecisionSchema.safeParse(order).success, `${targetEur}`).toBe(false);
    }
  });

  it("refuses the two ways action and orders can disagree", () => {
    // Both pass the shape and fail the contract, which is why `parseDecision`
    // checks them separately: a `trade` with no orders is a hold that would
    // vanish from the ledger, and a `hold` with orders is a trade nobody
    // admitted to.
    expect(() =>
      parseDecision({ ...mockHold(), action: "trade" }, "value"),
    ).toThrow(/chose to trade but attached no orders/);
    expect(() => parseDecision({ ...buy, action: "hold" }, "value")).toThrow(
      /held but attached 1 order/,
    );
  });

  it("names the portfolio and the field when it refuses", () => {
    // These messages end up in the workflow log at 22:30 on a weeknight.
    expect(() => parseDecision({ ...buy, confidence: 9 }, "value")).toThrow(/"value"/);
    expect(() => parseDecision({ ...buy, confidence: 9 }, "value")).toThrow(/confidence/);
  });

  it("documents every field it asks the model to fill", () => {
    // The descriptions are what `zodSchemaToJsonSchema` turns into the tool's
    // JSON schema — they are the only instructions the model gets about the
    // fields themselves, so an undocumented one is a field filled by guesswork.
    for (const [name, field] of Object.entries(AgentDecisionSchema.shape)) {
      expect(field.description, name).toBeTruthy();
    }
    for (const [name, field] of Object.entries(AgentOrderSchema.shape)) {
      expect(field.description, name).toBeTruthy();
    }
  });
});
