/**
 * The append-only event log (SPEC 4).
 *
 * `data/events.jsonl` holds one of these objects per line and is the only
 * source of truth in the system; `state.json` is a cache derived from it.
 * Events are immutable: nothing here ever mutates a balance in place.
 *
 * The zod schemas below are the single definition of each event: the
 * TypeScript types are inferred from them, so a field can never be validated
 * and typed differently. `zod` is the one dependency the domain core takes —
 * it is pure, and parsing is the boundary where untrusted JSON becomes a
 * `LedgerEvent`.
 */
import { z } from "zod";
import type {
  Currency,
  DecisionId,
  IsoTimestamp,
  OrderId,
  PortfolioId,
  Side,
  Ticker,
} from "./types.js";

export const EVENT_TYPES = [
  "DEPOSIT",
  "ORDER_PLACED",
  "ORDER_FILLED",
  "ORDER_REJECTED",
  "HOLD",
  "DIVIDEND",
  "SPLIT",
  "VALUATION",
  "SKIPPED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// --- Field vocabulary -------------------------------------------------------
//
// Named once so every event validates a ticker, an amount or an FX rate by the
// same rule, and so the messages a rejection carries are uniform.

/** A non-empty string: ids, tickers, reasons. A blank reason is not a reason. */
const text = z.string().min(1);

/** A string that may legitimately be empty, such as a rejection's detail. */
const optionalText = z.string();

/** Any finite EUR amount, sign allowed (cash and P&L lines can go negative). */
const amount = z.number().refine(Number.isFinite, "must be a finite number");

/** A finite amount that may not be negative. */
const nonNegative = amount.refine((value) => value >= 0, "must be >= 0");

/** Strictly positive: prices per unit of FX, split ratios. */
const positive = amount.refine((value) => value > 0, "must be > 0");

const side = z.literal(["buy", "sell"]);

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** ISO-8601, UTC, to the second or millisecond. Local offsets are refused. */
const timestamp = z
  .string()
  .refine(
    (value) => ISO_TS.test(value) && !Number.isNaN(Date.parse(value)),
    "must be an ISO-8601 UTC timestamp",
  );

/** Fields carried by every event (SPEC 4). */
const eventBase = {
  id: text,
  ts: timestamp,
  portfolio: text,
} as const;

// --- The nine event types ---------------------------------------------------

/** The monthly contribution, and the 100 EUR seed on day one. */
export const DepositEventSchema = z.object({
  ...eventBase,
  type: z.literal("DEPOSIT"),
  amountEur: nonNegative,
});

/**
 * An order queued by today's decision. It moves no cash: it is filled at the
 * next session's open (SPEC 1.1, no look-ahead).
 */
export const OrderPlacedEventSchema = z.object({
  ...eventBase,
  type: z.literal("ORDER_PLACED"),
  decisionId: text,
  ticker: text,
  side,
  /** EUR to deploy, not a share count (SPEC 7). */
  targetEur: nonNegative,
  reason: text,
});

/**
 * A fill of a previously placed order, at the open of the day after the
 * decision.
 *
 * `fxRate` is units of `currency` per EUR (1 for EUR instruments).
 * `netEur` is the magnitude of the cash movement, always positive: for a buy
 * it is `grossEur + feeEur + fxCostEur` (cash out), for a sell
 * `grossEur - feeEur - fxCostEur` (cash in).
 */
export const OrderFilledEventSchema = z.object({
  ...eventBase,
  type: z.literal("ORDER_FILLED"),
  orderId: text,
  ticker: text,
  side,
  qty: nonNegative,
  priceLocal: nonNegative,
  currency: text,
  fxRate: positive,
  grossEur: nonNegative,
  feeEur: nonNegative,
  fxCostEur: nonNegative,
  netEur: nonNegative,
});

/** A rejected order. Recorded for audit; touches no balance (SPEC 1.6). */
export const OrderRejectedEventSchema = z.object({
  ...eventBase,
  type: z.literal("ORDER_REJECTED"),
  orderId: text,
  reasonCode: text,
  detail: optionalText,
});

/** A decision to do nothing. A first-class outcome (SPEC 1.7). */
export const HoldEventSchema = z.object({
  ...eventBase,
  type: z.literal("HOLD"),
  decisionId: text,
  reason: text,
});

/** Cash dividend, net of withholding. */
export const DividendEventSchema = z.object({
  ...eventBase,
  type: z.literal("DIVIDEND"),
  ticker: text,
  amountLocal: nonNegative,
  currency: text,
  fxRate: positive,
  withholdingEur: nonNegative,
  netEur: nonNegative,
});

/** Share split: quantity is multiplied by `ratio`, entry price divided by it. */
export const SplitEventSchema = z.object({
  ...eventBase,
  type: z.literal("SPLIT"),
  ticker: text,
  ratio: positive,
});

/** A position line inside a VALUATION mark. */
export const ValuationPositionSchema = z.object({
  ticker: text,
  qty: nonNegative,
  priceLocal: nonNegative,
  currency: text,
  fxRate: positive,
  valueEur: amount,
});

/**
 * The daily mark, written every trading day including days with no activity.
 * `marketValueEur` is the positions only; total equity is `cash + market`.
 */
export const ValuationEventSchema = z.object({
  ...eventBase,
  type: z.literal("VALUATION"),
  cashEur: amount,
  positions: z.array(ValuationPositionSchema).readonly(),
  marketValueEur: amount,
  /** Cumulative EUR effect of FX, kept apart from the price contribution. */
  fxEffectEur: amount,
  contributedToDateEur: amount,
});

/** Data failure, budget exhaustion or market holiday (SPEC 1.5). */
export const SkippedEventSchema = z.object({
  ...eventBase,
  type: z.literal("SKIPPED"),
  reason: text,
});

/** Any line of `events.jsonl`, discriminated on `type`. */
export const LedgerEventSchema = z.discriminatedUnion("type", [
  DepositEventSchema,
  OrderPlacedEventSchema,
  OrderFilledEventSchema,
  OrderRejectedEventSchema,
  HoldEventSchema,
  DividendEventSchema,
  SplitEventSchema,
  ValuationEventSchema,
  SkippedEventSchema,
]);

// --- Types, inferred from the schemas ---------------------------------------
//
// `Readonly` is applied here rather than per field: events are immutable once
// written, and the mapped type distributes over the union so narrowing on
// `type` keeps working.

export type DepositEvent = Readonly<z.infer<typeof DepositEventSchema>>;
export type OrderPlacedEvent = Readonly<z.infer<typeof OrderPlacedEventSchema>>;
export type OrderFilledEvent = Readonly<z.infer<typeof OrderFilledEventSchema>>;
export type OrderRejectedEvent = Readonly<
  z.infer<typeof OrderRejectedEventSchema>
>;
export type HoldEvent = Readonly<z.infer<typeof HoldEventSchema>>;
export type DividendEvent = Readonly<z.infer<typeof DividendEventSchema>>;
export type SplitEvent = Readonly<z.infer<typeof SplitEventSchema>>;
export type ValuationPosition = Readonly<
  z.infer<typeof ValuationPositionSchema>
>;
export type ValuationEvent = Readonly<z.infer<typeof ValuationEventSchema>>;
export type SkippedEvent = Readonly<z.infer<typeof SkippedEventSchema>>;
export type LedgerEvent = Readonly<z.infer<typeof LedgerEventSchema>>;

/** Fields carried by every event. */
export type EventBase = Readonly<{
  id: string;
  ts: IsoTimestamp;
  portfolio: PortfolioId;
  type: EventType;
}>;

// The scalar aliases in `types.ts` document intent at the call sites; assert
// here that the schemas still produce what those aliases stand for, so a
// change to either side is a compile error rather than a silent drift.
export type ScalarAliasChecks = [
  Expect<DepositEvent["portfolio"], PortfolioId>,
  Expect<DepositEvent["ts"], IsoTimestamp>,
  Expect<OrderPlacedEvent["decisionId"], DecisionId>,
  Expect<OrderPlacedEvent["side"], Side>,
  Expect<OrderFilledEvent["orderId"], OrderId>,
  Expect<OrderFilledEvent["ticker"], Ticker>,
  Expect<OrderFilledEvent["currency"], Currency>,
  Expect<LedgerEvent["type"], EventType>,
];
type Expect<Actual extends Expected, Expected> = Actual;

/** Narrowing helper for the discriminated union. */
export function isEventOfType<T extends EventType>(
  event: LedgerEvent,
  type: T,
): event is Extract<LedgerEvent, { type: T }> {
  return event.type === type;
}

// --- Parsing ----------------------------------------------------------------

/** Thrown when a log line is not a well-formed event. */
export class EventParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "EventParseError";
  }
}

function pathOf(issue: z.core.$ZodIssue): string {
  return issue.path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? segment
          : `.${String(segment)}`,
    )
    .join("");
}

/**
 * Turn zod's first issue into one precise, loggable sentence. Every rejection
 * names the field it is about: these messages end up in CI output and in the
 * workflow log, where "invalid input" would cost someone an hour.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = pathOf(issue);
  if (field.length === 0) return issue.message;

  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? `missing field "${field}"`
        : `field "${field}" must be a ${issue.expected === "number" ? "finite number" : issue.expected}`;
    case "too_small":
      return issue.origin === "string"
        ? `field "${field}" must not be empty`
        : `field "${field}" must be >= ${String(issue.minimum)}, got ${String(issue.input)}`;
    case "invalid_value":
      return `field "${field}" must be ${issue.values.map((value) => JSON.stringify(value)).join(" or ")}`;
    case "custom":
      return `field "${field}" ${issue.message}, got ${JSON.stringify(issue.input)}`;
    default:
      return `field "${field}" ${issue.message}`;
  }
}

/** Validate one already-JSON-decoded object as a ledger event. */
export function parseEvent(input: unknown): LedgerEvent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EventParseError("event must be a JSON object");
  }

  // Checked before the union so an unrecognised type is reported as itself
  // rather than as nine simultaneous shape mismatches.
  const type: unknown = (input as Record<string, unknown>)["type"];
  if (typeof type !== "string") {
    throw new EventParseError('missing field "type"');
  }
  if (!(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new EventParseError(`unknown event type "${type}"`);
  }

  const result = LedgerEventSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new EventParseError(
      issue === undefined ? "invalid event" : describeIssue(issue),
    );
  }
  return result.data;
}

/**
 * Parse a whole `events.jsonl` document. Pure: the caller does the file I/O
 * and hands the text in. Blank lines are ignored so the log can be appended to
 * with a trailing newline.
 */
export function parseEventLog(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch (cause) {
      throw new EventParseError(
        `invalid JSON: ${(cause as Error).message}`,
        index + 1,
      );
    }
    try {
      events.push(parseEvent(decoded));
    } catch (cause) {
      throw new EventParseError((cause as Error).message, index + 1);
    }
  }
  return events;
}
