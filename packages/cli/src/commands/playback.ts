/**
 * `render.noDeadFrames` and `scene.errors` — the two gates that need the film played through.
 *
 * ## Why `noDeadFrames` exists when `frameContent` already does
 *
 * `render.frameContent` samples about thirty instants and asks "is anything here". That is a *sampled* check,
 * and sampling has a structural blind spot: a shot that draws nothing for eight frames between two samples
 * passes. `render.noDeadFrames` is the complement — every frame, at low resolution, comparing each to the one
 * before. It is the only check in the suite that can see a gap *between* instants, which is exactly the kind of
 * defect a sampled gate cannot be blamed for missing.
 *
 * It is deliberately cheap: the canvas is read at a coarse stride and reduced to one luminance value per frame.
 * Comparing consecutive luminances at full width would cost as much as a render for a strictly weaker answer.
 *
 * The threshold is "something changes in every 0.5 s window", because a film may hold a still image on purpose —
 * a title card does not change for seconds and is correct. What it may not do is hold *nothing*: a frozen frame
 * that is also empty. So a window is dead only when it is both unchanged AND has almost no content, which is the
 * signature of a renderer that stopped drawing rather than a director who chose to hold.
 *
 * ## `scene.errors`
 *
 * Captures `Runtime.exceptionThrown` and `Runtime.consoleAPICalled` while every shot renders. A scene that
 * throws is reported by the engine and drawn as an error card — but an error card is *visible in the film*, and a
 * gate that only looked at pixels would call it content. This gate looks at the console instead, because that is
 * where the engine says what happened.
 */

import { join } from "node:path";

import { Browser, startStaticServer } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import type { Offender } from "./check.js";

export interface DeadFrameCheck {
  id: string;
  ok: boolean;
  measured: Record<string, string | number>;
  offenders: Offender[];
  skipped?: string;
}

/** The in-page pass: one luminance and one content figure per frame. */
export function deadFrameProbeExpression(totalFrames: number, fps: number, stride: number): string {
  return `(function () {
  var TOTAL = ${totalFrames}, FPS = ${fps}, STRIDE = ${stride};
  var canvas = document.getElementById("out") || document.querySelector("canvas");
  var g = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;
  var out = [];
  var exceptions = [];
  for (var f = 0; f < TOTAL; f++) {
    window.cvpw.renderFrame(f / FPS);
    var d = g.getImageData(0, 0, W, H).data;
    var sum = 0, n = 0;
    var counts = {};
    for (var y = 0; y < H; y += STRIDE) {
      for (var x = 0; x < W; x += STRIDE) {
        var p = (y * W + x) * 4;
        sum += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
        var key = ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4);
        counts[key] = (counts[key] || 0) + 1;
        n++;
      }
    }
    /* Content fraction: the share of sampled pixels not equal to the frame's dominant colour. A dead frame is
       one flat fill, so its dominant colour is the whole frame. */
    var best = 0;
    for (var k in counts) if (counts[k] > best) best = counts[k];
    out.push({ frame: f, luminance: n ? sum / n / 255 : 0, content: n ? 1 - best / n : 0 });
  }
  return { frames: out, exceptions: exceptions };
})()`;
}

/**
 * A window is dead when nothing changed in it **and** it had no content.
 *
 * Both conditions, deliberately. A held title card is unchanged and full of content — correct. A frozen black
 * frame is unchanged and empty — the renderer stopped. Only the conjunction is a defect.
 */
export function findDeadWindows(
  frames: ReadonlyArray<{ frame: number; luminance: number; content: number }>,
  fps: number,
): Array<{ from: number; to: number; reason: string }> {
  const windowFrames = Math.max(1, Math.round(fps * 0.5));
  const dead: Array<{ from: number; to: number; reason: string }> = [];
  for (let start = 0; start + windowFrames <= frames.length; start += windowFrames) {
    const slice = frames.slice(start, start + windowFrames);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) continue;
    const changed = slice.some((frame) => Math.abs(frame.luminance - first.luminance) > 0.002);
    const content = slice.reduce((sum, frame) => sum + frame.content, 0) / slice.length;
    if (!changed && content < 0.0005) {
      dead.push({
        from: start / fps,
        to: (start + windowFrames) / fps,
        reason: `unchanged for ${(windowFrames / fps).toFixed(2)} s with ${(content * 100).toFixed(4)} % content — nothing was drawn, rather than something being held`,
      });
    }
  }
  return dead;
}

export interface PlaybackInput {
  root: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
}

/** Run the film once, returning both gates' verdicts from a single pass. */
export async function checkPlayback(input: PlaybackInput): Promise<{ deadFrames: DeadFrameCheck; sceneErrors: DeadFrameCheck }> {
  const deadBase = { id: "render.noDeadFrames" };
  const errBase = { id: "scene.errors" };
  const browserInfo = detectBrowser();
  if (!browserInfo) {
    return {
      deadFrames: { ...deadBase, ok: true, measured: {}, offenders: [], skipped: "no browser, so the film cannot be played through" },
      sceneErrors: { ...errBase, ok: true, measured: {}, offenders: [], skipped: "no browser, so no scene can run" },
    };
  }

  const totalFrames = Math.max(1, Math.round(input.duration * input.fps));
  const server = await startStaticServer({ root: input.root });
  const browser = await Browser.launch({
    executable: browserInfo.path,
    args: renderArgs(),
    tempRoot: join(input.root, "render", ".scratch"),
    timeoutMs: 90_000,
  });

  const consoleErrors: string[] = [];
  const exceptions: string[] = [];
  browser.on("Runtime.exceptionThrown", (params) => {
    const detail = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    exceptions.push((detail.exceptionDetails?.exception?.description ?? detail.exceptionDetails?.text ?? "unknown").slice(0, 300));
  });
  browser.on("Runtime.consoleAPICalled", (params) => {
    const detail = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
    if (detail.type !== "error") return;
    consoleErrors.push((detail.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ").slice(0, 300));
  });

  try {
    await browser.setViewport(input.width, input.height, 1);
    // `Runtime.enable` must precede navigation, or the exceptions thrown during load are lost.
    await browser.send("Runtime.enable", {}, 10_000).catch(() => undefined);
    await browser.navigate(`${server.origin}/engine/index.html?capture`, 90_000);
    for (let i = 0; i < 600; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await browser
      .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
      .catch(() => undefined);

    const probed = await browser.evaluate<{ frames?: Array<{ frame: number; luminance: number; content: number }> }>(
      deadFrameProbeExpression(totalFrames, input.fps, 16),
      { timeoutMs: 1_800_000 },
    );
    const frames = probed.frames ?? [];
    const dead = findDeadWindows(frames, input.fps);

    return {
      deadFrames: {
        ...deadBase,
        ok: dead.length === 0,
        measured: { frames: frames.length, "dead windows": dead.length },
        offenders: dead.slice(0, 12).map((window) => ({
          code: "dead-window",
          where: `[${window.from.toFixed(2)}, ${window.to.toFixed(2)})`,
          detail: window.reason,
        })),
      },
      sceneErrors: {
        ...errBase,
        ok: consoleErrors.length === 0 && exceptions.length === 0,
        measured: { exceptions: exceptions.length, "console errors": consoleErrors.length, frames: frames.length },
        offenders: [...exceptions.map((text) => ({ code: "pageerror", where: "runtime", detail: text })), ...consoleErrors.map((text) => ({ code: "console-error", where: "runtime", detail: text }))].slice(0, 12),
      },
    };
  } finally {
    await browser.close();
    await server.close();
  }
}
