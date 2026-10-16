import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCENE_THRESHOLDS,
  frameMetricsExpression,
  judgeFrame,
  sampleTimes,
  type FrameContent,
} from "../../packages/render/src/content.js";

function frame(overrides: Partial<FrameContent> = {}): FrameContent {
  return {
    t: 1,
    frame: 30,
    contentFraction: 0.4,
    dominant: "#140b1e",
    distinctColors: 500,
    meanLuma: 60,
    shots: ["s01"],
    errorCard: false,
    ...overrides,
  };
}

/**
 * `judgeFrame` is the rule that was missing when a film of near-black passed every other check, so it is
 * tested against the exact frame that got through: a flat fill of the palette's ink.
 */
describe("judgeFrame — the empty-frame rule", () => {
  it("fails a frame that is entirely its own background", () => {
    const verdict = judgeFrame(frame({ contentFraction: 0, dominant: "#140b1e", distinctColors: 1 }), DEFAULT_SCENE_THRESHOLDS);
    expect(verdict.level).toBe("empty");
    expect(verdict.reason).toContain("#140b1e");
    // The message has to say what is wrong in a way that someone staring at a black PNG recognises.
    expect(verdict.reason).toContain("without its subject");
  });

  it("passes an ordinary composed frame", () => {
    expect(judgeFrame(frame({ contentFraction: 0.4 }), DEFAULT_SCENE_THRESHOLDS).level).toBe("ok");
  });

  it("passes a frame whose only content is a small caption", () => {
    // A 20 px caption on 1080p is about 0.0002 of the frame. It is a legitimate composition, so it must not
    // fail — but it is returned as `thin` so a reviewer sees how close the film is to nothing.
    const verdict = judgeFrame(frame({ contentFraction: 0.0002 }), DEFAULT_SCENE_THRESHOLDS);
    expect(verdict.level).not.toBe("empty");
  });

  it("reports a thin frame without failing it", () => {
    const verdict = judgeFrame(frame({ contentFraction: 0.002 }), DEFAULT_SCENE_THRESHOLDS);
    expect(verdict.level).toBe("thin");
    expect(verdict.reason).toContain("0.200");
  });

  it("always fails a frame the engine flagged", () => {
    // An error card is a contract failure regardless of how much ink it puts down.
    const verdict = judgeFrame(frame({ contentFraction: 0.9, errorCard: true }), DEFAULT_SCENE_THRESHOLDS);
    expect(verdict.level).toBe("empty");
    expect(verdict.reason).toContain("problem");
  });

  it("makes `empty` fail at or below the threshold, so zero tolerance is expressible", () => {
    // `<=` matters: with `<`, `emptyContent: 0` would be unsatisfiable and a project asking for zero
    // tolerance would silently get none.
    const strict = { ...DEFAULT_SCENE_THRESHOLDS, emptyContent: 0 };
    expect(judgeFrame(frame({ contentFraction: 0 }), strict).level).toBe("empty");
    expect(judgeFrame(frame({ contentFraction: 0.0001 }), strict).level).not.toBe("empty");
  });

  it("reports `thin` before `empty` when a project sets a very low threshold", () => {
    // Ordering matters: a frame below `emptyContent` is empty even if it is also below `thinContent`,
    // because "there is nothing here" is the more useful thing to say than "there is very little here".
    const strict = { emptyContent: 0, thinContent: 0.5, meanLumaFloor: 2 };
    expect(judgeFrame(frame({ contentFraction: 0 }), strict).level).toBe("empty");
    expect(judgeFrame(frame({ contentFraction: 0.0001 }), strict).level).toBe("thin");
  });
});

/**
 * Sampling is where a gate like this is quietly defeated: if the sample never lands inside a broken shot,
 * the gate passes and everyone believes the film. These tests assert coverage rather than counts.
 */
describe("sampleTimes — coverage", () => {
  const shots = [
    { t0: 0, t1: 1.02 },
    { t0: 1.02, t1: 4.02 },
    { t0: 4.02, t1: 6.52 },
    { t0: 6.52, t1: 8 },
  ];

  it("samples inside every shot, near its start, middle and end", () => {
    const times = sampleTimes(shots, 8, 3);
    for (const shot of shots) {
      const inside = times.filter((t) => t > shot.t0 && t < shot.t1);
      expect(inside.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("includes a frame just after each cut, which is where transition bugs live", () => {
    const times = sampleTimes(shots, 8);
    for (const shot of shots.slice(1)) {
      expect(times.some((t) => t >= shot.t0 && t < shot.t0 + 0.1)).toBe(true);
    }
  });

  it("never samples at or beyond the duration, or before zero", () => {
    const times = sampleTimes(shots, 8);
    expect(times.every((t) => t > 0 && t < 8)).toBe(true);
  });

  it("returns sorted, unique times", () => {
    const times = sampleTimes(shots, 8);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it("survives a zero-length shot rather than emitting NaN", () => {
    const times = sampleTimes([{ t0: 2, t1: 2 }, { t0: 2, t1: 4 }], 4);
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe("frameMetricsExpression", () => {
  it("produces something a browser can parse", () => {
    const source = frameMetricsExpression({ times: [0.5, 1.5], shots: [{ id: "s01", t0: 0, t1: 2 }] });
    // A syntax error here would only surface as a CDP failure mid-check, which is a slow way to learn it.
    expect(() => new Function(`return ${source}`)).not.toThrow();
  });

  it("interpolates the times rather than closing over them", () => {
    // The expression is carried across a CDP boundary, so it cannot reference Node-side variables.
    const source = frameMetricsExpression({ times: [1.25, 2.5] });
    expect(source).toContain("[1.25,2.5]");
  });

  it("contains no unescaped backtick, which would close the template literal", () => {
    const source = frameMetricsExpression({ times: [1] });
    expect(source.includes("`")).toBe(false);
  });

  it("accepts an empty time list without producing a broken expression", () => {
    const source = frameMetricsExpression({ times: [] });
    expect(() => new Function(`return ${source}`)).not.toThrow();
  });
});
