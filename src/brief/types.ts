/**
 * The shape of `data/briefs/YYYY-MM-DD.json` (SPEC 6).
 *
 * This file is the identical-information baseline of SPEC 1.4: built once by
 * deterministic code and handed unchanged to all five agents. It is also the
 * evidence in every audit the project makes of itself — the look-ahead check
 * (SPEC 1.1) reads the prices below to prove no fill used a price the agent
 * could already see, and every decision record stores this document's hash.
 *
 * Two conventions hold throughout, both in service of a stable hash:
 *
 *  - Absent data is `null`, never a missing key and never zero. A gap in the
 *    feed must not read as a price of nothing.
 *  - Keys are sorted when the document is serialised, so the committed file is
 *    exactly what was hashed, modulo whitespace.
 */
import { z } from "zod";

export const BRIEF_SCHEMA_VERSION = 1;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoTimestamp = z.string().datetime();
const nullableNumber = z.number().finite().nullable();

/**
 * Trailing returns over the windows SPEC 6 asks for, as fractions (0.0123 is
 * +1.23%). `null` where the history does not reach back far enough — a name
 * that listed three months ago has no 1y return, and inventing one would put a
 * fabricated number in front of five agents.
 */
export const ReturnWindowsSchema = z.object({
  d1: nullableNumber,
  d5: nullableNumber,
  m1: nullableNumber,
  m6: nullableNumber,
  y1: nullableNumber,
});

/**
 * One whitelisted instrument at the latest close.
 *
 * The five price fields are the ones the look-ahead check treats as visible to
 * the agent; anything added here that is a price must be added there too.
 */
export const InstrumentBriefSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  market: z.string(),
  currency: z.string(),
  region: z.string(),
  type: z.string(),
  sector: z.string().nullable(),
  exposure: z.string().nullable(),
  open: nullableNumber,
  high: nullableNumber,
  low: nullableNumber,
  close: nullableNumber,
  previousClose: nullableNumber,
  volume: nullableNumber,
  sessionDate: isoDate,
  asOf: isoTimestamp,
  returns: ReturnWindowsSchema,
});

/** An index or yield level. Context only — references are never tradable. */
export const ReferenceBriefSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  kind: z.string(),
  level: nullableNumber,
  previousClose: nullableNumber,
  changePct: nullableNumber,
  sessionDate: isoDate,
  asOf: isoTimestamp,
});

/** Units of `quote` per one `base`, the convention `money.toEur` expects. */
export const FxBriefSchema = z.object({
  pair: z.string(),
  base: z.string(),
  quote: z.string(),
  rate: z.number().finite(),
  asOf: isoTimestamp,
});

/**
 * One deduplicated story. `source` is the `id` of the feed in `feeds.yaml`, or
 * `yahoo:<query>` for the search module, so a decision record can always be
 * traced back to where the agent read something.
 */
export const HeadlineSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: isoTimestamp,
  /** Whitelisted instruments the story resolves to. Sorted, possibly empty. */
  tickers: z.array(z.string()),
  /** How many further copies of this story the dedup pass folded in. */
  duplicates: z.number().int().nonnegative(),
});

export const EarningsBriefSchema = z.object({
  ticker: z.string(),
  date: isoDate,
  confirmed: z.boolean(),
});

/**
 * Per-source outcome. A dead feed thins the brief rather than stopping the run
 * (SPEC 1.5 is about prices), so the thinning is recorded here where the
 * dashboard and the next maintainer can see it.
 */
export const SourceHealthSchema = z.object({
  source: z.string(),
  items: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const BriefSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** The session the brief describes. Decisions on it fill the next session. */
  date: isoDate,
  generatedAt: isoTimestamp,
  /** `sha256:<hex>` over every other field. */
  briefHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  fx: z.array(FxBriefSchema),
  /** Keyed by ticker, so a consumer can look one up without scanning. */
  instruments: z.record(z.string(), InstrumentBriefSchema),
  references: z.array(ReferenceBriefSchema),
  headlines: z.array(HeadlineSchema),
  earnings: z.array(EarningsBriefSchema),
  /**
   * What the universe did not supply today. `stale` quoted an older session
   * (flagged, never interpolated — SPEC 11); `missing` did not quote at all and
   * is therefore absent from `instruments` entirely, because an instrument with
   * no price is not something an agent can reason about.
   */
  gaps: z.object({
    stale: z.array(z.string()),
    missing: z.array(z.string()),
  }),
  sources: z.array(SourceHealthSchema),
});

export type ReturnWindows = Readonly<z.infer<typeof ReturnWindowsSchema>>;
export type InstrumentBrief = Readonly<z.infer<typeof InstrumentBriefSchema>>;
export type ReferenceBrief = Readonly<z.infer<typeof ReferenceBriefSchema>>;
export type FxBrief = Readonly<z.infer<typeof FxBriefSchema>>;
export type Headline = Readonly<z.infer<typeof HeadlineSchema>>;
export type EarningsBrief = Readonly<z.infer<typeof EarningsBriefSchema>>;
export type SourceHealth = Readonly<z.infer<typeof SourceHealthSchema>>;
export type BriefDocument = Readonly<z.infer<typeof BriefSchema>>;

/** The document before it is hashed: everything but the hash itself. */
export type UnhashedBrief = Omit<BriefDocument, "briefHash">;

/**
 * `data/prices/YYYY-MM-DD.json` (SPEC 6): the raw snapshot, kept apart from
 * the brief because it is the point-in-time record. "Never re-fetch history to
 * reconstruct the past, since Yahoo data gets revised."
 */
export const PriceSnapshotFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  date: isoDate,
  fetchedAt: isoTimestamp,
  quotes: z.array(
    z.object({
      ticker: z.string(),
      currency: z.string(),
      exchange: z.string(),
      open: nullableNumber,
      high: nullableNumber,
      low: nullableNumber,
      close: nullableNumber,
      previousClose: nullableNumber,
      volume: nullableNumber,
      asOf: isoTimestamp,
      sessionDate: isoDate,
    }),
  ),
});

export type PriceSnapshotFile = Readonly<z.infer<typeof PriceSnapshotFileSchema>>;

export class BriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefError";
  }
}
