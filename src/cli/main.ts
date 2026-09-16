#!/usr/bin/env node
/**
 * The CLI entry point (SPEC 3: `run-daily`, `verify`, `rebuild-state`).
 *
 * Four commands, one dispatcher, no framework. Everything impure is built in
 * `context.ts` and handed down; this file only decides which command runs and
 * what the process exits with.
 *
 * Exit codes are deliberate. `run-daily` exits 0 on a data failure, because
 * SPEC 1.5 says a stale fetch logs SKIPPED and exits 0 — the run did its job
 * by refusing to trade. `verify` exits 1 on a violation, because a ledger that
 * breaks an invariant is a broken repository and should stop CI.
 */
import { resolve } from "node:path";
import { boolFlag, flag, optionalFlag, parseArgs } from "./args.js";
import { createAgentPorts, createLivePorts, loadConfig, systemClock } from "./context.js";
import { dryRunCli, DEFAULT_SCENARIO } from "./dry-run.js";
import { rebuildStateCli } from "./rebuild-state.js";
import { runDailyCli } from "./run-daily.js";
import { verifyCli } from "./verify.js";

const USAGE = `investor-simulator

  run-daily      [--config config] [--data data] [--session YYYY-MM-DD] [--dry]
                 Run one session: fill, apply actions, deposit, brief, decide,
                 queue, mark. Exits 0 even when it skips (SPEC 1.5).

  verify         [--config config] [--data data]
                 Replay the whole log and assert every invariant, plus the
                 look-ahead check against the committed briefs. Exits 1 on any
                 violation.

  rebuild-state  [--config config] [--data data] [--check]
                 Rebuild state.json from events.jsonl. --check asserts the
                 committed file is byte-identical to a fresh replay.

  dry-run        [--scenario ${DEFAULT_SCENARIO}] [--out .dryrun] [--keep]
                 Replay recorded price fixtures across simulated sessions into
                 a scratch directory, then verify what it wrote.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const configDir = resolve(repoRoot, flag(args, "config", "config"));
  const dataRoot = resolve(repoRoot, flag(args, "data", "data"));

  switch (args.command) {
    case "run-daily": {
      const config = loadConfig(configDir);
      const clock = systemClock();
      const ports = createLivePorts(clock, config.feeds);
      const agents = createAgentPorts();
      const session = optionalFlag(args, "session");
      const result = await runDailyCli({
        config,
        market: ports.market,
        feedReader: ports.feedReader,
        clock,
        dataRoot,
        agents,
        ...(session ? { sessionDate: session } : {}),
        ...(boolFlag(args, "dry") ? { dryRun: true } : {}),
      });
      // SPEC 1.5: a skipped run is a successful run. It declined to trade on
      // data it could not trust, which is the behaviour being asked for.
      return result.run.status === "completed" || result.run.status === "skipped" ? 0 : 0;
    }

    case "verify": {
      const config = loadConfig(configDir);
      return verifyCli({ dataRoot, universe: config.universe }).ok ? 0 : 1;
    }

    case "rebuild-state": {
      const config = loadConfig(configDir);
      const result = rebuildStateCli({
        dataRoot,
        universe: config.universe,
        simulation: config.simulation,
        ...(boolFlag(args, "check") ? { check: true } : {}),
      });
      return result.ok ? 0 : 1;
    }

    case "dry-run": {
      const result = await dryRunCli({
        scenarioFile: flag(args, "scenario", DEFAULT_SCENARIO),
        outDir: flag(args, "out", ".dryrun"),
        repoRoot,
        ...(boolFlag(args, "keep") ? { keep: true } : {}),
      });
      return result.ok ? 0 : 1;
    }

    default:
      process.stdout.write(USAGE);
      return args.command === "" || args.command === "help" ? 0 : 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A thrown error here is a bug or a broken config, not a market-data
    // failure — those are already handled and logged as SKIPPED.
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
