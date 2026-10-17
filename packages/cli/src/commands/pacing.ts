/**
 * `timeline.pacing` — whether the edit has a shape.
 *
 * This is the only gate in the suite that judges the *edit* rather than the artefact, and the only one that
 * could be mistaken for taste. It is not: the three failures it names are all mechanical.
 *
 * - **`too-few-holds`** — fewer than three shots lasting a second or more. A film with no hold has no rhythm to
 *   break, so nothing that happens in it can feel like an event. This is measurable and it is not an opinion.
 * - **`equal-durations`** — a run of more than six shots of the same length. Uniform cutting is what a machine
 *   produces when it has not been asked to decide anything; an audience reads it as flat within about twenty
 *   seconds.
 * - **`no-contrast`** — a chorus whose median shot length is not meaningfully shorter than a verse's. The
 *   section labels are the author's own declaration of which part is which, so if the two parts are cut at the
 *   same speed, one of the two is mislabelled or the dynamic has not been written.
 *
 * All three are **exemptible** (`docs/QA.md`): a single-shot art film legitimately has one hold and no
 * contrast, and the framework's answer to that is a dated exemption, not a weakened threshold.
 *
 * Nothing here renders. It reads `timeline.json` and does arithmetic, which is why it costs milliseconds and
 * runs in `cvpw storyboard` as well as in the gate suite.
 */

import type { Offender } from "./check.js";

/** The minimum a shot needs for this analysis. Deliberately narrow: no scene, no args, just the timing. */
export interface PacingShot {
  id: string;
  t0: number;
  t1: number;
  block?: string;
}

export interface PacingResult {
  ok: boolean;
  measured: Record<string, string | number>;
  offenders: Offender[];
  skipped?: string;
  /** Per-block summary, so a storyboard can print it without recomputing. */
  stats: {
    shots: number;
    shortest: number;
    median: number;
    longest: number;
    holds: number;
    longestEqualRun: number;
  };
}

/** `docs/QA.md` thresholds. Named here so the numbers appear once and can be pointed at. */
export const PACING_LIMITS = {
  /** A shot at or above this length is a hold. */
  holdSeconds: 1.0,
  /** Fewer holds than this and the film has no rhythm to break. */
  minHolds: 3,
  /** More consecutive equal-length shots than this reads as machine-cut. */
  maxEqualRun: 6,
  /** A chorus must cut at most this fraction of the verse's median, to have any lift. */
  contrastRatio: 0.75,
} as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : (sorted[middle] as number);
}

/**
 * Measure the edit, and report each mechanical failure separately.
 *
 * Every check reports rather than short-circuits, because a film can be flat in two ways at once and the author
 * should learn both from one run.
 */
export function analysePacing(
  shots: readonly PacingShot[],
  options: { sections?: ReadonlyArray<{ name: string; t0: number; t1: number }> } = {},
): PacingResult {
  if (shots.length === 0) {
    return {
      ok: true,
      measured: {},
      offenders: [],
      skipped: "no shots, so there is no pacing to judge",
      stats: { shots: 0, shortest: 0, median: 0, longest: 0, holds: 0, longestEqualRun: 0 },
    };
  }

  const lengths = shots.map((shot) => Math.max(0, shot.t1 - shot.t0));
  const holds = lengths.filter((length) => length >= PACING_LIMITS.holdSeconds).length;

  // The longest run of consecutive shots of the same length, to the millisecond — the precision a derived
  // timeline actually has, so a rounding difference is not mistaken for deliberate variation.
  let longestEqualRun = 1;
  let run = 1;
  for (let i = 1; i < lengths.length; i++) {
    const same = Math.abs((lengths[i] as number) - (lengths[i - 1] as number)) < 0.001;
    run = same ? run + 1 : 1;
    longestEqualRun = Math.max(longestEqualRun, run);
  }

  const offenders: Offender[] = [];
  if (holds < PACING_LIMITS.minHolds) {
    offenders.push({
      code: "too-few-holds",
      where: "timeline",
      detail:
        `${holds} shot(s) hold for ${PACING_LIMITS.holdSeconds} s or more; the guideline is ${PACING_LIMITS.minHolds}. ` +
        `A film with no hold has no rhythm to break, so nothing in it can feel like an event.`,
    });
  }
  if (longestEqualRun > PACING_LIMITS.maxEqualRun) {
    const start = shots[lengths.findIndex((_, i) => i === 0)]?.id ?? "?";
    void start;
    offenders.push({
      code: "equal-durations",
      where: `run of ${longestEqualRun} shots`,
      detail:
        `${longestEqualRun} consecutive shots are the same length (limit ${PACING_LIMITS.maxEqualRun}). ` +
        `Uniform cutting is what a machine produces when it has not been asked to decide anything.`,
    });
  }

  // Section contrast, using the author's own labels. Only meaningful when both parts exist.
  const sections = options.sections ?? [];
  const chorus = sections.find((section) => /chorus|hook|drop/i.test(section.name));
  const verse = sections.find((section) => /verse|intro|build/i.test(section.name));
  let contrast = "not applicable";
  if (chorus && verse) {
    const inRange = (section: { t0: number; t1: number }): number[] =>
      shots.filter((shot) => shot.t0 >= section.t0 && shot.t1 <= section.t1).map((shot) => shot.t1 - shot.t0);
    const chorusMedian = median(inRange(chorus));
    const verseMedian = median(inRange(verse));
    if (chorusMedian > 0 && verseMedian > 0) {
      const ratio = chorusMedian / verseMedian;
      contrast = `${ratio.toFixed(2)} (chorus ${chorusMedian.toFixed(2)} s vs verse ${verseMedian.toFixed(2)} s)`;
      if (ratio > PACING_LIMITS.contrastRatio) {
        offenders.push({
          code: "no-contrast",
          where: "sections",
          detail:
            `the chorus is cut at ${ratio.toFixed(2)} of the verse's median shot length (limit ` +
            `${PACING_LIMITS.contrastRatio}). The sections are labelled differently but cut the same, so one of ` +
            `the two is mislabelled or the dynamic has not been written.`,
        });
      }
    }
  }

  return {
    ok: offenders.length === 0,
    measured: {
      shots: shots.length,
      shortest: `${Math.min(...lengths).toFixed(2)} s`,
      median: `${median(lengths).toFixed(2)} s`,
      longest: `${Math.max(...lengths).toFixed(2)} s`,
      holds,
      "longest equal run": longestEqualRun,
      "section contrast": contrast,
    },
    offenders,
    stats: {
      shots: shots.length,
      shortest: Math.min(...lengths),
      median: median(lengths),
      longest: Math.max(...lengths),
      holds,
      longestEqualRun,
    },
  };
}
