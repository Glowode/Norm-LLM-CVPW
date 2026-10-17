/**
 * `cvpw stills` and `cvpw render` — the two commands that produce pictures.
 *
 * The distinction that matters: **stills are for looking at, a render is for shipping.** Stills are cheap,
 * unencoded, and carry the debug overlay so a defect can be traced to a shot id. A render is expensive and
 * carries nothing but the film. Conflating them produces either a master with a timecode burned into it or
 * a review pass that costs twenty minutes.
 *
 * Both share the same capture path — the same page, the same `renderFrame(t)`, the same server — which is
 * the property that makes "the render matches the preview" a fact rather than a hope.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { Timebase } from "@cvpw/kernel";
import { render, renderStills, probeOutput, type RenderOutcome } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import {
  ContractError,
  UsageError,
  projectPaths,
  readJson,
  resolveTool,
  sha256,
  type Envelope,
} from "../shared.js";

export interface CaptureContext {
  root: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  renderer: string;
  workers: number;
  dpr: number;
  samples: number;
  noGrain: boolean;
  allowSoftware: boolean;
  audio: string | undefined;
  audioOffset: number;
  tempRoot: string;
  entry: string;
}

/**
 * Assemble everything a capture needs from the project's artifacts.
 *
 * Fails loudly and specifically on a missing prerequisite rather than falling back to a default, because
 * every default here would silently render a different film: the wrong frame rate changes the duration,
 * the wrong canvas size changes every composition, and a missing browser means nothing renders at all.
 */
export async function prepareCapture(root: string, overrides: Partial<CaptureContext> = {}): Promise<CaptureContext> {
  const paths = projectPaths(root);
  if (!existsSync(paths.projectJson)) {
    throw new ContractError(`no project.json in ${root}; run this inside a project, or pass --project <dir>`);
  }
  const project = (await readJson(paths.projectJson)) as {
    output?: { width?: number; height?: number; fps?: number };
    render?: { workers?: number; frameQuality?: number; allowSoftware?: boolean };
    audio?: { file?: string; offset?: number };
  };

  const width = overrides.width ?? project.output?.width ?? 1920;
  const height = overrides.height ?? project.output?.height ?? 1080;
  const fps = overrides.fps ?? project.output?.fps ?? 30;

  if (width % 2 !== 0 || height % 2 !== 0) {
    // yuv420p needs even dimensions, and ffmpeg's complaint about chroma subsampling does not mention the
    // canvas. Catching it here means the operator reads a sentence about their own project.json.
    throw new ContractError(
      `output dimensions must be even: got ${width}x${height}. ` +
        `yuv420p requires it, and an odd dimension fails inside ffmpeg with a message that does not mention the canvas.`,
    );
  }

  // Duration comes from the analysis when there is one, because that is the authority on when the music
  // ends. Without it, the timeline's own duration is the only honest answer.
  let duration = overrides.duration ?? 0;
  if (!duration && existsSync(paths.analysisAudio)) {
    const audio = (await readJson(paths.analysisAudio)) as { duration?: number };
    duration = audio.duration ?? 0;
  }
  if (!duration && existsSync(paths.timeline)) {
    const timeline = (await readJson(paths.timeline)) as { duration?: number };
    duration = timeline.duration ?? 0;
  }
  if (!duration) {
    throw new ContractError(
      `cannot determine the film's duration: no analysis/audio.json and no timeline.json with a duration.\n` +
        `  run \`cvpw analyze\` for a measured duration, or write one into timeline.json`,
    );
  }

  const browser = detectBrowser();
  if (!browser) {
    throw new ContractError(
      "no chromium-family browser found: nothing can be rendered.\n" +
        "  install Chrome or Edge, or set CVPW_BROWSER to an executable path",
    );
  }

  const audioFile = project.audio?.file ? join(root, project.audio.file) : undefined;

  return {
    root,
    width,
    height,
    fps,
    duration,
    renderer: browser.path,
    workers: overrides.workers ?? project.render?.workers ?? 2,
    dpr: overrides.dpr ?? 1,
    samples: overrides.samples ?? 1,
    noGrain: overrides.noGrain ?? false,
    allowSoftware: overrides.allowSoftware ?? project.render?.allowSoftware ?? false,
    audio: overrides.audio ?? (audioFile && existsSync(audioFile) ? audioFile : undefined),
    audioOffset: overrides.audioOffset ?? project.audio?.offset ?? 0,
    tempRoot: overrides.tempRoot ?? join(root, "render", ".scratch"),
    entry: overrides.entry ?? "engine/index.html",
  };
}

/** Resolve `--times`, accepting seconds or a time expression. Shared so stills and review agree. */
export async function resolveTimes(root: string, raw: readonly string[]): Promise<Array<{ label: string; t: number }>> {
  const paths = projectPaths(root);
  const cuesDoc = existsSync(paths.cues) ? ((await readJson(paths.cues)) as { cues?: Array<{ id: string; t: number }> }) : null;
  const audio = existsSync(paths.analysisAudio) ? ((await readJson(paths.analysisAudio)) as Record<string, unknown>) : null;
  const timeline = existsSync(paths.timeline) ? ((await readJson(paths.timeline)) as { duration?: number }) : null;

  const timebase = new Timebase({
    duration: (audio?.["duration"] as number) ?? timeline?.duration ?? 8,
    fps: (audio?.["fps"] as number) ?? 30,
    beats: (audio?.["beats"] as number[]) ?? [],
    beatsSmooth: (audio?.["beatsSmooth"] as number[]) ?? [],
    bars: (audio?.["bars"] as never[]) ?? [],
    sections: (audio?.["sections"] as never[]) ?? [],
    onsets: (audio?.["onsets"] as never[]) ?? [],
    impacts: (audio?.["impacts"] as never[]) ?? [],
    stops: (audio?.["stops"] as never[]) ?? [],
    cues: cuesDoc?.cues ?? [],
  });

  return raw.map((item) => {
    const text = item.trim();
    if (text === "") throw new UsageError("--times contains an empty entry");
    // A bare number is seconds; anything else is a time expression, resolved against the same timebase the
    // timeline uses. That means `--times 'cue(chorus)'` works, which is how a reviewer asks for the frame
    // that matters rather than the frame they guessed.
    if (/^[0-9]*\.?[0-9]+$/.test(text)) return { label: `${text}s`, t: Number(text) };
    return { label: text, t: timebase.resolve(text).t };
  });
}

export interface StillsOptions {
  root: string;
  times: Array<{ label: string; t: number }>;
  outDir?: string;
  overlay?: boolean;
}

export async function runStills(options: StillsOptions): Promise<{ files: string[]; manifestPath: string }> {
  const context = await prepareCapture(options.root);
  const outDir = options.outDir ?? join(options.root, "review", "stills");
  await mkdir(outDir, { recursive: true });

  const files = await renderStills({
    request: {
      root: context.root,
      entry: context.entry,
      browser: context.renderer,
      browserArgs: renderArgs(),
      width: context.width,
      height: context.height,
      fps: context.fps,
      duration: context.duration,
      dpr: context.dpr,
      samples: context.samples,
      noGrain: context.noGrain,
      tempRoot: context.tempRoot,
    },
    times: options.times.map((entry) => entry.t),
    outDir,
    ...(options.overlay ? { overlay: true } : {}),
  });

  // A manifest, not just files. `docs/SPEC.md` V3 makes a review without a manifest not a review, and the
  // reason is practical: an agent looking at a PNG cannot tell which shot produced it, so the mapping has
  // to be written down or the wrong file gets edited.
  const manifestPath = join(outDir, "manifest.json");
  const shots = existsSync(projectPaths(options.root).timeline)
    ? ((await readJson(projectPaths(options.root).timeline)) as { shots?: Array<{ id: string; at: string; scene: string; moment?: string }> }).shots ?? []
    : [];
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        note: "Written by `cvpw stills`. Every entry names the time and the shots active at it, so a defect visible in a PNG can be traced to a shot id without guessing.",
        overlay: options.overlay === true,
        width: context.width,
        height: context.height,
        frames: options.times.map((entry, index) => ({
          file: files[index] ? relative(options.root, files[index]).replace(/\\/g, "/") : null,
          label: entry.label,
          t: entry.t,
          frame: Math.round(entry.t * context.fps),
          shots: activeShotIds(shots, entry.t),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { files, manifestPath };
}

/**
 * Which shots are on screen at `t`, from the DERIVED timeline.
 *
 * The first version parsed `Number(shot.at)` and fell back to the first shot. That is wrong for every project
 * that uses a time expression — which is every project, because hand-typed times are what this framework
 * exists to eliminate — so a sheet labelled `4.5s` as `s01_open` when it was actually the grid. A review
 * artifact that names the wrong shot sends the fix to the wrong file, which is worse than naming none.
 *
 * `timeline.json` carries `resolved.t0/t1` precisely so this can be answered exactly, so read it.
 */
function activeShotIds(
  shots: Array<{ id: string; at: string; resolved?: { t0?: number; t1?: number } }>,
  t: number,
): string[] {
  return shots
    .filter((shot) => {
      const t0 = shot.resolved?.t0;
      const t1 = shot.resolved?.t1;
      return typeof t0 === "number" && typeof t1 === "number" && t >= t0 && t < t1;
    })
    .map((shot) => shot.id);
}

export interface RenderCommandOptions {
  root: string;
  name?: string;
  workers?: number;
  from?: number;
  to?: number;
  preview?: boolean;
  allowSoftware?: boolean;
  quality?: number;
  onProgress?: (line: string) => void;
}

export async function runRender(options: RenderCommandOptions): Promise<RenderOutcome & { reportPath: string }> {
  const preview = options.preview === true;
  const context = await prepareCapture(options.root, {
    // A preview renders at half resolution. It MUST be named as one and MUST NOT be delivered as a master,
    // which is why the filename says `_preview` rather than relying on anyone remembering.
    ...(preview ? { width: Math.round(1080 / 2 / 2) * 2, height: Math.round(1920 / 2 / 2) * 2 } : {}),
    ...(options.workers !== undefined ? { workers: options.workers } : {}),
    ...(options.allowSoftware !== undefined ? { allowSoftware: options.allowSoftware } : {}),
  });

  const width = preview ? 960 : context.width;
  const height = preview ? 540 : context.height;
  const from = options.from ?? 0;
  const to = options.to ?? Math.round(context.duration * context.fps);
  const name = options.name ?? (preview ? "preview" : "master");
  const output = join(options.root, "render", `${name}.mp4`);

  await mkdir(join(options.root, "render"), { recursive: true });

  const ffmpeg = resolveTool("ffmpeg");
  const ffprobe = resolveTool("ffprobe");
  if (!ffmpeg.path) throw new ContractError("ffmpeg was not found on PATH; set CVPW_FFMPEG to its full path");
  if (!ffprobe.path) throw new ContractError("ffprobe was not found on PATH; set CVPW_FFPROBE to its full path");

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const outcome = await render({
    root: context.root,
    entry: context.entry,
    browser: context.renderer,
    browserArgs: renderArgs(),
    ffmpeg: ffmpeg.path,
    ffprobe: ffprobe.path,
    width,
    height,
    fps: context.fps,
    from,
    to,
    dpr: context.dpr,
    workers: context.workers,
    samples: context.samples,
    // Grain is a determinism hazard for hashing and a visual one for seams, so a report always records
    // whether it was on. A render keeps it; a comparison never does.
    noGrain: context.noGrain,
    warmupFrames: 2,
    output,
    ...(context.audio ? { audio: context.audio } : {}),
    audioOffset: context.audioOffset,
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    tempRoot: context.tempRoot,
    allowSoftware: context.allowSoftware,
    ...(options.onProgress
      ? {
          onProgress: (progress) =>
            options.onProgress?.(
              `  ${progress.committed}/${progress.total} frames` +
                (progress.etaMs !== null ? `  eta ${Math.round(progress.etaMs / 1000)}s` : "") +
                (progress.sink.backPressureEvents ? `  (back-pressure ${progress.sink.backPressureEvents}x)` : ""),
            ),
        }
      : {}),
  });

  // The report is the artifact a verifier reads. It records the encoder that was ACTUALLY used and the
  // probe's evidence, because "the encoder is available" and "the encoder worked" are different claims and
  // only the second one is useful.
  const probed = await probeOutput(ffprobe.path, output);
  const reportPath = join(options.root, "render", "report.json");
  const fileBytes = await readFile(output);
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        $schema: "schemas/render-report.schema.json",
        schemaVersion: 1,
        run: {
          startedAt,
          durationSec: (Date.now() - started) / 1000,
          workers: context.workers,
          transport: "filesystem",
          cvpwVersion: "0.1.0",
          // Verified by ffprobe. `frames` above is what the sink wrote; this is what the FILE contains, and
          // the two disagreeing is exactly the failure the `render.frameCount` gate exists to catch.
          verified: { frames: probed.frames, durationSec: probed.duration },
        },
        name,
        output: relative(options.root, output).replace(/\\/g, "/"),
        codec: outcome.encoder.name,
        codecRequested: "auto",
        codecProbe: outcome.encoder.evidence,
        width,
        height,
        fps: context.fps,
        frames: outcome.frames,
        range: { from, to },
        msPerFrame: outcome.msPerFrame,
        renderer: outcome.renderer,
        software: outcome.software,
        resolvedTimes: {},
        frameHashes: outcome.frameHashes,
        registry: {},
        warnings: outcome.warnings,
        errors: outcome.errors,
        sha256: sha256(fileBytes),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { ...outcome, reportPath };
}

export function renderEnvelope(outcome: RenderOutcome & { reportPath: string }, root: string, command: string): Envelope {
  return {
    ok: outcome.errors.length === 0,
    command,
    schemaVersion: 1,
    project: root,
    artifactsWritten: [outcome.output, outcome.reportPath],
    result: {
      output: outcome.output,
      frames: outcome.frames,
      bytes: outcome.bytes,
      encoder: { name: outcome.encoder.name, probed: outcome.encoder.evidence },
      renderer: outcome.renderer,
      software: outcome.software,
      msPerFrame: outcome.msPerFrame,
      frameHashes: outcome.frameHashes,
    },
    warnings: outcome.warnings.map((message) => ({ code: "render", message })),
    errors: outcome.errors.map((message) => ({ code: "render", message })),
    summary: [
      `wrote ${outcome.output}`,
      `  ${outcome.frames} frames, ${(outcome.bytes / 1024 / 1024).toFixed(1)} MiB, encoder ${outcome.encoder.name}`,
      `  ${outcome.msPerFrame.avg.toFixed(1)} ms/frame average, ${outcome.msPerFrame.p95.toFixed(1)} ms p95`,
      `  renderer ${outcome.renderer}${outcome.software ? "   [SOFTWARE]" : ""}`,
    ],
  };
}
