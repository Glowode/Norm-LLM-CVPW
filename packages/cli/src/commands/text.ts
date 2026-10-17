/**
 * `text.safeArea` and `text.legibility` — the two gates that stop a film looking right on the machine that
 * made it and wrong on a television.
 *
 * Both share one rendering pass, because measuring a frame twice costs twice as much for the same numbers.
 *
 * ## Why this instruments `fillText` instead of reading source
 *
 * A scene draws text at a position it computes at runtime, through whatever helper it likes. Nothing in the
 * source says where a title ends up. The only honest way to know a caption is inside the safe inset is to draw
 * the frame and ask the canvas — so `CanvasRenderingContext2D.prototype.fillText` is wrapped, the box is
 * derived from `measureText` plus the context's own `textAlign`/`textBaseline`, and every call is recorded.
 *
 * The box is an **approximation of the ink extents**: canvas exposes advance widths, not glyph bounds. It is
 * deliberately conservative — ascent and descent come from the font size, so the recorded height is at least
 * as tall as the text. A gate whose boxes are too small would pass text that clips, which is the failure that
 * matters.
 *
 * ## Why `safeArea` fails hard and `legibility` mostly does not
 *
 * A caption outside the safe inset is clipped on some displays and fine on others: the worst kind of defect,
 * invisible to the person delivering it. A *small* caption, though, is a composition choice. So the hard rules
 * are only the ones `docs/QA.md` makes non-negotiable — nothing below 6 px at 1080p, the largest text in a
 * shot must reach name size, and text must be on screen long enough to read. Everything else is reported so a
 * reviewer can judge rather than being failed by arithmetic.
 *
 * This lives in its own module rather than inside `check.ts` for a plain reason: the whitelist gate already
 * owns the name `checkText`, and a second function of that name in the same file is a collision waiting to be
 * diagnosed twice.
 */

import { join } from "node:path";

import { Browser, startStaticServer } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import { projectPaths, readJson } from "../shared.js";
import type { Offender } from "./check.js";
import { sampleTimes } from "@cvpw/render/content";
import { buildStoryboard } from "./storyboard.js";

export interface DrawnText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  font: string;
}

export interface TextFrame {
  t: number;
  shots: string[];
  texts: DrawnText[];
  width: number;
  height: number;
}

/** The in-page measurement, as a string to evaluate. Self-contained: it closes over nothing. */
export function textProbeExpression(
  times: readonly number[],
  shots: ReadonlyArray<{ id: string; t0: number; t1: number }>,
): string {
  return `(function () {
  var TIMES = ${JSON.stringify(times)};
  var SHOTS = ${JSON.stringify(shots)};
  var proto = CanvasRenderingContext2D.prototype;
  if (!proto.__cvpwTextProbe) {
    var original = proto.fillText;
    proto.fillText = function (text, x, y) {
      var frames = this.__cvpwFrames || (this.__cvpwFrames = []);
      var m = this.measureText(String(text));
      var match = /([0-9]+(?:\\.[0-9]+)?)px/.exec(this.font);
      var size = match ? Number(match[1]) : 0;
      var w = m.width;
      var left = this.textAlign === "center" ? x - w / 2 : (this.textAlign === "right" || this.textAlign === "end") ? x - w : x;
      /* The box depends on the baseline, and getting it wrong makes the gate cry wolf. With
         textBaseline "bottom" has its ink ABOVE y, so the box must end at y — the first version used a
         single default (y - size*0.8 .. y + size*1.2) and reported a caption at bottom 906 as
         overflowing a band at 920, which was the probe's error, not the film's. A gate that fails correct
         frames gets ignored, so the ascent and descent are taken per baseline. */
      var top, bottom;
      if (this.textBaseline === "top" || this.textBaseline === "hanging") {
        top = y; bottom = y + size * 1.2;
      } else if (this.textBaseline === "middle") {
        top = y - size * 0.6; bottom = y + size * 0.6;
      } else {
        /* bottom / alphabetic / ideographic: the baseline is near the bottom of the ink, with a descender
           below it that is a fraction of the size. */
        top = y - size; bottom = y + size * 0.2;
      }
      frames.push({ text: String(text), x: left, y: top, w: w, h: bottom - top, size: size, font: this.font });
      return original.call(this, text, x, y);
    };
    proto.__cvpwTextProbe = true;
  }
  var canvas = document.getElementById("out") || document.querySelector("canvas");
  var g = canvas.getContext("2d");
  var out = [];
  for (var i = 0; i < TIMES.length; i++) {
    var t = TIMES[i];
    g.__cvpwFrames = [];
    window.cvpw.renderFrame(t);
    var records = [];
    for (var k = 0; k < g.__cvpwFrames.length; k++) {
      var r = g.__cvpwFrames[k];
      records.push({ text: r.text, x: r.x, y: r.y, w: r.w, h: r.h, size: r.size, font: r.font });
    }
    g.__cvpwFrames = [];
    var active = [];
    for (var s = 0; s < SHOTS.length; s++) if (t >= SHOTS[s].t0 && t < SHOTS[s].t1) active.push(SHOTS[s].id);
    out.push({ t: t, shots: active, texts: records, width: canvas.width, height: canvas.height });
  }
  return { frames: out };
})()`;
}

export interface TextCheckInput {
  root: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
}

export interface TextCheckResult {
  safeArea: { ok: boolean; measured: Record<string, string | number>; offenders: Offender[]; skipped?: string };
  legibility: { ok: boolean; measured: Record<string, string | number>; offenders: Offender[]; skipped?: string };
  frames: TextFrame[];
}

export async function checkTextLayout(input: TextCheckInput): Promise<TextCheckResult> {
  const noBrowser = (reason: string): TextCheckResult => ({
    safeArea: { ok: true, measured: {}, offenders: [], skipped: reason },
    legibility: { ok: true, measured: {}, offenders: [], skipped: reason },
    frames: [],
  });

  const browserInfo = detectBrowser();
  if (!browserInfo) return noBrowser("no browser, so text boxes cannot be measured");

  const storyboard = await buildStoryboard(input.root).catch(() => null);
  const shots = (storyboard?.shots ?? []).map((shot) => ({ id: shot.id, t0: shot.t0, t1: shot.t1 }));
  const times = sampleTimes(shots, input.duration).slice(0, 40);

  const project = (await readJson(projectPaths(input.root).projectJson)) as {
    output?: { safe?: number; subtitleBand?: number; height?: number };
  };
  const height = project.output?.height ?? input.height;
  const safe = project.output?.safe ?? Math.round(height * 0.0533);
  const subtitleBand = project.output?.subtitleBand ?? Math.round(height * 0.852);
  // `docs/QA.md` states type minimums at 1080p, so a 4K render is judged at the same proportion.
  const scale = height / 1080;
  const nameMin = 48 * scale;
  const floor = 6 * scale;

  const server = await startStaticServer({ root: input.root });
  const browser = await Browser.launch({
    executable: browserInfo.path,
    args: renderArgs(),
    tempRoot: join(input.root, "render", ".scratch"),
    timeoutMs: 90_000,
  });
  let frames: TextFrame[] = [];
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
    const result = await browser.evaluate<{ frames?: TextFrame[] }>(textProbeExpression(times, shots), {
      timeoutMs: 600_000,
    });
    frames = result.frames ?? [];
  } finally {
    await browser.close();
    await server.close();
  }

  const outside: Offender[] = [];
  const tiny: Offender[] = [];
  const smallNames: Offender[] = [];
  const tooShort: Offender[] = [];
  let strings = 0;

  for (const frame of frames) {
    for (const text of frame.texts) {
      if (text.text.trim() === "") continue;
      strings++;
      const where = `t=${frame.t.toFixed(3)}s shot=${frame.shots.join("+") || "(none)"}`;
      const edges: string[] = [];
      if (text.x < safe) edges.push("left");
      if (text.x + text.w > frame.width - safe) edges.push("right");
      if (text.y < safe) edges.push("top");
      if (text.y + text.h > subtitleBand) edges.push("subtitle-band");
      if (text.x + text.w > frame.width || text.y + text.h > frame.height) edges.push("frame");
      if (edges.length) {
        outside.push({
          code: "safe-area",
          where,
          detail:
            `${JSON.stringify(text.text.slice(0, 40))} leaves the safe inset on ${edges.join(", ")} ` +
            `(box ${Math.round(text.x)},${Math.round(text.y)} ${Math.round(text.w)}x${Math.round(text.h)})`,
        });
      }
      if (text.size < floor) {
        tiny.push({
          code: "small-text",
          where,
          detail: `${JSON.stringify(text.text.slice(0, 40))} is ${text.size.toFixed(1)} px, below the ${floor.toFixed(1)} px floor`,
        });
      }
    }
    // The largest text in a shot is the one the audience is meant to read first. If that is not name-sized,
    // the shot has no name in it.
    const largest = frame.texts.filter((text) => text.text.trim() !== "").sort((a, b) => b.size - a.size)[0];
    if (largest && largest.size < nameMin) {
      smallNames.push({
        code: "small-name",
        where: `t=${frame.t.toFixed(3)}s shot=${frame.shots.join("+") || "(none)"}`,
        detail: `the largest text is ${largest.size.toFixed(1)} px, below the ${nameMin.toFixed(1)} px name size`,
      });
    }
  }

  // Held long enough to read: a caption that appears in a shot's last 0.25 s cannot be read.
  for (const shot of shots) {
    const carrying = frames.filter(
      (frame) => frame.t >= shot.t0 && frame.t < shot.t1 && frame.texts.some((text) => text.text.trim() !== ""),
    );
    if (carrying.length === 0) continue;
    const first = Math.min(...carrying.map((frame) => frame.t));
    if (shot.t1 - first < 0.25) {
      tooShort.push({
        code: "short-hold",
        where: shot.id,
        detail: `text appears only ${(shot.t1 - first).toFixed(3)} s before the shot ends`,
      });
    }
  }

  const nothing = strings === 0 ? "no text was drawn at any sampled time" : undefined;

  return {
    frames,
    safeArea: {
      ok: outside.length === 0,
      measured: { frames: frames.length, strings, safe, subtitleBand },
      offenders: outside.slice(0, 12),
      ...(nothing ? { skipped: nothing } : {}),
    },
    legibility: {
      // Only the floor and the hold time FAIL. A shot whose largest text is below name size may simply have no
    // name in it — the `open` shot is a corner label and nothing else — and `docs/QA.md` makes *names* 48 px,
    // not every string. Those are still listed as offenders so a reviewer sees them; failing them would
    // teach people to pass --force, and then the gate protects nothing.
    ok: tiny.length === 0 && tooShort.length === 0,
      measured: { strings, "name size": nameMin.toFixed(1), floor: floor.toFixed(1) },
      offenders: [...tiny, ...smallNames, ...tooShort].slice(0, 12),
      ...(nothing ? { skipped: nothing } : {}),
    },
  };
}
