import { describe, expect, it } from "vitest";
import { eur, qty, roundTo, toEur } from "../src/domain/money.js";

describe("money", () => {
  it("rounds half away from zero at EUR precision", () => {
    expect(eur(1.005)).toBe(1.01);
    expect(eur(2.675)).toBe(2.68);
    expect(eur(-1.005)).toBe(-1.01);
    expect(eur(0.1 + 0.2)).toBe(0.3);
  });

  it("keeps quantities at 4dp (SPEC 4: fractional shares)", () => {
    expect(qty(0.123456)).toBe(0.1235);
    expect(qty(1 / 3)).toBe(0.3333);
  });

  it("never produces negative zero, so serialised state is stable", () => {
    expect(Object.is(eur(-0.001), 0)).toBe(true);
  });

  it("converts local currency to EUR at local-per-EUR rates", () => {
    expect(roundTo(toEur(200, 1.25), 2)).toBe(160);
    expect(toEur(150, 1)).toBe(150);
    expect(() => toEur(1, 0)).toThrow(/fxRate/);
  });
});
