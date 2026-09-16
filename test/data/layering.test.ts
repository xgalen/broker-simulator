/**
 * Structural guards on the data layer.
 *
 * SPEC 2: "The domain core must be unit-testable with zero network access."
 * The domain's own purity is asserted in `purity.test.ts`; this asserts the
 * boundary above it — that exactly one module reaches for the network client,
 * and that the domain never depends on the data layer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const dataDir = join(srcDir, "data");
const domainDir = join(srcDir, "domain");

const dataFiles = readdirSync(dataDir).filter((f) => f.endsWith(".ts"));
const domainFiles = readdirSync(domainDir).filter((f) => f.endsWith(".ts"));
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

/**
 * The modules allowed to reach the network, and the whole list.
 * `yahooClient.ts` fetches prices, `http.ts` fetches RSS. Everything else in
 * the data layer takes its transport as a parameter — `MarketDataPort`,
 * `HttpGet` — which is what lets the brief builder be tested end to end with
 * nothing plugged in.
 */
const NETWORK_MODULES = ["http.ts", "yahooClient.ts"];

/** Prose mentioning fetch is not I/O; code is. Compare code only. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

describe("data layer boundaries", () => {
  it("confines yahoo-finance2 to a single module", () => {
    const importers = dataFiles.filter((file) =>
      /from\s+["']yahoo-finance2["']/.test(read(dataDir, file)),
    );
    expect(importers).toEqual(["yahooClient.ts"]);
  });

  it("keeps the port free of the vendor, so both adapters can implement it", () => {
    expect(read(dataDir, "port.ts")).not.toMatch(/from\s+["']yahoo-finance2["']/);
  });

  it("never lets the domain depend on the data layer", () => {
    for (const file of domainFiles) {
      expect(read(domainDir, file), `${file} imports the data layer`).not.toMatch(
        /from\s+["']\.\.\/data\//,
      );
    }
  });

  it("keeps network I/O out of everything but the two transports", () => {
    for (const file of dataFiles.filter((f) => !NETWORK_MODULES.includes(f))) {
      expect(
        stripComments(read(dataDir, file)),
        `${file} reaches for the network`,
      ).not.toMatch(/\bfetch\b|\bXMLHttpRequest\b/);
    }
  });

  it("keeps the feed reader independent of its transport", () => {
    // The parser and the reader are the halves the brief depends on; both must
    // stay usable against recorded XML, so neither may import the transport.
    expect(read(dataDir, "rss.ts")).not.toMatch(/from\s+["']\.\/http\.js["']/);
  });

  it("reads the clock through the injected Clock, never the host", () => {
    for (const file of dataFiles) {
      const source = read(dataDir, file);
      expect(source, `${file} calls Date.now()`).not.toMatch(/\bDate\.now\s*\(/);
    }
  });
});
