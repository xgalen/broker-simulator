/**
 * `pnpm check:ledger` — the evening check on the real ledger.
 *
 * Deliberately standalone. It imports nothing from `src/`, and re-derives cash
 * from the event log with its own arithmetic rather than calling `replay`. If
 * it shared the domain's code, a bug in `replay` would hide from both the
 * engine and its auditor at once, and this check exists precisely for the days
 * when something in there is wrong.
 *
 * Checks, all from SPEC 4:
 *   1. one DEPOSIT per portfolio
 *   2. a VALUATION per portfolio per trading day
 *   3. no ORDER_FILLED whose date is not strictly after its ORDER_PLACED
 *   4. cash never negative
 *
 * Usage:  pnpm check:ledger [--data data]
 * Exit:   0 when the ledger holds, 1 when it does not.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Event {
  readonly id: string;
  readonly ts: string;
  readonly portfolio: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

const num = (event: Event, key: string): number => {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const str = (event: Event, key: string): string => {
  const value = event[key];
  return typeof value === "string" ? value : "";
};

const dateOf = (event: Event): string => event.ts.slice(0, 10);

function parseLedger(text: string): Event[] {
  const events: Event[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch (cause) {
      throw new Error(`events.jsonl line ${index + 1} is not JSON: ${(cause as Error).message}`);
    }
    if (typeof decoded !== "object" || decoded === null) {
      throw new Error(`events.jsonl line ${index + 1} is not an object`);
    }
    const event = decoded as Event;
    for (const field of ["id", "ts", "portfolio", "type"]) {
      if (typeof event[field] !== "string") {
        throw new Error(`events.jsonl line ${index + 1} has no "${field}"`);
      }
    }
    events.push(event);
  }
  return events;
}

const dataFlagIndex = process.argv.indexOf("--data");
const dataDir = dataFlagIndex === -1 ? "data" : (process.argv[dataFlagIndex + 1] ?? "data");
const ledgerPath = resolve(process.cwd(), dataDir, "events.jsonl");

if (!existsSync(ledgerPath)) {
  console.error(`check:ledger: no ledger at ${ledgerPath}`);
  console.error("  Nothing has been written yet. If a session was supposed to run, that is the bug.");
  process.exit(1);
}

const events = parseLedger(readFileSync(ledgerPath, "utf8"));
const problems: string[] = [];
const note = (line: string): void => {
  problems.push(line);
};

const portfolios = [...new Set(events.map((event) => event.portfolio))].sort();

// --- 1. One DEPOSIT per portfolio -------------------------------------------
//
// True for the first month. A second DEPOSIT is the monthly contribution
// (SPEC 5) and is legitimate once the ledger crosses a month boundary — at
// which point this check needs widening rather than the ledger fixing. The
// failure prints every deposit so that is obvious at a glance.
const depositsByPortfolio = new Map<string, Event[]>();
for (const event of events) {
  if (event.type !== "DEPOSIT") continue;
  const list = depositsByPortfolio.get(event.portfolio) ?? [];
  list.push(event);
  depositsByPortfolio.set(event.portfolio, list);
}
for (const portfolio of portfolios) {
  const deposits = depositsByPortfolio.get(portfolio) ?? [];
  if (deposits.length === 1) continue;
  if (deposits.length === 0) {
    note(`${portfolio}: no DEPOSIT at all; the portfolio was never funded`);
    continue;
  }
  const detail = deposits.map((d) => `${dateOf(d)} ${num(d, "amountEur").toFixed(2)} EUR`).join(", ");
  note(
    `${portfolio}: ${deposits.length} DEPOSIT events (${detail}). ` +
      `Expected one. If the extra is a 50.00 EUR contribution on a month's first ` +
      `trading day, that is SPEC 5 working and this check needs widening.`,
  );
}

// --- 2. A VALUATION per portfolio per trading day ---------------------------
//
// A trading day is a date the run marked at all. Days where every portfolio
// was SKIPPED (a holiday, a stale fetch) carry no mark by design and are not
// trading days.
const marksByDate = new Map<string, Map<string, number>>();
for (const event of events) {
  if (event.type !== "VALUATION") continue;
  const byPortfolio = marksByDate.get(dateOf(event)) ?? new Map<string, number>();
  byPortfolio.set(event.portfolio, (byPortfolio.get(event.portfolio) ?? 0) + 1);
  marksByDate.set(dateOf(event), byPortfolio);
}
const tradingDays = [...marksByDate.keys()].sort();
for (const date of tradingDays) {
  const byPortfolio = marksByDate.get(date) ?? new Map<string, number>();
  for (const portfolio of portfolios) {
    // A portfolio that joins later has no marks before it existed; only
    // complain from its first event onwards.
    const firstSeen = events.find((event) => event.portfolio === portfolio);
    if (firstSeen === undefined || dateOf(firstSeen) > date) continue;
    const count = byPortfolio.get(portfolio) ?? 0;
    if (count === 1) continue;
    note(
      count === 0
        ? `${date}: no VALUATION for ${portfolio}, though other portfolios were marked`
        : `${date}: ${count} VALUATION events for ${portfolio}; expected exactly one`,
    );
  }
}

// --- 3. Every fill strictly after its order (SPEC 1 rule 1) -----------------
const placed = new Map<string, Event>();
for (const event of events) {
  if (event.type === "ORDER_PLACED") placed.set(event.id, event);
}
for (const event of events) {
  if (event.type !== "ORDER_FILLED") continue;
  const orderId = str(event, "orderId");
  const order = placed.get(orderId);
  if (order === undefined) {
    note(`${dateOf(event)}: fill ${event.id} references order "${orderId}", which was never placed`);
    continue;
  }
  if (dateOf(event) <= dateOf(order)) {
    note(
      `${dateOf(event)}: ${event.portfolio} filled ${str(event, "ticker")} on ${dateOf(event)}, ` +
        `not strictly after its order of ${dateOf(order)} — a look-ahead fill`,
    );
  }
}

// --- 4. Cash never negative --------------------------------------------------
//
// Re-derived here rather than read from the VALUATION marks: a mark that
// disagrees with the events is exactly the kind of thing worth catching.
const cash = new Map<string, number>();
for (const event of events) {
  const current = cash.get(event.portfolio) ?? 0;
  let next = current;
  if (event.type === "DEPOSIT") next = current + num(event, "amountEur");
  else if (event.type === "DIVIDEND") next = current + num(event, "netEur");
  else if (event.type === "ORDER_FILLED") {
    next = str(event, "side") === "buy" ? current - num(event, "netEur") : current + num(event, "netEur");
  }
  // A cent of tolerance: every amount is rounded to 2dp as it is written.
  if (next < -0.01) {
    note(
      `${dateOf(event)}: ${event.portfolio} cash would go to ${next.toFixed(2)} EUR after ${event.type} ${event.id}`,
    );
  }
  cash.set(event.portfolio, next);
}

// --- Report ------------------------------------------------------------------
const first = events[0];
const last = events[events.length - 1];
console.log(`check:ledger  ${ledgerPath}`);
console.log(
  `  ${events.length} event(s), ${portfolios.length} portfolio(s), ${tradingDays.length} trading day(s)` +
    (first && last ? `, ${dateOf(first)} to ${dateOf(last)}` : ""),
);
for (const portfolio of portfolios) {
  const deposits = depositsByPortfolio.get(portfolio) ?? [];
  const contributed = deposits.reduce((total, deposit) => total + num(deposit, "amountEur"), 0);
  console.log(
    `  ${portfolio.padEnd(14)} cash ${(cash.get(portfolio) ?? 0).toFixed(2).padStart(9)} EUR` +
      `   contributed ${contributed.toFixed(2)} EUR`,
  );
}

if (problems.length > 0) {
  console.error(`\ncheck:ledger: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\ncheck:ledger: clean");
