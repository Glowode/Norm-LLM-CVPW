/**
 * `cvpw cues` — settle named moments onto measured evidence.
 *
 * A cue is a time the music contains but the grid cannot name: "the moment the vocal comes in", "the
 * downbeat after the breakdown". `docs/SPEC.md` T8 requires them to be registered rather than written inline,
 * and this command is how a first guess becomes a measured one.
 *
 * **The rule that matters: it never overwrites a `manual` cue.** A human who has placed a cut by ear has
 * information the analysis does not have — a breath, a visual beat, a decision about the film — so a tool
 * that "corrects" it is destroying the only authoritative source in the file. The command refuses, names the
 * cue, and says how to override if the operator is certain.
 *
 * The second rule is about honesty of provenance. A cue's `source` records how its time was obtained, and the
 * `cues.settled` gate fails the film while any cue is still `initial`. So a guess that this command cannot
 * improve stays `initial` rather than being relabelled `measured`: a wrong provenance is worse than an
 * unresolved one, because it makes the gate stop asking.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ContractError, projectPaths, readJson, relPath, type Envelope } from "../shared.js";

export type CueSource = "measured" | "analysis" | "audit" | "initial" | "manual";

export interface Cue {
  id: string;
  t: number;
  source?: CueSource;
  label?: string;
  note?: string;
}

export interface CuesOptions {
  root: string;
  /** How close a measured onset must be to accept it, in seconds. Default 40 ms: about one frame at 25 fps. */
  toleranceSec?: number;
  /** Rewrite even `manual` cues. Off by default, and off means "refuse", not "skip quietly". */
  force?: boolean;
  /** Print what would change without writing. */
  dryRun?: boolean;
}

export interface CueChange {
  id: string;
  from: number;
  to: number;
  source: CueSource;
  /** Why this time: the measured feature it was snapped to. */
  evidence: string;
  skipped?: string;
}

export interface CuesResult {
  root: string;
  changes: CueChange[];
  unchanged: number;
  /** Cues that remain `initial` because nothing measurable was near enough. */
  unresolved: string[];
  path: string;
  total: number;
}

/** Candidate measured times, each with a description, in the order a cue should prefer them. */
interface Anchor {
  t: number;
  kind: CueSource;
  evidence: string;
}

/**
 * Build the anchor list from the analysis.
 *
 * Ordered by how *specific* the evidence is: an impact is a sound event with a strength, while a stop or a
 * section boundary is a change in texture. A cue lands on the most specific anchor within tolerance, which
 * is also the one an ear would pick.
 */
function anchorsFrom(audio: {
  onsets?: number[];
  impacts?: Array<{ t?: number; strength?: number; kind?: string }>;
  stops?: Array<{ start?: number; kind?: string }>;
  sections?: Array<{ start?: number; name?: string; manual?: boolean }>;
  beats?: number[];
}): Anchor[] {
  const anchors: Anchor[] = [];
  for (const impact of audio.impacts ?? []) {
    if (typeof impact.t !== "number") continue;
    anchors.push({
      t: impact.t,
      kind: "measured",
      evidence: `impact ${impact.kind ?? "?"} strength ${(impact.strength ?? 0).toFixed(2)}`,
    });
  }
  for (const stop of audio.stops ?? []) {
    if (typeof stop.start !== "number") continue;
    anchors.push({ t: stop.start, kind: "analysis", evidence: `stop (${stop.kind ?? "break"})` });
  }
  for (const section of audio.sections ?? []) {
    if (typeof section.start !== "number") continue;
    // A manually corrected section boundary is a human decision, so a cue landing on one inherits `manual`
    // provenance rather than claiming the analysis found it.
    anchors.push({
      t: section.start,
      kind: section.manual ? "audit" : "analysis",
      evidence: `section "${section.name ?? "?"}" start`,
    });
  }
  for (const onset of audio.onsets ?? []) {
    anchors.push({ t: onset, kind: "measured", evidence: "onset" });
  }
  return anchors;
}

export async function settleCues(options: CuesOptions): Promise<CuesResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.cues)) {
    throw new ContractError(
      `no cues/cues.json in ${options.root}\n` +
        `  a project with no cues has nothing to settle. Create one with the moments the grid cannot name:\n` +
        `  {"$schema":"schemas/cues.schema.json","schemaVersion":1,"duration":<n>,"cues":[{"id":"chorus","t":0,"source":"initial"}]}`,
    );
  }
  // The cue cursor is NOT written by an analysis: it is the one file a human owns. Read it, report on it.
  if (!existsSync(paths.analysisAudio)) {
    throw new ContractError(
      "no analysis/audio.json, so there is no measured evidence to settle a cue onto.\n" +
        "  run `cvpw analyze` first — settling onto nothing would just relabel a guess as measured",
    );
  }

  const doc = (await readJson(paths.cues)) as { duration?: number; cues?: Cue[] };
  const cues = doc.cues ?? [];
  const audio = (await readJson(paths.analysisAudio)) as Parameters<typeof anchorsFrom>[0];
  const anchors = anchorsFrom(audio);
  const tolerance = options.toleranceSec ?? 0.04;

  const changes: CueChange[] = [];
  const unresolved: string[] = [];
  let unchanged = 0;

  for (const cue of cues) {
    if (cue.source === "manual" && !options.force) {
      changes.push({
        id: cue.id,
        from: cue.t,
        to: cue.t,
        source: "manual",
        evidence: "",
        skipped: "manual — placed by a human, so the analysis does not get to move it (pass --force to override)",
      });
      continue;
    }

    // The nearest anchor within tolerance. `reduce` rather than sort: the list is short and a stable,
    // readable comparison beats a sort with a comparator nobody checks.
    let best: Anchor | null = null;
    let bestDelta = Infinity;
    for (const anchor of anchors) {
      const delta = Math.abs(anchor.t - cue.t);
      if (delta <= tolerance && delta < bestDelta) {
        best = anchor;
        bestDelta = delta;
      }
    }

    if (!best) {
      unresolved.push(cue.id);
      if (cue.source !== "initial") {
        changes.push({
          id: cue.id,
          from: cue.t,
          to: cue.t,
          source: cue.source ?? "initial",
          evidence: "",
          skipped: "no measured event within tolerance; left as-is rather than moved to a guess",
        });
      } else {
        unchanged++;
      }
      continue;
    }

    if (Math.abs(best.t - cue.t) < 1e-6 && cue.source === best.kind) {
      unchanged++;
      continue;
    }
    changes.push({ id: cue.id, from: cue.t, to: best.t, source: best.kind, evidence: best.evidence });
  }

  const moved = changes.filter((change) => !change.skipped);
  if (!options.dryRun && moved.length) {
    for (const change of moved) {
      const cue = cues.find((entry) => entry.id === change.id);
      if (!cue) continue;
      cue.t = change.to;
      cue.source = change.source;
      cue.note = `${cue.note ? `${cue.note} ` : ""}settled by \`cvpw cues\` onto ${change.evidence}.`;
    }
    await mkdir(dirname(paths.cues), { recursive: true });
    await writeFile(paths.cues, `${JSON.stringify({ ...doc, cues }, null, 2)}\n`, "utf8");
  }

  return {
    root: options.root,
    changes,
    unchanged,
    unresolved,
    path: relPath(options.root, paths.cues),
    total: cues.length,
  };
}

export function cuesEnvelope(result: CuesResult, dryRun: boolean): Envelope {
  const moved = result.changes.filter((change) => !change.skipped);
  const skipped = result.changes.filter((change) => change.skipped);
  const summary = [
    `${result.total} cue(s) in ${result.path}`,
    dryRun ? `  would move ${moved.length}` : `  moved ${moved.length}`,
    `  ${result.unchanged} already settled, ${result.unresolved.length} with no measured evidence nearby`,
  ];
  for (const change of moved) {
    summary.push(`  ${change.id}: ${change.from.toFixed(4)} -> ${change.to.toFixed(4)}  (${change.source}: ${change.evidence})`);
  }
  for (const change of skipped) summary.push(`  ${change.id}: skipped — ${change.skipped}`);
  if (result.unresolved.length) {
    summary.push(
      "",
      `  ${result.unresolved.length} cue(s) are still guesses: ${result.unresolved.join(", ")}`,
      "  The `cues.settled` gate fails while any cue is `initial`. Either place them by ear and mark them",
      "  `manual`, or widen --tolerance if the analysis is close but not close enough.",
    );
  }
  return {
    ok: true,
    command: "cues",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: dryRun || moved.length === 0 ? [] : [join(result.root, result.path)],
    result,
    warnings: result.unresolved.map((id) => ({
      code: "cue.initial",
      message: `${id} has no measured evidence and remains a guess`,
    })),
    errors: [],
    summary,
  };
}
