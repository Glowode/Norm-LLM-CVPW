/**
 * `cvpw storyboard` — resolve the edit, then write it down twice.
 *
 * Two outputs, for two readers, from one pass over the same data:
 *
 * - **`timeline.json`** for machines: every expression resolved to a number, coverage verified, problems
 *   named. Written with both the *expression* and the *resolved time*, because a resolved number alone
 *   loses the reason the cut is there and an expression alone cannot be checked by a tool that lacks the
 *   timebase.
 * - **`docs/STORYBOARD.md`** for humans: the same table, with each shot's `moment` sentence. This is what a
 *   reviewer reads, and it is generated rather than maintained by hand precisely so it cannot drift from
 *   the film.
 *
 * The hand-written `engine/timeline.js` stays the source of truth. `timeline.json` is a *derived*
 * artifact (`docs/CONTRACTS.md` §1 marks it authored, and this command is the one place that reconciles
 * the two): editing it by hand would put the authoritative expressions and the committed numbers in
 * disagreement, which is the drift this framework exists to remove.
 *
 * A missing `document` is deliberate throughout. Resolution must be possible without a browser, because a
 * broken time expression found in 50 ms is a fix and one found at frame 2400 is an afternoon.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Timebase, TimeExpressionError, type TimebaseData } from "@cvpw/kernel";

import { ContractError, projectPaths, readJson, relPath, type Envelope } from "../shared.js";

export interface StoryboardShot {
  id: string;
  scene: string;
  block?: string;
  /** The authored expression, kept verbatim. */
  atExpression: string;
  /** The resolved canonical time. */
  t0: number;
  /** The authored end expression, when there is one. */
  toExpression?: string;
  t1: number;
  frameFrom: number;
  frameTo: number;
  moment?: string;
  style?: string;
  args?: Record<string, unknown>;
  transitions: string[];
  handoff: string | null;
}

export interface StoryboardProblem {
  shotId: string;
  reason: string;
  message: string;
}

export interface StoryboardResult {
  shots: StoryboardShot[];
  problems: StoryboardProblem[];
  warnings: string[];
  duration: number;
  fps: number;
  timelinePath: string;
  markdownPath: string;
  blocks: Array<{ id: string; file?: string; from: number; to: number; cues: string[] }>;
}

/** Build a timebase from the project's artifacts. Shared shape with the validator, deliberately. */
export async function buildTimebase(root: string): Promise<{ timebase: Timebase; warnings: string[] }> {
  const paths = projectPaths(root);
  const warnings: string[] = [];

  const audio = existsSync(paths.analysisAudio)
    ? ((await readJson(paths.analysisAudio)) as Partial<TimebaseData> & { duration?: number; fps?: number })
    : null;
  const cuesDoc = existsSync(paths.cues) ? ((await readJson(paths.cues)) as { cues?: TimebaseData["cues"] }) : null;
  const lyricsTiming = existsSync(paths.lyricsTiming)
    ? ((await readJson(paths.lyricsTiming)) as { lines?: TimebaseData["lyricLines"] })
    : null;
  const project = existsSync(paths.projectJson)
    ? ((await readJson(paths.projectJson)) as { output?: { fps?: number } })
    : null;

  if (!audio) {
    warnings.push(
      "analysis/audio.json is absent, so there is no measured grid: b() and h() cannot resolve and are " +
        "reported as problems rather than guessed at.",
    );
  }
  if (!cuesDoc) warnings.push("cues/cues.json is absent, so no named cue resolves.");

  const duration = audio?.duration ?? (await timelineDurationHint(root)) ?? 8;
  const timebase = new Timebase({
    duration,
    fps: audio?.fps ?? project?.output?.fps ?? 30,
    ...(audio?.tempo ? { tempo: audio.tempo } : {}),
    ...(audio?.meter ? { meter: audio.meter } : {}),
    beats: audio?.beats ?? [],
    beatsSmooth: audio?.beatsSmooth ?? audio?.beats ?? [],
    bars: audio?.bars ?? [],
    sections: audio?.sections ?? [],
    onsets: audio?.onsets ?? [],
    impacts: audio?.impacts ?? [],
    stops: audio?.stops ?? [],
    cues: cuesDoc?.cues ?? [],
    lyricLines: lyricsTiming?.lines ?? [],
  });
  return { timebase, warnings };
}

/** Read just the `duration` from `engine/timeline.js` without executing it, for a project with no audio. */
async function timelineDurationHint(root: string): Promise<number | null> {
  const path = join(root, "engine", "timeline.js");
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  const match = /duration\s*:\s*([0-9.]+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Load the authored timeline.
 *
 * A `.mjs` copy is imported so that Node parses it as ESM regardless of what `package.json` the project
 * does or does not have. The copy is written next to the original and removed afterwards, which keeps the
 * project's own file types untouched.
 */
export async function loadAuthoredTimeline(root: string): Promise<{
  shots: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
  duration?: number;
  source: string;
}> {
  const candidates = [join(root, "engine", "timeline.js"), join(root, "engine", "timeline.mjs")];
  const source = candidates.find((path) => existsSync(path));
  if (!source) {
    throw new ContractError(
      `no engine/timeline.js in ${root}\n` +
        `  the timeline is the edit; nothing can be storyboarded without it`,
    );
  }

  let importPath = source;
  if (source.endsWith(".js")) {
    const copy = join(root, "engine", "timeline.__cvpw.mjs");
    await writeFile(copy, await readFile(source, "utf8"), "utf8");
    importPath = copy;
    try {
      return await importTimeline(importPath, source);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(copy, { force: true }).catch(() => undefined);
    }
  }
  return importTimeline(importPath, source);
}

async function importTimeline(
  importPath: string,
  source: string,
): Promise<{ shots: Array<Record<string, unknown>>; blocks: Array<Record<string, unknown>>; duration?: number; source: string }> {
  let module: { timeline?: unknown; default?: unknown };
  try {
    module = (await import(pathToFileURL(importPath).href)) as typeof module;
  } catch (error) {
    throw new ContractError(
      `could not import ${source}: ${error instanceof Error ? error.message : String(error)}\n` +
        `  a timeline must be data with no DOM access at import time, so that validation can run in Node`,
    );
  }
  const doc = (module.timeline ?? module.default) as {
    shots?: Array<Record<string, unknown>>;
    blocks?: Array<Record<string, unknown>>;
    duration?: number;
  };
  if (!doc || !Array.isArray(doc.shots)) {
    throw new ContractError(`${source} must export a \`timeline\` object with a \`shots\` array`);
  }
  return {
    shots: doc.shots,
    blocks: doc.blocks ?? [],
    ...(typeof doc.duration === "number" ? { duration: doc.duration } : {}),
    source: relPath(join(source, "..", "..", ".."), source),
  };
}

/**
 * Resolve every shot and check the things a machine can check.
 *
 * The coverage check is the important one: a gap in the timeline renders as a black frame with a `NO SHOT`
 * marker, and finding it here costs milliseconds instead of a render.
 */
export async function buildStoryboard(root: string): Promise<StoryboardResult> {
  const paths = projectPaths(root);
  const { timebase, warnings } = await buildTimebase(root);
  const authored = await loadAuthoredTimeline(root);
  const duration = authored.duration ?? timebase.duration;
  const fps = timebase.fps;

  const problems: StoryboardProblem[] = [];
  const shots: StoryboardShot[] = [];

  for (const raw of authored.shots) {
    const id = typeof raw.id === "string" ? raw.id : "(unnamed shot)";
    const scene = typeof raw.scene === "string" ? raw.scene : "";
    const at = typeof raw.at === "string" ? raw.at : null;
    if (!scene) problems.push({ shotId: id, reason: "unknown-scene", message: "no `scene` name" });
    if (!at) {
      problems.push({ shotId: id, reason: "bad-time", message: "no `at` expression" });
      continue;
    }

    let t0: number;
    try {
      t0 = timebase.resolve(at).t;
    } catch (error) {
      problems.push({
        shotId: id,
        reason: "bad-time",
        message: error instanceof TimeExpressionError ? error.message : String(error),
      });
      continue;
    }

    const next = authored.shots[authored.shots.indexOf(raw) + 1] as Record<string, unknown> | undefined;
    const toExpression = typeof raw.to === "string" ? raw.to : undefined;
    let t1: number;
    if (toExpression) {
      try {
        t1 = timebase.resolve(toExpression).t;
      } catch (error) {
        problems.push({
          shotId: id,
          reason: "bad-time",
          message: error instanceof TimeExpressionError ? error.message : String(error),
        });
        continue;
      }
    } else if (next && typeof next.at === "string") {
      try {
        t1 = timebase.resolve(next.at).t;
      } catch {
        t1 = duration;
      }
    } else {
      t1 = duration;
    }

    if (t1 <= t0) {
      problems.push({
        shotId: id,
        reason: "empty-range",
        message: `resolves to an empty or reversed range [${t0.toFixed(3)}, ${t1.toFixed(3)})`,
      });
      continue;
    }

    const transition = raw.transition as { type?: string; overlap?: number } | undefined;
    const handoff = raw.handoff as { out?: string | null } | undefined;

    shots.push({
      id,
      scene,
      ...(typeof raw.block === "string" ? { block: raw.block } : {}),
      atExpression: at,
      t0: round(t0),
      ...(toExpression ? { toExpression } : {}),
      t1: round(t1),
      frameFrom: timebase.frameIndex(t0),
      frameTo: timebase.frameIndex(t1),
      ...(typeof raw.moment === "string" ? { moment: raw.moment } : {}),
      ...(typeof raw.style === "string" ? { style: raw.style } : {}),
      ...(raw.args && typeof raw.args === "object" ? { args: raw.args as Record<string, unknown> } : {}),
      transitions: transition?.type ? [transition.type] : [],
      handoff: handoff?.out ?? null,
    });
  }

  // Coverage. A gap is a failure, not a warning: it renders as a marked black frame, and a film with a
  // black hole in it is not "mostly working".
  let cursor = 0;
  for (const shot of shots) {
    if (shot.t0 > cursor + 1e-3) {
      problems.push({
        shotId: shot.id,
        reason: "empty-range",
        message: `leaves a gap [${cursor.toFixed(3)}, ${shot.t0.toFixed(3)}) with no active shot`,
      });
    }
    cursor = Math.max(cursor, shot.t1);
  }
  if (shots.length && shots[0] && shots[0].t0 > 1e-3) {
    problems.push({ shotId: shots[0].id, reason: "empty-range", message: `the first shot starts at ${shots[0].t0.toFixed(3)}s, not 0` });
  }
  if (shots.length && Math.abs(cursor - duration) > 1e-3) {
    problems.push({
      shotId: "timeline",
      reason: "empty-range",
      message: `the last shot ends at ${cursor.toFixed(3)}s but the duration is ${duration.toFixed(3)}s`,
    });
  }

  // --- write timeline.json ------------------------------------------------------------------------
  const derived = {
    $schema: "schemas/timeline.schema.json",
    schemaVersion: 1,
    duration: round(duration),
    note:
      "DERIVED by `cvpw storyboard` from engine/timeline.js. Do not hand-edit: the authored expressions in " +
      "engine/timeline.js are the source of truth, and both the expression and its resolved time are kept " +
      "here so that a change in the music is visible as a change in the numbers.",
    edges: shots.filter((s) => s.transitions.length === 0).slice(1).map((s) => s.atExpression),
    shots: shots.map((shot) => ({
      id: shot.id,
      scene: shot.scene,
      at: shot.atExpression,
      resolved: { t0: shot.t0, t1: shot.t1, frameFrom: shot.frameFrom, frameTo: shot.frameTo },
      ...(shot.toExpression ? { to: shot.toExpression } : {}),
      ...(shot.moment ? { moment: shot.moment } : {}),
      ...(shot.block ? { block: shot.block } : {}),
      ...(shot.style ? { style: shot.style } : {}),
      ...(shot.args ? { args: shot.args } : {}),
      ...(shot.transitions.length ? { transition: { type: shot.transitions[0] } } : {}),
      ...(shot.handoff ? { handoff: { out: shot.handoff } } : {}),
    })),
  };
  await writeFile(paths.timeline, `${JSON.stringify(derived, null, 2)}\n`, "utf8");

  // --- write docs/STORYBOARD.md ------------------------------------------------------------------
  const blocks = partitionBlocks(shots, timebase);
  const markdown = renderStoryboard({ shots, problems, blocks, duration, fps, warnings, root });
  const markdownPath = join(root, "docs", "STORYBOARD.md");
  await writeFile(markdownPath, markdown, "utf8");

  return {
    shots,
    problems,
    warnings,
    duration,
    fps,
    timelinePath: paths.timeline,
    markdownPath,
    blocks,
  };
}

/** Group shots by their `block` field, resolving each block's range from its shots. */
function partitionBlocks(
  shots: readonly StoryboardShot[],
  timebase: Timebase,
): Array<{ id: string; file?: string; from: number; to: number; cues: string[] }> {
  const byBlock = new Map<string, StoryboardShot[]>();
  for (const shot of shots) {
    const key = shot.block ?? "(unassigned)";
    const list = byBlock.get(key) ?? [];
    list.push(shot);
    byBlock.set(key, list);
  }
  return [...byBlock.entries()]
    .map(([id, list]) => {
      const from = Math.min(...list.map((s) => s.t0));
      const to = Math.max(...list.map((s) => s.t1));
      // Cue ids referenced anywhere in the block, so an author can see which musical moments are theirs.
      const cues = new Set<string>();
      for (const shot of list) {
        for (const match of shot.atExpression.matchAll(/cue\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) cues.add(match[1] as string);
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(shot.atExpression)) cues.add(shot.atExpression);
      }
      void timebase;
      return { id, from: round(from), to: round(to), cues: [...cues] };
    })
    .sort((a, b) => a.from - b.from);
}

function renderStoryboard(input: {
  shots: readonly StoryboardShot[];
  problems: readonly StoryboardProblem[];
  blocks: StoryboardResult["blocks"];
  duration: number;
  fps: number;
  warnings: readonly string[];
  root: string;
}): string {
  const { shots, problems, blocks, duration, fps, warnings } = input;
  const lines: string[] = [
    "# STORYBOARD",
    "",
    "**Generated by `cvpw storyboard`. Do not edit.** The source of truth is `engine/timeline.js`; edit that",
    "and re-run the command. A hand-edited table drifts from the film, and a table that has drifted is worse",
    "than no table because it is trusted.",
    "",
    `Duration **${duration.toFixed(3)} s** at **${fps} fps** — ${Math.round(duration * fps)} frames.`,
    `${shots.length} shot(s) in ${blocks.length} block(s).`,
    "",
  ];

  if (warnings.length) {
    lines.push("## Warnings", "");
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  if (problems.length) {
    lines.push("## Problems", "");
    lines.push("These MUST be fixed before a render. A coverage gap renders as a marked black frame.", "");
    lines.push("| shot | kind | detail |", "|---|---|---|");
    for (const problem of problems) {
      lines.push(`| \`${problem.shotId}\` | ${problem.reason} | ${escapeCell(problem.message)} |`);
    }
    lines.push("");
  } else {
    lines.push("## Problems", "", "None. Every time expression resolves and the timeline covers the whole duration.", "");
  }

  lines.push("## Shots", "");
  lines.push("| # | id | scene | at | resolved | frames | moment |");
  lines.push("|---|---|---|---|---|---|---|");
  shots.forEach((shot, index) => {
    lines.push(
      `| ${index + 1} | \`${shot.id}\` | \`${shot.scene}\` | \`${shot.atExpression}\` | ` +
        `${shot.t0.toFixed(3)}–${shot.t1.toFixed(3)} s | ${shot.frameFrom}–${shot.frameTo} | ${escapeCell(shot.moment ?? "—")} |`,
    );
  });
  lines.push("");

  if (blocks.length) {
    lines.push("## Blocks", "");
    lines.push(
      "The unit of parallel work: one owner, a disjoint time range, a disjoint set of files. A block author",
      "edits only the scene files their block owns. See `docs/BLOCKS.md` and `skills/cvpw/references/03-parallel-work.md`.",
      "",
    );
    lines.push("| block | range | duration | cues |", "|---|---|---|---|");
    for (const block of blocks) {
      lines.push(
        `| \`${block.id}\` | ${block.from.toFixed(3)}–${block.to.toFixed(3)} s | ` +
          `${(block.to - block.from).toFixed(2)} s | ${block.cues.map((c) => `\`${c}\``).join(", ") || "—"} |`,
      );
    }
    lines.push("");
  }

  // A first pass at pacing. Deliberately descriptive rather than prescriptive: whether uniform shot lengths
  // are wrong depends on the film, and the `timeline.pacing` gate is where a project states its own rule.
  if (shots.length >= 4) {
    const lengths = shots.map((s) => s.t1 - s.t0).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
    const shortest = lengths[0] ?? 0;
    const longest = lengths[lengths.length - 1] ?? 0;
    const holds = shots.filter((s) => s.t1 - s.t0 >= 1.0).length;
    lines.push(
      "## Pacing",
      "",
      `Shot lengths: shortest ${shortest.toFixed(2)} s, median ${median.toFixed(2)} s, longest ${longest.toFixed(2)} s.`,
      `${holds} shot(s) hold for a second or more.`,
      "",
      "A film with no hold has no rhythm to break, and a film whose shots are all the same length has no",
      "shape. Neither is an error a tool can call — look at the numbers and decide.",
      "",
    );
  }

  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function storyboardEnvelope(result: StoryboardResult, root: string): Envelope {
  const summary = [
    `resolved ${result.shots.length} shot(s) over ${result.duration.toFixed(3)} s at ${result.fps} fps`,
    `  ${relPath(root, result.timelinePath)}  (derived — do not hand-edit)`,
    `  ${relPath(root, result.markdownPath)}  (read this one)`,
    ...(result.problems.length
      ? [`  ${result.problems.length} problem(s) — fix before rendering:`]
      : ["  no problems: every expression resolves and the duration is covered"]),
    ...result.problems.slice(0, 8).map((p) => `    ${p.shotId}: ${p.message}`),
    ...result.warnings.map((w) => `  warning: ${w}`),
  ];
  return {
    ok: result.problems.length === 0,
    command: "storyboard",
    schemaVersion: 1,
    project: root,
    artifactsWritten: [result.timelinePath, result.markdownPath],
    result: {
      duration: result.duration,
      fps: result.fps,
      shots: result.shots,
      blocks: result.blocks,
      problems: result.problems,
      warnings: result.warnings,
    },
    warnings: result.warnings.map((message) => ({ code: "storyboard", message })),
    errors: result.problems.map((problem) => ({
      code: problem.reason,
      message: `${problem.shotId}: ${problem.message}`,
    })),
    summary,
  };
}
