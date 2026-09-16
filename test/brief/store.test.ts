/**
 * Committing the brief and the price snapshot (SPEC 6).
 *
 * These files are the point-in-time record: "never re-fetch history to
 * reconstruct the past, since Yahoo data gets revised". So the store refuses
 * to rewrite a day that already exists, and refuses to hand back a file that
 * no longer hashes to what it claims.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { serializeBrief } from "../../src/brief/hash.js";
import {
  briefPath,
  pricesPath,
  readBrief,
  readPrices,
  writeBrief,
  writePrices,
} from "../../src/brief/store.js";
import { BriefError, type BriefDocument } from "../../src/brief/types.js";
import { buildFixtureBrief } from "../helpers/brief.js";

const roots: string[] = [];
const newRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "brief-store-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const built = await buildFixtureBrief();
const brief = built.brief;
/** The same session, built half an hour later: a different, validly sealed brief. */
const rebuilt = (await buildFixtureBrief({ clock: fixedClock("2026-09-15T21:00:00.000Z") })).brief;

describe("writeBrief", () => {
  it("writes the canonical form under data/briefs/", () => {
    const root = newRoot();
    const file = writeBrief(root, brief);
    expect(file).toBe(briefPath(root, brief.date));
    expect(readFileSync(file, "utf8")).toBe(serializeBrief(brief));
  });

  it("round-trips through the reader", () => {
    const root = newRoot();
    expect(readBrief(writeBrief(root, brief))).toEqual(brief);
  });

  it("accepts a retried run writing the same bytes again", () => {
    const root = newRoot();
    writeBrief(root, brief);
    expect(() => writeBrief(root, brief)).not.toThrow();
  });

  it("refuses to rewrite a day with different content", () => {
    const root = newRoot();
    writeBrief(root, brief);
    expect(() => writeBrief(root, rebuilt)).toThrow(/never rewritten/);
  });

  it("rewrites only when a human says so explicitly", () => {
    const root = newRoot();
    writeBrief(root, brief);
    expect(() => writeBrief(root, rebuilt, { overwrite: true })).not.toThrow();
    expect(readBrief(briefPath(root, brief.date))).toEqual(rebuilt);
  });

  it("refuses a brief whose hash does not cover its content", () => {
    const root = newRoot();
    const tampered = { ...brief, date: "2026-09-16" } as BriefDocument;
    expect(() => writeBrief(root, tampered)).toThrow(/not the hash of its content/);
  });
});

describe("readBrief", () => {
  it("rejects a file that was edited after it was committed", () => {
    const root = newRoot();
    const file = writeBrief(root, brief);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const headlines = raw["headlines"] as { title: string }[];
    (headlines[0] as { title: string }).title = "Something the agent never read";
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expect(() => readBrief(file)).toThrow(/does not match its own hash/);
  });

  it("rejects a file that is not a brief", () => {
    const root = newRoot();
    const file = join(root, "not-a-brief.json");
    writeFileSync(file, '{"schemaVersion":1}', "utf8");
    expect(() => readBrief(file)).toThrow(BriefError);
  });

  it("rejects unreadable JSON", () => {
    const root = newRoot();
    const file = join(root, "broken.json");
    writeFileSync(file, "{ not json", "utf8");
    expect(() => readBrief(file)).toThrow(/not readable JSON/);
  });
});

describe("writePrices", () => {
  it("round-trips the raw snapshot under data/prices/", () => {
    const root = newRoot();
    const file = writePrices(root, built.prices);
    expect(file).toBe(pricesPath(root, built.prices.date));
    expect(readPrices(file)).toEqual(built.prices);
  });

  it("refuses to revise a committed snapshot", () => {
    const root = newRoot();
    writePrices(root, built.prices);
    const revised = { ...built.prices, fetchedAt: "2026-09-15T21:00:00.000Z" };
    expect(() => writePrices(root, revised)).toThrow(/never rewritten/);
  });
});
