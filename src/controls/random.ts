/**
 * The `random` control (SPEC 5).
 *
 * "Each month picks uniformly at random from the whitelist and buys. Seeded
 * RNG, seed committed, so it is reproducible."
 *
 * Its job is to answer a question `dca` cannot: how much of an agent's result
 * is skill and how much is simply having been long something. A monkey with a
 * dartboard and the same fee schedule is the right comparison for that, and it
 * has to be a *reproducible* monkey or its result is one sample of a
 * distribution nobody can re-draw.
 *
 * Reproducibility comes from keying the stream by the contribution month
 * rather than carrying an RNG cursor between runs (see `rng.ts`). October's
 * pick is a pure function of the committed seed and the string "2026-10", so
 * it survives a crashed run, a retried job, and a full rebuild from
 * `events.jsonl`.
 */
import { isContributionSession, monthOf } from "../engine/deposits.js";
import { hold, trade, type Decider, type Decision, type DecisionContext } from "../engine/decision.js";
import type { PortfolioId, Ticker } from "../domain/types.js";
import { nextIndex, streamFor } from "./rng.js";

/**
 * How many draws to spend looking for a tradable name before giving up.
 *
 * A draw can land on an instrument with no usable close — a suspended listing,
 * a gap in the feed — and re-drawing keeps the control uniform over the names
 * that can actually be bought. The cap stops a mostly-dark brief from spinning,
 * and the draws are deterministic, so a rerun makes exactly the same sequence
 * of attempts.
 */
const MAX_DRAWS = 32;

export interface RandomDraw {
  readonly ticker: Ticker;
  readonly attempts: number;
  readonly candidates: number;
  readonly month: string;
}

export class RandomControl implements Decider {
  constructor(
    readonly portfolio: PortfolioId,
    private readonly seed: string,
  ) {}

  /**
   * The month's pick, exposed so the decision record can archive exactly how
   * it was arrived at and a test can re-derive it without running the engine.
   */
  draw(context: DecisionContext): RandomDraw | null {
    const month = monthOf(context.sessionDate);
    const candidates = context.universe.tickers;
    if (candidates.length === 0) return null;

    const random = streamFor(this.seed, month);
    for (let attempt = 1; attempt <= MAX_DRAWS; attempt += 1) {
      const ticker = candidates[nextIndex(random, candidates.length)];
      if (ticker === undefined) continue;
      if (context.prices.closeOf(ticker) !== null) {
        return { ticker, attempts: attempt, candidates: candidates.length, month };
      }
    }
    return null;
  }

  decide(context: DecisionContext): Decision {
    if (!isContributionSession(context.state, context.sessionDate)) {
      return hold(
        `random holds by construction: ${context.sessionDate} is not a contribution session. It buys once a month and never sells.`,
        3,
      );
    }

    const budget = context.availableCashEur;
    if (budget < context.simulation.minOrderEur) {
      return hold(
        `random has ${budget.toFixed(2)} EUR available, below the ${context.simulation.minOrderEur.toFixed(2)} EUR minimum order; the contribution carries to next month.`,
        3,
      );
    }

    const picked = this.draw(context);
    if (picked === null) {
      return hold(
        `random drew ${MAX_DRAWS} times without landing on a whitelisted instrument with a usable close on ${context.sessionDate}.`,
        1,
      );
    }

    return trade(
      `Uniform draw over ${picked.candidates} whitelisted instruments for ${picked.month} selected ${picked.ticker} (draw ${picked.attempts}, seed "${this.seed}"). ${budget.toFixed(2)} EUR deployed.`,
      {
        ticker: picked.ticker,
        side: "buy",
        targetEur: budget,
        thesis: `No thesis. This control exists to measure how much of an agent's result survives comparison with an arbitrary long position carrying identical fees.`,
        invalidation: `Nothing invalidates this order. The control never sells and holds no view that could be proven wrong.`,
      },
      { confidence: 1, sourcesUsed: [context.brief.briefHash] },
    );
  }
}
