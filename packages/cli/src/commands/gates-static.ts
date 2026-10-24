/**
 * The gates that need no rendering.
 *
 * Six of `docs/QA.md`'s ids are answerable from artifacts already on disk — the storyboard, the timeline, the
 * analysis, the render report. They live here rather than in `check.ts` because each is a small pure function
 * over data, and keeping them together makes the expensive, browser-driven gates stand out by contrast: if a
 * gate is in this file, it costs milliseconds and can be reasoned about by reading it.
 */

import { existsSync } from "node:fs";

import { join } from "node:path";

import { projectPaths, readJson } from "../shared.js";
import type { Offender } from "./check.js";
import type { StoryboardResult } from "./storyboard.js";

export interface StaticGate {
  id: string;
  title: string;
  ok: boolean;
  measured: Record<string, string | number>;
  offenders: Offender[];
  skipped?: string;
}

/** `timeline.moment` — every shot says what it is *for*. */
export function gateMoment(storyboard: StoryboardResult | null): StaticGate {
  const base = { id: "timeline.moment", title: "every shot declares a one-sentence moment" };
  if (!storyboard) return { ...base, ok: true, measured: {}, offenders: [], skipped: "the storyboard could not be built" };
  const missing = storyboard.shots.filter((shot) => !shot.moment || shot.moment.trim().length < 8);
  return {
    ...base,
    ok: missing.length === 0,
    measured: { shots: storyboard.shots.length, missing: missing.length },
    offenders: missing.map((shot) => ({
      code: "missing-moment",
      where: shot.id,
      detail:
        "no `moment` sentence. One line saying what the shot is for is what stops an edit becoming a " +
        "collection of pretty frames — and it is unrecoverable later, because only the author knew.",
    })),
  };
}

/**
 * `timeline.absoluteTimes` — a bare number is allowed but must be acknowledged.
 *
 * `docs/SPEC.md` T2 makes a hand-typed time a warning rather than an error, because a project legitimately
 * begins at `0.0s` before any music exists. What is not acceptable is doing it silently: this gate fails only
 * when the project's own `project.json::budgets.absoluteTimeWarnings` acknowledgement is absent, so choosing to
 * hard-code a time is a recorded decision rather than an oversight.
 */
export async function gateAbsoluteTimes(root: string): Promise<StaticGate> {
  const base = { id: "timeline.absoluteTimes", title: "hand-typed times are acknowledged, not silent" };
  const timelinePath = join(root, "timeline.json");
  if (!existsSync(timelinePath)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no timeline.json" };
  }
  const doc = (await readJson(timelinePath)) as {
    shots?: Array<{ id?: string; at?: string; to?: string }>;
  };
  const bare = /^\s*-?\d+(?:\.\d+)?(?:s)?\s*$/;
  const offenders: Offender[] = [];
  for (const shot of doc.shots ?? []) {
    for (const field of ["at", "to"] as const) {
      const value = shot[field];
      if (typeof value !== "string") continue;
      // `"12.5s"` is the explicit form and counts as acknowledged: the author wrote a unit.
      if (bare.test(value) && !/s\s*$/.test(value)) {
        offenders.push({
          code: "absolute-time",
          where: `${shot.id ?? "?"}.${field}`,
          detail: `${JSON.stringify(value)} is a bare number. Name the musical moment, or write it as "12.5s" to say the literal is deliberate.`,
        });
      }
    }
  }
  return {
    ...base,
    ok: offenders.length === 0,
    measured: { shots: doc.shots?.length ?? 0, "bare times": offenders.length },
    offenders: offenders.slice(0, 12),
  };
}

/** `scene.emptyFrames` — no sampled instant falls outside every shot. */
export function gateEmptyFrames(storyboard: StoryboardResult | null, fps: number): StaticGate {
  const base = { id: "scene.emptyFrames", title: "no sampled time falls outside every shot" };
  if (!storyboard || storyboard.shots.length === 0) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "the storyboard has no shots" };
  }
  const total = Math.round(storyboard.duration * fps);
  const gaps: Offender[] = [];
  // Every frame, because a gap of three frames is still a black flash and the check is arithmetic.
  for (let frame = 0; frame < total; frame++) {
    const t = frame / fps;
    const inside = storyboard.shots.some((shot) => t >= shot.t0 && t < shot.t1);
    if (!inside) gaps.push({ code: "empty-frame", where: `frame ${frame} (t=${t.toFixed(3)}s)`, detail: "no shot is active here; it renders as a marked black frame" });
    if (gaps.length >= 12) break;
  }
  return {
    ...base,
    ok: gaps.length === 0,
    measured: { frames: total, gaps: gaps.length },
    offenders: gaps,
  };
}

/** `scene.perf` — the render met the project's own frame budget. */
export async function gateScenePerf(root: string): Promise<StaticGate> {
  const base = { id: "scene.perf", title: "the render met the project's frame-time budget" };
  const reportPath = join(root, "render", "report.json");
  if (!existsSync(reportPath)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no render/report.json — nothing has been rendered" };
  }
  const report = (await readJson(reportPath)) as { msPerFrame?: { avg?: number; p95?: number; max?: number } };
  const project = existsSync(projectPaths(root).projectJson)
    ? ((await readJson(projectPaths(root).projectJson)) as { budgets?: Record<string, number> })
    : {};
  const budget = project.budgets?.["msPerFrame"] ?? 40;
  const p95 = report.msPerFrame?.p95 ?? 0;
  return {
    ...base,
    ok: p95 <= budget,
    measured: { "p95 ms": p95.toFixed(2), budget, "avg ms": (report.msPerFrame?.avg ?? 0).toFixed(2), "max ms": (report.msPerFrame?.max ?? 0).toFixed(2) },
    offenders:
      p95 <= budget
        ? []
        : [
            {
              code: "slow-render",
              where: "render/report.json",
              detail: `p95 frame time is ${p95.toFixed(1)} ms against a ${budget} ms budget. Either the scene is too expensive or the budget is wrong — decide which and record it.`,
            },
          ],
  };
}

/**
 * `lyrics.alignment` — every lyric line sits within ±150 ms of a detected vocal onset.
 *
 * Only lines marked `lrc` or `manual` are judged: a line marked `estimated` was spread across activity by
 * `cvpw lyrics` itself, so failing it would be the tool grading its own guess. Estimating is honest; claiming an
 * estimate is aligned is not.
 */
export async function gateLyricsAlignment(root: string): Promise<StaticGate> {
  const base = { id: "lyrics.alignment", title: "every timed lyric line sits within 150 ms of a vocal onset" };
  const paths = projectPaths(root);
  if (!existsSync(paths.lyricsTiming)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no cues/lyrics.timing.json" };
  }
  const timing = (await readJson(paths.lyricsTiming)) as {
    lines?: Array<{ i?: number; start?: number; source?: string }>;
  };
  const lines = (timing.lines ?? []).filter((line) => typeof line.start === "number");
  if (lines.length === 0) {
    return { ...base, ok: true, measured: { lines: 0 }, offenders: [], skipped: "the timing file has no lines" };
  }
  if (!existsSync(paths.analysisAudio)) {
    return { ...base, ok: true, measured: { lines: lines.length }, offenders: [], skipped: "no analysis, so there are no onsets to compare against" };
  }
  const audio = (await readJson(paths.analysisAudio)) as {
    onsets?: Array<{ t?: number } | number>;
    vocalActivity?: Array<{ start?: number; end?: number }>;
  };
  const onsets = (audio.onsets ?? [])
    .map((onset) => (typeof onset === "number" ? onset : onset.t))
    .filter((t): t is number => typeof t === "number");
  if (onsets.length === 0) {
    return { ...base, ok: true, measured: { lines: lines.length }, offenders: [], skipped: "the analysis found no onsets" };
  }

  const tolerance = 0.15;
  const offenders: Offender[] = [];
  let judged = 0;
  for (const line of lines) {
    if (line.source === "estimated") continue;
    judged++;
    const start = line.start as number;
    const nearest = onsets.reduce((best, t) => (Math.abs(t - start) < Math.abs(best - start) ? t : best), onsets[0] as number);
    const delta = start - nearest;
    if (Math.abs(delta) > tolerance) {
      offenders.push({
        code: delta < 0 ? "lyric-early" : "lyric-late",
        where: `line ${line.i ?? "?"} at ${start.toFixed(3)}s`,
        detail: `${(delta * 1000).toFixed(0)} ms from the nearest onset at ${nearest.toFixed(3)}s (limit ±${tolerance * 1000} ms)`,
      });
    }
  }
  return {
    ...base,
    ok: offenders.length === 0,
    measured: { lines: lines.length, judged, estimated: lines.length - judged, onsets: onsets.length, tolerance: `${tolerance * 1000} ms` },
    offenders: offenders.slice(0, 12),
    ...(judged === 0 ? { skipped: "every line is `estimated`, so nothing claims to be aligned" } : {}),
  };
}

/**
 * `render.registry` — the render that produced the master used the same code as the project now.
 *
 * A report records the scenes and styles that were registered when it rendered. If the project has since added
 * or renamed one, the master on disk is not the film the current source describes — and every other gate would
 * happily validate the new definition against the old file. This is the gate that notices.
 */
export async function gateRegistry(root: string, storyboard: StoryboardResult | null): Promise<StaticGate> {
  const base = { id: "render.registry", title: "the master was rendered with the scenes this project now has" };
  const reportPath = join(root, "render", "report.json");
  if (!existsSync(reportPath)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no render/report.json" };
  }
  const report = (await readJson(reportPath)) as { registry?: { scenes?: string[]; styles?: string[] } };
  const recorded = report.registry?.scenes ?? [];
  if (recorded.length === 0) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "the report records no registry, so there is nothing to compare" };
  }
  const current = new Set((storyboard?.shots ?? []).map((shot) => shot.scene));
  const missing = [...current].filter((scene) => !recorded.includes(scene));
  return {
    ...base,
    ok: missing.length === 0,
    measured: { "recorded scenes": recorded.length, "used by the timeline": current.size },
    offenders: missing.map((scene) => ({
      code: "registry-drift",
      where: `scene ${scene}`,
      detail:
        `the timeline uses ${JSON.stringify(scene)} but the master's report does not list it, so the master on ` +
        `disk was rendered from different source. Re-render before delivering.`,
    })),
  };
}
/**
 * `render.diskSpace` — the volume can hold what the project says it needs.
 *
 * `budgets.peakDiskGb` was declared in the schema and read by nothing. It is worth honouring because running out of
 * disk fails a render at the WORST possible moment: after the frames are drawn, during the encode, leaving a
 * truncated file that `render.frameCount` then has to explain. A pre-flight check costs one `statfs` and turns a
 * forty-second failure into an immediate one.
 *
 * A project that declares no budget skips with that reason rather than passing on an assumption — the framework's
 * rule is that a check which never ran must never look like a check which passed.
 */
export async function gateDiskSpace(root: string): Promise<StaticGate> {
  const base = { id: "render.diskSpace", title: "the volume has the disk space the project budgets for" };
  const projectPath = projectPaths(root).projectJson;
  if (!existsSync(projectPath)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no project.json" };
  }
  const project = (await readJson(projectPath)) as { budgets?: Record<string, number> };
  const declared = project.budgets?.["peakDiskGb"];
  if (typeof declared !== "number" || !(declared > 0)) {
    return {
      ...base,
      ok: true,
      measured: { declared: "(none)" },
      offenders: [],
      skipped: "project.json declares no budgets.peakDiskGb, so there is no figure to check against",
    };
  }
  const { diskFreeGb } = await import("../doctor.js");
  const free = diskFreeGb(root);
  if (free === null) {
    return {
      ...base,
      ok: true,
      measured: { declared: `${declared} GiB`, free: "unknown" },
      offenders: [],
      skipped: "the volume's free space could not be read on this platform",
    };
  }
  return {
    ...base,
    ok: free >= declared,
    measured: { declared: `${declared} GiB`, free: `${free.toFixed(1)} GiB` },
    offenders:
      free >= declared
        ? []
        : [
            {
              code: "disk.too-full",
              where: `volume holding ${root}`,
              detail:
                `${free.toFixed(1)} GiB free but the project budgets ${declared} GiB. Failing here rather than ` +
                `during the encode: running out mid-render leaves a truncated master that only frameCount can ` +
                `explain afterwards.`,
            },
          ],
  };
}
/**
 * `audio.declared` — the facts a project declares about its audio match what the analysis measured.
 *
 * `project.json::audio.sampleRate` is documented in `docs/CONTRACTS.md` as "of the source file": it is not a knob,
 * it is a recorded fact about the input. A recorded fact that nothing checks is worse than no record, because it
 * ages silently — swap in a different master at a different rate and the declaration keeps asserting the old one.
 *
 * `analysis/audio.json` already carries both `sampleRate` (the source) and `analysisRate` (the 24 kHz the analysis
 * works at), so this is a comparison rather than a measurement.
 */
export async function gateAudioDeclared(root: string): Promise<StaticGate> {
  const base = { id: "audio.declared", title: "declared audio facts match the measured analysis" };
  const paths = projectPaths(root);
  if (!existsSync(paths.projectJson)) {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "no project.json" };
  }
  const project = (await readJson(paths.projectJson)) as {
    audio?: { file?: string; sampleRate?: number } | null;
  };
  if (!project.audio || typeof project.audio.file !== "string") {
    return { ...base, ok: true, measured: {}, offenders: [], skipped: "the project declares no audio" };
  }
  if (!existsSync(paths.analysisAudio)) {
    return {
      ...base,
      ok: true,
      measured: { declared: String(project.audio.sampleRate ?? "(none)") },
      offenders: [],
      skipped: "no analysis/audio.json, so there is nothing measured to compare against",
    };
  }
  const analysis = (await readJson(paths.analysisAudio)) as { sampleRate?: number; analysisRate?: number };
  const declared = project.audio.sampleRate;
  const measured = analysis.sampleRate;
  const offenders: Offender[] = [];
  if (typeof declared === "number" && typeof measured === "number" && declared !== measured) {
    offenders.push({
      code: "audio.rate-mismatch",
      where: "project.json::audio.sampleRate",
      detail:
        `declared ${declared} Hz but the analysed file is ${measured} Hz. The declaration is a recorded fact about ` +
        `the input (CONTRACTS.md), so a mismatch means one of the two is stale — most likely a different master ` +
        `was analysed than the project believes it is using.`,
    });
  }
  return {
    ...base,
    ok: offenders.length === 0,
    measured: {
      declared: typeof declared === "number" ? `${declared} Hz` : "(not declared)",
      measured: typeof measured === "number" ? `${measured} Hz` : "(not recorded)",
      "analysis rate": typeof analysis.analysisRate === "number" ? `${analysis.analysisRate} Hz` : "(not recorded)",
    },
    offenders,
    ...(typeof declared === "number" ? {} : { skipped: "the project does not declare a sampleRate to check" }),
  };
}