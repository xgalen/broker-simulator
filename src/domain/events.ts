/**
 * The append-only event log (SPEC 4).
 *
 * `data/events.jsonl` holds one of these objects per line and is the only
 * source of truth in the system; `state.json` is a cache derived from it.
 * Events are immutable: nothing here ever mutates a balance in place.
 *
 * Parsing is hand-written rather than delegated to a schema library so that
 * the domain core has zero runtime dependencies and every rejection carries a
 * precise, loggable reason.
 */
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

/** Fields carried by every event. */
export interface EventBase {
  readonly id: string;
  readonly ts: IsoTimestamp;
  readonly portfolio: PortfolioId;
  readonly type: EventType;
}

/** The monthly contribution, and the 100 EUR seed on day one. */
export interface DepositEvent extends EventBase {
  readonly type: "DEPOSIT";
  readonly amountEur: number;
}

/**
 * An order queued by today's decision. It moves no cash: it is filled at the
 * next session's open (SPEC 1.1, no look-ahead).
 */
export interface OrderPlacedEvent extends EventBase {
  readonly type: "ORDER_PLACED";
  readonly decisionId: DecisionId;
  readonly ticker: Ticker;
  readonly side: Side;
  readonly targetEur: number;
  readonly reason: string;
}

/**
 * A fill of a previously placed order, at the open of the day after the
 * decision.
 *
 * `fxRate` is units of `currency` per EUR (1 for EUR instruments).
 * `netEur` is the magnitude of the cash movement, always positive: for a buy
 * it is `grossEur + feeEur + fxCostEur` (cash out), for a sell
 * `grossEur - feeEur - fxCostEur` (cash in).
 */
export interface OrderFilledEvent extends EventBase {
  readonly type: "ORDER_FILLED";
  readonly orderId: OrderId;
  readonly ticker: Ticker;
  readonly side: Side;
  readonly qty: number;
  readonly priceLocal: number;
  readonly currency: Currency;
  readonly fxRate: number;
  readonly grossEur: number;
  readonly feeEur: number;
  readonly fxCostEur: number;
  readonly netEur: number;
}

/** A rejected order. Recorded for audit; touches no balance (SPEC 1.6). */
export interface OrderRejectedEvent extends EventBase {
  readonly type: "ORDER_REJECTED";
  readonly orderId: OrderId;
  readonly reasonCode: string;
  readonly detail: string;
}

/** A decision to do nothing. A first-class outcome (SPEC 1.7). */
export interface HoldEvent extends EventBase {
  readonly type: "HOLD";
  readonly decisionId: DecisionId;
  readonly reason: string;
}

/** Cash dividend, net of withholding. */
export interface DividendEvent extends EventBase {
  readonly type: "DIVIDEND";
  readonly ticker: Ticker;
  readonly amountLocal: number;
  readonly currency: Currency;
  readonly fxRate: number;
  readonly withholdingEur: number;
  readonly netEur: number;
}

/** Share split: quantity is multiplied by `ratio`, entry price divided by it. */
export interface SplitEvent extends EventBase {
  readonly type: "SPLIT";
  readonly ticker: Ticker;
  readonly ratio: number;
}

/** A position line inside a VALUATION mark. */
export interface ValuationPosition {
  readonly ticker: Ticker;
  readonly qty: number;
  readonly priceLocal: number;
  readonly currency: Currency;
  readonly fxRate: number;
  readonly valueEur: number;
}

/**
 * The daily mark, written every trading day including days with no activity.
 * `marketValueEur` is the positions only; total equity is `cash + market`.
 */
export interface ValuationEvent extends EventBase {
  readonly type: "VALUATION";
  readonly cashEur: number;
  readonly positions: readonly ValuationPosition[];
  readonly marketValueEur: number;
  readonly fxEffectEur: number;
  readonly contributedToDateEur: number;
}

/** Data failure, budget exhaustion or market holiday (SPEC 1.5). */
export interface SkippedEvent extends EventBase {
  readonly type: "SKIPPED";
  readonly reason: string;
}

export type LedgerEvent =
  | DepositEvent
  | OrderPlacedEvent
  | OrderFilledEvent
  | OrderRejectedEvent
  | HoldEvent
  | DividendEvent
  | SplitEvent
  | ValuationEvent
  | SkippedEvent;

/** Narrowing helper for the discriminated union. */
export function isEventOfType<T extends EventType>(
  event: LedgerEvent,
  type: T,
): event is Extract<LedgerEvent, { type: T }> {
  return event.type === type;
}

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

type Raw = Record<string, unknown>;

function req(raw: Raw, key: string): unknown {
  if (!(key in raw)) throw new EventParseError(`missing field "${key}"`);
  return raw[key];
}

function str(raw: Raw, key: string, { allowEmpty = false } = {}): string {
  const value = req(raw, key);
  if (typeof value !== "string") {
    throw new EventParseError(`field "${key}" must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new EventParseError(`field "${key}" must not be empty`);
  }
  return value;
}

function num(raw: Raw, key: string, { min }: { min?: number } = {}): number {
  const value = req(raw, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EventParseError(`field "${key}" must be a finite number`);
  }
  if (min !== undefined && value < min) {
    throw new EventParseError(`field "${key}" must be >= ${min}, got ${value}`);
  }
  return value;
}

function side(raw: Raw, key: string): Side {
  const value = str(raw, key);
  if (value !== "buy" && value !== "sell") {
    throw new EventParseError(`field "${key}" must be "buy" or "sell"`);
  }
  return value;
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function timestamp(raw: Raw): IsoTimestamp {
  const value = str(raw, "ts");
  if (!ISO_TS.test(value) || Number.isNaN(Date.parse(value))) {
    throw new EventParseError(`field "ts" must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function positions(raw: Raw): readonly ValuationPosition[] {
  const value = req(raw, "positions");
  if (!Array.isArray(value)) {
    throw new EventParseError(`field "positions" must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new EventParseError(`positions[${index}] must be an object`);
    }
    const p = entry as Raw;
    return {
      ticker: str(p, "ticker"),
      qty: num(p, "qty", { min: 0 }),
      priceLocal: num(p, "priceLocal", { min: 0 }),
      currency: str(p, "currency"),
      fxRate: num(p, "fxRate", { min: Number.MIN_VALUE }),
      valueEur: num(p, "valueEur"),
    };
  });
}

/** Validate one already-JSON-decoded object as a ledger event. */
export function parseEvent(input: unknown): LedgerEvent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EventParseError("event must be a JSON object");
  }
  const raw = input as Raw;
  const base = {
    id: str(raw, "id"),
    ts: timestamp(raw),
    portfolio: str(raw, "portfolio"),
  };
  const type = str(raw, "type");

  switch (type) {
    case "DEPOSIT":
      return { ...base, type, amountEur: num(raw, "amountEur", { min: 0 }) };
    case "ORDER_PLACED":
      return {
        ...base,
        type,
        decisionId: str(raw, "decisionId"),
        ticker: str(raw, "ticker"),
        side: side(raw, "side"),
        targetEur: num(raw, "targetEur", { min: 0 }),
        reason: str(raw, "reason"),
      };
    case "ORDER_FILLED":
      return {
        ...base,
        type,
        orderId: str(raw, "orderId"),
        ticker: str(raw, "ticker"),
        side: side(raw, "side"),
        qty: num(raw, "qty", { min: 0 }),
        priceLocal: num(raw, "priceLocal", { min: 0 }),
        currency: str(raw, "currency"),
        fxRate: num(raw, "fxRate", { min: Number.MIN_VALUE }),
        grossEur: num(raw, "grossEur", { min: 0 }),
        feeEur: num(raw, "feeEur", { min: 0 }),
        fxCostEur: num(raw, "fxCostEur", { min: 0 }),
        netEur: num(raw, "netEur", { min: 0 }),
      };
    case "ORDER_REJECTED":
      return {
        ...base,
        type,
        orderId: str(raw, "orderId"),
        reasonCode: str(raw, "reasonCode"),
        detail: str(raw, "detail", { allowEmpty: true }),
      };
    case "HOLD":
      return {
        ...base,
        type,
        decisionId: str(raw, "decisionId"),
        reason: str(raw, "reason"),
      };
    case "DIVIDEND":
      return {
        ...base,
        type,
        ticker: str(raw, "ticker"),
        amountLocal: num(raw, "amountLocal", { min: 0 }),
        currency: str(raw, "currency"),
        fxRate: num(raw, "fxRate", { min: Number.MIN_VALUE }),
        withholdingEur: num(raw, "withholdingEur", { min: 0 }),
        netEur: num(raw, "netEur", { min: 0 }),
      };
    case "SPLIT":
      return { ...base, type, ratio: num(raw, "ratio", { min: Number.MIN_VALUE }), ticker: str(raw, "ticker") };
    case "VALUATION":
      return {
        ...base,
        type,
        cashEur: num(raw, "cashEur"),
        positions: positions(raw),
        marketValueEur: num(raw, "marketValueEur"),
        fxEffectEur: num(raw, "fxEffectEur"),
        contributedToDateEur: num(raw, "contributedToDateEur"),
      };
    case "SKIPPED":
      return { ...base, type, reason: str(raw, "reason") };
    default:
      throw new EventParseError(`unknown event type "${type}"`);
  }
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
