/**
 * Caching (SPEC 6). The point is immutability, not speed: the committed
 * snapshot is the record of what the agents saw, and Yahoo revises history.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryCache, PointInTimeCache } from "../../src/data/cache.js";

const root = mkdtempSync(join(tmpdir(), "cache-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("MemoryCache", () => {
  it("round-trips a value", async () => {
    const cache = new MemoryCache();
    await cache.set("k", { a: 1 });
    expect(await cache.get("k")).toEqual({ a: 1 });
    expect(await cache.has("k")).toBe(true);
  });

  it("misses cleanly for an unknown key", async () => {
    expect(await new MemoryCache().get("nope")).toBeUndefined();
  });
});

describe("PointInTimeCache", () => {
  it("writes a key once and never rewrites it", async () => {
    const cache = new PointInTimeCache(root);
    await cache.set("prices:2026-09-15", { AAPL: 241.37 });
    await cache.set("prices:2026-09-15", { AAPL: 999.99 });
    // A revision must not overwrite what the agent actually saw that day.
    expect(await cache.get("prices:2026-09-15")).toEqual({ AAPL: 241.37 });
  });

  it("survives tickers that are not filesystem-safe", async () => {
    const cache = new PointInTimeCache(root);
    await cache.set("chart:^GSPC:2026-09-15", [1, 2]);
    await cache.set("chart:EURUSD=X:2026-09-15", [3]);
    expect(await cache.get("chart:^GSPC:2026-09-15")).toEqual([1, 2]);
    expect(await cache.get("chart:EURUSD=X:2026-09-15")).toEqual([3]);
  });

  it("writes readable JSON, since the file is committed to the repo", async () => {
    const cache = new PointInTimeCache(root);
    await cache.set("readable", { a: 1 });
    const text = readFileSync(join(root, "readable.json"), "utf8");
    expect(text).toBe('{\n  "a": 1\n}\n');
  });

  it("reports a miss for a key never written", async () => {
    expect(await new PointInTimeCache(root).has("absent")).toBe(false);
  });
});
