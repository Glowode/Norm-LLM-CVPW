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

import { Browser } from "@cvpw/render";
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
  "determinism.gold",
  "scenes.registry",
  "timeline.time",
  "text.whitelist",
] as const;
export type CheckId = (typeof IMPLEMENTED_CHECKS)[number];

export interface CheckContext {
  root: string;
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

/** `scenes.registry` — every shot's scene is registered, and every registered scene is reachable. */
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
  const wanted = options.only?.filter((id) => id !== "") ?? [];
  const should = (id: string): boolean => wanted.length === 0 || wanted.some((w) => id === w || id.startsWith(`${w}.`) || w.startsWith(`${id.split(".")[0]}.`));

  const storyboard = await buildStoryboard(context.root).catch(() => null);
  const outcomes: CheckOutcome[] = [];
  let frames: FrameContent[] = [];

  if (should("timeline.time")) outcomes.push(checkTimeline(storyboard));
  if (should("scenes.registry")) outcomes.push(checkRegistry(context.root, storyboard));
  if (should("text.whitelist")) outcomes.push(await checkText(context.root, storyboard));
  if (should("render.frameContent")) {
    const measured = await checkScenes(context);
    outcomes.push(measured.outcome);
    frames = measured.frames;
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
    profile: context.profile ?? "scenes",
    outcomes,
    frames,
    ok: outcomes.every((outcome) => outcome.ok),
    errors,
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
