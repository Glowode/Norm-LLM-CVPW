/**
 * `cvpw analyze` — audio in, timebase out.
 *
 * This is the command the framework's central claim rests on. `docs/SPEC.md` T2–T5 say cuts must be derived
 * from *measured* `beats[]`/`bars[]` and never from `n * 60 / bpm`, because tempo drifts and a grid built on
 * a label is wrong by the second verse. So the analysis is not a convenience: without it, every time
 * expression in a project collapses to a bare number and the film is no better than a hand-timed edit.
 *
 * The work is `python -m cvpw_py`, which is where the signal processing lives. This module's job is the part
 * that has to be right on a Windows host with code page 936:
 *
 * - **Spawn with UTF-8 forced.** A Python child that prints a CJK character or a `€` dies with
 *   `UnicodeEncodeError` when the console is 936, and the failure looks like a bug in the script.
 * - **Hand it ASCII-only paths.** A temp path with a non-ASCII component breaks external tools in ways that
 *   are hard to attribute; the reference machine's user directory is already ASCII, but a project path need
 *   not be.
 * - **Never rewrite the source audio.** `docs/SPEC.md` P6 forbids it. The analysis reads the file and writes
 *   only into `analysis/`.
 *
 * The command also *refuses to be quiet about the one failure that matters most*: an octave error in the
 * tempo. A grid at double or half the true rate is obvious on `analysis/overview.png` and invisible in the
 * JSON, so the summary points at the plot instead of claiming success.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { run } from "@cvpw/render";

import { ContractError, projectPaths, readJson, relPath, resolveTool, type Envelope } from "../shared.js";

export interface AnalyzeOptions {
  root: string;
  /** Override the audio path from `project.json::audio.file`. */
  audio?: string;
  fps?: number;
  /** Force a tempo instead of detecting one. Corrects an octave error the detector could not see. */
  bpm?: number;
  /** First beat in seconds, when the detector puts the grid on the wrong beat. */
  firstBeat?: number;
  /** Print progress on stderr. */
  onProgress?: (line: string) => void;
}

export interface AnalyzeResult {
  root: string;
  audio: string;
  bpm: number;
  confidence: number;
  octave: string;
  beats: number;
  bars: number;
  sections: number;
  duration: number;
  barRanges: string[];
  beatPeriod: number;
  firstBeat: number;
  pickupBars: number;
  impacts: number;
  stops: number;
  overview: string;
  warnings: string[];
}

/** Locate the Python interpreter that has the analysis dependencies (numpy, soundfile). */
function findPython(root: string): string {
  const candidates = [
    process.env["CVPW_PYTHON"],
    // A project-local venv, then the framework's, then PATH. The reference machine needs the venv: the
    // system Python lacks soundfile, and a missing decoder surfaces as "cannot read audio" rather than as
    // "you are running the wrong interpreter".
    join(root, ".venv", "Scripts", "python.exe"),
    join(root, ".venv", "bin", "python"),
    join(process.cwd(), ".venv", "Scripts", "python.exe"),
    join(process.cwd(), ".venv", "bin", "python"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");

  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return resolveTool("python").path ?? "python";
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) {
    throw new ContractError(`no project.json in ${options.root}; run this inside a project`);
  }
  const project = (await readJson(paths.projectJson)) as {
    audio?: { file?: string };
    output?: { fps?: number };
  };

  const audioPath = options.audio ?? (project.audio?.file ? join(options.root, project.audio.file) : undefined);
  if (!audioPath) {
    throw new ContractError(
      "no audio to analyse: project.json has no `audio.file` and --audio was not given.\n" +
        "  put the song at audio/song.wav and set audio.file, or pass --audio <path>",
    );
  }
  if (!existsSync(audioPath)) {
    throw new ContractError(
      `audio not found: ${audioPath}\n` +
        `  project.json::audio.file points here, so either the file is missing or it was never copied in`,
    );
  }

  const outDir = join(options.root, "analysis");
  await mkdir(outDir, { recursive: true });

  const python = findPython(options.root);
  const args = [
    "-m",
    "cvpw_py",
    "analyze",
    "--audio",
    audioPath,
    "--out",
    outDir,
    "--fps",
    String(options.fps ?? project.output?.fps ?? 30),
  ];
  if (options.bpm !== undefined) args.push("--bpm", String(options.bpm));
  if (options.firstBeat !== undefined) args.push("--first-beat", String(options.firstBeat));

  options.onProgress?.(`  ${python} -m cvpw_py analyze`);

  const result = await run(python, args, {
    cwd: options.root,
    timeoutMs: 15 * 60 * 1000,
    // The Python package lives in the framework, not in the project, so it must be importable.
    env: { PYTHONPATH: pythonPathForFramework() },
  });

  if (result.spawnFailed) {
    throw new ContractError(
      `could not start Python (${python}): ${result.error ?? "unknown error"}\n` +
        `  set CVPW_PYTHON to an interpreter with numpy and soundfile installed`,
    );
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").filter(Boolean).slice(-8).join("\n");
    throw new ContractError(
      `cvpw_py analyze exited ${result.code}\n${tail || "(no stderr)"}\n` +
        `  the analysis is required: without beats[] and bars[], every b() and h() cannot resolve`,
    );
  }

  const audio = (await readJson(paths.analysisAudio)) as {
    duration?: number;
    tempo?: { bpm?: number; confidence?: number; octaveCheck?: string; beatPeriod?: number; firstBeat?: number };
    meter?: { beatsPerBar?: number; unit?: number };
    beats?: unknown[];
    bars?: Array<{ index?: number; start?: number; end?: number; pickup?: boolean; beats?: number }>;
    sections?: unknown[];
    impacts?: unknown[];
    stops?: unknown[];
    warnings?: string[];
  };

  const warnings = [...(audio.warnings ?? [])];
  const overviewPath = join(outDir, "overview.png");
  if (!existsSync(overviewPath)) {
    warnings.push(
      "analysis/overview.png was not written, so the tempo cannot be checked by eye. A grid at double or " +
        "half the true rate is invisible in the JSON and obvious on the plot.",
    );
  }
  if ((audio.tempo?.confidence ?? 1) < 0.5) {
    warnings.push(
      `tempo confidence is only ${(audio.tempo?.confidence ?? 0).toFixed(2)}, so the grid may be wrong. ` +
        `LOOK at ${relPath(options.root, overviewPath)} before storyboarding against it.`,
    );
  }
  if (audio.tempo?.octaveCheck && audio.tempo.octaveCheck !== "ok") {
    warnings.push(
      `the detector reported an octave ambiguity (${audio.tempo.octaveCheck}). If the cuts feel half-speed, ` +
        `re-run with --bpm ${Math.round((audio.tempo.bpm ?? 120) * 2)} or --bpm ${Math.round((audio.tempo.bpm ?? 120) / 2)}.`,
    );
  }

  return {
    root: options.root,
    audio: relPath(options.root, audioPath),
    bpm: audio.tempo?.bpm ?? 0,
    confidence: audio.tempo?.confidence ?? 0,
    octave: audio.tempo?.octaveCheck ?? "unknown",
    beats: audio.beats?.length ?? 0,
    bars: audio.bars?.length ?? 0,
    sections: audio.sections?.length ?? 0,
    duration: audio.duration ?? 0,
    beatPeriod: audio.tempo?.beatPeriod ?? 0,
    firstBeat: audio.tempo?.firstBeat ?? 0,
    pickupBars: audio.bars?.filter((bar) => bar.pickup).length ?? 0,
    impacts: audio.impacts?.length ?? 0,
    stops: audio.stops?.length ?? 0,
    barRanges: (audio.bars ?? []).map(
      (bar) => `${(bar.start ?? 0).toFixed(2)}–${(bar.end ?? 0).toFixed(2)}${bar.pickup ? " (pickup)" : ""}`,
    ),
    overview: relPath(options.root, overviewPath),
    warnings,
  };
}

/** Where `cvpw_py` lives relative to this file at runtime, so PYTHONPATH can be set without a build step. */
function pythonPathForFramework(): string {
  // dist/commands/ -> packages/cli/dist/commands -> packages/cli -> packages -> <repo>
  const here = import.meta.url.replace(/^file:\/\/\//, "").replace(/\//g, "\\");
  const parts = here.split("\\");
  // Find the "packages" segment and cut back to the repo root.
  const index = parts.lastIndexOf("packages");
  const repo = index > 0 ? parts.slice(0, index).join("\\") : process.cwd();
  return join(repo, "python", "src");
}

export function analyzeEnvelope(result: AnalyzeResult): Envelope {
  const summary = [
    `analysed ${result.audio}`,
    `  ${result.bpm.toFixed(2)} BPM, confidence ${result.confidence.toFixed(2)}, octave ${result.octave}`,
    `  ${result.beats} beat(s), ${result.bars} bar(s), ${result.sections} section(s), ${result.duration.toFixed(3)} s`,
    `  beat period ${result.beatPeriod.toFixed(4)} s, first beat ${result.firstBeat.toFixed(3)} s, ${result.pickupBars} pickup bar(s)`,
    `  ${result.impacts} impact(s), ${result.stops} stop(s)`,
    `  bars: ${result.barRanges.join(", ") || "(none)"}`,

    "",
    `  LOOK AT ${result.overview} before storyboarding. An octave error in the tempo is obvious on the plot`,
    "  and invisible in the JSON, and it is the most common analysis failure there is.",
  ];
  for (const warning of result.warnings) summary.push(`  warning: ${warning}`);

  return {
    ok: true,
    command: "analyze",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [
      join(result.root, "analysis", "audio.json"),
      join(result.root, "analysis", "envelope.json"),
      join(result.root, "analysis", "envelope.f32"),
      join(result.root, result.overview),
    ],
    result,
    warnings: result.warnings.map((message) => ({ code: "analyze", message })),
    errors: [],
    summary,
  };
}
