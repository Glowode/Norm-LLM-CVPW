/**
 * Seeded, stateless randomness.
 *
 * Everything here is a pure function of an integer key, so a frame never depends on which frames
 * were rendered before it, and two workers rendering different ranges of the same film agree on
 * every value. This is the only permitted source of randomness in the frame-drawing path
 * (`docs/SPEC.md` D2).
 *
 * There is deliberately no `random()` that "just works": unseeded randomness is the bug this module
 * exists to prevent.
 */

/**
 * The film-wide seed every hash is folded through.
 *
 * `project.json::seeds.global` was declared, marked REQUIRED by the schema, and read by nothing: the engine
 * seeded from string and index literals inside each scene, so the project-level seed never influenced a pixel.
 * That is the same defect as an unimplemented `bloom`, and worse, because validation vouched for it.
 *
 * Folding it in HERE rather than in each scene is the whole point: every seeded value in every scene funnels
 * through `hash32`, so one line makes the declared seed real everywhere at once. A per-scene change would have
 * to be remembered by every future scene author, which is a rule that gets forgotten.
 *
 * Set once at boot from the project, never mutated afterwards, so a frame remains a pure function of
 * `(t, project)` - which is what `docs/SPEC.md` D1 actually promises.
 */
let globalSeed = "";

/** Set the film-wide seed. Called once by the engine at boot; not part of the per-frame path. */
export function setGlobalSeed(seed: string | number | undefined): void {
  globalSeed = seed === undefined || seed === "" ? "" : typeof seed === "number" ? numberToKey(seed) : String(seed);
}

/** The seed in effect, for a diagnostic that needs to say which film it measured. */
export function getGlobalSeed(): string {
  return globalSeed;
}

/** FNV-1a, 32-bit. The base hash for turning strings and numbers into integer keys. */
export function hash32(input: string | number): number {
  const raw = typeof input === "number" ? numberToKey(input) : input;
  // Prefixing rather than mixing keeps the empty-seed case byte-identical to the pre-seed behaviour, so a
  // project that declares no seed renders exactly as it did before this existed.
  const s = globalSeed === "" ? raw : `${globalSeed}\u0000${raw}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A stable string form of a number, so `hash32(1.5)` and `hash32("1.5")` agree and so the key does
 * not depend on the platform's number-to-string formatting.
 */
function numberToKey(n: number): string {
  if (!Number.isFinite(n)) return "NaN";
  if (Number.isInteger(n)) return `${n}`;
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A single deterministic value in `[0, 1)` for a key.
 *
 * Use this for one-off decisions: which of five poses, whether a butterfly appears.
 * For a *sequence* of values, use {@link mulberry32} so consecutive draws are uncorrelated.
 */
export function hash1(key: string | number, salt = 0): number {
  const h = hash32(`${typeof key === "number" ? numberToKey(key) : key}:${salt}`);
  // Map to [0,1) with the same finaliser mulberry32 uses, so the two agree on distribution shape.
  let x = h;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}

/** Two independent values for a key, for 2-D placement without correlation. */
export function hash2(key: string | number, salt = 0): [number, number] {
  return [hash1(key, salt), hash1(key, salt + 0x9e37)];
}

/** A deterministic value in `[lo, hi)`. */
export function hashRange(key: string | number, lo: number, hi: number, salt = 0): number {
  return lo + (hi - lo) * hash1(key, salt);
}

/** A deterministic integer in `[0, n)`. */
export function hashInt(key: string | number, n: number, salt = 0): number {
  if (n <= 0) throw new Error(`hashInt needs n > 0, got ${n}`);
  return Math.min(n - 1, Math.floor(hash1(key, salt) * n));
}

/** Pick one element deterministically. Throws on an empty list rather than returning undefined. */
export function hashPick<T>(key: string | number, items: readonly T[], salt = 0): T {
  if (!items.length) throw new Error("hashPick needs a non-empty list");
  return items[hashInt(key, items.length, salt)] as T;
}

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * Returns a generator, not a value, because a sequence is usually what is wanted:
 * `const r = mulberry32(seed); r(); r();`
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: a generator seeded from a string or number key. */
export function rng(key: string | number, salt = 0): () => number {
  return mulberry32(hash32(`${typeof key === "number" ? numberToKey(key) : key}:${salt}`));
}

/** A generator whose first `count` values are drawn in a fixed order — for a fixed-size sample set. */
export function rngN(key: string | number, count: number, salt = 0): number[] {
  const next = rng(key, salt);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = next();
  return out;
}

// --- value noise -------------------------------------------------------------------------------

/**
 * 1-D value noise with smooth interpolation. Deterministic in `(x, seed)`; the same `x` gives the
 * same value on every machine, and continuity in `x` means it can drive a camera drift.
 */
export function noise1(x: number, seed: number | string = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(seed, i) * 2 - 1;
  const b = hash1(seed, i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f); // smoothstep
  return a + (b - a) * u;
}

/** 2-D value noise on a quadrilateral lattice. */
export function noise2(x: number, y: number, seed: number | string = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const at = (dx: number, dy: number): number => hash1(seed, (ix + dx) * 73856093 ^ ((iy + dy) * 19349663));
  const a = at(0, 0);
  const b = at(1, 0);
  const c = at(0, 1);
  const d = at(1, 1);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return (top + (bottom - top) * uy) * 2 - 1;
}

/** Fractal Brownian motion over {@link noise1}. */
export function fbm1(x: number, octaves = 4, seed: number | string = 0, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise1(x * freq, `${seed}/${o}`);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Fractal Brownian motion over {@link noise2}. */
export function fbm2(
  x: number,
  y: number,
  octaves = 4,
  seed: number | string = 0,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, `${seed}/${o}`);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * The frame index a time belongs to.
 *
 * Every per-frame decision — grain offset, dither, which of four noise tiles is current — MUST use
 * this rather than `Math.floor(t * fps)`. The two disagree on exact frame boundaries, and the
 * disagreement shows up as one-frame flicker at shot joins, which is the hardest kind of defect to
 * find by eye (`docs/SPEC.md` D4).
 */
export function frameIndex(t: number, fps: number): number {
  return Math.round(t * fps);
}

/**
 * A per-frame value that is constant across the whole shutter window of one output frame.
 *
 * Sub-frames of a motion-blurred frame all share a `frameIndex`, so they must also share this value;
 * seeding noise with the continuous `t` instead would make grain crawl within a single frame
 * (`docs/SPEC.md` D6).
 */
export function frameJitter(t: number, fps: number, salt = 0): number {
  return hash1("frame", frameIndex(t, fps) ^ (salt * 2654435761));
}
