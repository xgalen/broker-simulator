/**
 * The whitelist (SPEC 1.6). These run against the real
 * `config/universe.yaml`, so the file that governs trading is covered by CI
 * rather than by inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UniverseError, parseUniverse } from "../../src/data/universe.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const realYaml = readFileSync(join(repoRoot, "config", "universe.yaml"), "utf8");

const minimal = `
schemaVersion: 1
currencies: [EUR, USD]
markets:
  XETR: { name: Xetra, country: DE, currency: EUR, timezone: Europe/Berlin }
benchmarks:
  default: { EU: SAP.DE }
  sector: {}
dcaInstrument: SAP.DE
instruments:
  - { ticker: SAP.DE, name: SAP, market: XETR, currency: EUR, region: EU, sector: technology, type: equity }
references:
  - { ticker: "^GDAXI", name: DAX, kind: index }
fx:
  - { pair: "EURUSD=X", base: EUR, quote: USD }
`;

describe("config/universe.yaml", () => {
  const universe = parseUniverse(realYaml);

  it("holds the ~150 instruments SPEC 6 asks for", () => {
    expect(universe.size).toBe(150);
  });

  it("declares every instrument in a currency SPEC 4 defines", () => {
    expect(universe.document.currencies).toEqual(["EUR", "USD"]);
  });

  it("makes the dca control's ETF tradable", () => {
    expect(universe.has(universe.document.dcaInstrument)).toBe(true);
  });

  it("does not make index references tradable (SPEC 1.6)", () => {
    for (const reference of universe.document.references) {
      expect(universe.has(reference.ticker)).toBe(false);
      expect(universe.isReference(reference.ticker)).toBe(true);
    }
  });

  it("quotes references and FX in the brief without listing them as tradable", () => {
    expect(universe.quotableTickers).toContain("^GSPC");
    expect(universe.quotableTickers).toContain("EURUSD=X");
    expect(universe.has("^GSPC")).toBe(false);
    expect(universe.has("EURUSD=X")).toBe(false);
  });

  it("gives every instrument a home market that exists", () => {
    for (const instrument of universe.document.instruments) {
      expect(universe.document.markets[instrument.market]).toBeDefined();
    }
  });
});

describe("universe validation", () => {
  it("accepts a minimal well-formed file", () => {
    expect(parseUniverse(minimal).size).toBe(1);
  });

  it("rejects a duplicated ticker", () => {
    const text = minimal.replace(
      "instruments:\n",
      "instruments:\n  - { ticker: SAP.DE, name: Dup, market: XETR, currency: EUR, region: EU, sector: technology, type: equity }\n",
    );
    expect(() => parseUniverse(text)).toThrow(/duplicate ticker "SAP.DE"/);
  });

  it("rejects an instrument on a market that does not exist", () => {
    expect(() => parseUniverse(minimal.replace("market: XETR", "market: XNYS"))).toThrow(
      /unknown market "XNYS"/,
    );
  });

  it("rejects a currency that disagrees with its market", () => {
    expect(() => parseUniverse(minimal.replace("currency: EUR, region", "currency: USD, region"))).toThrow(
      /is USD but XETR trades in EUR/,
    );
  });

  it("rejects a currency outside the declared scope", () => {
    const text = minimal
      .replace("currency: EUR, timezone", "currency: CHF, timezone")
      .replace("currency: EUR, region", "currency: CHF, region");
    expect(() => parseUniverse(text)).toThrow(/outside the declared currencies/);
  });

  it("rejects a dcaInstrument the control cannot buy", () => {
    expect(() => parseUniverse(minimal.replace("dcaInstrument: SAP.DE", "dcaInstrument: NOPE.DE"))).toThrow(
      /dcaInstrument "NOPE.DE" is not in the universe/,
    );
  });

  it("rejects a benchmark that is not in the universe", () => {
    expect(() => parseUniverse(minimal.replace("default: { EU: SAP.DE }", "default: { EU: GONE.DE }"))).toThrow(
      /benchmark "GONE.DE" is not in the universe/,
    );
  });

  it("rejects a ticker that is both tradable and a reference", () => {
    expect(() => parseUniverse(minimal.replace('ticker: "^GDAXI"', "ticker: SAP.DE"))).toThrow(
      /both tradable and a reference/,
    );
  });

  it("rejects an instrument with neither sector nor exposure", () => {
    expect(() => parseUniverse(minimal.replace("sector: technology, ", ""))).toThrow(
      /has neither a sector nor an exposure/,
    );
  });

  it("names the field when the shape is wrong", () => {
    expect(() => parseUniverse(minimal.replace("schemaVersion: 1", "schemaVersion: one"))).toThrow(
      UniverseError,
    );
  });

  it("rejects text that is not YAML at all", () => {
    expect(() => parseUniverse("{{{")).toThrow(/not valid YAML/);
  });
});
