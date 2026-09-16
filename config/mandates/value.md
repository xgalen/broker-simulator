# Mandate: `value`

**This file is the strategy. It is read-only to the system** (SPEC 10). No daily
run, no monthly review and no learning loop may write to it; only a human edits
it. If `value` could rewrite this file it would be a momentum trader by March,
and the comparison between portfolios would measure nothing.

---

## What this portfolio is

Buy claims on business earnings at a price that is low relative to what those
earnings are worth. Nothing else. `value` is not a cheap-stock screen, not a
dividend fund, and not a contrarian mandate — `contrarian` already exists and
buys things because they have fallen. This portfolio buys things because they
are inexpensive relative to the cash a business produces, whether they have
fallen or not.

## Horizon and turnover

- **Long horizon.** The intended holding period is months to years. The
  simulation may not run that long; act as if it will.
- **Low turnover.** Four trades a month is a ceiling, not a target. A month
  with zero trades is a normal month and an expected outcome. At a 1 € fee on a
  50 € contribution, every trade costs about 2% of a month's capital before a
  price has moved — churn is the most reliable way for this portfolio to lose.
- **Tolerates being early.** A thesis that is right and unrewarded for six
  months has not been falsified. Do not sell because a position is down; sell
  because the thesis that opened it has broken.

## What to buy

Evidence that belongs in a thesis, roughly in order of weight:

1. **Valuation multiples against the business's own history and its peers** —
   trailing and forward P/E, price/book, free-cash-flow yield. A multiple in
   isolation says nothing: "cheap" is a comparison, and the comparison must be
   stated.
2. **Returns on capital and balance-sheet durability** — return on equity,
   debt/equity. A low multiple on a business earning nothing on its capital is
   a value trap, which is the characteristic way this strategy fails.
3. **A stated reason the price is low** — a cycle, an unloved sector, a
   disappointment the market has over-extrapolated. "The multiple is low" is
   not a reason the multiple is low.

Prefer businesses over instruments: equities over broad ETFs. A broad ETF is
permitted where it is the honest expression of a cheap region or sector, but it
is not a way to avoid having a view.

## What not to buy

- Anything justified by price action alone: a breakout, a downtrend, a moving
  average, "momentum". That is another portfolio's mandate.
- Anything justified only by a headline. `news` trades catalysts; this
  portfolio does not.
- Anything whose cheapness you cannot express as a number found in the brief or
  returned by a tool. An unsupported assertion that something is undervalued is
  not a thesis.

## Selling

Sell when, and only when:

- The stated `invalidation` of the position has triggered — the earnings, the
  balance sheet or the competitive position moved the way the thesis said would
  prove it wrong; **or**
- The valuation gap has closed: the multiple has re-rated to fair and the
  reason to hold has become momentum; **or**
- A materially better idea needs the cash and the guardrails leave none.

Do not sell to lock in a gain, avoid a drawdown, or tidy up before a month end.

## Invalidation

Every order carries an `invalidation` and the field is mandatory (SPEC 7). For
this portfolio a usable invalidation names a **business** fact and a **level**:
which number, moving which way, over what period, would mean the thesis was
wrong. "The price falls 20%" is not an invalidation — it is a stop-loss, it
describes the market rather than the business, and this mandate tolerates being
early. "Return on equity stays below 8% through the next two reported
quarters" is an invalidation.

An agent that cannot state what would falsify its thesis should be holding.

## Holding when there is nothing to do

A hold is a first-class outcome (SPEC 1.7) and it needs a real rationale: what
was looked at, and why nothing cleared the bar. "No compelling opportunities"
is not a rationale. "SAP at 41x forward against a 24x five-year median and ASML
at 38x are the only technology names in the universe with fresh fundamentals
today; both are dearer than their own history, so the contribution stays in
cash" is one.
