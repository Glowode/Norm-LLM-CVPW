import { describe, expect, it } from "vitest";

import { Timebase, TimeExpressionError } from "../../packages/kernel/src/time.js";
import type { TimebaseData } from "../../packages/kernel/src/timebase.js";

/**
 * A purpose-built fixture with every kind of data the grammar can reference.
 *
 * The numbers are round on purpose: 120 BPM, first beat at 0.02 s, so every expected value in this
 * file is checkable by hand. A conformance test whose expectations cannot be verified by reading is
 * a test that will be "fixed" to match the bug.
 */
export const FIXTURE: TimebaseData = {
  duration: 8,
  fps: 30,
  tempo: { bpm: 120, confidence: 0.95, beatPeriod: 0.5, firstBeat: 0.02, octaveCheck: "ok" },
  meter: "4/4",
  beats: [0.02, 0.52, 1.02, 1.52, 2.02, 2.52, 3.02, 3.52, 4.02, 4.52, 5.02, 5.52, 6.02, 6.52, 7.02, 7.52],
  beatsSmooth: [0.02, 0.52, 1.02, 1.52, 2.02, 2.52, 3.02, 3.52, 4.02, 4.52, 5.02, 5.52, 6.02, 6.52, 7.02, 7.52],
  bars: [
    { index: 0, start: 0.02, end: 2.02, bpm: 120, pickup: false, beats: 4 },
    { index: 1, start: 2.02, end: 4.02, bpm: 120, pickup: false, beats: 4 },
    { index: 2, start: 4.02, end: 6.02, bpm: 120, pickup: false, beats: 4 },
    { index: 3, start: 6.02, end: 8.0, bpm: 120, pickup: false, beats: 4 },
  ],
  sections: [
    { index: 0, name: "intro", start: 0, end: 2.02, confidence: 0.8 },
    { index: 1, name: "verse", start: 2.02, end: 6.02, confidence: 0.9 },
    { index: 2, name: "outro", start: 6.02, end: 8, confidence: 0.7 },
  ],
  onsets: [
    { t: 0.02, strength: 1, band: "low" },
    { t: 2.02, strength: 0.8, band: "low" },
    { t: 4.02, strength: 0.9, band: "low" },
  ],
  impacts: [
    { t: 2.02, strength: 1, kind: "section_start" },
    { t: 4.02, strength: 0.95, kind: "hit" },
    { t: 7.9, strength: 0.4, kind: "final_cut" },
  ],
  stops: [
    { start: 3.52, end: 3.72, depthDb: -40, kind: "stop" },
    { start: 6.02, end: 6.22, depthDb: -35, kind: "gap" },
  ],
  cues: [
    { id: "downbeat1", t: 0.02, source: "measured", label: "first downbeat" },
    { id: "verse", t: 2.02, source: "measured" },
    { id: "chorus", t: 4.02, source: "manual", label: "chorus in, by ear" },
    { id: "last_hit", t: 7.9, source: "audit" },
  ],
  lyricLines: [
    { i: 0, start: 2.02, end: 3.0, words: [{ start: 2.02, end: 2.3 }] },
    { i: 1, start: 4.02, end: 5.0, words: [{ start: 4.02, end: 4.4 }] },
  ],
  words: [
    { word: "sudden", start: 2.05, end: 2.3, line: 0 },
    { word: "drop", start: 4.05, end: 4.4, line: 1 },
  ],
};

function tb(overrides: Partial<TimebaseData> = {}): Timebase {
  return new Timebase({ ...FIXTURE, ...overrides });
}

describe("Timebase.resolve — absolute seconds", () => {
  it("accepts a bare number and marks it absolute", () => {
    const r = tb().resolve("12.5");
    expect(r.t).toBe(12.5);
    expect(r.absolute).toBe(true);
  });

  it("accepts an explicit `s` suffix", () => {
    expect(tb().resolve("3s").t).toBe(3);
  });

  it("applies a signed offset", () => {
    expect(tb().resolve("2 + 0.12").t).toBeCloseTo(2.12, 9);
    expect(tb().resolve("2 - 0.12").t).toBeCloseTo(1.88, 9);
    expect(tb().resolve("2+0.5s").t).toBeCloseTo(2.5, 9);
  });

  it("rejects a negative absolute time", () => {
    expect(() => tb().resolve("-1")).toThrowError(TimeExpressionError);
  });

  it("rejects a result before zero, naming the base token", () => {
    try {
      tb().resolve("0.1 - 0.5");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as TimeExpressionError;
      expect(e.reason).toBe("negative");
      expect(e.token).toContain("s(");
    }
  });

  it("rejects more than six decimal places", () => {
    expect(() => tb().resolve("1.1234567")).toThrowError(TimeExpressionError);
  });

  it("rejects an empty expression", () => {
    expect(() => tb().resolve("   ")).toThrowError(/empty time expression/);
  });

  it("rejects trailing garbage rather than ignoring it", () => {
    expect(() => tb().resolve("2.5 nonsense")).toThrowError(/unexpected trailing input/);
  });
});

describe("Timebase.resolve — bars", () => {
  it("resolves a bar and beat inside the measured grid", () => {
    // bar 1 starts at 2.02, four beats of 0.5 s
    expect(tb().resolve("b(1,0)").t).toBeCloseTo(2.02, 9);
    expect(tb().resolve("b(1,2)").t).toBeCloseTo(3.02, 9);
  });

  it("accepts a fractional beat", () => {
    expect(tb().resolve("b(1,2.5)").t).toBeCloseTo(3.27, 9);
  });

  it("looks a bar up by its index field, not by array position", () => {
    // Bars start at index 10: array position 0 is index 10, so b(10,0) must work and b(0,0) must not.
    const shifted = tb({
      bars: [
        { index: 10, start: 0.02, end: 2.02, beats: 4 },
        { index: 11, start: 2.02, end: 4.02, beats: 4 },
      ],
    });
    expect(shifted.resolve("b(10,0)").t).toBeCloseTo(0.02, 9);
    expect(shifted.resolve("b(11,1)").t).toBeCloseTo(2.52, 9);
    expect(() => shifted.resolve("b(0,0)")).toThrowError(/no bar with index 0/);
  });

  it("continues into the next bar when the grid is contiguous", () => {
    // bar 1 spans 2.02..4.02 with 4 beats; beat 5 is one beat into bar 2
    expect(tb().resolve("b(1,5)").t).toBeCloseTo(4.52, 9);
  });

  it("refuses to invent a bar beyond the measured grid, and lists the nearest", () => {
    try {
      tb().resolve("b(99,0)");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as TimeExpressionError;
      expect(e.reason).toBe("unknown-id");
      expect(e.alternatives.length).toBeGreaterThan(0);
      expect(e.message).toContain("nearest:");
    }
  });

  it("throws a no-data error naming the grid when there is no beat grid", () => {
    const manual = tb({ beats: [], beatsSmooth: [], bars: [] });
    expect(manual.hasGrid()).toBe(false);
    expect(() => manual.resolve("b(1,0)")).toThrowError(/no beat grid/);
  });

  it("rejects a beat that overflows a non-contiguous grid", () => {
    const gappy = tb({
      bars: [
        { index: 0, start: 0.02, end: 2.02, beats: 4 },
        { index: 1, start: 5.0, end: 7.0, beats: 4 },
      ],
    });
    expect(() => gappy.resolve("b(0,4.5)")).toThrowError(/beyond the measured grid/);
  });
});

describe("Timebase.resolve — half-beats", () => {
  it("interpolates halfway between two beats", () => {
    expect(tb().resolve("h(0)").t).toBeCloseTo(0.02, 9);
    expect(tb().resolve("h(1)").t).toBeCloseTo(0.27, 9);
    expect(tb().resolve("h(2)").t).toBeCloseTo(0.52, 9);
  });

  it("throws when there is no beat grid", () => {
    const manual = tb({ beats: [], beatsSmooth: [], bars: [] });
    expect(() => manual.resolve("h(4)")).toThrowError(/no beat grid/);
  });

  it("refuses a half-beat past the measured end", () => {
    expect(() => tb().resolve("h(999)")).toThrowError(/past the end/);
  });
});

describe("Timebase.resolve — cues", () => {
  it("resolves a quoted cue id", () => {
    expect(tb().resolve("cue('chorus')").t).toBe(4.02);
  });

  it("accepts a bare identifier as a cue id", () => {
    expect(tb().resolve("chorus").t).toBe(4.02);
    expect(tb().resolve("downbeat1").t).toBe(0.02);
  });

  it("accepts an offset after a cue", () => {
    expect(tb().resolve("cue('chorus') + 0.12").t).toBeCloseTo(4.14, 9);
    expect(tb().resolve("chorus - 0.2").t).toBeCloseTo(3.82, 9);
  });

  it("suggests a near-miss id instead of failing blankly", () => {
    try {
      tb().resolve("choru");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as TimeExpressionError;
      expect(e.reason).toBe("unknown-id");
      expect(e.alternatives.map((a) => a.id)).toContain("chorus");
    }
  });
});

describe("Timebase.resolve — lyrics, words, impacts, sections, stops, quantile", () => {
  it("resolves a lyric line start", () => {
    expect(tb().resolve("L(1)").t).toBe(4.02);
  });

  it("throws no-data for a lyric line when there is no lyric timing", () => {
    const noLyrics = tb({ lyricLines: [] });
    expect(() => noLyrics.resolve("L(0)")).toThrowError(/no lyric timing/);
  });

  it("resolves a sung word onset", () => {
    expect(tb().resolve("VOX('sudden')").t).toBe(2.05);
  });

  it("matches a word case- and punctuation-insensitively", () => {
    expect(tb().resolve("VOX('Sudden.')").t).toBe(2.05);
  });

  it("throws no-data for VOX when no alignment data exists", () => {
    const noWords = tb({ words: [] });
    expect(() => noWords.resolve("VOX('sudden')")).toThrowError(/no sung-word timing/);
  });

  it("refuses to pick between repeated words, and reports each occurrence", () => {
    const repeated = tb({
      words: [
        { word: "go", start: 1.0, end: 1.2, line: 0 },
        { word: "go", start: 5.0, end: 5.2, line: 3 },
      ],
    });
    try {
      repeated.resolve("VOX('go')");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as TimeExpressionError;
      expect(e.reason).toBe("out-of-tolerance");
      expect(e.alternatives.map((a) => a.id)).toEqual(["L(0)", "L(3)"]);
    }
  });

  it("resolves the strongest impact of a kind when no reference time is given", () => {
    expect(tb().resolve("HIT('section_start')").t).toBe(2.02);
  });

  it("resolves the nearest impact of a kind within tolerance", () => {
    expect(tb().resolve("HIT('hit', 4.0)").t).toBe(4.02);
  });

  it("fails when the nearest impact is outside tolerance", () => {
    expect(() => tb().resolve("HIT('hit', 5.5)")).toThrowError(/beyond the .* tolerance/);
  });

  it("resolves a section by name and by index", () => {
    expect(tb().resolve("S('verse')").t).toBe(2.02);
    expect(tb().resolve("S(2)").t).toBe(6.02);
  });

  it("lists section names when one is unknown", () => {
    try {
      tb().resolve("S('bridge')");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as TimeExpressionError;
      expect(e.alternatives.map((a) => a.id)).toContain("verse");
    }
  });

  it("resolves a stop by index", () => {
    expect(tb().resolve("STOP(0)").t).toBe(3.52);
    expect(tb().resolve("STOP(1)").t).toBe(6.02);
  });

  it("rejects a stop index past the end, naming the valid range", () => {
    expect(() => tb().resolve("STOP(9)")).toThrowError(/numbered 0\.\.1/);
  });

  it("resolves a fraction of the duration", () => {
    expect(tb().resolve("p(0.5)").t).toBe(4);
    expect(tb().resolve("p(1)").t).toBe(8);
  });

  it("rejects a fraction outside 0..1", () => {
    expect(() => tb().resolve("p(1.5)")).toThrowError(/within 0\.\.1/);
  });
});

describe("Timebase.resolve — determinism and caching", () => {
  it("returns the identical result for the same expression", () => {
    const t = tb();
    expect(t.resolve("b(1,2)").t).toBe(t.resolve("b(1,2)").t);
  });

  it("resolves the same value on a freshly built timebase", () => {
    expect(tb().resolve("cue('chorus') + 0.12").t).toBe(tb().resolve("cue('chorus') + 0.12").t);
  });

  it("does not mutate the timebase when resolving", () => {
    const t = tb();
    const before = JSON.stringify(t.listCues());
    t.resolve("cue('verse')");
    expect(JSON.stringify(t.listCues())).toBe(before);
  });
});

describe("Timebase — frames", () => {
  it("computes the frame count with round, matching the render gate", () => {
    expect(tb().frames).toBe(240);
  });

  it("maps time to frame index with round, not floor", () => {
    const t = tb();
    // 0.9999 s at 30 fps is frame 30 by round; floor would say 29.
    expect(t.frameIndex(0.9999)).toBe(30);
    expect(t.frameTime(30)).toBeCloseTo(1.0, 9);
  });

  it("rejects an unusable timebase rather than failing later", () => {
    expect(() => tb({ duration: 0 })).toThrowError(/duration must be a positive finite number/);
    expect(() => tb({ fps: 0 })).toThrowError(/fps must be a positive finite number/);
  });
});
