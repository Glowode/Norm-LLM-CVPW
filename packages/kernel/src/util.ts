/**
 * Small deterministic maths helpers.
 *
 * Everything here is a pure function. Nothing reads a clock, nothing stores state, nothing depends
 * on the platform beyond IEEE-754 arithmetic (`docs/SPEC.md` D1).
 */

export const TAU = Math.PI * 2;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

export function invLerp(a: number, b: number, x: number): number {
  return a === b ? 0 : (x - a) / (b - a);
}

/** Remap `x` from `[a,b]` to `[c,d]`, unclamped. */
export function remap(x: number, a: number, b: number, c: number, d: number): number {
  return c + (d - c) * invLerp(a, b, x);
}

/** Remap and clamp to `[c,d]`. */
export function remapClamped(x: number, a: number, b: number, c: number, d: number): number {
  return clamp(lerp(c, d, clamp01(invLerp(a, b, x))), Math.min(c, d), Math.max(c, d));
}

/** A 0→1 ramp over `[t0, t1]`, clamped. Degenerate intervals return 0 before and 1 after. */
export function ramp(t: number, t0: number, t1: number): number {
  if (t1 === t0) return t >= t1 ? 1 : 0;
  return clamp01((t - t0) / (t1 - t0));
}

/** A 0→1→0 pulse centred on `[t0, t1]` with the peak at `tc` (default midpoint). */
export function pulse(t: number, t0: number, t1: number, tc?: number): number {
  const centre = tc ?? (t0 + t1) / 2;
  if (t <= t0 || t >= t1) return 0;
  return t < centre ? ramp(t, t0, centre) : 1 - ramp(t, centre, t1);
}

/**
 * An exponentially decaying hit, starting at full strength at `t0`.
 * `halfLife` is in seconds; the value is 0.5 at `t0 + halfLife` and never exactly reaches 0.
 */
export function hit(t: number, t0: number, halfLife: number, strength = 1): number {
  if (t < t0) return 0;
  if (halfLife <= 0) return t === t0 ? strength : 0;
  return strength * Math.pow(0.5, (t - t0) / halfLife);
}

/** The strongest of several hits at `t`, which is how overlapping impacts compose. */
export function hits(t: number, events: readonly (readonly [number, number])[], strength = 1): number {
  let m = 0;
  for (const [t0, halfLife] of events) {
    const v = hit(t, t0, halfLife, strength);
    if (v > m) m = v;
  }
  return m;
}

/** A smooth 0→1→0 window between two times, with ease in and out. */
export function window01(t: number, t0: number, t1: number): number {
  return easeInOutCubic(pulse(t, t0, t1));
}

/** A sine oscillation with a deterministic phase offset. */
export function osc(t: number, freq: number, phase = 0): number {
  return Math.sin(t * freq * TAU + phase);
}

/** Aspect-ratio-preserving squash about a pivot, area-preserving for small amounts. */
export function squash(k: number): [number, number] {
  const sx = 1 + k;
  return [sx, 1 / sx];
}

/** Round to a fixed number of decimals, so serialised values do not carry float noise. */
export function round(x: number, decimals = 3): number {
  const p = Math.pow(10, decimals);
  return Math.round(x * p) / p;
}

/** `true` when two times fall in the same output frame. */
export function sameFrame(a: number, b: number, fps: number): boolean {
  return Math.round(a * fps) === Math.round(b * fps);
}

// --- easing -------------------------------------------------------------------------------------
// Named easings, small and dependency-free. Authoring code should never inline a magic bezier.

export function easeLinear(x: number): number {
  return x;
}

export function easeInQuad(x: number): number {
  return x * x;
}

export function easeOutQuad(x: number): number {
  return 1 - (1 - x) * (1 - x);
}

export function easeInOutQuad(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export function easeInCubic(x: number): number {
  return x * x * x;
}

export function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutExpo(x: number): number {
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

export function easeInExpo(x: number): number {
  return x <= 0 ? 0 : Math.pow(2, 10 * x - 10);
}

/** Overshoots past 1 then settles — the standard "arrival" ease. */
export function easeOutBack(x: number, overshoot = 1.70158): number {
  const c3 = overshoot + 1;
  const p = x - 1;
  return 1 + c3 * p * p * p + overshoot * p * p;
}

/** A critically-damped spring step. `omega` is the angular frequency; higher is snappier. */
export function springStep(x: number, omega = 12): number {
  if (x >= 1) return 1;
  if (x <= 0) return 0;
  return 1 - (1 + omega * x) * Math.exp(-omega * x);
}

export function easeOutElastic(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c4 = TAU / 3;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

/** A stepped ease: `steps` discrete levels. Useful for a drawn-on-twos cadence. */
export function stepEase(x: number, steps: number): number {
  if (steps <= 1) return x >= 1 ? 1 : 0;
  return Math.min(1, Math.floor(clamp01(x) * steps) / (steps - 1));
}

/** Choose an easing by name, for styles and scene args that store a name rather than a function. */
export function easing(name: string): (x: number) => number {
  switch (name) {
    case "linear":
      return easeLinear;
    case "inQuad":
      return easeInQuad;
    case "outQuad":
      return easeOutQuad;
    case "inOutQuad":
      return easeInOutQuad;
    case "inCubic":
      return easeInCubic;
    case "outCubic":
      return easeOutCubic;
    case "inOutCubic":
      return easeInOutCubic;
    case "inExpo":
      return easeInExpo;
    case "outExpo":
      return easeOutExpo;
    case "outBack":
      return easeOutBack;
    case "outElastic":
      return easeOutElastic;
    default:
      throw new Error(
        `unknown easing ${JSON.stringify(name)}; known: linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, inExpo, outExpo, outBack, outElastic`,
      );
  }
}

// --- colour -------------------------------------------------------------------------------------

/** `#rrggbb` or `#rgb` to `[r,g,b]` in 0..255. Throws on anything else — no silent black. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  let body = m[1] as string;
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

/** Linear interpolation between two hex colours, returning `rgb(...)`. */
export function mixHex(a: string, b: string, k: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const t = clamp01(k);
  return `rgb(${Math.round(lerp(ar, br, t))},${Math.round(lerp(ag, bg, t))},${Math.round(lerp(ab, bb, t))})`;
}

/** A hex colour with an alpha, as `rgba(...)`. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp01(alpha)})`;
}

/** Perceptual-ish luminance in 0..1, for decisions like "is this text readable on that plate?". */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
