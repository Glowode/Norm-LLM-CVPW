import { describe, expect, it } from "vitest";

import { decideAlignment, type AlignmentPolicy } from "../../packages/kernel/src/asr.js";

const p = (mode: AlignmentPolicy["mode"], extra: Partial<AlignmentPolicy> = {}): AlignmentPolicy => ({
  mode,
  ...extra,
});

/**
 * The policy is the part most likely to be got wrong and hardest to notice being wrong: a project that silently
 * chose a path produces timings that look like any other timings. So every rule is pinned here.
 */
describe("decideAlignment — a fact beats a computation", () => {
  it("uses existing timed lyrics and never recognises over them", () => {
    const decision = decideAlignment({ hasLyricsFile: true, hasLyricTiming: true });
    expect(decision.action).toBe("use-lyrics");
    expect(decision.reason).toContain("already has timed lyrics");
    // No question, because there is nothing to decide.
    expect(decision.question).toBeUndefined();
  });

  it("prefers timed lyrics even when a provider is selected and available", () => {
    // The dangerous case: a project that recorded `asr` and later gained a timed lyric file. The fact still wins.
    const decision = decideAlignment({
      hasLyricsFile: true,
      hasLyricTiming: true,
      policy: p("asr", { provider: "x" }),
      availableProviders: ["x"],
    });
    expect(decision.action).toBe("use-lyrics");
  });
});

describe("decideAlignment — no decision recorded means ask", () => {
  it("asks when there is no lyric file at all, and names all three paths", () => {
    const decision = decideAlignment({ hasLyricsFile: false, hasLyricTiming: false });
    expect(decision.action).toBe("ask");
    expect(decision.question).toContain("no lyric file");
    expect(decision.question).toContain("recognition");
    expect(decision.question).toContain("skip");
  });

  it("asks when lyrics exist but are untimed, and offers energy alignment as the cheap path", () => {
    const decision = decideAlignment({ hasLyricsFile: true, hasLyricTiming: false });
    expect(decision.action).toBe("ask");
    // The cheap option has to be in the question, or the human cannot weigh it against the slow one.
    expect(decision.question).toContain("energy");
    expect(decision.question).toContain("slow");
  });

  it("never returns a silent choice when nothing is recorded", () => {
    for (const hasLyricsFile of [true, false]) {
      expect(decideAlignment({ hasLyricsFile, hasLyricTiming: false }).action).toBe("ask");
    }
  });
});

describe("decideAlignment — a recorded policy is honoured", () => {
  it("carries out `estimated` without asking, because it was already chosen", () => {
    const decision = decideAlignment({ hasLyricsFile: false, hasLyricTiming: false, policy: p("estimated", { reason: "instrumental intro" }) });
    expect(decision.action).toBe("estimated");
    expect(decision.reason).toBe("instrumental intro");
  });

  it("carries out `manual` without asking", () => {
    expect(decideAlignment({ hasLyricsFile: true, hasLyricTiming: false, policy: p("manual") }).action).toBe("manual");
  });

  it("asks when `lyrics` is recorded but no lyric file exists, because the policy cannot be carried out", () => {
    const decision = decideAlignment({ hasLyricsFile: false, hasLyricTiming: false, policy: p("lyrics") });
    expect(decision.action).toBe("ask");
    expect(decision.reason).toContain("cannot be carried out");
  });
});

describe("decideAlignment — recognition is never assumed available", () => {
  it("asks when `asr` names no provider", () => {
    const decision = decideAlignment({ hasLyricsFile: true, hasLyricTiming: false, policy: p("asr") });
    expect(decision.action).toBe("ask");
    expect(decision.question).toContain("adapter");
  });

  it("asks when the named provider has no adapter on this machine", () => {
    const decision = decideAlignment({
      hasLyricsFile: true,
      hasLyricTiming: false,
      policy: p("asr", { provider: "gpt-sovits" }),
      availableProviders: ["whisper-local"],
    });
    expect(decision.action).toBe("ask");
    // The question must name the missing thing, or the human cannot fix it.
    expect(decision.question).toContain("gpt-sovits");
    expect(decision.question).toContain("Write one");
  });

  it("proceeds only when the named provider is actually present", () => {
    const decision = decideAlignment({
      hasLyricsFile: true,
      hasLyricTiming: false,
      policy: p("asr", { provider: "gpt-sovits" }),
      availableProviders: ["gpt-sovits"],
    });
    expect(decision.action).toBe("asr");
  });
});
