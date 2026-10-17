/**
 * `cvpw handoff` — measuring the seams between blocks.
 *
 * A seam is where one block's shot ends and another's begins. `docs/CONTRACTS.md` §9 defines two classes and
 * the difference is the whole reason this command exists:
 *
 * - **`pixel`** — both sides read a shared contract and the pixels must match across the cut. The later shot
 *   does *not* own drawing it; the two just have to agree. Measurable, and this measures it.
 * - **`transition`** — the later shot owns the drawing entirely, so there is nothing to compare. The seam is
 *   a creative handoff, not a continuity requirement, and grading it would be grading a deliberate choice.
 *
 * The grade is mean absolute difference over the frame, with grain disabled — grain is per-frame noise, so
 * comparing two frames with it on measures the noise generator, not the seam. `docs/QA.md` sets the
 * thresholds: `< 0.03` fails, `< 0.01` is ok.
 *
 * **`handoff.json` is never written by this command.** `docs/CONTRACTS.md` §9 makes it an *authored*
 * contract: which shots meet, and which class the seam is, is an editorial decision. A tool that inferred it
 * from timeline adjacency would be right most of the time, and the times it was wrong would be the seams
 * nobody checked.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Browser, runBinary, startStaticServer } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import { ContractError, projectPaths, readJson, relPath, resolveTool, type Envelope } from "../shared.js";
import { prepareCapture } from "./render.js";
import { buildTimebase } from "./storyboard.js";

export interface SeamReport {
  id: string;
  kind: "pixel" | "transition";
  /** The frame index compared. Even for a `transition` seam, so a report can name it. */
  frame: number;
  /** Resolved seconds of the boundary instant. */
  t: number;
  /** Mean absolute difference, 0..1. Null for a transition seam, which has nothing to compare. */
  diff: number | null;
  grade: "ok" | "minor" | "fail" | "n/a";
  fromShot: string;
  toShot: string;
  note?: string;
}

export interface HandoffOptions {
  root: string;
  /** Only measure these seam ids. */
  only?: readonly string[];
}

export interface HandoffResult {
  root: string;
  seams: SeamReport[];
  ok: boolean;
  path: string;
  thresholds: { minor: number; fail: number };
  warnings: string[];
}

/**
 * The authored contract, in the shape `schemas/handoff.schema.json` declares.
 *
 * Note what it does NOT carry: a frame index. The seam is authored as a *time expression* (`t`), which is the
 * only form the framework permits for a moment — so a seam follows the music when the grid is re-analysed,
 * exactly like a cut does. Writing a frame number here would make the seam the one thing in the project that
 * silently stops pointing at the right instant.
 */
interface HandoffDocument {
  seams?: Array<{
    /** `<lastShotId>|<firstShotId>`, per the schema's pattern. */
    id: string;
    /** Time expression for the boundary instant. */
    t: string;
    mode: "pixel" | "transition";
    lastFrameOf: string;
    firstFrameOf: string;
    contract?: Record<string, unknown>;
    note?: string;
  }>;
}

export async function measureHandoffs(options: HandoffOptions): Promise<HandoffResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.handoff)) {
    throw new ContractError(
      `no handoff.json in ${options.root}\n` +
        `  handoff.json is AUTHORED, not generated: which shots meet and which class each seam is are ` +
        `editorial decisions. Write the seams you want measured, then run this again.`,
    );
  }

  const doc = (await readJson(paths.handoff)) as HandoffDocument;
  const seams = (doc.seams ?? []).filter((seam) => !options.only?.length || options.only.includes(seam.id));
  // Resolve each seam's time expression through the same timebase the timeline uses, so a seam and a cut
  // cannot disagree about when a moment is.
  const timebase = await buildTimebase(options.root).then((built) => built.timebase);
  const resolved = seams.map((seam) => {
    let frame = 0;
    let t0 = 0;
    try {
      t0 = timebase.resolve(seam.t).t;
      frame = timebase.frameIndex(t0);
    } catch (error) {
      throw new ContractError(
        `seam ${seam.id}: cannot resolve time ${JSON.stringify(seam.t)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { seam, frame, t0 };
  });
  if (seams.length === 0) {
    throw new ContractError(
      options.only?.length
        ? `none of the requested seams exist in handoff.json: ${options.only.join(", ")}`
        : "handoff.json declares no seams",
    );
  }

  const project = existsSync(paths.projectJson)
    ? ((await readJson(paths.projectJson)) as { budgets?: Record<string, number> })
    : {};
  // Thresholds from project.json::budgets, falling back to docs/QA.md's numbers. Never invented here.
  const fail = project.budgets?.["seamDiffFail"] ?? 0.03;
  const minor = project.budgets?.["seamDiffMinor"] ?? 0.01;

  const context = await prepareCapture(options.root);
  const pixelSeams = resolved.filter((entry) => entry.seam.mode === "pixel");
  const reports: SeamReport[] = [];
  const warnings: string[] = [];
  // Declared here, not inside the pixel block: the report needs it whether or not any seam was measured.
  let rendererName = "unknown";

  // Transitions need no rendering: there is nothing to compare, and saying so is more useful than a number.
  for (const entry of resolved) {
    const seam = entry.seam;
    if (seam.mode === "transition") {
      reports.push({
        id: seam.id,
        kind: "transition",
        frame: entry.frame,
        t: entry.t0,
        diff: null,
        grade: "n/a",
        fromShot: seam.lastFrameOf,
        toShot: seam.firstFrameOf,
        ...(seam.note ? { note: seam.note } : {}),
      });
    }
  }

  if (pixelSeams.length > 0) {
    const browserInfo = detectBrowser();
    if (!browserInfo) throw new ContractError("no chromium-family browser found, so no seam can be measured");

    const server = await startStaticServer({ root: context.root });
    const browser = await Browser.launch({
      executable: browserInfo.path,
      args: renderArgs(),
      tempRoot: context.tempRoot,
      timeoutMs: 90_000,
    });

    try {
      // Grain OFF: comparing two frames with per-frame noise measures the noise generator, not the seam.
      await browser.setViewport(context.width, context.height, context.dpr);
      await browser.navigate(`${server.origin}/${context.entry.replace(/^\/+/, "")}?capture&nograin`, 90_000);
      for (let i = 0; i < 600; i++) {
        if (await browser.evaluate("window.ready === true")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await browser
        .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
        .catch(() => undefined);

      // Both sides of each seam: the frame BEFORE the boundary belongs to A, the boundary frame to B. Comparing
      // only the boundary frame would compare a frame with nothing, which is how the first version graded a
      // legitimate pixel seam as unmeasurable.
      const wanted = new Set<number>();
      for (const entry of pixelSeams) {
        wanted.add(Math.max(0, entry.frame - 1));
        wanted.add(entry.frame);
      }
      rendererName = await browser
        .evaluate<string>(
          "(function(){var c=document.createElement(\"canvas\");var gl=c.getContext(\"webgl2\");" +
            "if(!gl)return \"no webgl2\";var e=gl.getExtension(\"WEBGL_debug_renderer_info\");" +
            "return e?String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER));})()",
        )
        .catch(() => "unknown");
      const frames = [...wanted];
      const last = Math.max(...frames);

      // Walk from zero, flushing each frame, for the reason `Browser.flush` documents: a frame's pixels
      // depend on how much queued work preceded it, so a seam measured by jumping to it measures the jump.
      let previous: Uint8Array | null = null;
      let previousIndex = -1;
      const diffs = new Map<number, { diff: number; vsIndex: number }>();

      for (let f = 0; f <= last; f++) {
        await browser.evaluate(`window.cvpw.renderFrame(${f} / ${context.fps})`);
        await browser.flush();
        if (!wanted.has(f)) continue;
        const png = await browser.screenshot({ format: "png", timeoutMs: 180_000 });
        const current = await decodeToRgb(png, context.width, context.height);
        if (previous) diffs.set(f, { diff: meanAbsDiff(previous, current), vsIndex: previousIndex });
        previous = current;
        previousIndex = f;
      }

      for (const entry of pixelSeams) {
        const seam = entry.seam;
        const frame = entry.frame;
        const measured = diffs.get(frame);
        const diff = measured?.diff ?? null;
        reports.push({
          id: seam.id,
          kind: "pixel",
          frame,
          t: entry.t0,
          diff,
          grade: diff === null ? "fail" : diff < minor ? "ok" : diff < fail ? "minor" : "fail",
          fromShot: seam.lastFrameOf,
          toShot: seam.firstFrameOf,
          ...(seam.note ? { note: seam.note } : {}),
        });
        if (diff === null) {
          warnings.push(`seam ${seam.id} could not be measured (no comparison frame)`);
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  }

  reports.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));
  const ok = reports.every((report) => report.grade === "ok" || report.grade === "n/a");

  const path = join(options.root, "handoff.report.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        $schema: "schemas/handoff-report.schema.json",
        schemaVersion: 1,
        run: {
          startedAt: new Date().toISOString(),
          // The schema's enum is on|off as strings, and `off` is not a preference: with grain on, two frames at
          // different times differ across the whole screen, so a seam compared with it on fails whatever the
          // film did.
          grain: "off",
          renderer: rendererName,
        },
        seams: reports.map((report) => ({
          id: report.id,
          t: report.t,
          diffAB: report.diff,
          grade:
            report.grade === "ok"
              ? "ok"
              : report.grade === "minor"
                ? "minor"
                : report.grade === "n/a"
                  ? "unchecked"
                  : "ALIGN",
          activeBefore: report.fromShot,
          activeAfter: report.toShot,
          ...(report.note ? { note: report.note } : {}),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { root: options.root, seams: reports, ok, path: relPath(options.root, path), thresholds: { minor, fail }, warnings };
}

/**
 * Mean absolute difference over the frame, 0..1.
 *
 * Over RGB triplets normalised to 0..1, so the number is comparable to the thresholds in `docs/QA.md` rather
 * than to a raw byte count nobody can interpret.
 */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / length / 255;
}

/** Decode a PNG to raw RGB with ffmpeg, because a second image decoder would be a second bug surface. */
async function decodeToRgb(png: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const ffmpeg = resolveTool("ffmpeg").path;
  if (!ffmpeg) throw new ContractError("ffmpeg was not found on PATH; set CVPW_FFMPEG to its full path");
  const { writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = join(tmpdir(), `cvpw-seam-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`);
  await writeFile(scratch, png);
  try {
    // `runBinary`, not `run`: rawvideo is not text, and decoding it would replace invalid sequences with
    // U+FFFD so the comparison would measure the decoder rather than the image.
    const result = await runBinary(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", scratch, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { timeoutMs: 120_000 },
    );
    if (result.code !== 0) {
      throw new ContractError(`ffmpeg could not decode a seam frame: ${result.stderr.trim().slice(0, 200)}`);
    }
    const expected = width * height * 3;
    if (result.stdout.length !== expected) {
      throw new ContractError(
        `decoded ${result.stdout.length} bytes but expected ${expected} for ${width}x${height} rgb24; ` +
          `the frame and the viewport disagree, so a seam diff would be meaningless`,
      );
    }
    return result.stdout;
  } finally {
    await rm(scratch, { force: true }).catch(() => undefined);
  }
}

export function handoffEnvelope(result: HandoffResult): Envelope {
  const summary = [`measured ${result.seams.length} seam(s) -> ${result.path}`];
  for (const seam of result.seams) {
    const grade = seam.grade === "ok" ? "ok  " : seam.grade === "n/a" ? "n/a " : "FAIL";
    const value = seam.diff === null ? "(transition: nothing to compare)" : seam.diff.toFixed(5);
    summary.push(`  ${grade}  ${seam.id.padEnd(16)} frame ${String(seam.frame).padStart(4)}  ${value}`);
  }
  summary.push(
    "",
    `  thresholds: minor < ${result.thresholds.minor}, fail >= ${result.thresholds.fail} (docs/QA.md, project budgets)`,
    "  grain is OFF for this measurement: with it on you would be measuring the noise generator.",
  );
  for (const warning of result.warnings) summary.push(`  warning: ${warning}`);
  return {
    ok: result.ok,
    command: "handoff",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [join(result.root, result.path)],
    result,
    warnings: result.warnings.map((message) => ({ code: "handoff", message })),
    errors: result.seams
      .filter((seam) => seam.grade === "fail")
      .map((seam) => ({ code: "seam.fail", message: `${seam.id} at frame ${seam.frame}: ${seam.diff?.toFixed(4) ?? "unmeasured"}` })),
    summary,
  };
}

export { mkdir };
