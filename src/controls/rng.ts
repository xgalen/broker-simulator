/**
 * A seeded, reproducible pseudo-random generator (SPEC 5).
 *
 * "Seeded RNG, seed committed, so it is reproducible."
 *
 * Implemented here rather than pulled in as a dependency for two reasons: the
 * algorithms are six lines each, and a committed seed is only worth anything
 * if the sequence it produces is pinned by this repository rather than by
 * whatever version of a package happens to be installed in three years.
 *
 * `Math.random()` appears nowhere in this project, and the domain's purity
 * test forbids it outright.
 */

/** FNV-1a, 32-bit. Maps a seed string to a well-mixed integer. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // The FNV prime, 16777619, by shift-and-add so the whole thing stays
    // inside 32-bit integer arithmetic.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32: small, fast, and good enough for choosing a ticker. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A generator for one draw, keyed by the committed seed and whatever makes
 * this draw distinct — for `random`, the contribution month.
 *
 * Keying the stream rather than carrying a cursor is what makes the control
 * replayable. There is no RNG state to persist between runs and none to
 * corrupt: October's pick is a pure function of the seed and the string
 * "2026-10", so it can be re-derived from the ledger alone, and a run that is
 * retried after a crash picks the same instrument it picked the first time.
 */
export function streamFor(seed: string, key: string): () => number {
  return mulberry32(fnv1a32(`${seed}|${key}`));
}

/** Uniform integer in `[0, bound)`. */
export function nextIndex(random: () => number, bound: number): number {
  if (bound <= 0) throw new RangeError(`bound must be positive, got ${bound}`);
  const index = Math.floor(random() * bound);
  // `random()` is in [0, 1), so this only guards against a float landing on
  // the bound through rounding.
  return index >= bound ? bound - 1 : index;
}
