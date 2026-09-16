/**
 * Structural guards on the engine and the controls.
 *
 * `purity.test.ts` asserts the domain is pure and `data/layering.test.ts`
 * asserts exactly two modules reach the network. This asserts the layer above
 * both: the engine is where the daily sequence lives, and it must stay drivable
 * with nothing plugged in — otherwise the dry run stops being a test of the
 * real thing and becomes a test of a second implementation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/engine.js";

const srcDir = join(repoRoot, "src");
const engineDir = join(srcDir, "engine");
const controlsDir = join(srcDir, "controls");

const ts = (dir: string): string[] => readdirSync(dir).filter((file) => file.endsWith(".ts"));
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

/** The engine's own file I/O, and the only module allowed any. */
const IO_MODULES = ["ledger.ts"];

describe("engine boundaries", () => {
  it("has modules to check", () => {
    expect(ts(engineDir).length).toBeGreaterThan(5);
    expect(ts(controlsDir).length).toBeGreaterThan(2);
  });

  it("never reads the host clock: everything takes a Clock", () => {
    for (const dir of [engineDir, controlsDir]) {
      for (const file of ts(dir)) {
        const source = stripComments(read(dir, file));
        expect(source, `${file} calls Date.now()`).not.toMatch(/\bDate\.now\s*\(/);
        expect(source, `${file} constructs a Date from now`).not.toMatch(/new Date\s*\(\s*\)/);
      }
    }
  });

  it("never reaches the network", () => {
    for (const dir of [engineDir, controlsDir]) {
      for (const file of ts(dir)) {
        expect(stripComments(read(dir, file)), `${file} reaches the network`).not.toMatch(
          /\bfetch\s*\(|XMLHttpRequest/,
        );
      }
    }
  });

  it("never imports the vendor client", () => {
    for (const dir of [engineDir, controlsDir]) {
      for (const file of ts(dir)) {
        expect(read(dir, file), file).not.toMatch(/from\s+["']yahoo-finance2["']/);
      }
    }
  });

  it("confines the engine's file I/O to the ledger module", () => {
    for (const file of ts(engineDir).filter((name) => !IO_MODULES.includes(name))) {
      expect(read(engineDir, file), `${file} touches the filesystem`).not.toMatch(
        /from\s+["']node:fs["']/,
      );
    }
    // And the run itself takes a log and returns a log: the CLI does the writing.
    expect(read(engineDir, "run.ts")).not.toMatch(/from\s+["']node:/);
  });

  it("keeps Math.random out of the controls: the seed is the whole point", () => {
    // SPEC 5: "Seeded RNG, seed committed, so it is reproducible." A single
    // Math.random() anywhere in here makes that claim false.
    for (const file of ts(controlsDir)) {
      expect(stripComments(read(controlsDir, file)), file).not.toMatch(/Math\.random\s*\(/);
    }
    for (const file of ts(engineDir)) {
      expect(stripComments(read(engineDir, file)), file).not.toMatch(/Math\.random\s*\(/);
    }
  });

  it("builds the only host-reading clock in the composition root", () => {
    const cli = join(srcDir, "cli");
    const clockOwners = ts(cli).filter((file) => /Date\.now\s*\(/.test(stripComments(read(cli, file))));
    expect(clockOwners).toEqual(["context.ts"]);
  });

  it("never lets the domain or the data layer depend on the engine", () => {
    for (const dir of [join(srcDir, "domain"), join(srcDir, "data"), join(srcDir, "brief")]) {
      for (const file of ts(dir)) {
        expect(read(dir, file), `${file} imports the engine`).not.toMatch(
          /from\s+["']\.\.\/(engine|controls|cli)\//,
        );
      }
    }
  });
});
