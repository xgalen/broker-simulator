/**
 * `config/portfolios.yaml` and `config/simulation.yaml`, parsed and checked
 * (SPEC 8).
 *
 * Parsing is pure — the caller reads the files and hands the text in — for the
 * same reason `universe.ts` is: the guardrails are the interesting half of the
 * engine, and they should be exercisable in a unit test without a filesystem.
 *
 * Guardrails resolve against `defaults` here, once, so no caller downstream
 * has to remember which fields fall back and which do not. A portfolio that
 * overrides `minHoldDays` keeps every other default; that is how SPEC 8's
 * "minHoldDays: 3 # 0 for `news`" is expressed without restating the block.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PortfolioId, Ticker } from "../domain/types.js";
import type { Universe } from "../data/universe.js";

const text = z.string().min(1);
const nonNegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();

// --- simulation.yaml --------------------------------------------------------

const EngineSchema = z.object({
  pendingOrderExpirySessions: z.number().int().positive().default(5),
  maxQuoteAgeSessions: z.number().int().nonnegative().default(1),
});

const MetricsSchema = z.object({
  riskFreeAnnual: z.number().finite().default(0),
});

/**
 * What one model costs, in USD per million tokens (SPEC 7).
 *
 * Anthropic bills in USD; this project is denominated in EUR. Both are kept:
 * the USD figure is what the invoice will say, and the decision record also
 * carries its EUR value at the brief's own EURUSD rate. Guessing a rate here
 * would put a made-up number on the dashboard's cost line.
 */
const ModelPriceSchema = z.object({
  inputPerMTokUsd: nonNegative,
  outputPerMTokUsd: nonNegative,
  /** Cached input, normally 0.1x the input rate. */
  cacheReadPerMTokUsd: nonNegative.default(0),
  /** Writing to the cache, normally 1.25x the input rate at a 5m TTL. */
  cacheWritePerMTokUsd: nonNegative.default(0),
});

/**
 * SPEC 7's cost and loop controls, shared by every agent.
 *
 * These are guardrails and live with the guardrails: SPEC 10 forbids the
 * learning loop from altering the token budget, and the cheapest way to
 * guarantee that is to keep the budget out of any file learning writes to.
 */
const AgentsSchema = z.object({
  /** SPEC 7: "12 tool calls per run", counted by the tool wrapper itself. */
  maxToolCalls: z.number().int().positive().default(12),
  /** The SDK's own loop cap. A turn is one model call plus its tools. */
  maxTurns: z.number().int().positive().default(15),
  /** Cumulative input + output across the run (SPEC 7's token budget). */
  maxTotalTokensPerRun: z.number().int().positive().default(200_000),
  maxOutputTokensPerRun: z.number().int().positive().default(24_000),
  /** Per model call, not per run. */
  maxTokens: z.number().int().positive().default(8_000),
  /** SPEC 7: "Cap at 5 searches per agent per run." */
  maxWebSearches: z.number().int().nonnegative().default(5),
  /** SPEC 7: "its own decision history for the last 30 days". */
  decisionHistoryDays: z.number().int().nonnegative().default(30),
  pricing: z.record(z.string(), ModelPriceSchema).default({}),
});

export type ModelPrice = Readonly<z.infer<typeof ModelPriceSchema>>;
export type AgentsConfig = Readonly<z.infer<typeof AgentsSchema>>;

/**
 * The block a `simulation.yaml` with no `agents:` section resolves to.
 *
 * Spelled out rather than derived, because zod's `.default()` wants the parsed
 * shape and because a reader of this file should be able to see what a config
 * that says nothing actually gets. `pricing` is empty on purpose: an invented
 * price would put a fabricated number on the dashboard's cost line, and an
 * absent one is recorded as "unknown".
 */
const AGENT_DEFAULTS: z.infer<typeof AgentsSchema> = {
  maxToolCalls: 12,
  maxTurns: 15,
  maxTotalTokensPerRun: 200_000,
  maxOutputTokensPerRun: 24_000,
  maxTokens: 8_000,
  maxWebSearches: 5,
  decisionHistoryDays: 30,
  pricing: {},
};

export const SimulationSchema = z.object({
  schemaVersion: z.number().int().positive(),
  initialDepositEur: positive,
  monthlyDepositEur: positive,
  feePerOrderEur: nonNegative,
  /** Basis points added to every EUR<->USD conversion on a US trade. */
  fxSpreadBps: nonNegative,
  minOrderEur: nonNegative,
  dividendWithholdingPct: z.number().finite().min(0).max(100),
  engine: EngineSchema.default({ pendingOrderExpirySessions: 5, maxQuoteAgeSessions: 1 }),
  metrics: MetricsSchema.default({ riskFreeAnnual: 0 }),
  agents: AgentsSchema.default(AGENT_DEFAULTS),
});

export type SimulationConfig = Readonly<z.infer<typeof SimulationSchema>>;

// --- portfolios.yaml --------------------------------------------------------

/**
 * SPEC 8's guardrail block. Every field is required once resolved: a guardrail
 * that is merely absent is a guardrail nobody enforces, and the validator has
 * to be able to answer "is this allowed" without a maybe.
 */
const GuardrailsSchema = z.object({
  maxTradesPerMonth: z.number().int().nonnegative(),
  minHoldDays: z.number().int().nonnegative(),
  maxPositionPct: z.number().finite().min(0).max(100),
  positionLimitsActiveAboveEur: nonNegative,
  cashFloorEur: nonNegative,
  allowShorting: z.boolean(),
  allowLeverage: z.boolean(),
  allowDerivatives: z.boolean(),
});

const GuardrailsOverrideSchema = GuardrailsSchema.partial();

const DcaControlSchema = z.object({ type: z.literal("dca") });

const RandomControlSchema = z.object({
  type: z.literal("random"),
  /** SPEC 5: committed, so the whole sequence of picks is reproducible. */
  seed: text,
});

const ControlSchema = z.discriminatedUnion("type", [
  DcaControlSchema,
  RandomControlSchema,
]);

const PortfolioSchema = z.object({
  key: text,
  kind: z.literal(["control", "agent"]),
  enabled: z.boolean().default(true),
  description: text,
  guardrails: GuardrailsOverrideSchema.default({}),
  control: ControlSchema.optional(),
  mandate: text.optional(),
  model: text.optional(),
  learning: z.literal(["enabled", "frozen"]).optional(),
});

export const PortfoliosSchema = z.object({
  schemaVersion: z.number().int().positive(),
  defaults: z.object({ guardrails: GuardrailsSchema }),
  portfolios: z.array(PortfolioSchema).min(1),
});

export type Guardrails = Readonly<z.infer<typeof GuardrailsSchema>>;
type GuardrailsOverride = Readonly<z.infer<typeof GuardrailsOverrideSchema>>;
export type ControlSpec = Readonly<z.infer<typeof ControlSchema>>;
type RawPortfolio = Readonly<z.infer<typeof PortfolioSchema>>;

/** One portfolio, with its guardrails already resolved against the defaults. */
export interface PortfolioConfig {
  readonly key: PortfolioId;
  readonly kind: "control" | "agent";
  readonly enabled: boolean;
  readonly description: string;
  readonly guardrails: Guardrails;
  readonly control?: ControlSpec;
  readonly mandate?: string;
  readonly model?: string;
  readonly learning?: "enabled" | "frozen";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function firstIssue(error: z.ZodError, file: string): ConfigError {
  const issue = error.issues[0];
  const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
  return new ConfigError(`${file} is malformed${where}: ${issue?.message ?? "unknown error"}`);
}

function readYaml(yamlText: string, file: string): unknown {
  try {
    return parseYaml(yamlText);
  } catch (cause) {
    throw new ConfigError(`${file} is not valid YAML: ${(cause as Error).message}`);
  }
}

export function parseSimulation(yamlText: string): SimulationConfig {
  const result = SimulationSchema.safeParse(readYaml(yamlText, "simulation.yaml"));
  if (!result.success) throw firstIssue(result.error, "simulation.yaml");

  const config = result.data;
  const problems: string[] = [];
  if (config.minOrderEur > config.monthlyDepositEur) {
    // A minimum order above the monthly contribution means no portfolio can
    // ever act on a normal month. That is a configuration that silently does
    // nothing, which is the worst kind.
    problems.push(
      `minOrderEur ${config.minOrderEur} exceeds monthlyDepositEur ${config.monthlyDepositEur}: no portfolio could trade`,
    );
  }
  if (config.feePerOrderEur >= config.minOrderEur) {
    problems.push(
      `feePerOrderEur ${config.feePerOrderEur} is not below minOrderEur ${config.minOrderEur}: the smallest allowed order could not cover its own fee`,
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `simulation.yaml failed ${problems.length} check(s):\n  ${problems.join("\n  ")}`,
    );
  }
  return config;
}

/**
 * The portfolio roster, indexed. `active` is what the daily run iterates:
 * a declared-but-unbuilt agent (SPEC 12 phases 5-6) stays in the file so the
 * cast is visible from the start, but must not produce empty days in the log.
 */
export class Portfolios {
  private readonly byKey: ReadonlyMap<PortfolioId, PortfolioConfig>;

  constructor(readonly all: readonly PortfolioConfig[]) {
    const index = new Map<PortfolioId, PortfolioConfig>();
    for (const portfolio of all) index.set(portfolio.key, portfolio);
    this.byKey = index;
  }

  /** Every declared portfolio, in file order. */
  get keys(): readonly PortfolioId[] {
    return this.all.map((portfolio) => portfolio.key);
  }

  /** The portfolios this run actually drives. */
  get active(): readonly PortfolioConfig[] {
    return this.all.filter((portfolio) => portfolio.enabled);
  }

  get activeKeys(): readonly PortfolioId[] {
    return this.active.map((portfolio) => portfolio.key);
  }

  get controls(): readonly PortfolioConfig[] {
    return this.all.filter((portfolio) => portfolio.kind === "control");
  }

  get(key: PortfolioId): PortfolioConfig | undefined {
    return this.byKey.get(key);
  }

  has(key: PortfolioId): boolean {
    return this.byKey.has(key);
  }
}

/**
 * Overlay the fields a portfolio actually set onto the defaults.
 *
 * `{ ...defaults, ...override }` would not do: zod's `.partial()` produces
 * present-but-undefined keys, and under `exactOptionalPropertyTypes` those
 * overwrite a default with `undefined` — a guardrail silently unset by the act
 * of not mentioning it.
 */
function mergeGuardrails(
  defaults: Guardrails,
  override: GuardrailsOverride,
): Guardrails {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as Guardrails;
}

function resolve(raw: RawPortfolio, defaults: Guardrails): PortfolioConfig {
  return {
    key: raw.key,
    kind: raw.kind,
    enabled: raw.enabled,
    description: raw.description,
    guardrails: mergeGuardrails(defaults, raw.guardrails),
    ...(raw.control ? { control: raw.control } : {}),
    ...(raw.mandate ? { mandate: raw.mandate } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.learning ? { learning: raw.learning } : {}),
  };
}

/**
 * Parse and check `portfolios.yaml`.
 *
 * The cross-field checks catch the misconfigurations that would otherwise show
 * up as a portfolio that quietly never trades: a control with no behaviour, an
 * agent with no mandate, a percentage cap so small that every order it permits
 * is below `minOrderEur`.
 */
export function parsePortfolios(
  yamlText: string,
  options: { readonly simulation?: SimulationConfig } = {},
): Portfolios {
  const result = PortfoliosSchema.safeParse(readYaml(yamlText, "portfolios.yaml"));
  if (!result.success) throw firstIssue(result.error, "portfolios.yaml");

  const doc = result.data;
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const portfolio of doc.portfolios) {
    if (seen.has(portfolio.key)) problems.push(`duplicate portfolio key "${portfolio.key}"`);
    seen.add(portfolio.key);

    if (portfolio.kind === "control" && portfolio.control === undefined) {
      problems.push(`control "${portfolio.key}" declares no control block, so it has no behaviour`);
    }
    if (portfolio.kind === "agent" && portfolio.control !== undefined) {
      problems.push(`agent "${portfolio.key}" declares a control block`);
    }
    if (portfolio.kind === "agent" && portfolio.mandate === undefined) {
      problems.push(`agent "${portfolio.key}" names no mandate file`);
    }

    const guardrails = mergeGuardrails(doc.defaults.guardrails, portfolio.guardrails);
    if (guardrails.allowShorting || guardrails.allowLeverage || guardrails.allowDerivatives) {
      // SPEC 4 tracks long cash positions in two currencies and nothing else.
      // A portfolio permitted to short has no modelled margin, no borrow cost
      // and no valuation path — better to refuse the config than to invent one.
      problems.push(
        `"${portfolio.key}" enables shorting, leverage or derivatives, which the engine does not model`,
      );
    }
    const simulation = options.simulation;
    if (simulation !== undefined && guardrails.maxPositionPct > 0) {
      const capAtThreshold =
        (guardrails.positionLimitsActiveAboveEur * guardrails.maxPositionPct) / 100;
      if (capAtThreshold < simulation.minOrderEur && guardrails.maxPositionPct < 100) {
        // SPEC 8's own worked example: a 25% cap on a 50 EUR portfolio is
        // 12.50 EUR per name. The threshold exists so the cap stays dormant
        // until it is meaningful; if it bites at the threshold too, it never
        // stops biting.
        problems.push(
          `"${portfolio.key}": at ${guardrails.positionLimitsActiveAboveEur} EUR the ${guardrails.maxPositionPct}% cap allows ${capAtThreshold.toFixed(2)} EUR, below minOrderEur ${simulation.minOrderEur}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `portfolios.yaml failed ${problems.length} check(s):\n  ${problems.join("\n  ")}`,
    );
  }

  return new Portfolios(
    doc.portfolios.map((portfolio) => resolve(portfolio, doc.defaults.guardrails)),
  );
}

/**
 * The instrument the `dca` control buys. It lives in `universe.yaml` so the
 * control and SPEC 10's GLOBAL benchmark can never drift apart.
 */
export function dcaInstrument(universe: Universe): Ticker {
  return universe.document.dcaInstrument;
}
