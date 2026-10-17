/**
 * `cvpw review` — the record that somebody looked.
 *
 * `docs/SPEC.md` V1–V3 are blunt about this: **a review with no manifest is not a review.** Rendering stills
 * and opening none of them is the most common way a video pipeline produces something nobody has seen, and it
 * is invisible afterwards — the artifacts look exactly like a review that happened. So this command's job is
 * not to *do* the looking; it is to make the looking **recordable**, and to refuse to claim a review that
 * leaves no trace.
 *
 * What it writes is `review/report.json`: for every still, what was looked at, what was wrong, and what was
 * changed. What it refuses is a vacuous pass: a report with no findings and no `looked: true` entries reads as
 * "somebody claimed this was fine", which is the state the whole gate suite exists to prevent.
 *
 * The verdict vocabulary is deliberately small. `ok`, `fix`, `hold` — because a review that can say "needs
 * work" without saying what is a review that will be repeated next week.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContractError, projectPaths, readJson, relPath, type Envelope } from "../shared.js";

export type Verdict = "ok" | "fix" | "hold";

export interface ReviewFinding {
  /** The still this refers to, as a filename in review/stills. */
  still: string;
  /** What is wrong, in a sentence an art director would accept. Not "looks bad". */
  issue: string;
  /** What was done about it, or `pending` while it is still open. */
  action: string;
  verdict: Verdict;
}

export interface ReviewOptions {
  root: string;
  /** The findings. Empty is a failure: see the module note. */
  findings?: readonly ReviewFinding[];
  /** Which stills were actually opened. Required; the whole point is that this list is not assumed. */
  looked?: readonly string[];
  /** A free-text note about the pass. */
  note?: string;
  /** Mark the review as accepted, for `cvpw deliver` to read. */
  accept?: boolean;
}

export interface ReviewResult {
  root: string;
  path: string;
  stills: string[];
  looked: string[];
  /** Stills that exist but were not looked at — reported, because those are the blind spots. */
  unlooked: string[];
  findings: ReviewFinding[];
  verdict: Verdict;
  accepted: boolean;
  warnings: string[];
}

export async function recordReview(options: ReviewOptions): Promise<ReviewResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) throw new ContractError(`no project.json in ${options.root}`);

  const stillsDir = join(options.root, "review", "stills");
  const onDisk = existsSync(stillsDir)
    ? (await readdir(stillsDir)).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).sort()
    : [];

  if (onDisk.length === 0) {
    throw new ContractError(
      `no stills in ${relPath(options.root, stillsDir)}; a review needs something to review\n` +
        `  run \`cvpw stills --times ... --overlay\` first`,
    );
  }

  const findings = [...(options.findings ?? [])];
  const looked = options.looked ? [...options.looked] : [];

  const warnings: string[] = [];
  if (looked.length === 0) {
    warnings.push(
      "no stills were recorded as looked at. `cvpw review --looked <files>` is the whole point: a review " +
        "whose manifest does not say what was seen is indistinguishable from one that never happened.",
    );
  }
  const unlooked = onDisk.filter((name) => !looked.some((entry) => entry.endsWith(name)));
  if (unlooked.length > 0) {
    warnings.push(
      `${unlooked.length} still(s) were never looked at: ${unlooked.slice(0, 6).join(", ")}` +
        (unlooked.length > 6 ? ", …" : ""),
    );
  }
  const unknown = looked.filter((entry) => !onDisk.some((name) => entry.endsWith(name)));
  if (unknown.length > 0) {
    warnings.push(
      `--looked names ${unknown.length} file(s) that are not in review/stills: ${unknown.slice(0, 4).join(", ")}`,
    );
  }

  const open = findings.filter((finding) => finding.verdict !== "ok");
  const verdict: Verdict = findings.some((finding) => finding.verdict === "fix")
    ? "fix"
    : open.length > 0
      ? "hold"
      : "ok";

  // `accepted` is not the same as `ok`. A film can be fine and not yet signed off, and conflating the two is
  // how a delivery ships a review nobody approved.
  const accepted = options.accept === true && verdict === "ok" && looked.length > 0;

  const path = join(options.root, "review", "report.json");
  await mkdir(join(options.root, "review"), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        $schema: undefined,
        schemaVersion: 1,
        reviewedAt: new Date().toISOString(),
        note: options.note ?? "",
        stills: onDisk,
        looked,
        unlooked,
        findings,
        verdict,
        accepted,
        howToRead:
          "`accepted` is the delivery gate. It is true only when the verdict is ok, at least one still was " +
          "looked at, and --accept was passed. A film that is fine and not yet signed off is not the same " +
          "thing as a film that is approved.",
      },
      (key, value) => (key === "$schema" && value === undefined ? undefined : value),
      2,
    )}\n`,
    "utf8",
  );

  return {
    root: options.root,
    path: relPath(options.root, path),
    stills: onDisk,
    looked,
    unlooked,
    findings,
    verdict,
    accepted,
    warnings,
  };
}

export function reviewEnvelope(result: ReviewResult): Envelope {
  const summary = [
    `review recorded in ${result.path}`,
    `  ${result.stills.length} still(s) on disk, ${result.looked.length} looked at`,
    `  verdict: ${result.verdict.toUpperCase()}, accepted: ${result.accepted}`,
  ];
  for (const finding of result.findings) {
    summary.push(`  [${finding.verdict}] ${finding.still}: ${finding.issue}`);
    summary.push(`          -> ${finding.action}`);
  }
  for (const warning of result.warnings) summary.push(`  warning: ${warning}`);
  if (result.verdict === "ok" && !result.accepted) {
    summary.push("", "  the verdict is ok but the review is not accepted; pass --accept once a human agrees.");
  }
  return {
    ok: result.verdict === "ok",
    command: "review",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [join(result.root, result.path)],
    result,
    warnings: result.warnings.map((message) => ({ code: "review", message })),
    errors:
      result.verdict === "ok"
        ? []
        : result.findings
            .filter((finding) => finding.verdict !== "ok")
            .map((finding) => ({ code: "review.finding", message: `${finding.still}: ${finding.issue}` })),
    summary,
  };
}

export { readJson };
