# Build spec: `investor-simulator`

Build a GitHub-hosted simulated investing platform where several LLM agents, each with its own
identical budget, make paper trades against real market data and are scored against deterministic
control portfolios. Everything runs on GitHub Actions and publishes a static dashboard to GitHub
Pages. No server, no database, no real money, no broker connection.

Read this whole document before writing code. Ask me about anything ambiguous rather than guessing
on the invariants in "Hard rules".

---

## 1. Hard rules (do not violate these)

1. **No look-ahead.** A decision made using data up to the close of day T may only be filled at the
   next open of day T+1 in that asset's home market. Never fill at a price the agent could see when
   deciding. Write a test that fails if any fill price equals a price present in the brief that
   triggered it.
2. **Forward-only.** No backtesting. The simulation starts the day it is first run and moves forward.
   An LLM already knows what happened in 2024; a backtest of it is meaningless.
3. **Append-only ledger.** All state is derived by replaying an immutable event log. Nothing mutates
   a balance in place. `state.json` is a cache that can always be rebuilt from `events.jsonl`.
4. **Identical information baseline.** The daily market brief is built once, by deterministic code,
   and handed unchanged to all five agents. Agents may fetch more via tools, but they all start from
   the same page. Otherwise the experiment compares source luck, not strategy.
5. **Stale data means no trading.** If the data fetch fails or returns prices older than the last
   session close, the run logs a `SKIPPED` event for every portfolio and exits 0. Never trade on
   stale prices.
6. **Whitelist enforcement.** An order for a ticker not in `config/universe.yaml` is rejected by the
   validator, logged with the rejection reason, and never reaches the ledger.
7. **Every decision is recorded**, including decisions to do nothing.

---

## 2. Stack

- **TypeScript** everywhere. Node 22+. pnpm. ESM. Strict mode, no `any` in domain code.
- **Agents:** `@strands-agents/sdk` (Strands Agents TypeScript SDK), using the Anthropic model
  provider directly — not Bedrock. API key from `ANTHROPIC_API_KEY`. Check the current SDK docs for
  the exact provider import and structured-output API before writing agent code; do not guess the
  surface from memory.
- **Market data:** `yahoo-finance2` (v4). Covers EU and US quotes, historical, fundamentals and
  search from one library.
- **Dashboard:** Astro, static output, deployed to GitHub Pages. Charts via a lightweight library
  (ECharts or Chart.js). No client-side data fetching — the dashboard reads committed JSON at build
  time.
- **Scheduling:** GitHub Actions cron. The workflow commits its results back to the repo.
- **Testing:** vitest. The domain core must be unit-testable with zero network access.

---

## 3. Repo layout

```
/config
  universe.yaml          # whitelisted tradable instruments
  portfolios.yaml        # the portfolios and their rules
  /mandates/<agent>.md   # immutable strategy mandates — agents never write here
  feeds.yaml             # RSS/news sources
  simulation.yaml        # fees, FX spread, timing, caps
/src
  /domain                # pure, no I/O: ledger, replay, valuation, metrics
  /data                  # yahoo-finance2 adapters, feed readers, caching
  /brief                 # daily market brief builder
  /agents                # Strands agents, tools, prompts, output schema
  /engine                # order validation, fill simulation, month-end contributions
  /review                # monthly Opus review pass
  /cli                   # `run-daily`, `run-monthly`, `verify`, `rebuild-state`
/data                    # committed simulation output (the actual dataset)
  events.jsonl
  state.json
  /briefs/YYYY-MM-DD.json
  /decisions/YYYY-MM-DD/<portfolio>.json
  /prices/YYYY-MM-DD.json
  /playbooks/<agent>.json    # mutable learned rules, written monthly only
  /reviews/YYYY-MM.json
/web                     # Astro dashboard
/.github/workflows
  daily.yml
  monthly.yml
  deploy.yml
```

---

## 4. Domain model

### Event log (`data/events.jsonl`, one JSON object per line)

Every event has `id`, `ts` (ISO, UTC), `portfolio`, `type`. Types:

- `DEPOSIT` — `{ amountEur }`. The monthly contribution.
- `ORDER_PLACED` — `{ decisionId, ticker, side, targetEur, reason }`. Queued, not yet filled.
- `ORDER_FILLED` — `{ orderId, ticker, side, qty, priceLocal, currency, fxRate, grossEur, feeEur, fxCostEur, netEur }`.
- `ORDER_REJECTED` — `{ orderId, reasonCode, detail }`.
- `HOLD` — `{ decisionId, reason }`. First-class outcome, not an absence of one.
- `DIVIDEND` — `{ ticker, amountLocal, currency, fxRate, withholdingEur, netEur }`.
- `SPLIT` — `{ ticker, ratio }`.
- `VALUATION` — written **every trading day**, including days with no activity:
  `{ cashEur, positions[], marketValueEur, fxEffectEur, contributedToDateEur }`.
- `SKIPPED` — `{ reason }`. Data failure, budget exhaustion, market holiday.

### Derived state

`replay(events) -> PortfolioState` is a pure function. `pnpm verify` replays the whole log and
asserts: cash never negative, quantity never negative, no position outside the whitelist, every
`ORDER_FILLED` has a preceding `ORDER_PLACED`, and every fill date is strictly after its decision
date.

### Money

- All portfolios are denominated in **EUR**.
- US positions are held in USD and converted for valuation using `EURUSD=X`.
- **Track the FX contribution to P&L separately** from the price contribution. A portfolio can be up
  because the dollar moved, and the dashboard must not let that masquerade as stock picking.
- Fractional shares are allowed (4 decimal places).

---

## 5. The portfolios

Each portfolio is seeded with **100 € on day one**, then receives **50 € on the first trading day of
every subsequent month**. Independent portfolios — they do not share cash and do not see each other.

**Five LLM agents** (Claude Sonnet, one Strands agent each):

| Key | Mandate |
|---|---|
| `news` | Trades on catalysts: earnings, guidance changes, M&A, regulatory news, product events. Short horizon. |
| `value` | Trades on fundamentals and valuation multiples. Long horizon, low turnover, tolerates being early. |
| `contrarian` | Mean reversion. Buys what has been beaten down without fundamental impairment; fades crowded moves. |
| `macro` | Top-down: rates, inflation, energy, currency, sector rotation. Expresses views mainly through ETFs. |
| `news-frozen` | Byte-identical to `news` — same mandate, same prompt, same model — except that learning is disabled and it never receives a playbook. The control for learning itself. |

Without `news-frozen` there is no way to tell whether the learning mechanism in §10 helped or merely
added drift. If you want to drop it, set `learning: frozen` on `news` instead and accept that the
question goes unanswered.

**Two deterministic controls** (no LLM, pure code — build these first):

| Key | Behaviour |
|---|---|
| `dca` | Buys a single global equity ETF with the full contribution every month. Never sells. |
| `random` | Each month picks uniformly at random from the whitelist and buys. Seeded RNG, seed committed, so it is reproducible. |

The controls exist because "+3.2%" is meaningless on its own. The headline number of this project is
each agent's return **relative to `dca`**, after fees.

---

## 6. Market data and the daily brief

`src/brief` builds `data/briefs/YYYY-MM-DD.json` once per run, before any agent starts:

- OHLCV for every instrument in the universe at the latest close, plus 1d/5d/1m/6m/1y returns.
- `EURUSD=X` rate.
- Index levels for a handful of references (S&P 500, STOXX 600, VIX, 10y yields if available).
- Headlines from `config/feeds.yaml` (RSS plus `yahoo-finance2`'s search/news module), deduplicated,
  each with source, timestamp, URL and instrument tags where resolvable.
- Upcoming earnings dates within the next 7 days for whitelisted names.

Rules:

- The brief is **hashed**; every decision record stores the hash of the brief it saw.
- The raw price snapshot is committed to `data/prices/YYYY-MM-DD.json`. This is the point-in-time
  record — never re-fetch history to reconstruct the past, since Yahoo data gets revised.
- `yahoo-finance2` is an unofficial client. Wrap it with retry, a rate limiter, and a circuit breaker
  that triggers rule 5 above.
- **Keep the starting universe to roughly 150 instruments** (about 60 EU names, 60 US names, 30
  UCITS ETFs). Fetching 1,100 symbols daily will get you throttled and buys nothing. Design
  `universe.yaml` so it can be expanded later without migration.

---

## 7. Agents

One Strands agent per strategy. Each run receives:

- The shared daily brief.
- Its own portfolio state: cash, positions, cost basis, unrealized P&L, trades left this month.
- Its own decision history for the last 30 days — rationales included, so it can be consistent with
  or deliberately contradict its past self.
- Its mandate and its constraints, stated as hard limits.
- Its **playbook**: the active, evidence-backed rules it has earned (§10). `news-frozen` receives
  none, and agents receive none until they have earned any, so this is empty for the first months.

### Tools available to agents

- `getPriceHistory(ticker, range)`
- `getFundamentals(ticker)`
- `getNewsForTicker(ticker)`
- `webSearch(query)` — pluggable provider behind an interface (Brave / Tavily / Exa; key in repo
  secrets). **Cap at 5 searches per agent per run.** Archive every query and every returned snippet
  into the decision record verbatim. Without that archive the decision is unauditable.

### Output contract

Structured output, validated with zod before anything touches the ledger:

```ts
{
  action: "trade" | "hold",
  rationale: string,            // required for both
  confidence: 1..5,
  orders: Array<{
    ticker: string,
    side: "buy" | "sell",
    targetEur: number,          // EUR to deploy, not share count
    thesis: string,
    invalidation: string        // what would prove this wrong — required
  }>,
  sourcesUsed: string[]         // URLs/IDs from brief or web search
}
```

The `invalidation` field is mandatory and non-empty. An agent that cannot say what would falsify its
thesis should be holding.

### Cost and loop control

- Strands turn limit: 12 tool calls per run. Token budget per run enforced by the SDK.
- Exceeding either aborts the agent and writes a `HOLD` event with `reason: "budget_exceeded"`.
- Record model ID, input/output tokens and computed cost in every decision record, and surface
  cumulative LLM spend on the dashboard. This project has a real running cost; make it visible.

---

## 8. Execution engine

Daily sequence, in this order:

1. **Fill pending orders** from the previous run, using today's open in the asset's home market.
2. **Apply corporate actions** — dividends (credit cash, apply a configurable withholding rate),
   splits.
3. **Apply deposits** — the 100 € seed on the very first run, then 50 € on the first trading day of
   each subsequent month.
4. **Build the brief.**
5. **Run the controls**, then the five agents.
6. **Validate and queue** resulting orders.
7. **Write the valuation mark**, rebuild `state.json`, commit.

### Frictions (`config/simulation.yaml`)

```yaml
initialDepositEur: 100.00
monthlyDepositEur: 50.00
feePerOrderEur: 1.00
fxSpreadBps: 25          # applied to EUR<->USD conversion on US trades
minOrderEur: 5.00
dividendWithholdingPct: 15
```

At 50 €/month a 1 € fee is 2% of the contribution. Fee drag must be a first-class number on the
dashboard, per portfolio, cumulative.

### Guardrails (`config/portfolios.yaml`, per portfolio)

```yaml
maxTradesPerMonth: 4
minHoldDays: 3               # 0 for `news`
maxPositionPct: 25
positionLimitsActiveAboveEur: 250   # below this, concentration is allowed
cashFloorEur: 0
allowShorting: false
allowLeverage: false
allowDerivatives: false
```

The `positionLimitsActiveAboveEur` threshold matters: a 25% position cap on a 50 € portfolio means
12.50 € per name, below `minOrderEur`, and the agent would be unable to act at all in month one.
Percentage limits stay dormant until the portfolio is worth enough for them to be meaningful.

---

## 9. Metrics

Compute both, and label them clearly — they answer different questions:

- **Time-weighted return**, chained **daily**, with each deposit treated as an external flow that
  closes one sub-period and opens the next. This ranks the portfolios. Daily chaining is
  precisely what stops a 50 € deposit from registering as a 50 € gain.
- **Money-weighted return (XIRR)** for "what did this actually earn on the money put in".

Also per portfolio: max drawdown, annualized volatility, Sharpe (EUR risk-free from config), hit
rate on closed positions, average holding period, turnover, cumulative fees, cumulative FX effect,
cumulative LLM cost.

---

## 10. Monthly review and learning

Agents adapt, but only under the constraints below. At four trades a month, a six-month history is
roughly 24 closed positions — far too few to support outcome-based conclusions. An LLM will readily
construct a confident causal story from three losing trades, and acting on it means drifting
systematically on the basis of luck. The mechanism below exists to make that failure mode
structurally difficult.

### Immutable vs mutable

- `config/mandates/<agent>.md` — the strategy itself. **Read-only to the system.** Only a human
  edits it. If `value` can rewrite its own mandate, it becomes a momentum trader by March and the
  comparison between portfolios measures nothing.
- `data/playbooks/<agent>.json` — learned tactics *within* the mandate. Mutable, but only by the
  monthly review, never by a daily run.

Nothing in the learning loop may alter guardrails: trade caps, position limits, cash floor, token
budget, or the whitelist. Learning governs what to trade, not how much rope the agent has.

### Trade evaluation (deterministic, no LLM)

Before the review runs, compute for every position closed in the month:

- Absolute return, and **excess return vs its sector/region ETF over the identical holding window**,
  and vs `dca` over the same window. Feed the review excess return. Absolute return teaches the
  agent that the market went down, which is not a strategy lesson.
- Whether the stated `invalidation` condition triggered during the holding period, and whether the
  agent acted on it when it did.
- Fee and FX cost as a percentage of the position.

### The review call

First run of each month, one Claude Opus call per agent, receiving the mandate, the current
playbook, the month's decisions with rationales, and the deterministic evaluation above. It must
classify each questionable decision as:

- **Process error** — ignored its own invalidation, contradicted data present in the brief it read,
  breached its own stated horizon, overtraded into fees. These are diagnosable at small N and are
  the only errors that should generate rules.
- **Outcome error** — the thesis was reasonable, the result was bad. Logged, never turned into a
  rule. At this sample size it is indistinguishable from noise.

### Playbook rules

```ts
{
  id: string,
  text: string,                 // one sentence, actionable, within mandate
  status: "probation" | "active" | "retired",
  evidence: string[],           // decision IDs that support it
  createdMonth: string,
  lastTestedMonth: string,
  retiredReason?: string
}
```

- A rule enters at `probation` and is **not injected into the daily prompt**. It appears on the
  dashboard only. This is deliberate: what the agent believes it has learned is the interesting
  output, and letting it steer capital on three data points is the expensive one.
- Promotion to `active` requires **at least 3 closed positions** of supporting evidence.
- Maximum **7 active rules**. Adding an eighth requires retiring one, forcing the agent to rank its
  own beliefs rather than accumulating a list of superstitions.
- Every active rule is re-tested each month. Three months with no measurable improvement in excess
  return on decisions that cited it → `retired`, with a reason. Rules decay unless they keep earning
  their place.
- Playbook changes are ordinary commits. Their history is diffable and belongs on the dashboard.

### Dashboard

A rules timeline per agent: when each rule was born, promoted, cited, and retired — set against that
agent's equity curve and against `news-frozen`. That comparison is the actual research question this
project asks.

---

## 11. Dashboard (Astro, static, GitHub Pages)

- **Leaderboard** — **daily** equity curves for every portfolio, one point per trading day since inception,
  with a stepped "total contributed" line beneath them. Two toggleable views: raw portfolio value,
  which jumps every deposit day, and P&L excluding contributions, which does not. Default to the
  second — the first one looks like a 50 % gain on day 30 of month one.
- **Daily strip** — pick any day and see it whole: value change per portfolio, who traded, who held
  and why, what the market did. The unit of this project is the day, not the month.
- **Portfolio detail** — holdings, realized/unrealized P&L, price vs FX attribution, fee drag,
  trade log with the rationale attached to every line.
- **Decision explorer** — pick a date and a portfolio: see the brief it read, the searches it ran,
  the sources it cited, what it decided, and what happened afterwards.
- **Monthly reviews** — the Opus critiques.
- **Cost** — cumulative API spend vs simulated portfolio value. Displayed honestly; it may well
  exceed the gains, and that is itself a finding worth showing.

On weekends and market holidays, carry the previous mark forward and flag it stale. Never
interpolate, and never draw a segment that implies movement on a day the market was shut.

Mobile-readable. Dark mode. Built from committed JSON only — the site must build with the network
disabled.

---

## 12. Build order

Do not skip ahead. Each phase must run green before the next starts.

1. Domain core: events, replay, valuation, metrics. Pure functions, fixture data, full unit tests.
2. Data layer: `yahoo-finance2` adapters, caching, rate limiting, failure handling.
3. Brief builder.
4. The two control portfolios, running end to end on a cron. **This proves the whole pipeline with
   zero LLM spend.** Let it run a few days before phase 5.
5. One agent (`value`) with Strands, tools, schema validation, decision records.
6. The remaining four agents.
7. Dashboard.
8. Monthly review pass — first as read-only commentary, then the playbook mechanism on top of it.
   Do not build learning until at least two months of real decisions exist to learn from; before
   that there is nothing to test it against and you will be debugging against fiction.
9. Actions workflows and Pages deployment.

---

## 13. Operational details

- Daily workflow runs at 22:30 CET (after the US close), Monday–Friday. Handle market holidays by
  detecting no new close rather than hardcoding a calendar.
- Secrets: `ANTHROPIC_API_KEY`, and the web search provider key. Never logged, never committed.
- The workflow commits to `main` with a bot identity and a message like
  `sim: 2026-09-16 (3 trades, 3 holds)`.
- Concurrency group on the workflow so two runs can never race the ledger.
- Repo is public — free Actions minutes and Pages. Nothing sensitive is stored.
- `README.md` must state plainly: this is a simulation for research and entertainment, it is not
  investment advice, and no real money is involved.

---

## 14. Acceptance checks

- `pnpm verify` replays the full event log and passes every invariant in §4.
- A look-ahead test proves no fill price was visible in the brief that caused it.
- Deleting `state.json` and rebuilding from `events.jsonl` produces a byte-identical file.
- A simulated data-source failure produces `SKIPPED` events and zero trades.
- An agent returning an off-whitelist ticker, an over-limit order, or an order exceeding available
  cash produces `ORDER_REJECTED` with a reason and no ledger mutation.
- Every run in `data/decisions/` has a rationale, including holds.
- `pnpm build` in `/web` succeeds with the network disabled.
- A mandate file is never modified by any code path — test it by checksumming mandates before and
  after a full monthly run.
- A `probation` rule never appears in a daily agent prompt; assert on the serialized prompt.
- `news-frozen` prompts contain no playbook content in any month.
- No learning output can change a value in `portfolios.yaml` or `simulation.yaml`.

Start with phase 1. Show me the domain model and the config files before writing the data layer.
