/**
 * Chroma keying, as a pure function over pixel data.
 *
 * ## Why this lives in the kernel and not in a scene
 *
 * Every asset a film loads has to arrive at the same pixels on every render, on every machine, forever
 * (`docs/SPEC.md` D1–D3). A key that depends on a GPU driver's `mix-blend-mode`, or on the order two `globalAlpha`
 * operations happen to issue, is exactly the kind of thing that silently changes between machines. So the key is
 * arithmetic over an `ImageData` buffer: same input, same output, in Node and in a browser, testable without a
 * canvas.
 *
 * ## Why it is not "make green transparent"
 *
 * A naive key produces two defects that are worse than a hard edge:
 *
 * - **Fringing.** Green bounces off the subject, so edge pixels are a green-contaminated version of the subject.
 *   Setting them transparent leaves a green halo. This implementation *despills* — it removes the green
 *   contribution from the surviving pixels rather than only deciding alpha.
 * - **Holes.** A single distance threshold eats dark parts of the subject that happen to be greenish. This uses a
 *   soft knee: fully transparent inside `inner`, fully opaque beyond `outer`, and a smooth ramp between.
 *
 * The output is straight (not premultiplied) alpha, because that is what `putImageData` and `drawImage` expect.
 */

export interface ChromaKeyOptions {
  /** The background colour to remove, `[r, g, b]` 0–255. Default is the classic key green. */
  key?: readonly [number, number, number];
  /** Below this distance from the key colour a pixel becomes fully transparent. 0–1. */
  inner?: number;
  /** Above this distance a pixel becomes fully opaque. 0–1. */
  outer?: number;
  /** How much of the key's colour to subtract from surviving pixels, 0–1. Despills fringing. */
  despill?: number;
  /** Fraction of the original alpha to respect; 1 leaves alpha untouched outside the key. */
  preserveAlpha?: number;
}

/** The default key: pure green, the colour a physical green screen is painted. */
export const DEFAULT_KEY: readonly [number, number, number] = [0, 177, 64];

/** Normalised RGB distance in 0–1, which keeps the thresholds comparable across bit depths. */
function distance(r: number, g: number, b: number, key: readonly [number, number, number]): number {
  const dr = (r - (key[0] as number)) / 255;
  const dg = (g - (key[1] as number)) / 255;
  const db = (b - (key[2] as number)) / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
}

/**
 * Key a buffer in place and return it.
 *
 * Mutating in place is deliberate: a 1920×1080 frame is 8 MB, and copying it per call would make the function
 * cost more than the key itself. The name says `inPlace` so no caller can be surprised.
 */
export function keyChromaInPlace(data: Uint8ClampedArray, options: ChromaKeyOptions = {}): Uint8ClampedArray {
  const key = options.key ?? DEFAULT_KEY;
  const inner = options.inner ?? 0.18;
  const outer = options.outer ?? 0.34;
  const despill = options.despill ?? 0.8;
  const preserveAlpha = options.preserveAlpha ?? 1;
  // A knee that is not a knee would divide by zero; clamp instead of trusting the caller.
  const span = Math.max(1e-6, outer - inner);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const a = data[i + 3] as number;

    const d = distance(r, g, b, key);
    // 0 inside `inner`, 1 beyond `outer`, smoothstep between. Smoothstep rather than linear because a linear ramp
    // leaves a visible band where the key's falloff meets the subject.
    const t = Math.max(0, Math.min(1, (d - inner) / span));
    const alpha = t * t * (3 - 2 * t);

    data[i + 3] = Math.round(a * alpha * preserveAlpha);

    if (despill > 0 && alpha > 0) {
      // Remove the key's dominant channel contribution from what survives. For a green key that is the green
      // channel pulled down toward the larger of red and blue, which is what an edge pixel of the subject should
      // have been before the bounce light contaminated it.
      const dominant = key[0] >= key[1] && key[0] >= key[2] ? 0 : key[1] >= key[2] ? 1 : 2;
      const others = [0, 1, 2].filter((channel) => channel !== dominant);
      const ceiling = Math.max(data[i + (others[0] as number)] as number, data[i + (others[1] as number)] as number);
      const channel = data[i + dominant] as number;
      if (channel > ceiling) {
        const pulled = channel + (ceiling - channel) * despill;
        data[i + dominant] = pulled;
      }
    }
  }
  return data;
}

/** Convenience wrapper that does not mutate. Use the in-place form for full frames. */
export function keyChroma(data: Uint8ClampedArray, options: ChromaKeyOptions = {}): Uint8ClampedArray {
  return keyChromaInPlace(new Uint8ClampedArray(data), options);
}

/**
 * Trim fully transparent margins, returning the box that still has content.
 *
 * `assets/manifest.json` has a `trimmed` field precisely because this decision changes the registration point: a
 * trimmed asset drawn at the same coordinates as an untrimmed one lands somewhere else. Recording the box is what
 * makes the trim auditable instead of a silent shift.
 */
export function trimBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 1,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] as number) < alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
