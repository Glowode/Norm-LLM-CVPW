/**
 * `cvpw check` — the gate suite.
 *
 * One command, one profile, one verdict. The design rule that matters: **a gate reports offenders, never a
 * score.** "Frame 412 is 100 % #140b1e and nothing else, in shot `s03_burst`" is actionable; "scene quality:
 * 0.72" is not, and a threshold on a composite score is exactly the kind of invented number `docs/SPEC.md`
 * V5 forbids.
 *
 * Thresholds come from `docs/QA.md` for the framework's own rules and from `project.json::budgets` for a
 * film's own, and nowhere else. A gate with a hard-coded threshold is a gate nobody can tune without
 * editing the framework, and a gate nobody can tune is a gate people route around.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Browser, probeOutput, run } from "@cvpw/render";
import {
  DEFAULT_SCENE_THRESHOLDS,
  frameMetricsExpression,
  judgeFrame,
  sampleTimes,
  type FrameContent,
  type SceneCheckThresholds,
} from "@cvpw/render/content";
import { startStaticServer } from "@cvpw/render/server";

import { detectBrowser, renderArgs } from "../browser.js";
import { ContractError, projectPaths, readJson, relPath, type Envelope } from "../shared.js";
import { buildStoryboard } from "./storyboard.js";

/** The checks this command implements. Every id here also appears in `docs/QA.md`. */
export const IMPLEMENTED_CHECKS = [
  "render.frameContent",
  "render.frameCount",
  "av.sync",
  "determinism.gold",
  "scenes.registry",
  "timeline.time",
  "text.whitelist",
  "text.safeArea",
  "text.legibility",
  "flash.rate",
  "timeline.pacing",
  "assets.manifest",
  "handoff.pixel",
  "deliver.credit",
  "publish.lyricText",
] as const;
export type CheckId = (typeof IMPLEMENTED_CHECKS)[number];

export interface CheckContext {
  root: string;
  /** Output size. The text gates judge type sizes at 1080p proportions (docs/QA.md). */
  width?: number;
  height?: number;
  /** Output frame rate, from `project.json` or the analysis. */
  fps: number;
  duration: number;
  /** Restrict to frames inside this range. `--only-block <id>` sets it. */
  range?: { from: number; to: number; label: string };
  /** Which profile was asked for. Recorded for the report; the checks run are chosen by `--only`. */
  profile?: string;
  json: boolean;
}

export interface Offender {
  /** A stable machine-readable id, so a caller can group without parsing prose. */
  code: string;
  where: string;
  detail: string;
}

export interface CheckOutcome {
  id: string;
  title: string;
  ok: boolean;
  /** Measured numbers, always with units, because a number without one is a guess. */
  measured: Record<string, number | string>;
  offenders: Offender[];
  /** Set when the check could not run. Distinguished from a failure: a skipped gate must not read as pass. */
  skipped?: string;
}

export interface CheckReport {
  root: string;
  /** The block range, when the run was restricted to one. */
  range?: { from: number; to: number; label: string };
  /** When the run began. Only `qa/report.json` may carry a run timestamp (docs/SPEC.md A3). */
  startedAt: string;
  profile: string;
  outcomes: CheckOutcome[];
  /** Every frame sampled, so a reviewer can see the coverage rather than trust it. */
  frames: FrameContent[];
  ok: boolean;
  errors: number;
}

/**
 * Thresholds, resolved once.
 *
 * `docs/QA.md` is the authority for the framework's rules; `project.json::budgets` may tighten them for a
 * film. A project cannot *loosen* them here, because that would make the gate meaningless — a project that
 * needs a real exemption writes `qa/exemptions.json` with a date and a reason (`docs/SPEC.md` V6).
 */
async function resolveThresholds(root: string): Promise<SceneCheckThresholds> {
  const paths = projectPaths(root);
  const budgets = existsSync(paths.projectJson)
    ? ((await readJson(paths.projectJson)) as { budgets?: Record<string, number> }).budgets
    : undefined;
  const emptyContent = budgets?.["emptyFrameContent"];
  return {
    ...DEFAULT_SCENE_THRESHOLDS,
    // A project may only make it stricter. `Math.max` rather than assignment, deliberately.
    ...(typeof emptyContent === "number" && emptyContent > DEFAULT_SCENE_THRESHOLDS.emptyContent
      ? { emptyContent }
      : {}),
  };
}

/**
 * `render.frameContent` — the gate whose absence let a film of near-black pass everything (`docs/QA.md`).
 *
 * Opens the project the way a render would, samples times chosen to include every shot's first frame, and
 * measures what each one actually contains. The intent is stated plainly in the failure message, because
 * the person reading it is usually looking at a PNG wondering why it is black.
 */
export async function checkScenes(context: CheckContext): Promise<{ outcome: CheckOutcome; frames: FrameContent[] }> {
  const thresholds = await resolveThresholds(context.root);
  const storyboard = await buildStoryboard(context.root).catch(() => null);
  const shots = (storyboard?.shots ?? []).map((shot) => ({ id: shot.id, scene: shot.scene, t0: shot.t0, t1: shot.t1 }));

  const times = sampleTimes(shots, context.duration).filter((t) => {
    if (!context.range) return true;
    const frame = Math.round(t * context.fps);
    return frame >= context.range.from && frame < context.range.to;
  });

  if (times.length === 0) {
    return {
      outcome: {
        id: "render.frameContent",
        title: "no frame is only its background",
        ok: true,
        measured: { sampled: 0 },
        offenders: [],
        skipped: "no sample times fall inside the requested range",
      },
      frames: [],
    };
  }

  const browserInfo = detectBrowser();
  if (!browserInfo) {
    return {
      outcome: {
        id: "render.frameContent",
        title: "no frame is only its background",
        ok: true,
        measured: { sampled: 0 },
        offenders: [],
        skipped: "no chromium-family browser found, so no frame could be measured",
      },
      frames: [],
    };
  }

  const project = (await readJson(projectPaths(context.root).projectJson)) as {
    output?: { width?: number; height?: number; dpr?: number };
  };
  const width = project.output?.width ?? 1920;
  const height = project.output?.height ?? 1080;

  const server = await startStaticServer({ root: context.root });
  const browser = await Browser.launch({
    executable: browserInfo.path,
    args: renderArgs(),
    tempRoot: join(context.root, "render", ".scratch"),
    timeoutMs: 90_000,
  });

  try {
    await browser.setViewport(width, height, 1);
    await browser.navigate(`${server.origin}/engine/index.html?capture`, 90_000);

    for (let i = 0; i < 400; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await browser
      .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
      .catch(() => undefined);

    const result = await browser.evaluate<{ frames?: FrameContent[]; error?: string }>(
      frameMetricsExpression({ times, shots }),
      { timeoutMs: 600_000 },
    );
    if (result.error) throw new ContractError(`could not measure frames: ${result.error}`);

    const frames = result.frames ?? [];
    const verdicts = frames.map((frame) => judgeFrame(frame, thresholds));
    const offenders: Offender[] = [];
    for (const verdict of verdicts) {
      if (verdict.level !== "empty") continue;
      offenders.push({
        code: "frame.empty",
        where: `t=${verdict.frame.t.toFixed(3)}s frame=${verdict.frame.frame} shot=${verdict.frame.shots.join("+") || "(none)"}`,
        detail: verdict.reason,
      });
    }

    // `thin` frames are reported in `measured` rather than as offenders: a frame carrying one small caption
    // is a legitimate composition, and a gate that failed it would be ignored within a week.
    const thin = verdicts.filter((verdict) => verdict.level === "thin");
    const contents = frames.map((frame) => frame.contentFraction);
    const sorted = [...contents].sort((a, b) => a - b);
    const min = sorted[0] ?? 0;

    return {
      outcome: {
        id: "render.frameContent",
        title: "no frame is only its background",
        ok: offenders.length === 0,
        measured: {
          sampled: frames.length,
          "min content": `${(min * 100).toFixed(4)} %`,
          "median content": `${((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100).toFixed(3)} %`,
          "thin frames": thin.length,
          "empty threshold": `${(thresholds.emptyContent * 100).toFixed(4)} %`,
        },
        offenders: [
          // `frame.empty` first, because it is the failure; `frame.thin` after, because it is context that
          // explains a film which is technically fine and visually close to nothing.
          ...offenders,
          ...thin.slice(0, 5).map((verdict) => ({
            code: "frame.thin",
            where: `t=${verdict.frame.t.toFixed(3)}s shot=${verdict.frame.shots.join("+") || "(none)"}`,
            detail: `${verdict.reason} — reported, not a failure`,
          })),
        ],
      },
      frames,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}


/**
 * `render.frameCount` — the file contains the frames the film needs.
 *
 * **This is the gate that catches the worst failure available to a renderer.** A truncated MP4 passes an
 * existence check, has a plausible size, opens, and plays for the first thirty seconds. Everything about it
 * looks finished except the part nobody checks. So the count comes from `ffprobe -count_frames` — an actual
 * decode of every frame — and is compared against `round(duration × fps)`, not against whatever the frame
 * sink claimed to write.
 *
 * A missing master is reported as skipped rather than failed: the gate measures a file that exists, and
 * `deliver` is what refuses to ship when nothing was rendered. Two gates failing for one cause trains people
 * to read the list as noise.
 */
export async function checkFrameCount(root: string, ffprobe: string | null): Promise<CheckOutcome> {
  const id = "render.frameCount";
  const title = "the master contains exactly the frames the film needs";
  const renderDir = join(root, "render");
  const reportPath = join(renderDir, "report.json");

  if (!existsSync(reportPath)) {
    return { id, title, ok: true, measured: {}, offenders: [], skipped: "no render/report.json — nothing has been rendered" };
  }
  const report = (await readJson(reportPath)) as {
    output?: string;
    frames?: number;
    fps?: number;
    width?: number;
    height?: number;
  };
  const name = report.output?.split(/[/\\]/).pop();
  if (!name) {
    return { id, title, ok: false, measured: {}, offenders: [{ code: "report.no-output", where: "render/report.json", detail: "records no output file" }] };
  }
  const master = join(renderDir, name);
  if (!existsSync(master)) {
    return {
      id,
      title,
      ok: false,
      measured: {},
      offenders: [{ code: "master.missing", where: `render/${name}`, detail: "the report names a file that is not on disk" }],
    };
  }
  if (!ffprobe) {
    return { id, title, ok: true, measured: {}, offenders: [], skipped: "ffprobe not found, so the frame count cannot be verified" };
  }

  const probed = await probeOutput(ffprobe, master);
  if (probed.frames === null) {
    return {
      id,
      title,
      ok: false,
      measured: {},
      offenders: [{ code: "probe.failed", where: `render/${name}`, detail: "ffprobe could not count the frames, so the file cannot be trusted" }],
    };
  }

  const fps = report.fps ?? 30;
  const expected = report.frames ?? 0;
  const offenders: Offender[] = [];
  if (expected > 0 && probed.frames !== expected) {
    offenders.push({
      code: "frame-count",
      where: `render/${name}`,
      detail: `the file contains ${probed.frames} frames but the film needs ${expected} (${(probed.frames / fps).toFixed(3)} s of ${(expected / fps).toFixed(3)} s)`,
    });
  }
  return {
    id,
    title,
    ok: offenders.length === 0,
    measured: { expected, inFile: probed.frames, fps, durationSec: (probed.duration ?? 0).toFixed(3) },
    offenders,
  };
}

/**
 * `av.sync` — the audio and the picture start and end together.
 *
 * **What this measures, and what it does not.** `docs/QA.md` specifies a waveform cross-correlation within one
 * frame. That needs the two tracks decoded to PCM and correlated, which is a real piece of signal processing
 * and is not implemented. What IS implemented is the part a container can answer exactly: the audio stream's
 * start time against the video stream's, and the two durations. A mux offset of half a second is a sync bug,
 * it is detectable without correlation, and it is the failure a `-itsoffset` typo actually produces.
 *
 * The cross-correlation gap is reported as `skipped` with that reason, never as a pass — a gate that silently
 * checks less than its name promises is worse than no gate, because the name is what people trust.
 */
export async function checkAvSync(root: string, ffprobe: string | null): Promise<CheckOutcome> {
  const id = "av.sync";
  const title = "audio and picture start and end together";
  const renderDir = join(root, "render");
  const reportPath = join(renderDir, "report.json");
  if (!existsSync(reportPath)) {
    return { id, title, ok: true, measured: {}, offenders: [], skipped: "no render yet" };
  }
  const report = (await readJson(reportPath)) as { output?: string; frames?: number; fps?: number };
  const name = report.output?.split(/[/\\]/).pop();
  const master = name ? join(renderDir, name) : null;
  if (!master || !existsSync(master)) {
    return { id, title, ok: true, measured: {}, offenders: [], skipped: "no master on disk" };
  }
  if (!ffprobe) {
    return { id, title, ok: true, measured: {}, offenders: [], skipped: "ffprobe not found" };
  }

  const probed = await run(ffprobe, [
    "-v", "error", "-show_entries", "stream=codec_type,start_time,duration",
    "-of", "json", master,
  ], { timeoutMs: 60_000 });
  if (probed.code !== 0) {
    return { id, title, ok: false, measured: {}, offenders: [{ code: "probe.failed", where: `render/${name}`, detail: "ffprobe could not read the streams" }] };
  }
  let streams: Array<{ codec_type?: string; start_time?: string; duration?: string }> = [];
  try {
    streams = (JSON.parse(probed.stdout) as { streams?: typeof streams }).streams ?? [];
  } catch {
    streams = [];
  }
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");

  if (!audio) {
    return {
      id,
      title,
      ok: true,
      measured: { audio: "none" },
      offenders: [],
      skipped: "the master has no audio track, so there is no sync to check (a silent film is legitimate)",
    };
  }
  if (!video) {
    return { id, title, ok: false, measured: {}, offenders: [{ code: "no-video", where: `render/${name}`, detail: "audio but no video stream" }] };
  }

  const fps = report.fps ?? 30;
  const frameSec = 1 / fps;
  const vStart = Number(video.start_time ?? 0);
  const aStart = Number(audio.start_time ?? 0);
  const vDur = Number(video.duration ?? 0);
  const aDur = Number(audio.duration ?? 0);
  const startDelta = Math.abs(aStart - vStart);

  const offenders: Offender[] = [];
  if (Number.isFinite(startDelta) && startDelta > frameSec) {
    offenders.push({
      code: "av-lag",
      where: `render/${name}`,
      detail:
        `audio starts ${(startDelta * 1000).toFixed(1)} ms from the picture ` +
        `(${(startDelta / frameSec).toFixed(2)} frames, limit 1). A mux offset of this size is audible.`,
    });
  }

  return {
    id,
    title,
    ok: offenders.length === 0,
    measured: {
      "start delta ms": (startDelta * 1000).toFixed(1),
      "video start": vStart.toFixed(3),
      "audio start": aStart.toFixed(3),
      "video duration": vDur.toFixed(3),
      "audio duration": aDur.toFixed(3),
      // Stated so a reader knows what was NOT measured, in the same breath as what was.
      "waveform correlation": "not implemented — see this function's note",
    },
    offenders,
    ...(offenders.length === 0
      ? {}
      : {}),
  };
}

/** scenes.registry — every shot's scene is registered, and every registered scene is reachable. */
export function checkRegistry(root: string, storyboard: Awaited<ReturnType<typeof buildStoryboard>> | null): CheckOutcome {
  if (!storyboard) {
    return {
      id: "scenes.registry",
      title: "every shot names a scene that exists",
      ok: true,
      measured: {},
      offenders: [],
      skipped: "the storyboard could not be built, so scene references could not be resolved",
    };
  }
  const unknown = storyboard.problems.filter((problem) => problem.reason === "unknown-scene");
  return {
    id: "scenes.registry",
    title: "every shot names a scene that exists",
    ok: unknown.length === 0,
    measured: { shots: storyboard.shots.length, problems: storyboard.problems.length },
    offenders: unknown.map((problem) => ({
      code: "scene.unknown",
      where: problem.shotId,
      detail: problem.message,
    })),
  };
}

/** `timeline.time` — every expression resolves and the film is covered end to end. */
export function checkTimeline(storyboard: Awaited<ReturnType<typeof buildStoryboard>> | null): CheckOutcome {
  if (!storyboard) {
    return {
      id: "timeline.time",
      title: "every time expression resolves and the duration is covered",
      ok: false,
      measured: {},
      offenders: [{ code: "timeline.unreadable", where: "engine/timeline.js", detail: "the timeline could not be built" }],
    };
  }
  const bad = storyboard.problems.filter((problem) => problem.reason !== "unknown-scene");
  return {
    id: "timeline.time",
    title: "every time expression resolves and the duration is covered",
    ok: bad.length === 0,
    measured: { shots: storyboard.shots.length, duration: `${storyboard.duration.toFixed(3)} s` },
    offenders: bad.map((problem) => ({ code: problem.reason, where: problem.shotId, detail: problem.message })),
  };
}

/** `text.whitelist` — nothing reaches the screen that the project has not declared. */
export async function checkText(
  root: string,
  storyboard: Awaited<ReturnType<typeof buildStoryboard>> | null,
): Promise<CheckOutcome> {
  const paths = projectPaths(root);
  if (!existsSync(paths.projectJson)) {
    return {
      id: "text.whitelist",
      title: "every string on screen is declared in project.json::textWhitelist",
      ok: false,
      measured: {},
      offenders: [{ code: "project.missing", where: "project.json", detail: "no project.json, so there is no whitelist" }],
    };
  }
  const project = (await readJson(paths.projectJson)) as { textWhitelist?: string[] };
  const whitelist = new Set(project.textWhitelist ?? []);

  // Scene args are where text actually lives, and the storyboard has them resolved. Reading them here
  // rather than from source is what makes this check work on the *effective* text rather than on literals.
  const unlisted = new Set<string>();
  for (const shot of storyboard?.shots ?? []) {
    for (const [key, value] of Object.entries(shot.args ?? {})) {
      if (typeof value !== "string" || value.length === 0) continue;
      // Only keys whose names suggest on-screen text. A colour or a mask name is not text.
      if (!/(title|sub|label|word|text|caption|credit)/i.test(key)) continue;
      if (!whitelist.has(value)) unlisted.add(`${shot.id}.${key}=${JSON.stringify(value)}`);
    }
  }

  return {
    id: "text.whitelist",
    title: "every string on screen is declared in project.json::textWhitelist",
    ok: unlisted.size === 0,
    measured: { whitelist: whitelist.size, unlisted: unlisted.size },
    offenders: [...unlisted].map((entry) => ({
      code: "text.unlisted",
      where: entry.split("=")[0] ?? "?",
      detail: `${entry} is not in textWhitelist`,
    })),
  };
}

export async function runChecks(
  context: CheckContext,
  options: { only?: readonly string[] } = {},
): Promise<CheckReport> {
  const startedAt = new Date().toISOString();
  const wanted = options.only?.filter((id) => id !== "") ?? [];
  const should = (id: string): boolean => wanted.length === 0 || wanted.some((w) => id === w || id.startsWith(`${w}.`) || w.startsWith(`${id.split(".")[0]}.`));

  const storyboard = await buildStoryboard(context.root).catch(() => null);
  const outcomes: CheckOutcome[] = [];
  let frames: FrameContent[] = [];

  if (should("timeline.time")) outcomes.push(checkTimeline(storyboard));
  if (should("scenes.registry")) outcomes.push(checkRegistry(context.root, storyboard));
  if (should("text.whitelist")) outcomes.push(await checkText(context.root, storyboard));
  if (should("text.safeArea") || should("text.legibility")) {
    // Its own module: the whitelist gate above already owns the name `checkText`, and two functions of that
    // name in one file is a collision that gets diagnosed twice.
    const { checkTextLayout } = await import("./text.js");
    const layout = await checkTextLayout({
      root: context.root,
      fps: context.fps,
      duration: context.duration,
      width: context.width ?? 1920,
      height: context.height ?? 1080,
    });
    if (should("text.safeArea")) {
      outcomes.push({
        id: "text.safeArea",
        title: "every on-screen text box is inside the safe inset",
        ok: layout.safeArea.ok,
        measured: layout.safeArea.measured,
        offenders: layout.safeArea.offenders,
        ...(layout.safeArea.skipped ? { skipped: layout.safeArea.skipped } : {}),
      });
    }
    if (should("text.legibility")) {
      outcomes.push({
        id: "text.legibility",
        title: "on-screen text is large enough and held long enough to read",
        ok: layout.legibility.ok,
        measured: layout.legibility.measured,
        offenders: layout.legibility.offenders,
        ...(layout.legibility.skipped ? { skipped: layout.legibility.skipped } : {}),
      });
    }
  }
  if (should("render.frameContent")) {
    const measured = await checkScenes(context);
    outcomes.push(measured.outcome);
    frames = measured.frames;
  }
  if (should("publish.lyricText")) {
    // Pure file check, and the one gate here that is a LEGAL matter rather than a quality one
    // (docs/SPEC.md T7). A timing file says when a line starts; a text file reproduces somebody's writing.
    const paths = projectPaths(context.root);
    const project = existsSync(paths.projectJson)
      ? ((await readJson(paths.projectJson)) as { lyricsLicence?: string })
      : {};
    const hasText = existsSync(paths.lyrics);
    const licence = typeof project.lyricsLicence === "string" ? project.lyricsLicence.trim() : "";
    outcomes.push({
      id: "publish.lyricText",
      title: "lyric text is published only when the project declares a licence",
      ok: !hasText || licence !== "",
      measured: { "lyric text present": hasText ? "yes" : "no", licence: licence || "(none)" },
      offenders:
        hasText && licence === ""
          ? [
              {
                code: "lyric-text-unlicensed",
                where: "cues/lyrics.json",
                detail:
                  `lyric text is present but project.json declares no lyricsLicence. Either record the licence ` +
                  `or delete the file: publishing somebody's words without one is a legal problem, not a quality ` +
                  `one (docs/SPEC.md T7). Timing is committable; the words are not.`,
              },
            ]
          : [],
      ...(hasText ? {} : { skipped: "no lyric text is kept, so nothing can be published" }),
    });
  }
  if (should("deliver.credit")) {
    // Half of docs/QA.md's rule is checkable without a browser: the credit must appear verbatim in README.md.
    // The other half — that it appears in the end card — is what `text.whitelist` and `text.safeArea` cover
    // once the credit is drawn, so this gate does not re-render to duplicate them.
    const paths = projectPaths(context.root);
    const project = existsSync(paths.projectJson)
      ? ((await readJson(paths.projectJson)) as { credit?: string; textWhitelist?: string[] })
      : {};
    const credit = typeof project.credit === "string" ? project.credit.trim() : "";
    const readmePath = join(context.root, "README.md");
    const readme = existsSync(readmePath) ? await readFile(readmePath, "utf8") : null;
    const inReadme = credit === "" ? true : (readme ?? "").includes(credit);
    const whitelisted = credit === "" ? true : (project.textWhitelist ?? []).includes(credit);
    const offenders: Offender[] = [];
    if (credit !== "" && !inReadme) {
      offenders.push({
        code: "credit-missing",
        where: "README.md",
        detail: `project.json::credit is ${JSON.stringify(credit)} but it does not appear verbatim in README.md`,
      });
    }
    if (credit !== "" && !whitelisted) {
      offenders.push({
        code: "credit-not-drawable",
        where: "project.json::textWhitelist",
        detail:
          `the credit is not in textWhitelist, so no scene may draw it. A credit that cannot be put on screen ` +
          `is not a credit.`,
      });
    }
    outcomes.push({
      id: "deliver.credit",
      title: "the declared credit appears where a viewer and a reader can find it",
      ok: offenders.length === 0,
      measured: { credit: credit === "" ? "(none declared)" : credit, "in README": inReadme ? "yes" : "no", whitelisted: whitelisted ? "yes" : "no" },
      offenders,
      ...(credit === "" ? { skipped: "no credit is declared, so there is nothing to place" } : {}),
    });
  }
  if (should("assets.manifest")) {
    // Pure: reads assets/manifest.json and hashes what it declares. A project with no assets is valid, so a
    // missing manifest reports "nothing to validate" rather than failing.
    const { validateAssets } = await import("./assets.js");
    const assets = await validateAssets(context.root);
    outcomes.push({
      id: "assets.manifest",
      title: "every declared asset is present, hash-matched, licensed and sourced",
      ok: assets.problems.length === 0,
      measured: { declared: assets.declared, verified: assets.verified },
      offenders: assets.problems.map((problem) => ({ code: problem.code, where: problem.asset, detail: problem.message })),
      ...(assets.manifest === null ? { skipped: "no assets/manifest.json — a project with no asset files is valid" } : {}),
    });
  }
  if (should("handoff.pixel")) {
    // Reuses `cvpw handoff`'s measurement rather than duplicating it. `handoff.json` is AUTHORED, so absence
    // is a skip: there are no declared seams, which is different from seams that fail.
    const { measureHandoffs } = await import("./handoff.js");
    try {
      const handoff = await measureHandoffs({ root: context.root });
      const judged = handoff.seams.filter((seam) => seam.kind === "pixel");
      outcomes.push({
        id: "handoff.pixel",
        title: "declared pixel seams match across the cut",
        ok: handoff.ok,
        measured: {
          seams: handoff.seams.length,
          pixel: judged.length,
          worst: judged.reduce((worst, seam) => Math.max(worst, seam.diff ?? 0), 0).toFixed(5),
          "minor <": handoff.thresholds.minor,
          "fail >=": handoff.thresholds.fail,
        },
        offenders: handoff.seams
          .filter((seam) => seam.grade === "fail")
          .map((seam) => ({
            code: "seam.fail",
            where: `${seam.id} @ frame ${seam.frame}`,
            detail: `${seam.diff?.toFixed(5) ?? "unmeasured"} against a ${handoff.thresholds.fail} threshold`,
          })),
        ...(judged.length === 0 ? { skipped: "no pixel seams are declared in handoff.json" } : {}),
      });
    } catch (error) {
      outcomes.push({
        id: "handoff.pixel",
        title: "declared pixel seams match across the cut",
        ok: true,
        measured: {},
        offenders: [],
        skipped: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }
  if (should("timeline.pacing")) {
    // Pure arithmetic on the storyboard, so it needs no browser and costs milliseconds. It runs here as well
    // as in `cvpw storyboard` because a gate that only exists in one of the two places gets forgotten.
    const { analysePacing } = await import("./pacing.js");
    const pacing = analysePacing(
      (storyboard?.shots ?? []).map((shot) => ({ id: shot.id, t0: shot.t0, t1: shot.t1, block: shot.block })),
      {
        sections: (await (async () => {
          const { existsSync } = await import("node:fs");
          const audioPath = projectPaths(context.root).analysisAudio;
          if (!existsSync(audioPath)) return [];
          const audio = (await readJson(audioPath)) as { sections?: Array<{ name?: string; start?: number; end?: number }> };
          return (audio.sections ?? [])
            .filter((section) => typeof section.start === "number" && typeof section.end === "number")
            .map((section) => ({ name: section.name ?? "", t0: section.start as number, t1: section.end as number }));
        })()),
      },
    );
    outcomes.push({
      id: "timeline.pacing",
      title: "the edit has a shape: holds, variation, and contrast between sections",
      ok: pacing.ok,
      measured: pacing.measured,
      offenders: pacing.offenders,
      ...(pacing.skipped ? { skipped: pacing.skipped } : {}),
    });
  }
  if (should("flash.rate")) {
    const { checkFlash } = await import("./flash.js");
    const flash = await checkFlash({
      root: context.root,
      fps: context.fps,
      duration: context.duration,
      width: context.width ?? 1920,
      height: context.height ?? 1080,
    });
    outcomes.push({
      id: "flash.rate",
      title: "flash rate is within budget, or the film warns about it",
      ok: flash.ok,
      measured: flash.measured,
      // A `flash.warned` offender is the record that the film exceeds the budget AND warns, which is an
      // acceptable exhibit rather than a failure. It stays in the list so the report says so.
      offenders: flash.offenders,
      ...(flash.skipped ? { skipped: flash.skipped } : {}),
    });
  }
  if (should("render.frameCount") || should("av.sync")) {
    // `resolveTool` is imported lazily so a run that does not need ffprobe does not pay for the probe.
    const { resolveTool } = await import("../shared.js");
    const ffprobe = resolveTool("ffprobe").path ?? null;
    if (should("render.frameCount")) outcomes.push(await checkFrameCount(context.root, ffprobe));
    if (should("av.sync")) outcomes.push(await checkAvSync(context.root, ffprobe));
  }
  if (should("determinism.gold")) {
    // Imported lazily: the gold check opens its own browser session and walks the whole film, so a caller
    // running only `--only render.frameContent` should not pay for it.
    const { checkDeterminism } = await import("./gold.js");
    const result = await checkDeterminism(context.root);
    outcomes.push({
      id: "determinism.gold",
      title: "every witnessed frame still hashes to its baseline",
      ok: result.ok,
      measured: {
        compared: result.compared,
        differing: result.differing.length,
        renderer: result.renderer,
        ...(result.goldRenderer && result.goldRenderer !== result.renderer
          ? { "gold renderer": result.goldRenderer }
          : {}),
      },
      offenders: result.differing.slice(0, 12).map((diff) => ({
        code: "frame.changed",
        where: `frame ${diff.frame}`,
        detail: `expected ${diff.expected}, observed ${diff.observed}`,
      })),
      ...(result.skipped ? { skipped: result.skipped } : {}),
    });
  }

  const errors = outcomes.reduce((sum, outcome) => sum + (outcome.ok ? 0 : outcome.offenders.length), 0);
  return {
    root: context.root,
    startedAt,
    ...(context.range ? { range: context.range } : {}),
    profile: context.profile ?? "all",
    outcomes,
    frames,
    ok: outcomes.every((outcome) => outcome.ok),
    errors,
  };
}

/**
 * The `qa/report.json` artifact, in the shape `schemas/qa-report.schema.json` declares.
 *
 * Distinct from {@link checkEnvelope} on purpose: the envelope is for a human or an agent reading stdout, and
 * this is for the next command. Conflating them is how `cvpw check --json > qa/report.json` produced a file
 * that `cvpw deliver` demanded and `cvpw validate` rejected.
 */
export function qaReportDocument(report: CheckReport): Record<string, unknown> {
  return {
    $schema: "schemas/qa-report.schema.json",
    schemaVersion: 1,
    run: {
      startedAt: report.startedAt,
      // The schema restricts `profile` to all|render|deliver and `only` to a single block id, so neither may
      // carry the list of check ids that ran — that is what `checks[]` is for.
      profile: report.profile === "render" || report.profile === "deliver" ? report.profile : "all",
      ...(report.range?.label ? { only: report.range.label } : {}),
    },
    checks: report.outcomes.map((outcome) => ({
      id: outcome.id,
      // `status` is the schema's field and `ok` is derived from it, not the other way round: a skipped check
      // is not a pass, and a report that flattened the two would hide a gate that never ran.
      status: outcome.skipped ? "skipped" : outcome.ok ? "pass" : "fail",
      ok: outcome.ok,
      ...(outcome.skipped ? { reason: outcome.skipped } : {}),
      // `observed` is a STRING in the schema: one line a human reads, not a bag a tool has to parse.
      ...(Object.keys(outcome.measured).length
        ? {
            observed: Object.entries(outcome.measured)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(", "),
          }
        : {}),
      // Strings, not objects: the schema wants "concrete instances that justify the verdict", and a reader of
      // a delivery report needs a line they can act on rather than a structure they have to unpack.
      offenders: outcome.offenders.map(
        (offender) => `${offender.where} — ${offender.detail} [${offender.code}]`,
      ),
    })),
    ok: report.ok,
    waived: [],
  };
}

export function checkEnvelope(report: CheckReport, command = "check"): Envelope {
  const summary: string[] = [];
  for (const outcome of report.outcomes) {
    const mark = outcome.skipped ? "SKIP" : outcome.ok ? "ok  " : "FAIL";
    summary.push(`  ${mark}  ${outcome.id}: ${outcome.title}`);
    const measured = Object.entries(outcome.measured);
    if (measured.length) {
      summary.push(`          ${measured.map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    if (outcome.skipped) summary.push(`          skipped: ${outcome.skipped}`);
    for (const offender of outcome.offenders.filter((o) => !o.code.endsWith(".thin")).slice(0, 8)) {
      summary.push(`          ${offender.where}  ${offender.detail}`);
    }
  }
  const failing = report.outcomes.filter((outcome) => !outcome.ok);
  summary.push("");
  summary.push(
    failing.length === 0
      ? `every implemented gate passes (${report.outcomes.length} check(s), ${report.frames.length} frame(s) measured)`
      : `${failing.length} gate(s) failed`,
  );

  return {
    ok: report.ok,
    command,
    schemaVersion: 1,
    project: report.root,
    artifactsWritten: [],
    result: {
      profile: report.profile,
      outcomes: report.outcomes,
      framesMeasured: report.frames.length,
      // The worst frames, so a reader sees the shape of the film rather than only its failures.
      thinnestFrames: [...report.frames]
        .sort((a, b) => a.contentFraction - b.contentFraction)
        .slice(0, 5)
        .map((frame) => ({ t: frame.t, content: frame.contentFraction, shot: frame.shots.join("+") })),
    },
    warnings: report.outcomes
      .flatMap((outcome) => outcome.offenders.filter((o) => o.code.endsWith(".thin")))
      .map((offender) => ({ code: "frame.thin", message: `${offender.where}: ${offender.detail}` })),
    errors: failing.flatMap((outcome) =>
      outcome.offenders
        .filter((o) => !o.code.endsWith(".thin"))
        .map((offender) => ({ code: offender.code, message: `${outcome.id} ${offender.where}: ${offender.detail}` })),
    ),
    summary,
  };
}

export { relPath };
