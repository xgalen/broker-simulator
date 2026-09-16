/**
 * Reading and writing `data/briefs/` and `data/prices/` (SPEC 3, SPEC 6).
 *
 * The I/O half of the brief, kept apart from `build.ts` so the builder stays a
 * function from ports to a document and the golden test never touches a disk
 * it then has to clean up.
 *
 * Both files are point-in-time records. A brief is written once: re-running a
 * day and overwriting it would rewrite what the agents saw, and every decision
 * record citing the old hash would be left pointing at a document that no
 * longer exists. Rewriting the same bytes is fine — that is a retried job, not
 * a new brief — and anything else needs `overwrite` set explicitly by a human
 * who knows what the day's history is worth.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IsoDate } from "../domain/types.js";
import { canonicalize, serializeBrief, verifyBriefHash } from "./hash.js";
import {
  BriefError,
  BriefSchema,
  PriceSnapshotFileSchema,
  type BriefDocument,
  type PriceSnapshotFile,
} from "./types.js";

export function briefPath(dataRoot: string, date: IsoDate): string {
  return join(dataRoot, "briefs", `${date}.json`);
}

export function pricesPath(dataRoot: string, date: IsoDate): string {
  return join(dataRoot, "prices", `${date}.json`);
}

function writeOnce(file: string, contents: string, overwrite: boolean): void {
  if (existsSync(file) && !overwrite) {
    if (readFileSync(file, "utf8") === contents) return;
    throw new BriefError(
      `${file} already exists with different content; a committed point-in-time record is never rewritten`,
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

export interface WriteOptions {
  readonly overwrite?: boolean;
}

/** Write the brief in its canonical form and return the path. */
export function writeBrief(
  dataRoot: string,
  brief: BriefDocument,
  options: WriteOptions = {},
): string {
  if (!verifyBriefHash(brief)) {
    throw new BriefError(
      `brief for ${brief.date} carries ${brief.briefHash}, which is not the hash of its content`,
    );
  }
  const file = briefPath(dataRoot, brief.date);
  writeOnce(file, serializeBrief(brief), options.overwrite ?? false);
  return file;
}

export function writePrices(
  dataRoot: string,
  prices: PriceSnapshotFile,
  options: WriteOptions = {},
): string {
  const file = pricesPath(dataRoot, prices.date);
  writeOnce(file, `${JSON.stringify(canonicalize(prices), null, 2)}\n`, options.overwrite ?? false);
  return file;
}

/**
 * Read a committed brief, validate its shape and check its hash.
 *
 * The hash check is the point. A brief on disk is the evidence behind every
 * decision that cites it, and a file that no longer hashes to what it claims
 * has either been edited or been corrupted — in both cases the honest thing is
 * to refuse it rather than let an agent read it as the record.
 */
export function readBrief(file: string): BriefDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new BriefError(`${file} is not readable JSON: ${(cause as Error).message}`);
  }

  const result = BriefSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    throw new BriefError(`${file} is not a valid brief${where}: ${issue?.message ?? "unknown"}`);
  }

  const brief = result.data;
  if (!verifyBriefHash(brief)) {
    throw new BriefError(`${file} does not match its own hash ${brief.briefHash}`);
  }
  return brief;
}

export function readPrices(file: string): PriceSnapshotFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new BriefError(`${file} is not readable JSON: ${(cause as Error).message}`);
  }
  const result = PriceSnapshotFileSchema.safeParse(raw);
  if (!result.success) {
    throw new BriefError(`${file} is not a valid price snapshot`);
  }
  return result.data;
}
