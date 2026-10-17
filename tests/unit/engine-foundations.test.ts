import { describe, expect, it } from "vitest";

import { layoutFromOutput } from "../../packages/kernel/src/layout.js";
import { frameIndex, frameJitter, mulberry32, hash1, rngN } from "../../packages/kernel/src/rng.js";
import { Timebase } from "../../packages/kernel/src/time.js";

/**
 * The frame map is the foundation every other guarantee sits on.
 *
 * `docs/SPEC.md` D1 says a frame is a pure function of `t`; the corollary is that the *mapping* from `t` to a
 * frame index has to be exact and monotone, or two workers disagreeing by a rounding step produce two films.
 * `Math.round` is deliberate over `Math.floor`: at 30 fps, `t = 0.5` is frame 15, not 14.999999.
 */
describe("frameIndex — the t -> frame mapping", () => {
  it("maps every frame boundary to its own index, with no off-by-one", () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (let f = 0; f < 200; f++) expect(frameIndex(f / fps, fps)).toBe(f);
    }
  });

  it("is monotone, so no two times map backwards", () => {
    const fps = 30;
    let previous = -1;
    for (let i = 0; i <= 3000; i++) {
      const frame = frameIndex(i / 1000, fps);
      expect(frame).toBeGreaterThanOrEqual(previous);
      previous = frame;
    }
  });

  it("rounds a half-frame up, which is what makes a cut land on the beat rather than a frame early", () => {
    // 0.5 s at 30 fps is frame 15. Flooring here would put every cut one frame early.
    expect(frameIndex(0.5, 30)).toBe(15);
    expect(frameIndex(15.5 / 30, 30)).toBe(16);
  });

  it("survives floating-point drift at a non-integer frame rate", () => {
    // 30000/1001 is 29.97; a time computed as `frame * 1001 / 30000` must map back to the same frame.
    for (let f = 0; f < 600; f++) {
      const t = (f * 1001) / 30000;
      expect(frameIndex(t, 30000 / 1001)).toBe(f);
    }
  });
});

/**
 * The layout's only job is to make a scene's numbers independent of the output size. If `type(n)` did not
 * scale exactly with height, a vertical variant would be a different composition rather than the same film,
 * and `docs/SPEC.md` C7 forbids hard-coding 1920/1080 precisely to prevent that.
 */
describe("layoutFromOutput — resolution independence", () => {
  const base = layoutFromOutput({ width: 1920, height: 1080, safe: 96, subtitleBand: 920 });
  const uhd = layoutFromOutput({ width: 3840, height: 2160, safe: 192, subtitleBand: 1840 });
  const vertical = layoutFromOutput({ width: 1080, height: 1920, safe: 54, subtitleBand: 1640 });

  it("is resolution-independent: the same aspect gives the same value at 1080p and 4K", () => {
    // `type(n) = n * longEdge / height`, so both edges scaling together cancels out. That is the property
    // that makes a 4K render the same film rather than a re-composition.
    expect(uhd.type(96)).toBeCloseTo(base.type(96), 9);
    expect(uhd.type(48)).toBeCloseTo(base.type(48), 9);
  });

  it("follows longEdge / height exactly, which is what ties type size to the aspect", () => {
    for (const layout of [base, uhd, vertical]) {
      const longEdge = Math.max(layout.space.width, layout.space.height);
      expect(layout.type(96)).toBeCloseTo((96 / layout.space.height) * longEdge, 9);
    }
  });

  it("re-composes for a different aspect rather than scaling blindly", () => {
    // A vertical frame is taller than it is wide, so `longEdge / height` is 1 instead of 16/9. The same design
    // number therefore maps to fewer pixels — which is the intended behaviour: a 9:16 variant is re-composed,
    // not letterboxed.
    expect(vertical.type(96)).toBeCloseTo(96, 6);
    expect(base.type(96)).toBeGreaterThan(vertical.type(96));
  });
  it("keeps the ratio between two design numbers constant across outputs", () => {
    for (const layout of [base, uhd, vertical]) {
      expect(layout.type(48) / layout.type(96)).toBeCloseTo(0.5, 6);
    }
  });

  it("exposes the output space and the safe inset it was given", () => {
    expect(base.space.width).toBe(1920);
    expect(base.space.height).toBe(1080);
    expect(base.space.safe).toBe(96);
    expect(base.space.subtitleBand).toBe(920);
  });

  it("never returns a zero or negative size for a positive input", () => {
    for (const layout of [base, uhd, vertical]) {
      expect(layout.type(1)).toBeGreaterThan(0);
      expect(layout.type(0.5)).toBeGreaterThan(0);
    }
  });
});

/**
 * Determinism D1–D3 depends on *all* randomness being a pure function of a key. These tests assert that
 * property directly: same key, same value; different keys, different values; and no hidden state.
 */
describe("seeded randomness — purity", () => {
  it("returns the same value for the same key every time", () => {
    for (const key of ["spark", 42, "ring:3"]) {
      expect(hash1(key)).toBe(hash1(key));
    }
  });

  it("gives different values for different keys, without collisions in a small sample", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(hash1("grain", i));
    // 500 draws from a 32-bit space: collisions would indicate the key is not actually being used.
    expect(seen.size).toBe(500);
  });

  it("is unaffected by how many values were drawn before it", () => {
    // The failure this rules out: a generator whose state advances, so the same frame drawn after a different
    // number of earlier draws differs. That is exactly the class of bug that made `--workers` change the film.
    const first = hash1("x", 7);
    rngN("noise", 1000);
    expect(hash1("x", 7)).toBe(first);
  });

  it("produces a repeatable stream from an explicit seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  it("keeps frameJitter constant across a frame's shutter window", () => {
    // Sub-frames of a motion-blurred frame share a frame index, so they must share this value; seeding on the
    // continuous `t` instead would make grain crawl within a single frame.
    const fps = 30;
    const inside = [15 / fps, 15.1 / fps, 15.2 / fps];
    const values = inside.map((t) => frameJitter(t, fps));
    expect(new Set(values).size).toBe(1);
  });
});

/**
 * The timebase is what turns an expression into a number. `tests/unit/time.test.ts` covers the grammar; this
 * covers the *frame* consequences, which is what the renderer actually reads.
 */
describe("Timebase — frame consequences", () => {
  const timebase = new Timebase({
    duration: 8,
    fps: 30,
    beats: [0.4907, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5],
    beatsSmooth: [0.4907, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5],
    bars: [
      { index: 0, start: 0.4907, end: 2.496, beats: 4, pickup: false },
      { index: 1, start: 2.496, end: 4.5, beats: 4, pickup: false },
    ],
    sections: [],
    onsets: [],
    impacts: [],
    stops: [],
    cues: [],
  });

  it("reports the frame count a film of this duration needs", () => {
    expect(timebase.frameIndex(0)).toBe(0);
    expect(timebase.frameIndex(8)).toBe(240);
    expect(timebase.frameIndex(0.4907)).toBe(15);
  });

  it("resolves a bar downbeat to the measured beat, not to n * 60 / bpm", () => {
    // The grid starts at 0.4907 s, so bar 0 beat 0 must not be 0 and must not be 0.5.
    const resolved = timebase.resolve("b(0,0)");
    expect(resolved.t).toBeCloseTo(0.4907, 4);
    expect(resolved.t).not.toBeCloseTo(0.5, 4);
  });

  it("gives the same answer twice, so two workers cannot disagree", () => {
    for (const expression of ["b(1,0)", "b(0,2)", "h(4)"]) {
      expect(timebase.resolve(expression).t).toBe(timebase.resolve(expression).t);
    }
  });

  it("refuses an expression the grid cannot support instead of guessing", () => {
    // The whole point of T2-T3: a reference the timebase cannot substantiate is an error.
    expect(() => timebase.resolve("b(99,0)")).toThrow();
  });
});
