/**
 * `flash.rate` — photosensitivity, and what to do when a film exceeds the safe range.
 *
 * ## The rule, and why it is two-tier rather than a hard stop
 *
 * `docs/QA.md` sets the budget at **no more than 3 large-area luminance round-trips per second**. A film that
 * stays under it passes. A film that *exceeds* it is not automatically rejected — that would be the wrong
 * tool, because some genres genuinely want a strobe and the harm is preventable rather than inevitable. What
 * the guideline actually requires is that the audience is warned: a photosensitive-epilepsy caution shown at
 * the start, or at a clearly marked place, before the flashing begins.
 *
 * So the verdict is:
 *
 * | measured | warning present | verdict |
 * |---|---|---|
 * | within budget | — | **pass**, no warning needed |
 * | over budget | declared, drawn, held long enough | **pass**, with a note in the report |
 * | over budget | missing, or too brief, or not on screen where it can be read | **fail** |
 *
 * A gate that only failed would push people to ship the strobe and delete the gate. A gate that only warned
 * would be ignored. Requiring the warning is what makes the film *safe to exhibit*, which is the actual
 * objective — the number is a means, not the end.
 *
 * ## What is measured
 *
 * Sampled frames, mean luminance and saturated-red fraction. A **transition** is a large change in either —
 * red is weighted more heavily because saturated red flashes are the most provocative for photosensitive
 * viewers, which is why the guideline singles it out. A round-trip is a pair of transitions, so the budget is
 * 6 transitions per second.
 *
 * Tear and stripe patterns are named in `docs/QA.md` and are **not** measured here: detecting a stationary
 * high-contrast grating needs spatial frequency analysis, and claiming it with a luminance scan would be a
 * gate whose name promised more than it checked. That limitation is reported, not hidden.
 */

import { join } from "node:path";

import { Browser, startStaticServer } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import { projectPaths, readJson } from "../shared.js";
import type { Offender } from "./check.js";
import { textProbeExpression, type TextFrame } from "./text.js";

/** A large change in mean luminance, 0..1 of full scale. */
const LUMINANCE_STEP = 0.1;
/** A large change in the saturated-red fraction. Weighted lower because red is the more provocative. */
const RED_STEP = 0.2;
/** `docs/QA.md`: round-trips per second. */
const ROUND_TRIPS_PER_SECOND = 3;

export interface FlashSample {
  frame: number;
  t: number;
  /** Mean luminance, 0..1. */
  luminance: number;
  /** Fraction of sampled pixels that are saturated red. */
  red: number;
}

export interface FlashWindow {
  from: number;
  to: number;
  transitions: number;
  roundTrips: number;
}

export interface FlashMeasurement {
  samples: FlashSample[];
  /** The worst 1-second window in the film. */
  worst: FlashWindow | null;
  /** Frames involved in a large transition, in order. */
  hotFrames: number[];
  /** Where the flashing starts, for placing a warning before it. */
  firstHotSecond: number | null;
}

export interface WarningRequirement {
  /** The exact string that must appear. Must also be in `textWhitelist`. */
  text: string;
  /** How long it must be on screen, in seconds. Under a second cannot be read. */
  minDuration: number;
  /** Where it must appear, as a time expression resolved by the caller. Defaults to the film's start. */
  atExpression?: string;
}

export interface AccessibilityConfig {
  /** Declared by the project. Absent means "no warning is available", not "no warning needed". */
  photoSensitivityWarning?: WarningRequirement;
}

/** Read the project's accessibility declaration. */
export async function readAccessibility(root: string): Promise<AccessibilityConfig> {
  const project = (await readJson(projectPaths(root).projectJson)) as {
    accessibility?: AccessibilityConfig;
  } | null;
  return project?.accessibility ?? {};
}

/** The in-page luminance scan. Self-contained so it can cross a CDP boundary. */
export function flashProbeExpression(from: number, to: number, stride: number): string {
  return `(function () {
  var FROM = ${from}, TO = ${to}, STRIDE = ${stride};
  var canvas = document.getElementById("out") || document.querySelector("canvas");
  var g = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;
  var out = [];
  for (var f = FROM; f < TO; f++) {
    var t = f / (window.engine && window.engine.timebase ? window.engine.timebase.fps : 30);
    window.cvpw.renderFrame(t);
    var d = g.getImageData(0, 0, W, H).data;
    var sum = 0, n = 0, red = 0;
    for (var y = 0; y < H; y += STRIDE) {
      for (var x = 0; x < W; x += STRIDE) {
        var p = (y * W + x) * 4;
        var r = d[p], gg = d[p + 1], b = d[p + 2];
        sum += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        if (r > 200 && gg < 80 && b < 80) red++;
        n++;
      }
    }
    out.push({ frame: f, luminance: n ? sum / n / 255 : 0, red: n ? red / n : 0 });
  }
  return { samples: out, fps: (window.engine && window.engine.timebase ? window.engine.timebase.fps : 30) };
})()`;
}

/**
 * Reduce a luminance series to transitions, then to round-trips in a sliding 1-second window.
 *
 * Kept pure and exported so it can be tested without a browser — the arithmetic is where an off-by-one in a
 * safety check would hide, and a safety check whose logic is only exercised by rendering a whole film is a
 * safety check nobody will maintain.
 */
export function analyseFlashes(samples: readonly FlashSample[], fps: number): FlashMeasurement {
  const withT = samples.map((sample) => ({ ...sample, t: sample.frame / fps }));

  const hotFrames: number[] = [];
  for (let i = 1; i < withT.length; i++) {
    const previous = withT[i - 1] as FlashSample & { t: number };
    const current = withT[i] as FlashSample & { t: number };
    const dL = Math.abs(current.luminance - previous.luminance);
    const dR = Math.abs(current.red - previous.red);
    if (dL > LUMINANCE_STEP || dR > RED_STEP) hotFrames.push(current.frame);
  }

  // A sliding 1-second window: for each hot frame, how many land within the following second.
  let worst: FlashWindow | null = null;
  for (const start of hotFrames) {
    const startT = start / fps;
    const inside = hotFrames.filter((frame) => frame / fps >= startT && frame / fps < startT + 1);
    const roundTrips = Math.floor(inside.length / 2);
    if (!worst || roundTrips > worst.roundTrips || (roundTrips === worst.roundTrips && inside.length > worst.transitions)) {
      worst = { from: startT, to: startT + 1, transitions: inside.length, roundTrips };
    }
  }

  return {
    samples: withT,
    worst,
    hotFrames,
    firstHotSecond: hotFrames.length > 0 ? (hotFrames[0] as number) / fps : null,
  };
}

export interface FlashCheckResult {
  ok: boolean;
  measured: Record<string, string | number>;
  offenders: Offender[];
  skipped?: string;
}

export interface FlashCheckInput {
  root: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
}

/**
 * Measure the film, and decide what the film owes its audience.
 *
 * The warning is verified by the same `fillText` instrumentation the text gates use, because a caution nobody
 * can find is not a caution. Its text must appear, it must be on screen for at least the declared duration,
 * and it must be inside the safe inset — which is already enforced by `text.safeArea`.
 */
export async function checkFlash(input: FlashCheckInput): Promise<FlashCheckResult> {

  const browserInfo = detectBrowser();
  if (!browserInfo) {
    return { ok: true, measured: {}, offenders: [], skipped: "no browser, so luminance cannot be measured" };
  }

  const totalFrames = Math.max(1, Math.round(input.duration * input.fps));
  const server = await startStaticServer({ root: input.root });
  const browser = await Browser.launch({
    executable: browserInfo.path,
    args: renderArgs(),
    tempRoot: join(input.root, "render", ".scratch"),
    timeoutMs: 90_000,
  });

  try {
    await browser.setViewport(input.width, input.height, 1);
    await browser.navigate(`${server.origin}/engine/index.html?capture`, 90_000);
    for (let i = 0; i < 600; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await browser
      .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
      .catch(() => undefined);

    // Every frame, because a strobe at 3 Hz alternates faster than any sampling coarser than that could see.
    // Strided pixel reads keep it affordable: the measurement is an area average, so a coarse grid is enough.
    const scanned = await browser.evaluate<{ samples: FlashSample[]; fps: number }>(
      flashProbeExpression(0, totalFrames, 8),
      { timeoutMs: 900_000 },
    );
    const measurement = analyseFlashes(scanned.samples, scanned.fps || input.fps);
    // The budget comes from the project first, `docs/QA.md` second. Hard-coding 3 was a violation of AGENTS.md
    // rule 11 - "thresholds live in docs/QA.md or project.json::budgets; never invent one inside code" - and the
    // audit that found `budgets.flashPerSecond` unread was finding this gate.
    const projectDoc = (await readJson(projectPaths(input.root).projectJson)) as { budgets?: Record<string, number> };
    const declared = projectDoc.budgets?.["flashPerSecond"];
    const budget = typeof declared === "number" ? declared : ROUND_TRIPS_PER_SECOND;
    const budgetSource = typeof declared === "number" ? "project.json::budgets.flashPerSecond" : "docs/QA.md default";
    const overBudget = (measurement.worst?.roundTrips ?? 0) > budget;

    const measured: Record<string, string | number> = {
      frames: scanned.samples.length,
      "peak round-trips/s": measurement.worst?.roundTrips ?? 0,
      "peak transitions/s": measurement.worst?.transitions ?? 0,
      budget,
      "budget from": budgetSource,
      "worst window": measurement.worst ? `${measurement.worst.from.toFixed(3)}–${measurement.worst.to.toFixed(3)} s` : "—",
      "tear / stripe": "not measured — needs spatial frequency analysis, see this module's note",
    };

    if (!overBudget) {
      return { ok: true, measured, offenders: [] };
    }

    // Over budget. The film owes its audience a warning.
    const accessibility = await readAccessibility(input.root);
    const requirement = accessibility.photoSensitivityWarning;
    if (!requirement) {
      return {
        ok: false,
        measured,
        offenders: [
          {
            code: "flash.no-warning",
            where: measured["worst window"] as string,
            detail:
              `the film reaches ${measurement.worst?.roundTrips ?? 0} luminance round-trips per second ` +
              `(budget ${budget}), and declares no photosensitivity warning. Add ` +
              `project.json::accessibility.photoSensitivityWarning with the exact caution text, where it appears ` +
              `and how long it is held — or reduce the flashing.`,
          },
        ],
      };
    }

    // The warning is declared. Prove it is actually on screen, for long enough, near the start.
    const text = await browser.evaluate<{ frames?: TextFrame[] }>(
      textProbeExpression(
        Array.from({ length: Math.ceil(requirement.minDuration * 2) + 2 }, (_, i) => i * 0.5),
        [],
      ),
      { timeoutMs: 300_000 },
    );
    const frames = text.frames ?? [];
    const holding = frames.filter((frame) => frame.texts.some((drawn) => drawn.text.includes(requirement.text)));

    measured["warning declared"] = requirement.text.slice(0, 48);
    measured["warning on screen"] = holding.length > 0 ? `${holding[0]?.t.toFixed(2)}–${holding[holding.length - 1]?.t.toFixed(2)} s` : "not found";

    if (holding.length === 0) {
      return {
        ok: false,
        measured,
        offenders: [
          {
            code: "flash.warning-missing",
            where: "film start",
            detail:
              `project.json declares a photosensitivity warning but the text ${JSON.stringify(requirement.text)} ` +
              `was not drawn in the first ${Math.ceil(requirement.minDuration * 2) + 2} half-seconds. A declared ` +
              `warning that never reaches the screen protects nobody.`,
          },
        ],
      };
    }

    const heldFor = (holding[holding.length - 1]?.t ?? 0) - (holding[0]?.t ?? 0) + 0.5;
    if (heldFor < requirement.minDuration) {
      return {
        ok: false,
        measured,
        offenders: [
          {
            code: "flash.warning-too-brief",
            where: "film start",
            detail:
              `the photosensitivity warning is on screen for ${heldFor.toFixed(2)} s but must be held for ` +
              `${requirement.minDuration.toFixed(2)} s to be readable at the speed a warning is read.`,
          },
        ],
      };
    }

    return {
      ok: true,
      measured,
      offenders: [
        {
          code: "flash.warned",
          where: "film start",
          detail:
            `the film exceeds the flash budget and carries its declared photosensitivity warning ` +
            `(${heldFor.toFixed(2)} s). Acceptable to exhibit BECAUSE it warns; the report records it.`,
        },
      ],
    };
  } finally {
    await browser.close();
    await server.close();
  }
}


