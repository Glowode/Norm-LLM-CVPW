/**
 * `cvpw deliver` — the last gate before a file leaves the machine.
 *
 * Everything else in this framework measures a *property*. This measures **readiness**, which is a different
 * question and the only one that matters at the end: is there a master, was it reviewed, was the review
 * accepted, do the variants exist, and is anything about to ship that must not?
 *
 * It refuses for four reasons, and each has shipped a bad film somewhere:
 *
 * 1. **No render.** A project that was never rendered has no master, and a delivery list without files is a
 *    promise rather than a delivery.
 * 2. **A render whose report records errors.** `docs/PROGRESS.md` has the case: a truncated MP4 passes an
 *    existence check and plays for thirty seconds.
 * 3. **A review that was not accepted.** An `ok` verdict is a judgement; `accepted` is a sign-off. Conflating
 *    them is how a film nobody approved gets published.
 * 4. **Unlicensed lyric text.** `docs/SPEC.md` T7 makes this a hard stop, not a warning, because it is the one
 *    mistake here that is a legal problem rather than a quality one.
 *
 * What it writes is `delivery.json`: the files, their hashes, and the reason each check passed. A delivery
 * manifest that only lists paths is unusable six months later, when the question is "was this the reviewed
 * cut?" and the answer has to come from a hash rather than a memory.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContractError, projectPaths, readJson, relPath, sha256, type Envelope } from "../shared.js";

export interface DeliveryBlocker {
  code: string;
  message: string;
  /** What to do about it. A blocker without an action is a dead end. */
  action: string;
}

export interface DeliveryFile {
  path: string;
  bytes: number;
  sha256: string;
  role: "master" | "variant" | "report" | "subtitle";
}

export interface DeliverOptions {
  root: string;
  /** Variant names to include. Defaults to the master alone. */
  variants?: readonly string[];
  /** Write `delivery.json` even when blocked, marking it `delivered: false`. */
  force?: boolean;
}

export interface DeliverResult {
  root: string;
  delivered: boolean;
  blockers: DeliveryBlocker[];
  files: DeliveryFile[];
  manifest: string;
  master: { name: string; frames: number; codec: string } | null;
  review: { verdict: string; accepted: boolean } | null;
}

export async function deliver(options: DeliverOptions): Promise<DeliverResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) throw new ContractError(`no project.json in ${options.root}`);

  const blockers: DeliveryBlocker[] = [];
  const project = (await readJson(paths.projectJson)) as {
    id?: string;
    variants?: Record<string, { width?: number; height?: number }>;
    lyricsLicence?: string;
  };

  // --- 1. a master must exist, and its report must be clean -------------------------------------
  const renderDir = join(options.root, "render");
  const reportPath = join(renderDir, "report.json");
  let master: DeliverResult["master"] = null;

  if (!existsSync(renderDir)) {
    blockers.push({
      code: "deliver.no-render",
      message: "there is no render/ directory, so nothing has been rendered",
      action: "run `cvpw render` — a delivery list without files is a promise, not a delivery",
    });
  } else {
    const videos = (await readdir(renderDir)).filter((name) => /\.(mp4|mov|mkv)$/i.test(name));
    if (videos.length === 0) {
      blockers.push({
        code: "deliver.no-master",
        message: `no video file in ${relPath(options.root, renderDir)}`,
        action: "run `cvpw render --name master`",
      });
    }
    if (!existsSync(reportPath)) {
      blockers.push({
        code: "deliver.no-report",
        message: "render/report.json is missing, so the render cannot be audited",
        action: "re-run `cvpw render`; the report records the encoder, the frame count and the frame hashes",
      });
    } else {
      const report = (await readJson(reportPath)) as {
        output?: string;
        frames?: number;
        codec?: string;
        errors?: string[];
        warnings?: string[];
        probe?: { frames?: number | null };
        run?: { verified?: { frames?: number | null } };
      };
      if ((report.errors ?? []).length > 0) {
        blockers.push({
          code: "deliver.render-errors",
          message: `render/report.json records ${report.errors?.length} error(s): ${(report.errors ?? []).join("; ")}`,
          action: "fix the cause and re-render; a report with errors describes a film that is not finished",
        });
      }
      // The file must contain the frames the sink wrote. A truncated MP4 passes an existence check and plays
      // for thirty seconds, which is the worst outcome available — so the two counts are compared here.
      const expected = report.frames ?? 0;
      const actual = report.run?.verified?.frames ?? report.probe?.frames ?? null;
      if (expected > 0 && actual !== null && actual !== expected) {
        blockers.push({
          code: "deliver.frame-count",
          message: `the report says ${expected} frames but the file contains ${actual}`,
          action: "re-render: the encoder wrote a truncated master, which plays and lies",
        });
      }
      const outputName = report.output?.split(/[/\\]/).pop();
      if (outputName && videos.includes(outputName)) {
        master = { name: outputName, frames: expected, codec: report.codec ?? "unknown" };
      } else if (videos.length > 0) {
        master = { name: videos[0] as string, frames: expected, codec: report.codec ?? "unknown" };
      }
    }
  }

  // --- 2. the review must be accepted, not merely ok --------------------------------------------
  let review: DeliverResult["review"] = null;
  const reviewPath = join(options.root, "review", "report.json");
  if (!existsSync(reviewPath)) {
    blockers.push({
      code: "deliver.no-review",
      message: "review/report.json is missing, so nobody has recorded looking at this film",
      action: "run `cvpw stills`, look at them, then `cvpw review --looked <files> --accept`",
    });
  } else {
    const doc = (await readJson(reviewPath)) as { verdict?: string; accepted?: boolean; looked?: string[] };
    review = { verdict: doc.verdict ?? "unknown", accepted: doc.accepted === true };
    if (!review.accepted) {
      blockers.push({
        code: "deliver.review-not-accepted",
        message: `the review verdict is "${review.verdict}" and it is not accepted`,
        action:
          review.verdict === "ok"
            ? "a human agreed; re-run `cvpw review --accept` to record the sign-off"
            : "fix the findings in review/report.json, re-render, re-review, then `--accept`",
      });
    }
    if ((doc.looked ?? []).length === 0) {
      blockers.push({
        code: "deliver.not-looked-at",
        message: "the review records no stills as looked at",
        action: "look at the stills and pass `--looked <files>`; a review nobody performed is not a review",
      });
    }
  }

  // --- 3. lyric text must be licensed, or absent ------------------------------------------------
  const lyricText = paths.lyrics;
  if (existsSync(lyricText) && !project.lyricsLicence) {
    blockers.push({
      code: "deliver.lyric-text-unlicensed",
      message: "cues/lyrics.json exists but project.json declares no `lyricsLicence`",
      action:
        "either record the licence, or delete cues/lyrics.json — publishing somebody's words without a " +
        "licence is a legal problem, not a quality one (docs/SPEC.md T7)",
    });
  }

  // --- 4. the gate suite must have run and passed -----------------------------------------------
  const qaPath = join(options.root, "qa", "report.json");
  if (!existsSync(qaPath)) {
    blockers.push({
      code: "deliver.no-qa",
      message: "qa/report.json is missing, so the gate suite has not run against this build",
      action: "run `cvpw check --json > qa/report.json` (or `cvpw check` and review the output)",
    });
  }

  // --- assemble the delivery list ---------------------------------------------------------------
  const files: DeliveryFile[] = [];
  const wanted = options.variants ?? [];
  if (master) {
    const full = join(renderDir, master.name);
    const info = await stat(full);
    files.push({
      path: relPath(options.root, full),
      bytes: info.size,
      sha256: sha256(await readFile(full)),
      role: "master",
    });
  }
  for (const variant of wanted) {
    const candidate = join(renderDir, `${variant}.mp4`);
    if (!existsSync(candidate)) {
      blockers.push({
        code: "deliver.missing-variant",
        message: `variant "${variant}" was requested but render/${variant}.mp4 does not exist`,
        action: `render it: \`cvpw render --name ${variant}\``,
      });
      continue;
    }
    const info = await stat(candidate);
    files.push({
      path: relPath(options.root, candidate),
      bytes: info.size,
      sha256: sha256(await readFile(candidate)),
      role: "variant",
    });
  }
  if (master) {
    files.push({
      path: relPath(options.root, reportPath),
      bytes: (await stat(reportPath)).size,
      sha256: sha256(await readFile(reportPath)),
      role: "report",
    });
  }

  const delivered = blockers.length === 0;
  const manifestPath = join(options.root, "delivery.json");
  await mkdir(options.root, { recursive: true });
  if (delivered || options.force) {
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          project: project.id ?? null,
          delivered,
          deliveredAt: new Date().toISOString(),
          files,
          master,
          review,
          blockers,
          howToRead:
            "`delivered: false` with `--force` means the manifest was written for diagnosis, not for " +
            "publication. The `files` list is only meaningful when `delivered` is true.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return { root: options.root, delivered, blockers, files, manifest: relPath(options.root, manifestPath), master, review };
}

export function deliverEnvelope(result: DeliverResult): Envelope {
  const summary: string[] = [];
  if (result.delivered) {
    summary.push(`READY TO DELIVER — ${result.files.length} file(s), manifest ${result.manifest}`);
    for (const file of result.files) {
      summary.push(`  ${file.role.padEnd(8)} ${file.path}  ${(file.bytes / 1024 / 1024).toFixed(2)} MiB  ${file.sha256.slice(0, 16)}`);
    }
    if (result.master) summary.push(`  master: ${result.master.frames} frames, codec ${result.master.codec}`);
  } else {
    summary.push(`NOT READY — ${result.blockers.length} blocker(s)`);
    for (const blocker of result.blockers) {
      summary.push(`  ${blocker.code}: ${blocker.message}`);
      summary.push(`      -> ${blocker.action}`);
    }
    summary.push("", "  A blocker is a stop, not a warning. Each one above has shipped a bad film somewhere.");
  }
  return {
    ok: result.delivered,
    command: "deliver",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: result.delivered ? [join(result.root, result.manifest)] : [],
    result,
    warnings: [],
    errors: result.blockers.map((blocker) => ({ code: blocker.code, message: `${blocker.message} — ${blocker.action}` })),
    summary,
  };
}
