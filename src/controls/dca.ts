/**
 * The `dca` control (SPEC 5).
 *
 * "Buys a single global equity ETF with the full contribution every month.
 * Never sells."
 *
 * This is the portfolio every agent is measured against — "the headline number
 * of this project is each agent's return relative to `dca`, after fees" — so
 * it is deliberately the dullest code in the repository. No prices are read,
 * no conditions are evaluated, nothing is timed. On a contribution day it
 * deploys the cash; on every other day it holds and says so.
 *
 * Two decisions worth naming:
 *
 *  - It deploys *all* available cash, not exactly the contribution. Fees and
 *    4dp share rounding leave a few cents behind every month, and a control
 *    that let those accumulate would slowly become a cash-and-ETF portfolio
 *    and quietly understate the benchmark it exists to provide.
 *  - The instrument is `dcaInstrument` from `universe.yaml`, which is also
 *    SPEC 10's GLOBAL benchmark. One name in one place: the control and the
 *    benchmark cannot drift apart.
 */
import { isContributionSession } from "../engine/deposits.js";
import { hold, trade, type Decider, type Decision, type DecisionContext } from "../engine/decision.js";
import type { PortfolioId } from "../domain/types.js";

export class DcaControl implements Decider {
  constructor(readonly portfolio: PortfolioId) {}

  decide(context: DecisionContext): Decision {
    const ticker = context.universe.document.dcaInstrument;

    if (!isContributionSession(context.state, context.sessionDate)) {
      return hold(
        `dca holds by construction: ${context.sessionDate} is not a contribution session. Never sells.`,
        5,
      );
    }

    const budget = context.availableCashEur;
    if (budget < context.simulation.minOrderEur) {
      return hold(
        `dca has ${budget.toFixed(2)} EUR available, below the ${context.simulation.minOrderEur.toFixed(2)} EUR minimum order; the contribution carries to next month.`,
        5,
      );
    }

    return trade(
      `Monthly contribution of ${context.depositedTodayEur.toFixed(2)} EUR deployed into ${ticker}, together with ${(budget - context.depositedTodayEur).toFixed(2)} EUR left over from earlier months.`,
      {
        ticker,
        side: "buy",
        targetEur: budget,
        thesis: `Buy and hold a single global equity ETF. This control expresses no view: it is the passive baseline every agent is scored against.`,
        // SPEC 7 requires an invalidation on every order, and the honest one
        // for a control is that there isn't one. Saying so is more useful than
        // inventing a condition the control would never act on anyway.
        invalidation: `Nothing invalidates this order. dca never sells; the strategy is falsified only by an agent beating it after fees, which is the experiment.`,
      },
      { confidence: 5, sourcesUsed: [context.brief.briefHash] },
    );
  }
}
