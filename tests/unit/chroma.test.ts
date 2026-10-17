import { describe, expect, it } from "vitest";

import { DEFAULT_KEY, keyChroma, keyChromaInPlace, trimBounds } from "../../packages/kernel/src/chroma.js";

/** Build a tiny RGBA buffer from `[r,g,b,a]` tuples, so a test reads like the picture it describes. */
function pixels(...values: Array<[number, number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  values.forEach((pixel, i) => {
    out[i * 4] = pixel[0];
    out[i * 4 + 1] = pixel[1];
    out[i * 4 + 2] = pixel[2];
    out[i * 4 + 3] = pixel[3];
  });
  return out;
}

const alphaAt = (data: Uint8ClampedArray, index: number): number => data[index * 4 + 3] as number;

describe("keyChroma — what becomes transparent", () => {
  it("removes the key colour entirely", () => {
    const keyed = keyChroma(pixels([DEFAULT_KEY[0], DEFAULT_KEY[1], DEFAULT_KEY[2], 255]));
    expect(alphaAt(keyed, 0)).toBe(0);
  });

  it("keeps a subject colour that is far from the key", () => {
    // A warm skin tone: nowhere near green.
    const keyed = keyChroma(pixels([210, 160, 130, 255]));
    expect(alphaAt(keyed, 0)).toBe(255);
  });

  it("gives a soft edge rather than a hard one, because a single threshold eats dark subject areas", () => {
    // Three pixels at increasing distance from the key: inside, mid-knee, outside.
    const keyed = keyChroma(
      pixels(
        [DEFAULT_KEY[0], DEFAULT_KEY[1], DEFAULT_KEY[2], 255],
        [110, 170, 120, 255],
        [210, 160, 130, 255],
      ),
    );
    expect(alphaAt(keyed, 0)).toBe(0);
    expect(alphaAt(keyed, 2)).toBe(255);
    const mid = alphaAt(keyed, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });

  it("is monotonic: further from the key is never more transparent", () => {
    // The path must actually move away from the key at every step, or the test measures its own construction
    // instead of the function. An earlier draft walked a path that curved back toward the key and failed here,
    // which was the test's bug: distances were not monotonic. Linear interpolation is monotonic by construction.
    const far: [number, number, number] = [210, 160, 130];
    const samples: number[] = [];
    for (let step = 0; step <= 10; step++) {
      const t = step / 10;
      const colour: [number, number, number] = [
        Math.round((DEFAULT_KEY[0] as number) + (far[0] - (DEFAULT_KEY[0] as number)) * t),
        Math.round((DEFAULT_KEY[1] as number) + (far[1] - (DEFAULT_KEY[1] as number)) * t),
        Math.round((DEFAULT_KEY[2] as number) + (far[2] - (DEFAULT_KEY[2] as number)) * t),
      ];
      samples.push(alphaAt(keyChroma(pixels([colour[0], colour[1], colour[2], 255])), 0));
    }
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(255);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i] as number).toBeGreaterThanOrEqual(samples[i - 1] as number);
    }
  });
});

describe("keyChroma — despill", () => {
  it("pulls the key channel down on a surviving edge pixel", () => {
    // Green-contaminated skin: green far above red and blue, but distant enough to survive the key.
    const contaminated: [number, number, number, number] = [150, 235, 150, 255];
    const keyed = keyChroma(pixels(contaminated), { despill: 1 });
    expect(alphaAt(keyed, 0)).toBe(255);
    // With full despill, green is pulled to the larger of red and blue.
    expect(keyed[1] as number).toBe(150);
    expect(keyed[1] as number).toBeLessThan(contaminated[1]);
  });

  it("leaves a pixel whose key channel is already the smallest alone", () => {
    const keyed = keyChroma(pixels([200, 90, 160, 255]), { despill: 1 });
    expect(keyed[1] as number).toBe(90);
  });

  it("does nothing when despill is zero, which is how a caller audits fringing", () => {
    const keyed = keyChroma(pixels([150, 235, 150, 255]), { despill: 0 });
    expect(keyed[1] as number).toBe(235);
  });
});

describe("keyChroma — contract", () => {
  it("does not mutate through the copying form", () => {
    const original = pixels([DEFAULT_KEY[0], DEFAULT_KEY[1], DEFAULT_KEY[2], 255]);
    const copy = new Uint8ClampedArray(original);
    keyChroma(original);
    expect(Array.from(original)).toEqual(Array.from(copy));
  });

  it("mutates in place through the in-place form, and says so in its name", () => {
    const data = pixels([DEFAULT_KEY[0], DEFAULT_KEY[1], DEFAULT_KEY[2], 255]);
    const returned = keyChromaInPlace(data);
    expect(returned).toBe(data);
    expect(alphaAt(data, 0)).toBe(0);
  });

  it("survives degenerate thresholds without dividing by zero", () => {
    const keyed = keyChroma(pixels([100, 200, 120, 255]), { inner: 0.5, outer: 0.5 });
    expect(Number.isFinite(alphaAt(keyed, 0))).toBe(true);
  });

  it("honours preserveAlpha so a keyed asset built from a soft mask stays soft", () => {
    const keyed = keyChroma(pixels([210, 160, 130, 128]), { preserveAlpha: 0.5 });
    expect(alphaAt(keyed, 0)).toBe(64);
  });
});

describe("trimBounds", () => {
  it("finds the box that still has content", () => {
    // 4x4 with a single opaque pixel at (1,2).
    const data = new Uint8ClampedArray(4 * 4 * 4);
    const index = (2 * 4 + 1) * 4;
    data[index + 3] = 255;
    expect(trimBounds(data, 4, 4)).toEqual({ x: 1, y: 2, width: 1, height: 1 });
  });

  it("returns null for a fully transparent buffer rather than a zero-size box", () => {
    // A zero-size box would be drawn as nothing and read as a successful trim of an empty asset.
    expect(trimBounds(new Uint8ClampedArray(16 * 4), 4, 4)).toBeNull();
  });

  it("ignores pixels below the alpha threshold", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data[3] = 0;
    data[(3 * 4 + 3) * 4 + 3] = 255;
    expect(trimBounds(data, 4, 4, 1)).toEqual({ x: 3, y: 3, width: 1, height: 1 });
  });
});
