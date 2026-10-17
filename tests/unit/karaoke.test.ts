import { describe, expect, it } from "vitest";

import { parseLrcKaraoke } from "../../packages/cli/src/commands/lyrics.js";

/**
 * A real excerpt. Three lines share one timestamp: the karaoke line, the plain lyric line, and a translation.
 * This triplication is not an edge case — it is what the reference corpus actually contains, and a parser that
 * ignores it returns three times as many lines as the song has.
 */
const REAL_EXCERPT = [
  "[00:27.860]<0,160>刃<160,290>渡<450,100>り<550,260>數<810,250>セ<1060,90>ン<1150,210>チ",
  "[00:27.860]刃渡り數センチ",
  "[00:27.860]刀长数公分",
  "[00:30.840]<0,150>挙<150,70>げ<220,190>句",
  "",
  "[00:33.840]no markup at all",
].join("\n");

describe("parseLrcKaraoke — per-character timing", () => {
  it("extracts character times relative to the line's own timestamp", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    const first = lines.find((line) => line.text.startsWith("刃渡り")) as (typeof lines)[number];
    expect(first.chars.slice(0, 3)).toEqual([
      { ch: "刃", start: 27.86, end: 28.02 },
      { ch: "渡", start: 28.02, end: 28.31 },
      { ch: "り", start: 28.31, end: 28.41 },
    ]);
  });

  it("strips the markup from the text so it cannot be drawn on screen", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    expect(lines.some((line) => /<\d+,\d+>/.test(line.text))).toBe(false);
  });

  it("keeps the plain text alongside the character times, so a line can still be drawn whole", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    expect(lines.map((line) => line.text)).toContain("刃渡り數センチ");
  });
});

describe("parseLrcKaraoke — collapsing the per-timestamp triplication", () => {
  it("returns one line per timestamp, not three", () => {
    // Three source lines share 00:27.860; the result must hold one.
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    const at2786 = lines.filter((line) => Math.abs(line.t - 27.86) < 1e-6);
    expect(at2786).toHaveLength(1);
  });

  it("prefers the karaoke line over a plain line at the same instant, because it carries both", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    const at2786 = lines.find((line) => Math.abs(line.t - 27.86) < 1e-6) as (typeof lines)[number];
    expect(at2786.karaoke).toBe(true);
    expect(at2786.chars.length).toBeGreaterThan(0);
  });

  it("keeps a line that has no markup, rather than dropping what it cannot enrich", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    const plain = lines.find((line) => line.text === "no markup at all") as (typeof lines)[number];
    expect(plain.karaoke).toBe(false);
    expect(plain.chars).toEqual([]);
  });

  it("sorts by time so a caller can walk the lines in order", () => {
    const lines = parseLrcKaraoke(REAL_EXCERPT);
    for (let i = 1; i < lines.length; i++) {
      expect((lines[i] as { t: number }).t).toBeGreaterThanOrEqual((lines[i - 1] as { t: number }).t);
    }
  });

  it("returns nothing for a file with no timestamps, instead of inventing lines", () => {
    expect(parseLrcKaraoke("just some words\nand more")).toEqual([]);
  });

  it("survives a BOM, because the reference corpus is not guaranteed to be clean", () => {
    const lines = parseLrcKaraoke(`\uFEFF${REAL_EXCERPT}`);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.text.startsWith("刃")).toBe(true);
  });
});
