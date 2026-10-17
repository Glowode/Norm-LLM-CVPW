/**
 * `cvpw sheet` — a contact sheet of stills, for looking at a whole film at once.
 *
 * The review loop in `docs/WORKFLOW.md` stage 6 depends on being able to see *shape*: where the film gets
 * loud, where it holds, whether every shot looks like it belongs to the same film. Twenty individual PNGs do
 * not show that; a grid of twenty does, in one glance.
 *
 * ffmpeg does the tiling, deliberately. Writing an image compositor here would be a second rendering path
 * with its own bugs, and the framework already refuses that trade everywhere else. The `tile` filter is
 * exactly the operation needed, and it is the same binary the encoder uses, so a machine that can render can
 * build a sheet.
 *
 * **One rule about labelling that matters.** Each cell is numbered and the numbers are written into the
 * manifest beside the time and shot ids, because a contact sheet without an index is a mood board: it shows
 * you that something is wrong and refuses to tell you where.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "@cvpw/render";

import { ContractError, UsageError, projectPaths, readJson, relPath, resolveTool, type Envelope } from "../shared.js";

export interface SheetOptions {
  root: string;
  /** Source directory of stills. Defaults to `review/stills`. */
  from?: string;
  /** Output file, relative to the project. */
  out?: string;
  /** Cells across. 4 by default: wide enough to read shape, narrow enough to keep cells legible. */
  columns?: number;
  /** Cell width in px. 480 keeps a 16:9 cell about 270 tall, so 4x5 is legible at 1:1. */
  cellWidth?: number;
}

export interface SheetResult {
  root: string;
  out: string;
  cells: number;
  columns: number;
  rows: number;
  /** Cell index to the still it came from, in reading order. */
  index: Array<{ cell: number; file: string; label: string; t: number | null; shots: string[] }>;
  bytes: number;
  warnings: string[];
}

export async function buildSheet(options: SheetOptions): Promise<SheetResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) throw new ContractError(`no project.json in ${options.root}`);

  const fromDir = join(options.root, options.from ?? "review/stills");
  if (!existsSync(fromDir)) {
    throw new ContractError(
      `no stills in ${relPath(options.root, fromDir)}\n` +
        `  run \`cvpw stills --times ... --overlay\` first: a contact sheet is made from stills, not instead of them`,
    );
  }

  const allNames = (await readdir(fromDir)).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).sort();

  // The stills manifest gives each image its time and shot ids. Without it a sheet is still useful for shape
  // but cannot be traced back to a shot, so its absence is a warning rather than a failure.
  const warnings: string[] = [];
  let manifest: { frames?: Array<{ file?: string; label?: string; t?: number; shots?: string[] }> } = {};
  const manifestPath = join(fromDir, "manifest.json");
  if (existsSync(manifestPath)) {
    manifest = (await readJson(manifestPath)) as typeof manifest;
  } else {
    warnings.push(
      `no manifest.json beside the stills, so the sheet cannot say which shot each cell belongs to. ` +
        `Re-run \`cvpw stills\` to get one.`,
    );
  }

  const byFile = new Map<string, { label: string; t: number | null; shots: string[] }>();
  for (const frame of manifest.frames ?? []) {
    if (!frame.file) continue;
    // The manifest stores project-relative paths; the sheet needs the basename to match a directory entry.
    const base = frame.file.split(/[/\\]/).pop() as string;
    byFile.set(base, {
      label: frame.label ?? base,
      t: typeof frame.t === "number" ? frame.t : null,
      shots: frame.shots ?? [],
    });
  }

  // **When a manifest exists, take exactly the files it lists.** The first version took every image in the
  // directory, so a sheet made after two `cvpw stills` runs silently included the previous run's stills —
  // cells that belong to a film that no longer exists, indistinguishable from current ones. A directory is
  // not a review set; the manifest is.
  const names = byFile.size > 0 ? allNames.filter((name) => byFile.has(name)) : allNames;
  if (byFile.size > 0 && allNames.length > byFile.size) {
    warnings.push(
      `${allNames.length - names.length} image(s) in ${relPath(options.root, fromDir)} are not in the manifest ` +
        `and were excluded — they are left over from an earlier run. Delete them, or re-run \`cvpw stills\`.`,
    );
  }
  if (names.length === 0) {
    throw new ContractError(`no images in ${relPath(options.root, fromDir)}; run \`cvpw stills\` first`);
  }

  const ffmpeg = resolveTool("ffmpeg").path;
  if (!ffmpeg) throw new ContractError("ffmpeg was not found on PATH; set CVPW_FFMPEG to its full path");

  const columns = Math.max(1, Math.min(options.columns ?? 4, names.length));
  const rows = Math.ceil(names.length / columns);
  const cellWidth = Math.max(120, options.cellWidth ?? 480);

  // ffmpeg needs a numbered sequence, so link/copy the chosen stills into a scratch directory with
  // contiguous indices. `image2` with a glob would also work but its ordering is locale-dependent, and a
  // sheet whose cells are shuffled is worse than no sheet.
  const scratch = join(options.root, "review", ".sheet-src");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  for (const [index, name] of names.entries()) {
    await copyFile(join(fromDir, name), join(scratch, `c${String(index).padStart(4, "0")}.png`));
  }

  const outRel = options.out ?? "review/sheet.png";
  const outPath = join(options.root, outRel);
  await mkdir(join(outPath, ".."), { recursive: true });

  const result = await run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "1",
      "-i",
      join(scratch, "c%04d.png"),
      "-vf",
      `scale=${cellWidth}:-2,tile=${columns}x${rows}:padding=8:margin=8:color=0x101018`,
      "-frames:v",
      "1",
      outPath,
    ],
    { timeoutMs: 300_000 },
  );
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);

  if (result.code !== 0 || !existsSync(outPath)) {
    throw new ContractError(
      `ffmpeg could not build the contact sheet (exit ${result.code})\n` +
        `${result.stderr.trim().split("\n").filter(Boolean).slice(-4).join("\n") || "(no stderr)"}`,
    );
  }

  const { stat } = await import("node:fs/promises");
  const info = await stat(outPath);

  const index = names.map((name, cell) => {
    const entry = byFile.get(name);
    return {
      cell: cell + 1,
      file: relPath(options.root, join(fromDir, name)),
      label: entry?.label ?? name,
      t: entry?.t ?? null,
      shots: entry?.shots ?? [],
    };
  });

  // The index beside the sheet, so a cell number can be looked up without the terminal scrollback.
  await writeFile(
    join(options.root, "review", "sheet.json"),
    `${JSON.stringify(
      {
        note: "Cell numbering for review/sheet.png, reading left to right, top to bottom.",
        out: outRel,
        columns,
        rows,
        cells: index,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    root: options.root,
    out: outRel,
    cells: names.length,
    columns,
    rows,
    index,
    bytes: info.size,
    warnings,
  };
}

export function sheetEnvelope(result: SheetResult): Envelope {
  const summary = [
    `wrote ${result.out}  (${result.cells} cell(s), ${result.columns}x${result.rows})`,
    ...result.index
      .filter((entry) => entry.t !== null)
      .slice(0, 8)
      .map((entry) => `  cell ${String(entry.cell).padStart(2)}  ${entry.label.padEnd(10)} ${entry.shots.join("+")}`),
    result.index.length > 8 ? `  … and ${result.index.length - 8} more (see review/sheet.json)` : "",
    "",
    "LOOK AT IT. A contact sheet shows shape — where the film gets loud, where it holds, whether every shot",
    "looks like it belongs to the same film. That is the question stills cannot answer one at a time.",
  ].filter(Boolean);
  return {
    ok: true,
    command: "sheet",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [join(result.root, result.out), join(result.root, "review", "sheet.json")],
    result,
    warnings: result.warnings.map((message) => ({ code: "sheet", message })),
    errors: [],
    summary,
  };
}

export { UsageError };
