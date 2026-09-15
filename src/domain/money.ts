/**
 * Deterministic decimal arithmetic.
 *
 * Every monetary figure in the ledger is rounded to 2 decimal places and every
 * quantity to 4 (SPEC 4: "Fractional shares are allowed (4 decimal places)").
 * Rounding is applied after each event is folded in, so a replay of the same
 * log always produces bit-identical numbers regardless of evaluation order.
 */

/** EUR amounts and local-currency prices carry 2 decimals. */
export const EUR_DP = 2;

/** Share quantities carry 4 decimals. */
export const QTY_DP = 4;

/**
 * Half-away-from-zero rounding to `dp` decimals, with a relative epsilon so
 * that values whose binary representation sits a hair below a tie (1.005 is
 * really 1.00499999999999989) still round the way a human expects.
 */
export function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot round non-finite value: ${value}`);
  }
  const factor = 10 ** dp;
  const scaled = value * factor;
  const epsilon = Math.max(Math.abs(scaled), 1) * 1e-9;
  const rounded =
    scaled >= 0 ? Math.round(scaled + epsilon) : -Math.round(-scaled + epsilon);
  // `+ 0` normalises -0 to 0 so serialised state never contains "-0".
  return rounded / factor + 0;
}

/** Round to EUR precision (2dp). */
export function eur(value: number): number {
  return roundTo(value, EUR_DP);
}

/** Round to share-quantity precision (4dp). */
export function qty(value: number): number {
  return roundTo(value, QTY_DP);
}

/** True when two EUR amounts agree to within `tolerance` (default one cent). */
export function eurEquals(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance + 1e-9;
}

/**
 * Convert a local-currency amount to EUR.
 *
 * `fxRate` is quoted the way Yahoo quotes `EURUSD=X`: units of local currency
 * per one EUR. EUR-denominated instruments therefore carry a rate of exactly 1.
 */
export function toEur(amountLocal: number, fxRate: number): number {
  if (!(fxRate > 0)) {
    throw new RangeError(`fxRate must be positive, got: ${fxRate}`);
  }
  return amountLocal / fxRate;
}
