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

  it("keeps network I/O out of everything but the client", () => {
    for (const file of dataFiles.filter((f) => f !== "yahooClient.ts")) {
      expect(read(dataDir, file), `${file} calls fetch directly`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("reads the clock through the injected Clock, never the host", () => {
    for (const file of dataFiles) {
      const source = read(dataDir, file);
      expect(source, `${file} calls Date.now()`).not.toMatch(/\bDate\.now\s*\(/);
    }
  });
});
