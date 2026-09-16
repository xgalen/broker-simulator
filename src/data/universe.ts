/**
 * The tradable whitelist (SPEC 1.6, SPEC 6).
 *
 * `config/universe.yaml` decides what may be traded. An order for anything not
 * in `instruments` is rejected by the validator and never reaches the ledger,
 * and that includes the `references` block: index levels are context for the
 * brief, not something an agent may buy.
 *
 * Parsing is pure — the caller reads the file and hands the text in — so the
 * whitelist can be exercised in tests without touching a filesystem.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Ticker } from "../domain/types.js";

const text = z.string().min(1);

const MarketSchema = z.object({
  name: text,
  country: text,
  currency: text,
  timezone: text,
});

const InstrumentSchema = z.object({
  ticker: text,
  name: text,
  market: text,
  currency: text,
  region: text,
  type: text,
  /** Equities carry a sector; funds carry an exposure instead. */
  sector: text.optional(),
  exposure: text.optional(),
});

const ReferenceSchema = z.object({
  ticker: text,
  name: text,
  kind: text,
});

const FxPairSchema = z.object({
  pair: text,
  base: text,
  quote: text,
});

const BenchmarkMapSchema = z.record(z.string(), text);

export const UniverseSchema = z.object({
  schemaVersion: z.number().int().positive(),
  currencies: z.array(text).min(1),
  markets: z.record(z.string(), MarketSchema),
  benchmarks: z.object({
    default: BenchmarkMapSchema,
    sector: z.record(z.string(), BenchmarkMapSchema),
  }),
  dcaInstrument: text,
  instruments: z.array(InstrumentSchema).min(1),
  references: z.array(ReferenceSchema).default([]),
  fx: z.array(FxPairSchema).default([]),
});

export type Market = Readonly<z.infer<typeof MarketSchema>>;
export type Instrument = Readonly<z.infer<typeof InstrumentSchema>>;
export type Reference = Readonly<z.infer<typeof ReferenceSchema>>;
export type FxPair = Readonly<z.infer<typeof FxPairSchema>>;
export type UniverseDocument = Readonly<z.infer<typeof UniverseSchema>>;

export class UniverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniverseError";
  }
}

/**
 * The whitelist, indexed. `has()` is the question the order validator asks, and
 * it answers `false` for references and FX pairs by construction: only
 * `instruments` are ever added to the tradable set.
 */
export class Universe {
  private readonly byTicker: ReadonlyMap<Ticker, Instrument>;
  private readonly referenceTickers: ReadonlySet<Ticker>;

  constructor(readonly document: UniverseDocument) {
    const index = new Map<Ticker, Instrument>();
    for (const instrument of document.instruments) {
      index.set(instrument.ticker, instrument);
    }
    this.byTicker = index;
    this.referenceTickers = new Set(document.references.map((r) => r.ticker));
  }

  /** Every tradable ticker, in file order. */
  get tickers(): readonly Ticker[] {
    return this.document.instruments.map((i) => i.ticker);
  }

  /** Tradable instruments plus references and FX: everything the brief quotes. */
  get quotableTickers(): readonly Ticker[] {
    return [
      ...this.tickers,
      ...this.document.references.map((r) => r.ticker),
      ...this.document.fx.map((f) => f.pair),
    ];
  }

  /** SPEC 1.6: is this ticker tradable? References are not. */
  has(ticker: Ticker): boolean {
    return this.byTicker.has(ticker);
  }

  get(ticker: Ticker): Instrument | undefined {
    return this.byTicker.get(ticker);
  }

  isReference(ticker: Ticker): boolean {
    return this.referenceTickers.has(ticker);
  }

  get size(): number {
    return this.byTicker.size;
  }
}

/**
 * Parse and check `universe.yaml`.
 *
 * The cross-field checks are the ones that would otherwise fail much later and
 * much less clearly: a market that does not exist, a currency outside the two
 * SPEC 4 defines, a `dcaInstrument` the control portfolio cannot buy.
 */
export function parseUniverse(yamlText: string): Universe {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new UniverseError(`universe.yaml is not valid YAML: ${(cause as Error).message}`);
  }

  const result = UniverseSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    throw new UniverseError(
      `universe.yaml is malformed${where}: ${issue?.message ?? "unknown error"}`,
    );
  }

  const doc = result.data;
  const problems: string[] = [];
  const allowedCurrencies = new Set(doc.currencies);
  const seen = new Set<string>();

  for (const instrument of doc.instruments) {
    if (seen.has(instrument.ticker)) {
      problems.push(`duplicate ticker "${instrument.ticker}"`);
    }
    seen.add(instrument.ticker);

    const market = doc.markets[instrument.market];
    if (market === undefined) {
      problems.push(`"${instrument.ticker}" names unknown market "${instrument.market}"`);
    } else if (market.currency !== instrument.currency) {
      problems.push(
        `"${instrument.ticker}" is ${instrument.currency} but ${instrument.market} trades in ${market.currency}`,
      );
    }
    if (!allowedCurrencies.has(instrument.currency)) {
      problems.push(
        `"${instrument.ticker}" is ${instrument.currency}, outside the declared currencies [${doc.currencies.join(", ")}]`,
      );
    }
    if (instrument.sector === undefined && instrument.exposure === undefined) {
      problems.push(`"${instrument.ticker}" has neither a sector nor an exposure`);
    }
  }

  for (const reference of doc.references) {
    if (seen.has(reference.ticker)) {
      problems.push(
        `"${reference.ticker}" is both tradable and a reference; references must not be tradable`,
      );
    }
  }

  if (!seen.has(doc.dcaInstrument)) {
    problems.push(`dcaInstrument "${doc.dcaInstrument}" is not in the universe`);
  }

  const benchmarkTickers = [
    ...Object.values(doc.benchmarks.default),
    ...Object.values(doc.benchmarks.sector).flatMap((m) => Object.values(m)),
  ];
  for (const ticker of new Set(benchmarkTickers)) {
    if (!seen.has(ticker)) {
      problems.push(`benchmark "${ticker}" is not in the universe`);
    }
  }

  if (problems.length > 0) {
    throw new UniverseError(
      `universe.yaml failed ${problems.length} check(s):\n  ${problems.join("\n  ")}`,
    );
  }

  return new Universe(doc);
}
