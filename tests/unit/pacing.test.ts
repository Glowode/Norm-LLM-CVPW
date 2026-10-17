import { describe, expect, it } from "vitest";

import { analysePacing, PACING_LIMITS, type PacingShot } from "../../packages/cli/src/commands/pacing.js";

/** Build shots from lengths, which is what the analysis actually looks at. */
function shotsFrom(lengths: readonly number[]): PacingShot[] {
  let cursor = 0;
  return lengths.map((length, i) => {
    const shot = { id: `s${String(i + 1).padStart(2, "0")}`, t0: cursor, t1: cursor + length };
    cursor += length;
    return shot;
  });
}

/**
 * These are the mechanical failures `docs/QA.md` names, and each is a property of the *numbers* — so each can
 * be tested without rendering anything. That matters: a safety-adjacent gate whose logic is only exercised by
 * watching a whole film is a gate nobody will maintain.
 */
describe("analysePacing — holds", () => {
  it("passes when at least the minimum number of shots hold for a second", () => {
    const result = analysePacing(shotsFrom([2, 2, 2, 1.5, 0.5]));
    expect(result.stats.holds).toBe(4);
    expect(result.offenders.map((o) => o.code)).not.toContain("too-few-holds");
  });

  it("fails a film of uniform short cuts, naming the hold count", () => {
    const result = analysePacing(shotsFrom([0.4, 0.4, 0.4, 0.5, 0.5, 0.4, 0.5, 0.4]));
    expect(result.offenders.map((o) => o.code)).toContain("too-few-holds");
    expect(result.offenders.find((o) => o.code === "too-few-holds")?.detail).toContain("0 shot(s) hold");
  });

  it("treats a shot at exactly one second as a hold", () => {
    // The threshold is inclusive; an off-by-one here would quietly demand longer holds than the guideline.
    const result = analysePacing(shotsFrom([1, 1, 1]));
    expect(result.stats.holds).toBe(3);
    expect(result.ok).toBe(true);
  });
});

describe("analysePacing — variation", () => {
  it("passes a run of exactly the maximum equal length", () => {
    const result = analysePacing(shotsFrom([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 2, 2, 2]));
    expect(result.stats.longestEqualRun).toBe(PACING_LIMITS.maxEqualRun);
    expect(result.offenders.map((o) => o.code)).not.toContain("equal-durations");
  });

  it("fails one shot past the maximum, because uniform cutting reads as machine-cut", () => {
    const result = analysePacing(shotsFrom([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 2, 2, 2]));
    expect(result.stats.longestEqualRun).toBe(7);
    expect(result.offenders.map((o) => o.code)).toContain("equal-durations");
  });

  it("does not mistake a millisecond of drift for deliberate variation", () => {
    // Derived timelines carry rounding; a run that differs by 1 ms is still a run of equal shots.
    const result = analysePacing(shotsFrom([0.5, 0.5 + 0.001, 0.5, 0.5 - 0.001, 0.5, 0.5, 0.5]));
    expect(result.stats.longestEqualRun).toBe(7);
  });
});

describe("analysePacing — section contrast", () => {
  const sections = [
    { name: "verse", t0: 0, t1: 4 },
    { name: "chorus", t0: 4, t1: 8 },
  ];

  it("passes when the chorus cuts meaningfully faster than the verse", () => {
    // verse: two 2 s shots; chorus: four 1 s shots. Ratio 0.5, under the 0.75 limit.
    const result = analysePacing(shotsFrom([2, 2, 1, 1, 1, 1]), { sections });
    expect(result.measured["section contrast"]).toContain("0.50");
    expect(result.offenders.map((o) => o.code)).not.toContain("no-contrast");
  });

  it("fails when both sections are cut at the same speed, which means one label is wrong", () => {
    const result = analysePacing(shotsFrom([2, 2, 2, 2]), { sections });
    expect(result.measured["section contrast"]).toContain("1.00");
    expect(result.offenders.map((o) => o.code)).toContain("no-contrast");
  });

  it("says the contrast is not applicable rather than passing it silently when there are no labels", () => {
    const result = analysePacing(shotsFrom([2, 2, 1, 1, 1, 1]));
    expect(result.measured["section contrast"]).toBe("not applicable");
    expect(result.offenders.map((o) => o.code)).not.toContain("no-contrast");
  });
});

describe("analysePacing — degenerate input", () => {
  it("skips an empty timeline instead of dividing by zero", () => {
    const result = analysePacing([]);
    expect(result.skipped).toBeDefined();
    expect(result.stats.shots).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("reports every failure at once, so the author learns both in one run", () => {
    // Uniform short cuts with no holds and a chorus that is not faster: all three at once.
    const result = analysePacing(shotsFrom([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), {
      sections: [
        { name: "verse", t0: 0, t1: 2 },
        { name: "chorus", t0: 2, t1: 4 },
      ],
    });
    const codes = result.offenders.map((o) => o.code);
    expect(codes).toContain("too-few-holds");
    expect(codes).toContain("equal-durations");
    expect(codes).toContain("no-contrast");
  });
});
