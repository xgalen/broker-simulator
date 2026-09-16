/**
 * The deterministic control portfolios (SPEC 5, SPEC 12 phase 4).
 *
 * "Two deterministic controls (no LLM, pure code — build these first)... The
 * controls exist because '+3.2%' is meaningless on its own."
 *
 * They implement the same `Decider` interface the Strands agents will in phase
 * 5, and the engine cannot tell the two apart. That is the point of building
 * them first: by the time an agent is plugged in, the fills, the deposits, the
 * validator and the ledger have all been proven by something that costs
 * nothing to run and produces the same answer every time.
 */
import type { PortfolioConfig } from "../engine/config.js";
import type { Decider } from "../engine/decision.js";
import { DcaControl } from "./dca.js";
import { RandomControl } from "./random.js";

export * from "./dca.js";
export * from "./random.js";
export * from "./rng.js";

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/** Build the decider a control portfolio's config describes. */
export function createControl(portfolio: PortfolioConfig): Decider {
  const spec = portfolio.control;
  if (spec === undefined) {
    throw new ControlError(`"${portfolio.key}" has no control block`);
  }
  switch (spec.type) {
    case "dca":
      return new DcaControl(portfolio.key);
    case "random":
      return new RandomControl(portfolio.key, spec.seed);
  }
}

/** Every enabled control in the roster, as deciders. */
export function createControls(portfolios: readonly PortfolioConfig[]): Map<string, Decider> {
  const deciders = new Map<string, Decider>();
  for (const portfolio of portfolios) {
    if (portfolio.kind !== "control" || !portfolio.enabled) continue;
    deciders.set(portfolio.key, createControl(portfolio));
  }
  return deciders;
}
