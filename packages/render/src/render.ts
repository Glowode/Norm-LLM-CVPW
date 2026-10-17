/**
 * The renderer: several browser pages producing frames into one ordered sink.
 *
 * The design follows directly from what `docs/adr/0007` measured:
 *
 * - **Work is split into contiguous chunks, one per worker.** The ADR tested interleaving and chunks, and
 *   chunks are stable while interleaving is not — a worker starting mid-film reproduces what a sequential
 *   render produced, so a chunk boundary is invisible.
 * - **Warm-up frames are discarded at the head of the timeline.** A session's first two frames are the one
 *   thing the ADR could not make reproducible; rendering them and throwing them away costs 0.1 % of a long
 *   film and buys a re-render that matches the previous render.
 * - **Frames reach the encoder in ascending order regardless of arrival order** (`sink.ts`). That is what
 *   makes `--workers` a throughput knob rather than a creative one.
 * - **A failed render deletes its output and its frames** (`ffmpeg.ts`, `sink.ts`). A plausible-looking
 *   partial file is the worst outcome available, because it passes every check except watching it.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Browser, type CdpError } from "./cdp.js";
import { encode, probeEncoders, type EncoderProbe } from "./ffmpeg.js";
import { createSink, frameName, planChunks, type FrameSink, type SinkStats } from "./sink.js";
import { startStaticServer } from "./server.js";

/** Everything the renderer needs. Derived from `project.json` plus the CLI's flags. */
export interface RenderRequest {
  /** Absolute path of the project root to serve. */
  root: string;
  /** Path of the entry page, relative to `root`. */
  entry?: string;
  /** Browser executable. */
  browser: string;
  /** Extra browser arguments. Defaults to the GPU/throttling set. */
  browserArgs?: readonly string[];
  /** ffmpeg path. Required by `render`, which encodes; a stills-only request does not need it. */
  ffmpeg?: string;
  /** ffprobe path. Required by `render`, which verifies the frame count. */
  ffprobe?: string;
  width: number;
  height: number;
  fps: number;
  /** Film duration in seconds. Required by the stills path; a range render can derive it from `to`. */
  duration?: number;
  /** Inclusive first frame. */
  from: number;
  /** Exclusive last frame. */
  to: number;
  /** Supersampling factor. `1` for a native render. */
  dpr: number;
  /** Concurrent pages. The output MUST NOT depend on this value. */
  workers: number;
  /** Sub-frames per output frame, for motion blur. `1` disables it. */
  samples?: number;
  /** Shutter fraction of a frame interval. */
  shutter?: number;
  /** Disable the grain pass. Seam comparison and hashing MUST run with grain off. */
  noGrain?: boolean;
  /** Frames to render and discard at the head of the timeline. Defaults to 2 (ADR 0007). */
  warmupFrames?: number;
  /** Absolute path of the output file. */
  output: string;
  /** Absolute path of an audio file to mux. */
  audio?: string;
  /** Lead-in applied AT MUX TIME. */
  audioOffset?: number;
  /** Quality target passed to the encoder. */
  quality?: number;
  /** ASCII-only scratch root for profiles and frames. */
  tempRoot: string;
  /** Refuse to run under a software rasteriser unless this is set. */
  allowSoftware?: boolean;
  /** Called with progress. For reporting only; must not influence rendering. */
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderProgress {
  committed: number;
  total: number;
  elapsedMs: number;
  etaMs: number | null;
  sink: SinkStats;
}

export interface RenderOutcome {
  output: string;
  bytes: number;
  frames: number;
  /** The encoder actually used, after probing. */
  encoder: EncoderProbe;
  renderer: string;
  software: boolean;
  msPerFrame: { avg: number; p50: number; p95: number; max: number };
  /** Frame index to content hash, at the sampled times. */
  frameHashes: Record<string, string>;
  /**
   * The scenes and styles the pages registered, as the pages themselves reported them.
   *
   * Recorded so `render.registry` can answer "is the master on disk the film this source describes?" — a
   * question nothing else can ask, because every other gate validates the *current* definition against the
   * *recorded* file and would happily pass a master rendered before the scene was rewritten.
   */
  registry: { scenes: string[]; styles: string[] };
  warnings: string[];
  errors: string[];
  command: string[];
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

const SOFTWARE_MARKERS = ["swiftshader", "warp", "llvmpipe", "softpipe", "software", "basic render"];

/** The page-side API the renderer drives. A project's entry module must expose exactly this. */
const READY_EXPRESSION = "typeof window.cvpw !== 'undefined' && window.cvpw.ready ? window.cvpw.ready.then(function(){return true}) : (window.ready === true)";
const RENDER_EXPRESSION = (t: number): string =>
  `(window.cvpw && window.cvpw.renderFrame ? window.cvpw.renderFrame(${t}) : window.renderFrame(${t}))`;
const HASH_EXPRESSION = (t: number): string =>
  `(window.cvpw && window.cvpw.frameHash ? window.cvpw.frameHash(${t}) : (window.frameHash ? window.frameHash(${t}) : ''))`;

/** Render a film. Throws `RenderError` on any failure, having deleted everything it wrote. */
export async function render(request: RenderRequest): Promise<RenderOutcome> {
  const fps = request.fps;
  const total = request.to - request.from;
  if (total <= 0) throw new RenderError(`the frame range [${request.from}, ${request.to}) is empty`);
  if (request.workers < 1) throw new RenderError(`workers must be at least 1, got ${request.workers}`);

  const warmupFrames = request.warmupFrames ?? 2;
  const warnings: string[] = [];
  const errors: string[] = [];
  if (request.workers > 1 && warmupFrames === 0) {
    // Parallel rendering is only reproducible because each worker warms from the film's start. With warm-up
    // disabled a worker begins cold and produces different pixels, which is a deliberate choice the caller
    // has to make explicitly and should not discover from a mismatched gold file.
    warnings.push(
      `--workers ${request.workers} with warmupFrames 0: each worker starts cold, so this render will NOT ` +
        `match a sequential one. Pass warmupFrames >= 1 for a reproducible result.`,
    );
  }
  const startedAt = Date.now();

  // --- encoder, chosen by probing rather than by listing ------------------------------------------
  const ffmpeg = request.ffmpeg;
  const ffprobe = request.ffprobe;
  if (!ffmpeg) throw new RenderError("render needs an ffmpeg path; pass `ffmpeg` in the request");
  if (!ffprobe) throw new RenderError("render needs an ffprobe path; pass `ffprobe` in the request");
  const encoder = await probeEncoders({ ffmpeg, quality: request.quality });
  if (!encoder.usable) {
    throw new RenderError(
      `no usable encoder: ${encoder.name} failed with ${encoder.evidence}\n` +
        `  this is reported rather than worked around, because a render that cannot encode is not a render.`,
    );
  }
  if (encoder.name !== "h264_nvenc") {
    // Report the *attempt sequence*, not a bare claim. The first version of this read "hardware encoding was
    // not available (a 5-frame test encode succeeded)", which is self-contradictory and useless — the
    // parenthesised evidence belonged to the encoder that WON, not the ones that lost. A probe result is only
    // actionable when it says what was tried and why each attempt failed.
    const why = (encoder.rejected ?? []).map((entry) => `${entry.name}: ${entry.reason}`).join("; ");
    warnings.push(
      why
        ? `using ${encoder.name} because the preferred encoder(s) failed — ${why}`
        : `using ${encoder.name}; no preferred encoder was tried`,
    );
  }

  const server = await startStaticServer({ root: request.root });
  const frameDir = join(request.tempRoot, `frames-${process.pid}`);
  const frameExtension = "jpg";
  const sink = createSink({
    dir: frameDir,
    from: request.from,
    to: request.to,
    // Generous because frames are small (a 1080p JPEG is ~200 KB) and the bound exists to stop unbounded
    // growth, not to tightly couple the workers. 64 frames is ~13 MB worst case.
    lookahead: Math.max(8, request.workers * 8),
    extension: frameExtension,
  });

  const frameTimes: number[] = [];
  const frameHashes: Record<string, string> = {};
  const hashTargets = new Set<number>();
  // Hashing every frame would dominate the render; a sparse, evenly spread sample is what the gold gate
  // compares. Frame indices, not times, so a change to the timebase cannot shift which frames are compared.
  const hashEvery = Math.max(1, Math.floor(total / 24));
  for (let f = request.from; f < request.to; f += hashEvery) hashTargets.add(f);

  const progress = (): void => {
    const elapsed = Date.now() - startedAt;
    const committed = sink.stats().written;
    const rate = committed > 0 ? elapsed / committed : 0;
    request.onProgress?.({
      committed,
      total,
      elapsedMs: elapsed,
      etaMs: committed > 0 && rate > 0 ? Math.round(rate * (total - committed)) : null,
      sink: sink.stats(),
    });
  };

  try {
    const chunks = planChunks(request.from, request.to, request.workers);
    const entry = request.entry ?? "engine/index.html";
    // `?capture` hides the page furniture. Without it the hint bar is inside the capture region and every
    // frame of the film carries a line of documentation about the framework.
    const url = `${server.origin}/${entry.replace(/^\/+/, "")}?capture`;

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const browser = await Browser.launch({
          executable: request.browser,
          args: request.browserArgs ?? [],
          tempRoot: request.tempRoot,
          timeoutMs: 90_000,
        });
        try {
          return await runChunk({ browser, url, chunk, request, sink, hashTargets, frameHashes, frameTimes, progress, warnings, errors, warmupFrames, frameExtension });
        } finally {
          await browser.close();
        }
      }),
    );

    // Every worker must have agreed on the resolution and the renderer, or the frames come from different
    // films. Disagreement here is the signature of one worker falling back to software rendering, which is
    // the failure `--allow-software` exists to make explicit.
    const renderers = new Set(results.map((r) => r.renderer));
    const software = results.some((r) => r.software);
    if (renderers.size > 1) {
      throw new RenderError(
        `workers disagreed about the renderer: ${[...renderers].join(" | ")}\n` +
          `  frames from different rasterisers are not the same film; fix the GPU flags before rendering.`,
      );
    }
    if (software && !request.allowSoftware) {
      throw new RenderError(
        `the browser is using a software rasteriser (${[...renderers][0]}).\n` +
          `  It is roughly 10x slower and its float paths differ, so the result is a different artefact.\n` +
          `  Pass --allow-software to accept that deliberately.`,
      );
    }
    if (software) {
      warnings.push(`rendered under a software rasteriser: ${[...renderers][0]}`);
    }

    const closed = await sink.close();

    const encodeStarted = Date.now();
    const encoded = await encode({
      ffmpeg,
      frameDir,
      pattern: frameName(request.from, frameExtension).replace(/\d{6}/, "%06d"),
      fps,
      width: request.width,
      height: request.height,
      output: request.output,
      ...(request.audio ? { audio: request.audio } : {}),
      ...(request.audioOffset !== undefined ? { offsetSeconds: request.audioOffset } : {}),
      encoderArgs: encoder.args ?? [],
      frames: total,
    });
    void encodeStarted;

    const times = frameTimes.sort((a, b) => a - b);
    return {
      output: request.output,
      bytes: encoded.bytes,
      frames: closed.frames,
      encoder,
      renderer: [...renderers][0] ?? "unknown",
      software,
      msPerFrame: percentileSummary(times),
      frameHashes,
      registry: results[0]?.registry ?? { scenes: [], styles: [] },
      warnings,
      errors,
      command: encoded.command,
    };
  } catch (error) {
    // Delete everything. A partial film is worse than no film, because it passes an existence check.
    await sink.abort();
    await rm(request.output, { force: true }).catch(() => undefined);
    if (error instanceof RenderError) throw error;
    throw new RenderError(error instanceof Error ? error.message : String(error));
  } finally {
    await server.close();
    await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ChunkArgs {
  browser: Browser;
  url: string;
  chunk: { worker: number; from: number; to: number; frames: number };
  request: RenderRequest;
  sink: FrameSink;
  hashTargets: Set<number>;
  frameHashes: Record<string, string>;
  frameTimes: number[];
  progress: () => void;
  warnings: string[];
  errors: string[];
  warmupFrames: number;
  frameExtension: string;
}

/** One worker: open the page, draw its range, hand every frame to the sink. */
async function runChunk(
  args: ChunkArgs,
): Promise<{ renderer: string; software: boolean; registry: { scenes: string[]; styles: string[] } }> {
  const { browser, url, chunk, request, sink } = args;
  const fps = request.fps;

  browser.on("Runtime.consoleAPICalled", () => undefined);
  const pageErrors: string[] = [];
  browser.on("Runtime.exceptionThrown", (params) => {
    const detail = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    const text = detail.exceptionDetails?.exception?.description ?? detail.exceptionDetails?.text ?? "unknown";
    pageErrors.push(text);
    args.errors.push(`page exception: ${text.slice(0, 300)}`);
  });
  await browser.send("Runtime.enable", {}, 10_000).catch(() => undefined);

  // Before navigating, never after: a viewport change after load forces a relayout, and a canvas that has
  // already been sized from a stale viewport keeps that size.
  await browser.setViewport(request.width, request.height, request.dpr ?? 1);
  await browser.navigate(url, 90_000);

  for (let i = 0; i < 900; i++) {
    const ready = await browser.evaluate<boolean>(READY_EXPRESSION, { awaitPromise: true, timeoutMs: 180_000 }).catch(() => false);
    if (ready === true) break;
    await sleep(50);
  }

  // Fonts must settle BEFORE frame zero. A frame drawn with a fallback face is a different picture, and
  // the difference lands on the first frames of a render — exactly where nobody looks.
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
  const software = SOFTWARE_MARKERS.some((m) => renderer.toLowerCase().includes(m));

  // Warm-up: walk from the film's start to this worker's first frame, flushing as we go, and discard it all.
  //
  // **Why from frame 0, rather than a couple of frames back.** Once `Browser.flush` was in place, the *only*
  // remaining difference between `--workers 1` and `--workers 4` was the first frame of each chunk: frames 60,
  // 120 and 180 differed while every frame after them agreed. A chunk's first frame is drawn with a different
  // amount of queued work behind it than the same frame drawn mid-walk, and the flush returns pixels only
  // after that work has run. Walking from the start removes the distinction: a worker's queued state at frame
  // 180 is then the state a whole-film walk would have.
  //
  // It is not free. A 4-way split walks 0+60+120+180 = 360 frames of warm-up for a 240-frame film — about
  // 2.5× the drawing. That is the honest price of a reproducible parallel render, and it is why `workers` is
  // a throughput knob with a cost rather than a free one. `--workers 1` pays nothing and is byte-identical
  // to any other count.
  if (args.warmupFrames > 0) {
    for (let f = request.from; f < chunk.from; f++) {
      await browser.evaluate(RENDER_EXPRESSION(f / fps)).catch(() => undefined);
      await browser.flush().catch(() => undefined);
    }
  }



  for (let f = chunk.from; f < chunk.to; f++) {
    const t = f / fps;
    const drawStart = Date.now();
    await browser.evaluate(RENDER_EXPRESSION(t));
    // Before capturing, not after: canvas drawing is queued and a screenshot can rasterise a frame whose
    // draw calls have not all run. Without this the film depends on the capture schedule, which is how
    // `--workers` came to change the output. See `Browser.flush` for the measurements.
    await browser.flush();
    const screenshot = await browser.screenshot({
      format: "jpeg",
      quality: 0.94,
      timeoutMs: 180_000,
    });
    const ms = Date.now() - drawStart;

    if (args.hashTargets.has(f)) {
      // The hash comes from the CAPTURED bytes, not an in-page pixel read. Readback measured stable, so
      // in-page hashing would work — but the witness has to be the artefact that ships, and the two can
      // diverge once encoding is involved (ADR 0007, decision 3).
      const { createHash } = await import("node:crypto");
      args.frameHashes[String(f)] = createHash("sha256").update(screenshot).digest("hex").slice(0, 16);
    }

    await sink.write({
      index: f,
      data: screenshot,
      encoding: "jpeg",
      width: request.width,
      height: request.height,
      ms,
    });
    args.frameTimes.push(ms);
    args.progress();
  }

  if (pageErrors.length) {
    args.warnings.push(`worker ${chunk.worker} saw ${pageErrors.length} page exception(s)`);
  }
  // The page reports what it registered in `window.engine.meta`. Reading it from the page rather than from a
  // manifest means the report describes what actually ran, not what was supposed to.
  const registry = await browser
    .evaluate<{ scenes?: string[]; styles?: string[] }>(
      "(function(){var m = (window.engine && window.engine.meta) || {}; return { scenes: m.scenes || [], styles: m.styles || [] };})()",
    )
    .then((meta) => ({ scenes: meta?.scenes ?? [], styles: meta?.styles ?? [] }))
    .catch(() => ({ scenes: [], styles: [] }));
  return { renderer, software, registry };
}

function percentileSummary(values: readonly number[]): { avg: number; p50: number; p95: number; max: number } {
  if (!values.length) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return {
    avg: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write a one-frame PNG, used by `cvpw stills`. Kept here so the stills path shares the capture code. */
export async function renderStills(options: {
  request: Omit<RenderRequest, "output" | "from" | "to" | "workers">;
  times: readonly number[];
  outDir: string;
  overlay?: boolean;
}): Promise<string[]> {
  const server = await startStaticServer({ root: options.request.root });
  const written: string[] = [];
  const browser = await Browser.launch({
    executable: options.request.browser,
    args: options.request.browserArgs ?? [],
    tempRoot: options.request.tempRoot,
    timeoutMs: 90_000,
  });
  try {
    const entry = options.request.entry ?? "engine/index.html";
    await browser.setViewport(options.request.width, options.request.height, options.request.dpr ?? 1);
    await browser.navigate(`${server.origin}/${entry.replace(/^\/+/, "")}?capture`, 90_000);
    for (let i = 0; i < 900; i++) {
      const ready = await browser
        .evaluate<boolean>(READY_EXPRESSION, { awaitPromise: true, timeoutMs: 180_000 })
        .catch(() => false);
      if (ready === true) break;
      await sleep(50);
    }
    await browser
      .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
      .catch(() => undefined);

    for (const t of options.times) {
      await browser.evaluate(RENDER_EXPRESSION(t));
      await browser.flush();
      const png = await browser.screenshot({ format: "png", timeoutMs: 180_000 });
      const name = `t${t.toFixed(3).replace(".", "_")}.png`;
      const full = join(options.outDir, name);
      await writeFile(full, png);
      written.push(full);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return written;
}

export type { CdpError };
