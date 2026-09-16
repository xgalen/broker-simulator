# broker-simulator

A GitHub-hosted simulated investing platform. Several LLM agents, each with an
identical budget, make paper trades against real market data and are scored
against deterministic control portfolios. Everything runs on GitHub Actions and
publishes a static dashboard to GitHub Pages. No server, no database, no real
money, no broker connection.

> **This is a simulation, built for research and entertainment.** It is not
> investment advice, it is not a recommendation to buy or sell anything, and no
> real money is involved at any point. Nothing here is a broker, and nothing
> here connects to one. The portfolios are paper, the trades are paper, and the
> returns — good or bad — are the output of an experiment, not a track record.

## What the experiment asks

An agent that returns +3.2% has told you nothing. The question worth asking is
whether it beat the boring alternative after fees, so every portfolio is scored
relative to `dca` — a control that buys one global equity ETF with the whole
contribution every month and never sells — and against `random`, which picks
uniformly from the whitelist with a committed seed. At 50 €/month a 1 € order
fee is 2% of the contribution before a price has moved, and the dashboard shows
that drag as a first-class number.

Every portfolio starts with 100 € and receives 50 € on the first trading day of
each subsequent month. They are independent: they do not share cash and do not
see each other.

## Hard rules

The full specification is in [`SPEC.md`](SPEC.md). Four rules shape everything
else:

- **No look-ahead.** A decision made on the close of day T fills at the open of
  day T+1. `pnpm verify` traces every fill back to the brief its decision read
  and fails if the fill price appears in it.
- **Forward-only.** The simulation starts the day it first runs and moves
  forward. An LLM already knows what happened in 2024; backtesting one measures
  nothing.
- **Append-only ledger.** All state is derived by replaying `data/events.jsonl`.
  `data/state.json` is a cache that can always be thrown away and rebuilt.
- **Stale data means no trading.** A failed fetch, or prices older than the last
  session close, logs a `SKIPPED` event for every portfolio and exits 0.

## Status

Built in phases (`SPEC.md` §12), each green before the next starts.

| Phase | | |
|---|---|---|
| 1 | Domain core — events, replay, valuation, metrics | done |
| 2 | Data layer — `yahoo-finance2`, caching, failure handling | done |
| 3 | Brief builder | done |
| 4 | The two control portfolios, end to end on a cron | done |
| 5 | The `value` agent — Strands, tools, schema gate, decision records | done |
| 6 | The remaining four agents | not started |
| 7 | Dashboard | not started |
| 8 | Monthly review and the playbook mechanism | not started |
| 9 | Workflow hardening and Pages deployment | not started |

Phase 4 runs the whole pipeline — fills, deposits, corporate actions, order
validation, daily marks — with **zero LLM spend**, which is the point of
building the controls first. Phase 5 adds one agent, `value`, to that same
pipeline: the engine cannot tell it apart from a control, and its orders go
through the same validator and the same ledger. The other four agents are
declared in `config/portfolios.yaml` and disabled until phase 6.

## Running it

```sh
pnpm install
pnpm test              # 500+ unit tests, no network access and no API key anywhere
pnpm build

pnpm dry-run           # replay recorded price fixtures across simulated days
pnpm verify            # replay the ledger, assert every invariant
pnpm rebuild-state     # regenerate state.json from events.jsonl
node dist/cli/main.js run-daily   # one live session
```

### Secrets

`run-daily` reads two optional environment variables, both repo secrets, and
neither is logged or written to `data/`:

| | |
|---|---|
| `ANTHROPIC_API_KEY` | Required for the agents. Missing, each enabled agent records a hold saying so and the controls run as normal — a rotated secret must not cost the ledger a day. |
| `BRAVE_API_KEY` or `TAVILY_API_KEY` | Optional. Missing, `webSearch` reports that no provider is configured rather than returning an empty result set, which would read as "the web knows nothing about this". `WEB_SEARCH_PROVIDER` picks between them, or `none` switches search off. |

`pnpm dry-run` is the one worth knowing about. The daily run happens once a
day, which is a poor feedback loop for the parts of it that only fire monthly —
a contribution landing on the first trading day, an order filling at the next
open, a dividend on a position opened six weeks earlier. The dry run drives the
same engine, the same controls and the same ledger over a committed price
fixture with the clock pinned to each session in turn, writes to a scratch
directory, and verifies what it wrote. See
[`fixtures/dry-run/`](fixtures/dry-run/).

## Layout

```
config/     universe, portfolios, frictions, guardrails, feeds — all committed
src/domain  pure: events, replay, valuation, metrics. No I/O, no clock.
src/data    yahoo-finance2 adapters, RSS, caching, rate limiting, breakers
src/brief   the daily market brief, built once and handed to every portfolio
src/engine  fills, deposits, corporate actions, validation, the daily mark
src/controls  the two deterministic control portfolios
src/agents  the Strands agents: prompts, tools, schema, cost, decision records
src/cli     run-daily, verify, rebuild-state, dry-run
data/       the committed dataset (see data/README.md)
```
