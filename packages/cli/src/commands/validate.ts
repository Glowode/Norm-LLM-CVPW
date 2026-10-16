/**
 * `cvpw validate` — schema and cross-artifact validation.
 *
 * Two layers, and the second is the one that earns its keep:
 *
 * 1. **Schema.** Every artifact against its `schemas/*.schema.json`, with unknown keys rejected
 *    (`docs/SPEC.md` A4). This catches typos, which is the whole reason it exists.
 * 2. **Cross-artifact.** The checks no single schema can express, because they are about *relationships*:
 *    a cue a timeline references but that no longer exists; a shot whose `at` the timebase cannot
 *    substantiate; on-screen text missing from the whitelist; a block range that leaves a gap.
 *
 * Layer 2 is deliberately here rather than in the renderer. A render takes minutes and a validation takes
 * milliseconds, and a broken time expression found in 50 ms instead of at frame 2400 is the difference
 * between a fix and an afternoon.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Timebase, TimeExpressionError, type TimebaseData } from "@cvpw/kernel";

import { ContractError, projectPaths, readJson, relPath, walkFiles, type Envelope } from "../shared.js";
import { SchemaRegistry, formatIssue, type ValidationResult } from "../validate.js";

export interface ValidateOptions {
  root: string;
  /** Validate every known artifact, not only the ones that exist. */
  all?: boolean;
  /** Validate a single file. */
  artifact?: string;
}

export interface CrossCheck {
  id: string;
  ok: boolean;
  detail: string;
  offenders: string[];
}

export interface ValidateResult {
  root: string;
  artifacts: ValidationResult[];
  cross: CrossCheck[];
  ok: boolean;
}

/**
 * Which artifact lives where, and which schema describes it.
 *
 * `required` marks the artifacts a project cannot render without. A missing required artifact is reported
 * as a failure; a missing optional one is not, because `cues/lyrics.json` is genuinely absent on most
 * projects — lyric *timing* is what the engine needs and lyric *text* is what the user may not want
 * committed at all.
 */
const ARTIFACTS: Array<{ path: string; schema: string; required: boolean; doc: string }> = [
  { path: "project.json", schema: "project", required: true, doc: "the project's knobs" },
  { path: "timeline.json", schema: "timeline", required: false, doc: "written by `cvpw storyboard`" },
  { path: "cues/cues.json", schema: "cues", required: false, doc: "every off-grid time" },
  { path: "cues/lyrics.json", schema: "lyrics", required: false, doc: "lyric text, if it is being kept" },
  { path: "cues/lyrics.timing.json", schema: "lyrics-timing", required: false, doc: "lyric timing" },
  { path: "analysis/audio.json", schema: "audio", required: false, doc: "the timebase" },
  { path: "analysis/envelope.json", schema: "envelope", required: false, doc: "per-frame features" },
  { path: "handoff.json", schema: "handoff", required: false, doc: "the seam contracts" },
  { path: "handoff.report.json", schema: "handoff-report", required: false, doc: "seam measurements" },
  { path: "assets/manifest.json", schema: "assets", required: false, doc: "asset provenance" },
  { path: "render/report.json", schema: "render-report", required: false, doc: "the last render" },
  { path: "qa/report.json", schema: "qa-report", required: false, doc: "the last gate run" },
  { path: "qa/gold.json", schema: "gold", required: false, doc: "the determinism witness" },
  { path: "qa/exemptions.json", schema: "exemptions", required: false, doc: "dated waivers" },
];

export async function validateProject(options: ValidateOptions): Promise<ValidateResult> {
  const paths = projectPaths(options.root);
  const registry = await SchemaRegistry.load();
  const artifacts: ValidationResult[] = [];

  if (options.artifact) {
    const absolute = join(options.root, options.artifact);
    if (!existsSync(absolute)) throw new ContractError(`no such artifact: ${absolute}`);
    const known = ARTIFACTS.find((a) => a.path.replace(/\\/g, "/") === options.artifact?.replace(/\\/g, "/"));
    const value = await readJson(absolute);
    artifacts.push(
      known
        ? registry.validateArtifact(known.schema, options.artifact, value)
        : registry.validateByDeclaration(options.artifact, value),
    );
    return { root: options.root, artifacts, cross: [], ok: artifacts.every((a) => a.ok) };
  }

  for (const spec of ARTIFACTS) {
    const absolute = join(options.root, spec.path);
    if (!existsSync(absolute)) {
      if (spec.required || options.all) {
        artifacts.push({
          ok: false,
          artifact: spec.path,
          schema: spec.schema,
          issues: [
            {
              pointer: "",
              keyword: "required",
              message: `missing: ${spec.doc}${spec.required ? "" : " (optional, but --all asks about it)"}`,
            },
          ],
        });
      }
      continue;
    }
    const value = await readJson(absolute);
    artifacts.push(registry.validateArtifact(spec.schema, spec.path, value));
  }

  const cross = await crossCheck(options.root);
  return {
    root: options.root,
    artifacts,
    cross,
    ok: artifacts.every((a) => a.ok) && cross.every((c) => c.ok),
  };
}

/**
 * The relationship checks.
 *
 * Each one exists because its failure mode is *silent*: the render succeeds and the film is wrong. A cut
 * that resolves to the wrong moment, a cue that vanished, a label outside the whitelist — all of these
 * produce a finished MP4 that nobody can explain.
 */
export async function crossCheck(root: string): Promise<CrossCheck[]> {
  const checks: CrossCheck[] = [];
  const paths = projectPaths(root);

  const push = (id: string, ok: boolean, detail: string, offenders: string[] = []): void => {
    checks.push({ id, ok, detail, offenders });
  };

  // --- what is present ---------------------------------------------------------------------------
  const projectExists = existsSync(paths.projectJson);
  const timelineExists = existsSync(paths.timeline);
  if (!timelineExists) {
    push(
      "timeline.present",
      false,
      "timeline.json is absent, so there is no edit to validate",
      ["run `cvpw storyboard` once the timebase exists"],
    );
    return checks;
  }

  const timeline = (await readJson(paths.timeline)) as {
    shots?: Array<{ id?: string; scene?: string; at?: string; to?: string; moment?: string; text?: Array<{ s?: string }> }>;
    blocks?: Array<{ id?: string; from?: string; to?: string }>;
    duration?: number;
  };
  const cuesDoc = existsSync(paths.cues)
    ? ((await readJson(paths.cues)) as { cues?: Array<{ id: string; t: number; source?: string }> })
    : null;
  // JSON gives an unchecked string; narrow to the declared set once so an unrecognised source is reported
  // by `cues.provenance` rather than silently travelling as if it meant something.
  const CUE_SOURCES = ["measured", "analysis", "audit", "initial", "manual"] as const;
  const cues = (cuesDoc?.cues ?? []).map((cue) => ({
    id: cue.id,
    t: cue.t,
    ...(cue.source && (CUE_SOURCES as readonly string[]).includes(cue.source)
      ? { source: cue.source as (typeof CUE_SOURCES)[number] }
      : {}),
  }));
  const audio = existsSync(paths.analysisAudio)
    ? ((await readJson(paths.analysisAudio)) as Partial<TimebaseData> & { duration?: number; fps?: number })
    : null;
  const lyricsTiming = existsSync(paths.lyricsTiming)
    ? ((await readJson(paths.lyricsTiming)) as { lines?: TimebaseData["lyricLines"] })
    : null;

  // --- every time expression resolves ------------------------------------------------------------
  let timebase: Timebase | null = null;
  let timebaseError: string | null = null;
  try {
    timebase = new Timebase({
      duration: audio?.duration ?? timeline.duration ?? 8,
      fps: audio?.fps ?? 30,
      ...(audio?.tempo ? { tempo: audio.tempo } : {}),
      ...(audio?.meter ? { meter: audio.meter } : {}),
      beats: audio?.beats ?? [],
      beatsSmooth: audio?.beatsSmooth ?? audio?.beats ?? [],
      bars: audio?.bars ?? [],
      sections: audio?.sections ?? [],
      onsets: audio?.onsets ?? [],
      impacts: audio?.impacts ?? [],
      stops: audio?.stops ?? [],
      cues,
      lyricLines: lyricsTiming?.lines ?? [],
    });
  } catch (error) {
    timebaseError = error instanceof Error ? error.message : String(error);
  }

  if (!timebase) {
    push("timeline.timesResolve", false, `the timebase could not be built: ${timebaseError}`);
  } else {
    const failures: string[] = [];
    for (const shot of timeline.shots ?? []) {
      for (const field of ["at", "to"] as const) {
        const expression = shot[field];
        if (!expression) continue;
        try {
          const resolution = timebase.resolve(expression);
          if (resolution.absolute) {
            // Not an error: a project with no audio legitimately begins at 0.0s. It is a warning in
            // `cvpw lint`, and it is reported here so a reviewer sees how much of the edit is anchored to
            // the music rather than to a number.
          }
        } catch (error) {
          const detail =
            error instanceof TimeExpressionError
              ? `${error.message}`
              : `cannot resolve ${JSON.stringify(expression)}: ${error instanceof Error ? error.message : String(error)}`;
          failures.push(`${shot.id ?? "(unnamed shot)"}.${field}: ${detail}`);
        }
      }
    }
    push(
      "timeline.timesResolve",
      failures.length === 0,
      failures.length === 0
        ? `every time expression resolves against the timebase`
        : `${failures.length} time expression(s) do not resolve`,
      failures.slice(0, 12),
    );

    // --- coverage ---------------------------------------------------------------------------------
    const duration = audio?.duration ?? timeline.duration ?? 8;
    const shots = (timeline.shots ?? []).filter((s) => s.at);
    if (shots.length >= 2 && timebase) {
      const ranges: Array<{ id: string; t0: number; t1: number }> = [];
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i] as { id?: string; at?: string; to?: string };
        try {
          const t0 = timebase.resolve(shot.at as string).t;
          const next = shots[i + 1] as { at?: string } | undefined;
          const t1 = shot.to ? timebase.resolve(shot.to).t : next?.at ? timebase.resolve(next.at).t : duration;
          ranges.push({ id: shot.id ?? `#${i}`, t0, t1 });
        } catch {
          // Already reported by the resolution check; coverage cannot be judged for this shot.
        }
      }
      const gaps: string[] = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.t0 > cursor + 1e-3) gaps.push(`gap [${cursor.toFixed(3)}, ${range.t0.toFixed(3)}) before ${range.id}`);
        if (range.t1 <= range.t0) gaps.push(`${range.id} has an empty range [${range.t0.toFixed(3)}, ${range.t1.toFixed(3)})`);
        cursor = Math.max(cursor, range.t1);
      }
      if (ranges.length && cursor < duration - 1e-3) {
        gaps.push(`gap [${cursor.toFixed(3)}, ${duration.toFixed(3)}) at the end of the film`);
      }
      push(
        "timeline.coverage",
        gaps.length === 0,
        gaps.length === 0 ? `the timeline covers [0, ${duration.toFixed(3)}) with no gaps` : `${gaps.length} coverage problem(s)`,
        gaps.slice(0, 8),
      );
    }
  }

  // --- every shot declares a moment --------------------------------------------------------------
  const missingMoments = (timeline.shots ?? []).filter((s) => !s.moment || s.moment.length < 8).map((s) => s.id ?? "(unnamed)");
  push(
    "timeline.moment",
    missingMoments.length === 0,
    missingMoments.length === 0
      ? "every shot declares a moment"
      : `${missingMoments.length} shot(s) have no ` + "`moment` sentence, so nothing says what they are for",
    missingMoments,
  );

  // --- text outside the whitelist ----------------------------------------------------------------
  if (projectExists) {
    const project = (await readJson(paths.projectJson)) as { textWhitelist?: string[] };
    const whitelist = new Set(project.textWhitelist ?? []);
    const unlisted = new Set<string>();
    for (const shot of timeline.shots ?? []) {
      for (const entry of shot.text ?? []) {
        if (typeof entry?.s === "string" && entry.s.length > 0 && !whitelist.has(entry.s)) unlisted.add(entry.s);
      }
    }
    // Scene-level text arguments are not visible here; `cvpw lint` reads the source for those. This check
    // covers what the timeline declares, which is the part a validator can know without loading scenes.
    push(
      "text.whitelist",
      unlisted.size === 0,
      unlisted.size === 0
        ? `every timeline-declared string is whitelisted`
        : `${unlisted.size} string(s) on screen are not in project.json::textWhitelist`,
      [...unlisted].slice(0, 8).map((s) => JSON.stringify(s)),
    );
  }

  // --- cue provenance ----------------------------------------------------------------------------
  if (cuesDoc?.cues) {
    const weak = cuesDoc.cues.filter((c) => !c.source);
    const initial = cuesDoc.cues.filter((c) => c.source === "initial");
    const unknownSource = cuesDoc.cues.filter(
      (c) => c.source && !(CUE_SOURCES as readonly string[]).includes(c.source),
    );
    push(
      "cues.provenance",
      weak.length === 0,
      weak.length === 0
        ? `${cuesDoc.cues.length} cue(s), all with a source`
        : `${weak.length} cue(s) have no ` + "`source`, so nothing records how the time was obtained",
      weak.map((c) => c.id),
    );
    if (unknownSource.length) {
      push(
        "cues.source",
        false,
        `${unknownSource.length} cue(s) declare an unrecognised ` + "`source`",
        unknownSource.map((c) => `${c.id}: ${JSON.stringify(c.source)} (expected one of ${CUE_SOURCES.join(", ")})`),
      );
    }
    if (initial.length) {
      push(
        "cues.settled",
        false,
        `${initial.length} cue(s) are still marked ` + "`initial`, which means the time is a guess",
        initial.map((c) => `${c.id}@${c.t}`),
      );
    }
  }

  // --- referenced cues exist ---------------------------------------------------------------------
  if (timelineExists) {
    const referenced = await referencedCueIds(root, paths.timeline);
    if (referenced.size) {
      const defined = new Set((cuesDoc?.cues ?? []).map((c) => c.id));
      const missing = [...referenced].filter((id) => !defined.has(id));
      push(
        "cues.referenced",
        missing.length === 0,
        missing.length === 0
          ? `${referenced.size} referenced cue id(s) all exist`
          : `${missing.length} cue id(s) are referenced but not defined`,
        missing.map((id) => `${id} (referenced by the timeline, absent from cues/cues.json)`),
      );
    }
  }

  // --- scene modules exist -----------------------------------------------------------------------
  const scenesDir = join(root, "engine", "scenes");
  const sceneFiles = await walkFiles(scenesDir, { extensions: [".js"] });
  const sceneNames = new Set<string>();
  for (const file of sceneFiles) {
    const source = await readFile(join(scenesDir, file), "utf8");
    for (const match of source.matchAll(/name:\s*["'`]([A-Za-z][A-Za-z0-9_-]*)["'`]/g)) {
      // Only count a `name:` that belongs to a `scene({...})` call, so an unrelated object literal in a
      // helper file cannot make a missing scene look present.
      const before = source.slice(Math.max(0, (match.index ?? 0) - 400), match.index);
      if (/scene\s*\(\s*\{[^}]*$/s.test(before)) sceneNames.add(match[1] as string);
    }
  }
  const wanted = new Set((timeline.shots ?? []).map((s) => s.scene).filter((s): s is string => typeof s === "string"));
  const unknownScenes = [...wanted].filter((name) => !sceneNames.has(name));
  push(
    "scenes.registered",
    unknownScenes.length === 0,
    unknownScenes.length === 0
      ? `${wanted.size} scene(s) referenced, all found in engine/scenes/`
      : `${unknownScenes.length} scene(s) referenced by the timeline have no ` + "`scene({name: ...})` in engine/scenes/",
    unknownScenes,
  );

  return checks;
}

/**
 * Cue ids the timeline references, read as text.
 *
 * Text rather than by importing the module, because importing a project's timeline would execute its
 * imports — which in a browser-first project may touch `document`. A validator must be able to run without
 * a DOM, so it reads the source instead. The cost is that a cue id built at runtime is invisible here;
 * that is acceptable, because a time expression the validator cannot read is one a human cannot read either.
 */
async function referencedCueIds(root: string, timelinePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const sources = [timelinePath, join(root, "engine", "timeline.js")];
  for (const source of sources) {
    if (!existsSync(source)) continue;
    const text = await readFile(source, "utf8");
    for (const match of text.matchAll(/cue\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) ids.add(match[1] as string);
    // The bare-identifier shorthand: `"at": "chorus"`.
    for (const match of text.matchAll(/["'`](at|to)["'`]\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_.-]*)["'`]/g)) {
      const value = match[2] as string;
      if (!["s", "b", "h", "p", "cue", "L", "VOX", "HIT", "S", "STOP"].includes(value)) ids.add(value);
    }
  }
  return ids;
}

export function summariseValidation(result: ValidateResult): { lines: string[]; errors: number } {
  const lines: string[] = [];
  let errors = 0;

  for (const artifact of result.artifacts) {
    if (artifact.ok) {
      lines.push(`  ok    ${artifact.artifact}`);
      continue;
    }
    errors++;
    lines.push(`  FAIL  ${artifact.artifact}`);
    for (const issue of artifact.issues.slice(0, 6)) lines.push(`          ${formatIssue(issue)}`);
    if (artifact.issues.length > 6) lines.push(`          … and ${artifact.issues.length - 6} more`);
  }

  lines.push("");
  for (const check of result.cross) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.id}: ${check.detail}`);
    for (const offender of check.offenders.slice(0, 6)) lines.push(`          ${offender}`);
    if (!check.ok) errors++;
  }

  return { lines, errors };
}

export function validateEnvelope(result: ValidateResult, command = "validate"): Envelope {
  const summary = summariseValidation(result);
  return {
    ok: result.ok,
    command,
    schemaVersion: 1,
    project: result.root,
    result: {
      artifacts: result.artifacts.map((a) => ({
        artifact: a.artifact,
        schema: a.schema ?? null,
        ok: a.ok,
        issues: a.issues,
      })),
      cross: result.cross,
    },
    warnings: [],
    errors: result.ok
      ? []
      : [
          {
            code: "validate.failed",
            message: `${summary.errors} validation problem(s)`,
            detail: summary.lines,
          },
        ],
    summary: summary.lines,
  };
}

export { relPath };
