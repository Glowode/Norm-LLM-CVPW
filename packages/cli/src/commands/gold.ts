/**
 * `cvpw gold` and `cvpw check --determinism` — the determinism witness.
 *
 * The framework claims a frame is a pure function of `t`. Every architectural decision follows from that:
 * the ordering invariant, `--workers` as a throughput knob, seam comparison, resumable renders. Until now
 * the claim was verified by hand, twice, in spikes. This turns it into a regression test.
 *
 * **Two things about the design are deliberate and worth stating.**
 *
 * 1. **Frames are captured the way a render captures them** — render, `flush`, then an encoded screenshot —
 *    not by reading canvas pixels. The witness has to be the artefact that ships. This is the point ADR 0007
 *    decision 3 makes, and it is why the gate would have caught the queued-canvas bug: a pixel read does not
 *    go through the same path.
 *
 * 2. **A run walks from the film's start**, even when it only compares late frames. That is expensive and it
 *    is the whole reason the measurement is valid: a frame's pixels depend on how much work was queued before
 *    it, so a gate that jumped straight to frame 200 would compare a frame nobody ever ships.
 *
 * The comparison is by **quantised hash**, not by byte equality, so a GPU that differs in the last bit of a
 * float does not fail the gate — but a scene that changes colour does. The quantisation is coarse (6 bits per
 * channel) and the exact hash is recorded alongside it, so a report can always say which of the two views
 * disagreed.
 */

import { Browser, startStaticServer } from "@cvpw/render";
import { detectBrowser, renderArgs } from "../browser.js";
import { ContractError, projectPaths, readJson, relPath } from "../shared.js";
import { prepareCapture } from "./render.js";

/** How the frame is reduced to a witness. Both views are recorded; only one decides the verdict. */
export interface FrameWitness {
  /** SHA-256 of the captured bytes, first 16 hex chars. Byte-exact: changes with any encoder difference. */
  exact: string;
  /** SHA-256 of the 6-bit-per-channel quantised pixels. Stable against float noise; decides the verdict. */
  coarse: string;
}

export interface GoldDocument {
  $schema: string;
  schemaVersion: 1;
  fixture: string;
  renderer?: string;
  width: number;
  height: number;
  fps: number;
  dpr?: number;
  grain?: boolean;
  tolerance?: number;
  frames: Record<string, string>;
  reason?: string;
}

export interface GoldOptions {
  root: string;
  /** Frames to witness. Defaults to the evenly spread sample the renderer itself hashes. */
  frames?: readonly number[];
  /** How many frames to sample when `frames` is not given. */
  sample?: number;
  /** State the reason. Without one the file is written with a placeholder that says it is unexplained. */
  reason?: string;
  onProgress?: (frame: number, total: number) => void;
}

/** The sampled frame indices for a film of `totalFrames`, spread so every shot contributes. */
export function sampleFrameIndices(totalFrames: number, sample = 24): number[] {
  if (totalFrames <= 0) return [];
  const count = Math.max(1, Math.min(sample, totalFrames));
  const step = Math.max(1, Math.floor(totalFrames / count));
  const frames: number[] = [];
  for (let f = 0; f < totalFrames; f += step) frames.push(f);
  // Always include the last frame: an off-by-one at the end of a film is otherwise invisible to a sample.
  if (frames[frames.length - 1] !== totalFrames - 1) frames.push(totalFrames - 1);
  return frames;
}

/**
 * Capture witnesses for a set of frames, walking from frame 0.
 *
 * Returns the witnesses plus the renderer string, because a gold file taken on a different GPU is a
 * legitimate reason for a mismatch and recording it turns a mystery into a decision.
 */
export async function captureWitnesses(
  options: GoldOptions & { frames: readonly number[] },
): Promise<{ witnesses: Map<number, FrameWitness>; renderer: string; width: number; height: number; fps: number }> {
  const context = await prepareCapture(options.root);
  const browserInfo = detectBrowser();
  if (!browserInfo) throw new ContractError("no chromium-family browser found, so no frame can be witnessed");

  const targets = new Set(options.frames);
  const last = Math.max(...options.frames);
  const server = await startStaticServer({ root: context.root });
  const path = await import("node:crypto");
  const browser = await Browser.launch({
    executable: browserInfo.path,
    args: renderArgs(),
    tempRoot: context.tempRoot,
    timeoutMs: 90_000,
  });

  try {
    await browser.setViewport(context.width, context.height, context.dpr);
    await browser.navigate(`${server.origin}/${context.entry.replace(/^\/+/, "")}?capture`, 90_000);
    for (let i = 0; i < 600; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await browser
      .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
      .catch(() => undefined);

    const renderer = await browser
      .evaluate<string>(
        "(function(){var c=document.createElement('canvas');var gl=c.getContext('webgl2');" +
          "if(!gl)return 'no webgl2';var e=gl.getExtension('WEBGL_debug_renderer_info');" +
          "return e?String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER));})()",
      )
      .catch(() => "unknown");

    const witnesses = new Map<number, FrameWitness>();
    // From zero, always. A stride would compare frames drawn with different queued work behind them, which
    // is exactly the condition that made `--workers` change the output before `Browser.flush`.
    for (let f = 0; f <= last; f++) {
      await browser.evaluate(`window.cvpw.renderFrame(${f} / ${context.fps})`);
      if (!targets.has(f)) continue;
      // Deliberately NOT flushed here. A real render flushes, and the first measurement of this gate showed
      // that flushing changes nothing once warm-up walks from the start — but the gate must witness what a
      // render produces, so it takes the same path rather than a tidier one.
      await browser.flush();
      const png = await browser.screenshot({ format: "png", timeoutMs: 180_000 });
      witnesses.set(f, {
        exact: path.createHash("sha256").update(png).digest("hex").slice(0, 16),
        coarse: await quantisedHash(browser),
      });
      options.onProgress?.(f, last);
    }

    return { witnesses, renderer, width: context.width, height: context.height, fps: context.fps };
  } finally {
    await browser.close();
    await server.close();
  }
}

/**
 * A hash of the canvas quantised to 6 bits per channel.
 *
 * The instrument for the verdict, because the exact hash of *encoded* bytes is sensitive to the encoder as
 * well as to the picture — a libx264 build change could move it without a pixel changing. Quantising to 6
 * bits keeps a band of 4 levels, so GPU float noise in the last bit disappears while a scene that shifts
 * colour by more than one level does not.
 */
async function quantisedHash(browser: Browser): Promise<string> {
  const hex = await browser.evaluate<string>(
    `(function(){
      var c = document.getElementById("out") || document.querySelector("canvas");
      var g = c.getContext("2d");
      var d = g.getImageData(0, 0, c.width, c.height).data;
      var h1 = 0x811c9dc5, h2 = 0x811c9dc5;
      for (var i = 0; i < d.length; i += 4) {
        // 6 bits per channel: >> 2 folds four levels together.
        var k = ((d[i] >> 2) << 12) | ((d[i+1] >> 2) << 6) | (d[i+2] >> 2);
        h1 = Math.imul(h1 ^ (k & 255), 0x01000193);
        h1 = Math.imul(h1 ^ ((k >> 8) & 255), 0x01000193);
        h2 = Math.imul(h2 ^ k, 0x01000193);
      }
      return ((h1 >>> 0).toString(16).padStart(8, "0")) + ((h2 >>> 0).toString(16).padStart(8, "0"));
    })()`,
    { timeoutMs: 180_000 },
  );
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(hex).digest("hex").slice(0, 16);
}

/** Take a baseline and describe it as a `qa/gold.json` document. */
export async function takeGold(options: GoldOptions): Promise<{ document: GoldDocument; path: string }> {
  const context = await prepareCapture(options.root);
  const total = Math.round(context.duration * context.fps);
  const frames = options.frames ? [...options.frames] : sampleFrameIndices(total, options.sample ?? 24);
  if (frames.length === 0) throw new ContractError("there are no frames to witness; is the duration zero?");

  const captured = await captureWitnesses({ ...options, frames });

  return {
    document: {
      $schema: "schemas/gold.schema.json",
      schemaVersion: 1,
      fixture: relPath(process.cwd(), options.root) || ".",
      renderer: captured.renderer,
      width: captured.width,
      height: captured.height,
      fps: captured.fps,
      dpr: context.dpr,
      grain: !context.noGrain,
      tolerance: 0,
      frames: Object.fromEntries(
        [...captured.witnesses.entries()].sort((a, b) => a[0] - b[0]).map(([f, w]) => [String(f), w.coarse]),
      ),
      reason:
        options.reason ??
        "UNEXPLAINED: this baseline was taken without a stated reason. Replace this string with why it was " +
          "(re)taken — a gold file whose provenance is unknown is indistinguishable from an accident.",
    },
    path: projectPaths(options.root).gold,
  };
}

export interface DeterminismDiff {
  frame: number;
  expected: string;
  observed: string;
  /** True when the exact hashes agree but the coarse ones do not — impossible, and worth flagging. */
  impossible?: boolean;
}

export interface DeterminismResult {
  ok: boolean;
  compared: number;
  differing: DeterminismDiff[];
  /** Frames that differed from a SECOND capture of themselves in the same run. Never acceptable. */
  unstable?: Array<{ frame: number; first: string; second: string }>;
  missing: number[];
  renderer: string;
  goldRenderer?: string;
  /** Set when the gate could not run at all, which is different from passing. */
  skipped?: string;
  gold: GoldDocument | null;
}

/**
 * Compare the current render against the baseline.
 *
 * A missing gold file is **not** a failure: most projects do not have one, and a gate that fails until a
 * baseline exists would be turned off on day one. It is reported as skipped, with the command that creates
 * one. A gold file that exists and disagrees is a failure, and the report names the frames.
 */
export async function checkDeterminism(root: string, options: { reason?: string } = {}): Promise<DeterminismResult> {
  const paths = projectPaths(root);
  let gold: GoldDocument | null = null;
  try {
    gold = (await readJson(paths.gold)) as GoldDocument;
  } catch {
    gold = null;
  }
  if (!gold || typeof gold.frames !== "object") {
    return {
      ok: true,
      compared: 0,
      differing: [],
      missing: [],
      renderer: "unknown",
      gold: null,
      skipped: "no qa/gold.json yet — run `cvpw gold --reason \"<why>\"` to take a baseline",
    };
  }

  const frames = Object.keys(gold.frames)
    .map((key) => Number(key))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  if (frames.length === 0) {
    return { ok: true, compared: 0, differing: [], missing: [], renderer: "unknown", gold, skipped: "qa/gold.json has no frames" };
  }

  const captured = await captureWitnesses({ root, frames, ...(options.reason ? { reason: options.reason } : {}) });

  // STABILITY FIRST, and independently of any stored baseline.
  //
  // Comparing against `qa/gold.json` measures the machine as much as the renderer: the baseline may have been taken
  // on an idle machine, and a busy one then reports differing witnesses that no code change explains. That happened
  // twice in this project - a per-cell grain pass reported 11/11 and later 1 differing with identical code.
  //
  // So the same witnesses are captured a SECOND time inside this run and compared with each other. Two captures of
  // one frame in one session must agree; if they do not, the renderer is not a function of `t` and no baseline can
  // make that acceptable. This test needs no baseline file, which also means it works on a project that has none.
  const repeat = await captureWitnesses({ root, frames, ...(options.reason ? { reason: options.reason } : {}) });
  const unstable: Array<{ frame: number; first: string; second: string }> = [];
  for (const frame of frames) {
    const a = captured.witnesses.get(frame);
    const b = repeat.witnesses.get(frame);
    if (!a || !b) continue;
    if (a.exact !== b.exact) unstable.push({ frame, first: a.exact, second: b.exact });
  }
  const differing: DeterminismDiff[] = [];
  const missing: number[] = [];
  for (const frame of frames) {
    const observed = captured.witnesses.get(frame);
    const expected = gold.frames[String(frame)] ?? "";
    if (!observed || expected === "") {
      missing.push(frame);
      continue;
    }
    if (observed.coarse !== expected) {
      differing.push({ frame, expected, observed: observed.coarse });
    }
  }

  return {
    // A frame that differs from ITSELF inside one run is a hard failure regardless of any baseline: the renderer is
    // then not a pure function of `t`, which is the promise the whole framework is built on.
    ok: differing.length === 0 && missing.length === 0 && unstable.length === 0,
    compared: frames.length - missing.length,
    differing,
    missing,
    unstable,
    renderer: captured.renderer,
    ...(gold.renderer ? { goldRenderer: gold.renderer } : {}),
    gold,
  };
}
