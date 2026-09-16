/**
 * Canonical serialisation and the brief hash (SPEC 6: "The brief is hashed;
 * every decision record stores the hash of the brief it saw").
 *
 * The hash is what makes the audit trail load-bearing. A decision record
 * pointing at `sha256:0f3c…` is a claim about exactly which prices and
 * headlines the agent was looking at, and the claim is only checkable if the
 * same content always hashes the same way. So:
 *
 *  - Object keys are sorted before hashing, at every depth. JSON preserves
 *    insertion order, and insertion order here is an accident of the order the
 *    data layer answered in.
 *  - `undefined` is rejected rather than dropped. A key that vanishes when a
 *    value happens to be missing produces a different hash for the same brief.
 *  - The committed file is written from the same canonical form, so re-hashing
 *    `data/briefs/2026-09-16.json` off disk reproduces the hash inside it.
 */
import { createHash } from "node:crypto";
import { BriefError, type BriefDocument, type UnhashedBrief } from "./types.js";

/** A JSON value, after canonicalisation. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Recursively sort object keys and reject anything JSON cannot round-trip.
 *
 * Non-finite numbers are a failure rather than a `null`: `NaN` in a price
 * means the mapping upstream is broken, and silently serialising it as null
 * would bury that in a file five agents then read as fact.
 */
export function canonicalize(value: unknown, path = "$"): Json {
  if (value === null) return null;

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new BriefError(`non-finite number at ${path}: ${value}`);
      }
      // Normalise -0, which serialises as "0" but compares unequal to 0.
      return value === 0 ? 0 : value;
    case "undefined":
      throw new BriefError(`undefined at ${path}: the brief must say null instead`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, Json> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key], `${path}.${key}`);
    }
    return sorted;
  }

  throw new BriefError(`value at ${path} is not serialisable: ${typeof value}`);
}

/** Compact canonical JSON. This exact string is what gets hashed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash a brief that does not carry its hash yet.
 *
 * The hash covers everything else, `generatedAt` included: a brief built an
 * hour later from the same sources is a different brief, and pretending
 * otherwise would let two different documents share one identity.
 */
export function hashBrief(brief: UnhashedBrief): string {
  return `sha256:${sha256Hex(canonicalJson(brief))}`;
}

/** Stamp the hash onto the document it covers. */
export function sealBrief(brief: UnhashedBrief): BriefDocument {
  return { ...brief, briefHash: hashBrief(brief) };
}

/** Recompute the hash of a committed brief and compare. */
export function verifyBriefHash(brief: BriefDocument): boolean {
  const { briefHash, ...rest } = brief;
  return hashBrief(rest) === briefHash;
}

/**
 * The committed form: canonical key order, two-space indent, trailing newline.
 * Pretty-printed because these files are read by humans in pull requests, and
 * a one-line 300 KB diff is not a review.
 */
export function serializeBrief(brief: BriefDocument): string {
  return `${JSON.stringify(canonicalize(brief), null, 2)}\n`;
}
