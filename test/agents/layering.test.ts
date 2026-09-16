/**
 * Structural guards on the agent layer.
 *
 * The layers below have these: `purity.test.ts` for the domain,
 * `data/layering.test.ts` for the two transports, `engine/layering.test.ts`
 * for the engine and the controls. This is the same argument one layer up, and
 * it matters more here than anywhere else — an agent is the one component that
 * costs money to run, so an accidental dependency on the network or on a
 * credential is the difference between a test suite and a bill.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/engine.js";

const srcDir = join(repoRoot, "src");
const agentsDir = join(srcDir, "agents");

const ts = (dir: string): string[] => readdirSync(dir).filter((file) => file.endsWith(".ts"));
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

/**
 * The one module allowed to reach the network.
 *
 * The model provider does its own HTTP inside `@strands-agents/sdk`, which is
 * why `model.ts` is a factory rather than a client: every test hands the agent
 * a scripted `Model` and the SDK's transport is never constructed.
 */
const NETWORK_MODULES = ["search.ts"];

describe("agent layer boundaries", () => {
  it("has modules to check", () => {
    expect(ts(agentsDir).length).toBeGreaterThan(5);
  });

  it("confines network I/O to the search provider", () => {
    for (const file of ts(agentsDir).filter((name) => !NETWORK_MODULES.includes(name))) {
      expect(stripComments(read(agentsDir, file)), `${file} reaches the network`).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest/,
      );
    }
  });

  it("reads the credential in the composition root and nowhere else", () => {
    // SPEC 13: the key is a repo secret. One place reads it, one place holds
    // it, and nothing downstream can go looking for it in the environment.
    const readers = ts(agentsDir).filter((file) =>
      /process\.env/.test(stripComments(read(agentsDir, file))),
    );
    expect(readers).toEqual([]);

    const cli = join(srcDir, "cli");
    const envReaders = ts(cli).filter((file) => /process\.env/.test(stripComments(read(cli, file))));
    expect(envReaders).toEqual(["context.ts"]);
  });

  it("never logs a credential", () => {
    for (const file of ts(agentsDir)) {
      const source = stripComments(read(agentsDir, file));
      expect(source, `${file} logs an API key`).not.toMatch(
        /(console|log)[^\n]*\b(apiKey|API_KEY)\b/,
      );
    }
  });

  it("never touches the filesystem: mandates and history arrive as values", () => {
    // SPEC 14: "a mandate file is never modified by any code path". The
    // cheapest way to keep that true is for no code path here to be able to
    // name a file at all.
    for (const file of ts(agentsDir)) {
      expect(read(agentsDir, file), `${file} touches the filesystem`).not.toMatch(
        /from\s+["']node:fs["']/,
      );
    }
  });

  it("reads the clock through the session, never the host", () => {
    // Every date an agent sees comes from the brief or the session date. A
    // prompt built against the host clock would drift from the ledger it is
    // deciding on, and would make a recorded prompt unreproducible.
    for (const file of ts(agentsDir)) {
      const source = stripComments(read(agentsDir, file));
      expect(source, `${file} calls Date.now()`).not.toMatch(/\bDate\.now\s*\(/);
      expect(source, `${file} constructs a Date from now`).not.toMatch(/new Date\s*\(\s*\)/);
    }
  });

  it("keeps Math.random out: a recorded run has to be explicable", () => {
    for (const file of ts(agentsDir)) {
      expect(stripComments(read(agentsDir, file)), file).not.toMatch(/Math\.random\s*\(/);
    }
  });

  it("never lets a lower layer depend on the agents", () => {
    for (const dir of ["domain", "data", "brief", "engine", "controls"]) {
      for (const file of ts(join(srcDir, dir))) {
        expect(read(join(srcDir, dir), file), `${dir}/${file} imports the agents`).not.toMatch(
          /from\s+["']\.\.\/agents\//,
        );
      }
    }
  });

  it("confines the SDK to the modules that actually need it", () => {
    // `tools.ts` for the tool factory, `agent.ts` for the loop, `mock.ts` and
    // `model.ts` for the two model providers. Anything else importing the SDK
    // means a type from it has leaked into the project's own vocabulary.
    const importers = ts(agentsDir).filter((file) =>
      /from\s+["']@strands-agents\/sdk/.test(read(agentsDir, file)),
    );
    expect(importers.sort()).toEqual(["agent.ts", "mock.ts", "model.ts", "tools.ts"]);
  });

  it("keeps the vendor model provider out of everything but the factory", () => {
    const importers = ts(agentsDir).filter((file) =>
      /@strands-agents\/sdk\/models\/anthropic/.test(read(agentsDir, file)),
    );
    expect(importers).toEqual(["model.ts"]);
  });
});
