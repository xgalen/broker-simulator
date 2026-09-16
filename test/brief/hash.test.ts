/**
 * The brief hash (SPEC 6: "The brief is hashed; every decision record stores
 * the hash of the brief it saw").
 *
 * The property that matters is not that hashing works — it is that the same
 * content hashes the same way no matter what order the data layer answered in,
 * because a decision record citing a hash is only auditable if the hash is a
 * function of content alone.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalize,
  hashBrief,
  sealBrief,
  serializeBrief,
  sha256Hex,
  verifyBriefHash,
} from "../../src/brief/hash.js";
import { BriefError, type UnhashedBrief } from "../../src/brief/types.js";

const brief: UnhashedBrief = {
  schemaVersion: 1,
  date: "2026-09-15",
  generatedAt: "2026-09-15T20:30:00.000Z",
  fx: [{ pair: "EURUSD=X", base: "EUR", quote: "USD", rate: 1.0856, asOf: "2026-09-15T20:30:00.000Z" }],
  instruments: {},
  references: [],
  headlines: [],
  earnings: [],
  gaps: { stale: [], missing: [] },
  sources: [],
};

describe("canonicalize", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("leaves array order alone, because order is meaning there", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("normalises -0, which serialises as 0 but compares unequal", () => {
    expect(Object.is(canonicalize(-0), 0)).toBe(true);
  });

  it("refuses undefined rather than dropping the key", () => {
    expect(() => canonicalize({ close: undefined })).toThrow(/\$\.close/);
  });

  it("refuses a non-finite number rather than writing null", () => {
    expect(() => canonicalize({ returns: { d1: Number.NaN } })).toThrow(BriefError);
  });
});

describe("hashBrief", () => {
  it("is a function of content, not of key order", () => {
    const reordered = {
      sources: brief.sources,
      gaps: brief.gaps,
      earnings: brief.earnings,
      headlines: brief.headlines,
      references: brief.references,
      instruments: brief.instruments,
      fx: brief.fx,
      generatedAt: brief.generatedAt,
      date: brief.date,
      schemaVersion: brief.schemaVersion,
    } satisfies UnhashedBrief;
    expect(hashBrief(reordered)).toBe(hashBrief(brief));
  });

  it("changes when any content changes, down to a basis point", () => {
    const nudged: UnhashedBrief = {
      ...brief,
      fx: [{ ...(brief.fx[0] as (typeof brief.fx)[number]), rate: 1.0857 }],
    };
    expect(hashBrief(nudged)).not.toBe(hashBrief(brief));
  });

  it("changes when the brief is rebuilt at a different instant", () => {
    expect(hashBrief({ ...brief, generatedAt: "2026-09-15T20:31:00.000Z" })).not.toBe(
      hashBrief(brief),
    );
  });

  it("is a sha256 of the canonical JSON, and says so in the value", () => {
    expect(hashBrief(brief)).toBe(`sha256:${sha256Hex(canonicalJson(brief))}`);
  });
});

describe("sealBrief", () => {
  const sealed = sealBrief(brief);

  it("stamps a hash the document then verifies against", () => {
    expect(verifyBriefHash(sealed)).toBe(true);
  });

  it("fails verification once a byte of content is edited", () => {
    expect(verifyBriefHash({ ...sealed, date: "2026-09-16" })).toBe(false);
  });

  it("writes a file that still hashes to what it claims", () => {
    const fromDisk = JSON.parse(serializeBrief(sealed)) as typeof sealed;
    expect(verifyBriefHash(fromDisk)).toBe(true);
    expect(serializeBrief(sealed).endsWith("\n")).toBe(true);
  });
});
