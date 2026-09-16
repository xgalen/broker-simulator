/**
 * What an agent is shown (SPEC 7).
 *
 * "Each run receives: the shared daily brief; its own portfolio state — cash,
 * positions, cost basis, unrealized P&L, trades left this month; its own
 * decision history for the last 30 days — rationales included; its mandate and
 * its constraints, stated as hard limits; its playbook."
 *
 * Everything here is a pure function of those inputs. That matters for three
 * separate reasons:
 *
 *  - SPEC 1.4: the brief is built once and handed **unchanged** to every
 *    agent. The rendering below is deterministic and identical for all of
 *    them, so what differs between portfolios is the mandate and the state,
 *    never the view of the market.
 *  - SPEC 14 asks for assertions *on the serialized prompt*: that a
 *    `probation` rule never appears in one, and that `news-frozen` never
 *    receives playbook content. A prompt that is a value, not a side effect,
 *    is a prompt a test can read.
 *  - The whole prompt is committed to the decision record. A decision whose
 *    inputs are not recoverable is not auditable, and reconstructing them
 *    later from a template is exactly the kind of "close enough" that makes an
 *    audit worthless.
 *
 * The guardrails are stated to the model as hard limits, and the model is told
 * plainly that they are enforced by code afterwards. That is not redundancy:
 * an agent that knows the validator will reject a 200 EUR order from a 60 EUR
 * portfolio spends its turn on something useful instead.
 */
import type { BriefDocument } from "../brief/types.js";
import type { PortfolioState } from "../domain/replay.js";
import type { IsoDate, PortfolioId, Ticker } from "../domain/types.js";
import { valuePortfolio } from "../domain/valuation.js";
import type { PortfolioValuation } from "../domain/valuation.js";
import type { Universe } from "../data/universe.js";
import type { PortfolioConfig, SimulationConfig } from "../engine/config.js";
import type { DecisionRecord } from "../engine/decision.js";
import type { SessionPrices } from "../engine/pricing.js";

/**
 * A playbook rule, as the daily prompt sees one (SPEC 10).
 *
 * Phase 8 builds the review pass that writes these and the store they live in;
 * phase 5 only needs to know which of them may be shown, because the rule that
 * decides is a property of the prompt and is testable today. Until then the
 * list handed in is always empty.
 */
export interface PlaybookRule {
  readonly id: string;
  readonly text: string;
  readonly status: "probation" | "active" | "retired";
}

export interface PromptInput {
  readonly portfolio: PortfolioConfig;
  /** The mandate file's contents, read by the caller. Never written to. */
  readonly mandate: string;
  readonly state: PortfolioState;
  readonly brief: BriefDocument;
  readonly prices: SessionPrices;
  readonly universe: Universe;
  readonly simulation: SimulationConfig;
  readonly sessionDate: IsoDate;
  readonly availableCashEur: number;
  readonly depositedTodayEur: number;
  readonly tradesThisMonth: number;
  /** Newest first. The caller has already windowed it to 30 days. */
  readonly decisionHistory: readonly DecisionRecord[];
  /** SPEC 10. Empty until phase 8; `frozen` portfolios are never given any. */
  readonly playbook?: readonly PlaybookRule[];
}

export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
  /** Concatenated, which is what SPEC 14's assertions read. */
  readonly serialized: string;
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const system = buildSystemPrompt(input);
  const user = buildUserPrompt(input);
  return { system, user, serialized: `${system}\n\n${user}` };
}

// --- The system prompt ------------------------------------------------------

function buildSystemPrompt(input: PromptInput): string {
  const { portfolio, simulation } = input;
  const guardrails = portfolio.guardrails;
  const sections: string[] = [];

  sections.push(
    [
      `You are the \`${portfolio.key}\` portfolio manager in a paper-trading research simulation.`,
      "",
      "No real money is involved and no order you write reaches a broker. The point of",
      "the simulation is the comparison: seven portfolios run side by side against the",
      "same market data, and yours is scored against a passive monthly ETF purchase",
      "after fees. Beating it requires a reason, and the reason is what is recorded.",
      "",
      "You decide once per session, after the close. Anything you order is filled at",
      "the *next* session's open — you never trade at a price you can see.",
    ].join("\n"),
  );

  sections.push(["## Your mandate", "", input.mandate.trim()].join("\n"));

  sections.push(
    [
      "## Hard limits",
      "",
      "These are enforced in code after you answer. An order that breaks one is",
      "rejected with a reason and recorded as a rejection — it does not reach the",
      "ledger, and it does not get a second attempt today. Staying inside them is",
      "cheaper than being refused.",
      "",
      `- **Trades this month:** at most ${guardrails.maxTradesPerMonth}. Used so far: ${input.tradesThisMonth}. Remaining: ${Math.max(0, guardrails.maxTradesPerMonth - input.tradesThisMonth)}.`,
      `- **Minimum holding period:** ${guardrails.minHoldDays} day(s) before a position may be sold.`,
      `- **Position size:** no single name above ${guardrails.maxPositionPct}% of the portfolio, and only once the portfolio is worth more than ${guardrails.positionLimitsActiveAboveEur.toFixed(2)} EUR. Below that, concentration is allowed — a 25% cap on a 50 EUR portfolio would leave you unable to act at all.`,
      `- **Cash floor:** ${guardrails.cashFloorEur.toFixed(2)} EUR must remain uninvested.`,
      `- **Minimum order:** ${simulation.minOrderEur.toFixed(2)} EUR gross. **Fee:** ${simulation.feePerOrderEur.toFixed(2)} EUR per order, paid out of the same cash. **FX spread:** ${simulation.fxSpreadBps} bps on any non-EUR instrument.`,
      "- **No shorting, no leverage, no derivatives.** You may only sell what you hold.",
      "- **Whitelist only.** An order for anything outside the instrument list below is rejected.",
      "",
      `At ${simulation.monthlyDepositEur.toFixed(2)} EUR a month, a ${simulation.feePerOrderEur.toFixed(2)} EUR fee is ${((simulation.feePerOrderEur / simulation.monthlyDepositEur) * 100).toFixed(0)}% of a month's capital before a`,
      "price has moved. Trading because you feel you should is the most reliable way",
      "to lose here.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Tools",
      "",
      `You may make at most **${input.simulation.agents.maxToolCalls} tool calls** in this run, of which at most`,
      `**${input.simulation.agents.maxWebSearches}** may be \`webSearch\`. Every call is archived in the decision record,`,
      "searches with their full results. When the budget is gone the tools refuse and",
      "you decide with what you have.",
      "",
      "- `getPriceHistory(ticker, range)` — daily bars up to today's close. Nothing later exists.",
      "- `getFundamentals(ticker)` — multiples and balance-sheet figures.",
      "- `getNewsForTicker(ticker)` — recent items for one instrument.",
      "- `webSearch(query)` — the open web.",
      "",
      "The brief below is already in front of you. Do not spend a call re-reading",
      "something it already says.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Answering",
      "",
      "Finish by calling the structured-output tool exactly once. Rules the validator",
      "applies to what you submit:",
      "",
      "- `action` is `trade` if and only if `orders` is non-empty.",
      "- `rationale` is required on both outcomes, including a hold. It is written to",
      "  the ledger verbatim and read by a human later. Say what you looked at.",
      "- `targetEur` is EUR to deploy, not a share count, and for a buy it is the total",
      "  cash leaving the portfolio — fee and FX spread included.",
      "- `invalidation` is mandatory on every order and must name something that could",
      "  actually be observed. If you cannot say what would prove the thesis wrong,",
      "  hold instead.",
      "- `sourcesUsed` lists what you actually relied on.",
      "",
      "Holding is a first-class outcome, recorded as such. Most sessions for a",
      "low-turnover mandate are holds, and a hold with a real rationale is worth more",
      "than a trade with a thin one.",
    ].join("\n"),
  );

  const playbook = renderPlaybook(input);
  if (playbook !== null) sections.push(playbook);

  return sections.join("\n\n");
}

/**
 * The playbook block, or `null` when there is nothing to show (SPEC 10).
 *
 * Two rules, both load-bearing and both asserted in `test/agents/prompt.test.ts`:
 *
 *  - A portfolio with `learning: frozen` never receives playbook content in any
 *    month. `news-frozen` is the control for learning itself; a playbook
 *    leaking into its prompt would silently destroy the only comparison this
 *    project exists to make.
 *  - A `probation` rule is never injected. "It appears on the dashboard only.
 *    This is deliberate: what the agent believes it has learned is the
 *    interesting output, and letting it steer capital on three data points is
 *    the expensive one."
 */
function renderPlaybook(input: PromptInput): string | null {
  if (input.portfolio.learning === "frozen") return null;
  const active = (input.playbook ?? []).filter((rule) => rule.status === "active");
  if (active.length === 0) return null;

  return [
    "## Your playbook",
    "",
    "Rules you earned from your own past decisions, promoted only after at least",
    "three closed positions supported them. They are tactics within the mandate,",
    "never a replacement for it, and they cannot widen any limit above.",
    "",
    ...active.map((rule) => `- (${rule.id}) ${rule.text}`),
  ].join("\n");
}

// --- The user prompt --------------------------------------------------------

function buildUserPrompt(input: PromptInput): string {
  const valuation = valuePortfolio(
    input.state,
    input.prices.closingQuotes(input.state.positions.keys()),
  );

  return [
    `# Session ${input.sessionDate}`,
    "",
    `Brief ${input.brief.briefHash}, built ${input.brief.generatedAt}.`,
    "Orders you place today are filled at the next session's open.",
    "",
    renderPortfolio(input, valuation),
    "",
    renderBrief(input),
    "",
    renderHistory(input),
    "",
    "---",
    "",
    "Decide for today.",
  ].join("\n");
}

function renderPortfolio(input: PromptInput, valuation: PortfolioValuation): string {
  const { state, simulation } = input;
  const guardrails = input.portfolio.guardrails;
  const lines: string[] = ["## Your portfolio", ""];

  lines.push(
    `- Total value: **${valuation.totalValueEur.toFixed(2)} EUR** (${valuation.cashEur.toFixed(2)} cash + ${valuation.marketValueEur.toFixed(2)} positions)`,
    `- Cash you may actually deploy today: **${input.availableCashEur.toFixed(2)} EUR** (cash above the ${guardrails.cashFloorEur.toFixed(2)} EUR floor)`,
    `- Contributed to date: ${state.contributedToDateEur.toFixed(2)} EUR` +
      (input.depositedTodayEur > 0
        ? `, of which ${input.depositedTodayEur.toFixed(2)} EUR landed today`
        : ""),
    `- Unrealized P&L: ${sign(valuation.unrealizedPnlEur)} EUR (price ${sign(valuation.unrealizedPricePnlEur)}, FX ${sign(valuation.unrealizedFxPnlEur)})`,
    `- Realized P&L to date: ${sign(state.realizedPnlEur)} EUR`,
    `- Fees paid to date: ${state.feesPaidEur.toFixed(2)} EUR; FX costs ${state.fxCostsPaidEur.toFixed(2)} EUR`,
    `- Trades used this month: ${input.tradesThisMonth} of ${guardrails.maxTradesPerMonth}`,
  );

  const minimum = simulation.minOrderEur + simulation.feePerOrderEur;
  if (input.availableCashEur < minimum) {
    lines.push(
      `- **You cannot buy today.** ${input.availableCashEur.toFixed(2)} EUR is below the ${minimum.toFixed(2)} EUR a smallest valid order costs (${simulation.minOrderEur.toFixed(2)} gross + ${simulation.feePerOrderEur.toFixed(2)} fee).`,
    );
  }

  lines.push("", "### Positions", "");
  if (valuation.positions.length === 0) {
    lines.push("None. Everything is in cash.");
  } else {
    lines.push(
      "| ticker | qty | ccy | price | value EUR | cost EUR | unrealized EUR | price P&L | FX P&L | opened | held days |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const position of valuation.positions) {
      const held = input.state.positions.get(position.ticker);
      const openedTs = held?.openedTs ?? "";
      const opened = openedTs.slice(0, 10);
      lines.push(
        `| ${position.ticker} | ${position.qty} | ${position.currency} | ${position.priceLocal} | ${position.marketValueEur.toFixed(2)} | ${position.costBasisEur.toFixed(2)} | ${sign(position.unrealizedPnlEur)} | ${sign(position.pricePnlEur)} | ${sign(position.fxPnlEur)} | ${opened} | ${opened === "" ? "-" : daysBetween(opened, input.sessionDate)} |`,
      );
    }
    const sellable = valuation.positions.filter((position) => {
      const held = input.state.positions.get(position.ticker);
      return (
        held !== undefined &&
        daysBetween(held.openedTs.slice(0, 10), input.sessionDate) >= guardrails.minHoldDays
      );
    });
    lines.push(
      "",
      sellable.length === valuation.positions.length
        ? `All positions have cleared the ${guardrails.minHoldDays}-day minimum hold.`
        : `Sellable today (past the ${guardrails.minHoldDays}-day minimum hold): ${sellable.length === 0 ? "none" : sellable.map((p) => p.ticker).join(", ")}.`,
    );
  }

  if (input.state.pendingOrders.size > 0) {
    lines.push("", "### Orders already queued for the next open", "");
    for (const { order } of input.state.pendingOrders.values()) {
      lines.push(`- ${order.side} ${order.ticker} for ${order.targetEur.toFixed(2)} EUR`);
    }
    lines.push(
      "",
      "That cash is already committed. Do not queue it twice.",
    );
  }

  return lines.join("\n");
}

function renderBrief(input: PromptInput): string {
  const brief = input.brief;
  const lines: string[] = ["## The daily brief", "", "Identical for every portfolio today."];

  if (brief.fx.length > 0) {
    lines.push("", "### FX", "");
    for (const pair of brief.fx) {
      lines.push(`- ${pair.pair}: ${pair.rate} ${pair.quote} per 1 ${pair.base}`);
    }
  }

  if (brief.references.length > 0) {
    lines.push("", "### Reference levels (context only — not tradable)", "");
    lines.push("| index | level | change |", "|---|---|---|");
    for (const reference of brief.references) {
      lines.push(
        `| ${reference.name} (${reference.ticker}) | ${num(reference.level)} | ${pct(reference.changePct)} |`,
      );
    }
  }

  lines.push("", "### Whitelist at the close", "");
  lines.push(
    "Returns are fractions of price over the trailing window. `-` is data the source did not supply.",
    "",
    "| ticker | name | type | region | sector/exposure | ccy | close | 1d | 5d | 1m | 6m | 1y |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const tickers = Object.keys(brief.instruments).sort();
  for (const ticker of tickers) {
    const instrument = brief.instruments[ticker];
    if (instrument === undefined) continue;
    const tag = instrument.sector ?? instrument.exposure ?? "-";
    lines.push(
      `| ${instrument.ticker} | ${instrument.name} | ${instrument.type} | ${instrument.region} | ${tag} | ${instrument.currency} | ${num(instrument.close)} | ${pct(instrument.returns.d1)} | ${pct(instrument.returns.d5)} | ${pct(instrument.returns.m1)} | ${pct(instrument.returns.m6)} | ${pct(instrument.returns.y1)} |`,
    );
  }

  if (brief.gaps.stale.length > 0 || brief.gaps.missing.length > 0) {
    lines.push("", "### Gaps", "");
    if (brief.gaps.stale.length > 0) {
      lines.push(
        `- Stale (last close predates this session, so **untradable today**): ${brief.gaps.stale.join(", ")}`,
      );
    }
    if (brief.gaps.missing.length > 0) {
      lines.push(`- No quote at all today: ${brief.gaps.missing.join(", ")}`);
    }
  }

  lines.push("", "### Headlines", "");
  if (brief.headlines.length === 0) {
    lines.push("None today.");
  } else {
    for (const headline of brief.headlines) {
      const tagged = headline.tickers.length > 0 ? ` [${headline.tickers.join(", ")}]` : "";
      lines.push(
        `- (${headline.id}) ${headline.title} — ${headline.source}, ${headline.publishedAt}${tagged} ${headline.url}`,
      );
    }
  }

  lines.push("", "### Earnings in the next 7 days", "");
  if (brief.earnings.length === 0) {
    lines.push("None scheduled for whitelisted names.");
  } else {
    for (const entry of brief.earnings) {
      lines.push(`- ${entry.ticker}: ${entry.date}${entry.confirmed ? "" : " (estimated)"}`);
    }
  }

  return lines.join("\n");
}

function renderHistory(input: PromptInput): string {
  const days = input.simulation.agents.decisionHistoryDays;
  const lines: string[] = [
    `## Your last ${days} days of decisions`,
    "",
    "Your own words, newest first. Be consistent with them or contradict them",
    "deliberately — but do not repeat a thesis you have already acted on as though",
    "it were new.",
    "",
  ];

  if (input.decisionHistory.length === 0) {
    lines.push("Nothing yet. This is your first recorded session.");
    return lines.join("\n");
  }

  for (const record of input.decisionHistory) {
    const orders =
      record.orders.length === 0
        ? "held"
        : record.orders
            .map(
              (order) =>
                `${order.side} ${order.ticker} ${order.targetEur.toFixed(2)} EUR (${order.status}${order.reasonCode === null ? "" : `: ${order.reasonCode}`})`,
            )
            .join("; ");
    lines.push(`- **${record.date}** — ${record.action}, confidence ${record.confidence}. ${orders}`);
    lines.push(`  - ${record.rationale}`);
    for (const order of record.orders) {
      if (order.status !== "placed") continue;
      lines.push(`  - ${order.ticker} thesis: ${order.thesis}`);
      lines.push(`  - ${order.ticker} invalidation: ${order.invalidation}`);
    }
  }

  return lines.join("\n");
}

// --- Formatting -------------------------------------------------------------

function num(value: number | null): string {
  return value === null ? "-" : String(value);
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(2)}%`;
}

function sign(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The portfolios whose prompts must never contain playbook content (SPEC 10). */
export function receivesPlaybook(portfolio: PortfolioConfig): boolean {
  return portfolio.learning !== "frozen";
}

/** Named for the decision record, so a reader knows whose prompt this was. */
export function promptOwner(input: PromptInput): PortfolioId {
  return input.portfolio.key;
}

/** Tickers the prompt actually listed, for the tests that check the whitelist. */
export function listedTickers(brief: BriefDocument): readonly Ticker[] {
  return Object.keys(brief.instruments).sort();
}
