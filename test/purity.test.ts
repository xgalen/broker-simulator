/**
 * SPEC 2 / SPEC 12 phase 1: the domain core must be unit-testable with zero
 * network access. This asserts it structurally, so a later phase cannot quietly
 * reach for `fetch`, the filesystem, or the host clock from inside the fold.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const domainDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "domain");
const files = readdirSync(domainDir).filter((name) => name.endsWith(".ts"));

const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bfrom\s+["']node:/, why: "imports a Node builtin" },
  { pattern: /\brequire\s*\(/, why: "uses require()" },
  { pattern: /\bfetch\s*\(/, why: "performs network I/O" },
  { pattern: /\bXMLHttpRequest\b/, why: "performs network I/O" },
  { pattern: /\bprocess\.(env|cwd|argv)\b/, why: "reads the process environment" },
  { pattern: /\bDate\.now\s*\(/, why: "reads the system clock" },
  { pattern: /\bnew Date\s*\(\s*\)/, why: "reads the system clock" },
  { pattern: /\bperformance\.now\s*\(/, why: "reads the system clock" },
  { pattern: /\bMath\.random\s*\(/, why: "is non-deterministic" },
];

describe("src/domain purity", () => {
  it("has modules to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file} is pure`, () => {
      const source = readFileSync(join(domainDir, file), "utf8");
      const offences = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
        ({ why }) => why,
      );
      expect(offences, `${file} ${offences.join(", ")}`).toEqual([]);
    });
  }

  it("imports nothing outside the domain", () => {
    for (const file of files) {
      const source = readFileSync(join(domainDir, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      for (const specifier of imports) {
        expect(specifier.startsWith("./"), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("ships no clock that reads the host: only fixedClock", () => {
    const source = readFileSync(join(domainDir, "clock.ts"), "utf8");
    expect(source).toMatch(/export function fixedClock/);
    expect(source).not.toMatch(/export function systemClock/);
  });
});
