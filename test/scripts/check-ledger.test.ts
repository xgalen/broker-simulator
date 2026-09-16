/**
 * The evening check, checked.
 *
 * `scripts/check-ledger.ts` is the thing run by hand against the real ledger
 * during the verification week, so the failure that matters most is it
 * printing "clean" over a broken log. Each check gets a ledger built to break
 * it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "check-ledger.ts");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Result {
  readonly code: number;
  readonly out: string;
}

/** Write a ledger and run the checker over it. */
function check(events: readonly Record<string, unknown>[]): Result {
  const root = mkdtempSync(join(tmpdir(), "check-ledger-"));
  roots.push(root);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data", "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  try {
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

const deposit = (portfolio: string, date: string, amountEur = 100) => ({
  id: `dep-${portfolio}-${date}`,
  ts: `${date}T20:30:00Z`,
  portfolio,
  type: "DEPOSIT",
  amountEur,
});

const mark = (portfolio: string, date: string, cashEur = 100) => ({
  id: `val-${portfolio}-${date}`,
  ts: `${date}T20:30:00Z`,
  portfolio,
  type: "VALUATION",
  cashEur,
  positions: [],
  marketValueEur: 0,
  fxEffectEur: 0,
  contributedToDateEur: 100,
});

const order = (portfolio: string, date: string, id = "ord-1") => ({
  id,
  ts: `${date}T20:30:00Z`,
  portfolio,
  type: "ORDER_PLACED",
  decisionId: `dec-${date}`,
  ticker: "VWRL.AS",
  side: "buy",
  targetEur: 50,
  reason: "control",
});

const fill = (portfolio: string, date: string, orderId = "ord-1", netEur = 50) => ({
  id: `fill-${date}`,
  ts: `${date}T08:00:00Z`,
  portfolio,
  type: "ORDER_FILLED",
  orderId,
  ticker: "VWRL.AS",
  side: "buy",
  qty: 0.4,
  priceLocal: 117.11,
  currency: "EUR",
  fxRate: 1,
  grossEur: netEur - 1,
  feeEur: 1,
  fxCostEur: 0,
  netEur,
});

describe("a ledger that holds", () => {
  it("passes, and says so", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      order("dca", "2026-09-16"),
      mark("dca", "2026-09-16"),
      fill("dca", "2026-09-17"),
      mark("dca", "2026-09-17", 50),
    ]);
    expect(result.out).toContain("check:ledger: clean");
    expect(result.code).toBe(0);
  });

  it("reports the shape it found", () => {
    const result = check([deposit("dca", "2026-09-16"), mark("dca", "2026-09-16")]);
    expect(result.out).toContain("1 portfolio(s)");
    expect(result.out).toContain("1 trading day(s)");
  });
});

describe("the checks fire", () => {
  it("catches a portfolio funded twice", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      deposit("dca", "2026-09-17", 50),
      mark("dca", "2026-09-16"),
      mark("dca", "2026-09-17"),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("2 DEPOSIT events");
  });

  it("catches a portfolio that was never funded", () => {
    const result = check([mark("dca", "2026-09-16")]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("no DEPOSIT at all");
  });

  it("catches a missing VALUATION on a day other portfolios were marked", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      deposit("random", "2026-09-16"),
      mark("dca", "2026-09-16"),
      mark("random", "2026-09-16"),
      mark("dca", "2026-09-17"),
      // `random` has no mark on the 17th.
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("no VALUATION for random");
  });

  it("catches a portfolio marked twice in one day", () => {
    const doubled = { ...mark("dca", "2026-09-16"), id: "val-dup" };
    const result = check([deposit("dca", "2026-09-16"), mark("dca", "2026-09-16"), doubled]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("expected exactly one");
  });

  it("catches a fill on its own decision day (SPEC 1 rule 1)", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      order("dca", "2026-09-16"),
      fill("dca", "2026-09-16"),
      mark("dca", "2026-09-16"),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("look-ahead fill");
  });

  it("catches a fill whose order does not exist", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      mark("dca", "2026-09-16"),
      fill("dca", "2026-09-17", "ord-missing"),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("never placed");
  });

  it("catches cash going negative", () => {
    const result = check([
      deposit("dca", "2026-09-16"),
      order("dca", "2026-09-16"),
      mark("dca", "2026-09-16"),
      // 100 EUR in, 250 EUR out.
      fill("dca", "2026-09-17", "ord-1", 250),
      mark("dca", "2026-09-17", 0),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("cash would go to -150.00 EUR");
  });
});

describe("the ledger itself", () => {
  it("fails loudly when there is no ledger at all", () => {
    const root = mkdtempSync(join(tmpdir(), "check-ledger-empty-"));
    roots.push(root);
    try {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect.unreachable("should have exited 1");
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      expect(failure.status).toBe(1);
      expect(failure.stderr ?? "").toContain("no ledger at");
    }
  });

  it("refuses a corrupt line rather than skipping it", () => {
    const root = mkdtempSync(join(tmpdir(), "check-ledger-bad-"));
    roots.push(root);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "events.jsonl"), "not json\n", "utf8");
    try {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect.unreachable("should have exited non-zero");
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      expect(failure.status).not.toBe(0);
      expect(failure.stderr ?? "").toContain("is not JSON");
    }
  });
});
