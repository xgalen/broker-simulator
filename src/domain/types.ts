/** Shared scalar aliases. Narrow strings, validated at the parse boundary. */

/** ISO-8601 UTC timestamp, e.g. `2026-09-15T20:30:00.000Z`. */
export type IsoTimestamp = string;

/** Calendar date in UTC, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Portfolio key from `config/portfolios.yaml`, e.g. `value`, `dca`. */
export type PortfolioId = string;

/** Instrument symbol as it appears in `config/universe.yaml`. */
export type Ticker = string;

/** ISO-4217 currency code. */
export type Currency = string;

/** `id` of an ORDER_PLACED event. */
export type OrderId = string;

/** `id` of the decision record that produced an order or a hold. */
export type DecisionId = string;

/** Buy or sell. Shorting is disallowed by the guardrails, not by the type. */
export type Side = "buy" | "sell";

/** The UTC calendar date of a timestamp. */
export function dateOf(ts: IsoTimestamp): IsoDate {
  return ts.slice(0, 10);
}
