/**
 * `cvpw new` — scaffold a project from `templates/project`.
 *
 * A project is a directory outside this repository, containing everything needed to render: its own
 * engine, its own timeline, its own copy of the kernel. That last part deserves an explanation, because
 * vendoring a build output looks like a mistake and is not one:
 *
 *  - A render drives a browser against a **static file server rooted at the project**. A relative import
 *    from inside the project to `../../packages/kernel/dist/...` would be outside that root, so the page
 *    could not load it and the server would have to be widened to serve the framework repository — which
 *    would mean a project is not self-contained and cannot be moved, copied, or handed to anyone.
 *  - The kernel is the *runtime* of a project, and a runtime belongs with the thing that runs on it. The
 *    source of truth stays in the framework; the copy is a deploy artifact, refreshed by `cvpw link`.
 *  - It is recorded with its provenance (`vendor/kernel/PROVENANCE.json`) so a stale copy is detectable
 *    rather than a silent mismatch between what an author read and what the browser ran.
 *
 * The alternative — publish the kernel and `npm install` it — is right for a mature framework and wrong
 * for one whose API changes weekly, because it puts a publish step between "I fixed the engine" and "my
 * project has the fix".
 */

import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { ContractError, UsageError, frameworkRoot, log, relPath, sha256, type Envelope } from "../shared.js";

/** Paths the template contains that must NOT be copied: they are created per project, or never. */
const SKIP = new Set(["node_modules", "vendor", "analysis", "review", "render", "audio", "lyrics", ".git"]);

export interface NewOptions {
  dir: string;
  song?: string;
  lyrics?: string;
  template?: string;
  force?: boolean;
  /** Skip vendoring the kernel. The project will not render until `cvpw link` is run. */
  noVendor?: boolean;
}

export interface NewResult {
  root: string;
  files: number;
  vendored: { kernel: string; files: number; hash: string } | null;
  imported: { song?: string; lyrics?: string };
  nextSteps: string[];
}

export async function scaffold(options: NewOptions): Promise<NewResult> {
  const root = resolve(options.dir);
  const templateName = options.template ?? "project";
  const templateDir = join(frameworkRoot(), "templates", templateName);

  if (!existsSync(templateDir)) {
    throw new ContractError(
      `no template at ${templateDir}\n` +
        `  available: ${(await readdir(join(frameworkRoot(), "templates")).catch(() => [])).join(", ") || "(none)"}`,
    );
  }

  // Refuse a non-empty target. Scaffolding over somebody's work is the one mistake in this command that
  // cannot be undone by re-running it.
  if (existsSync(root)) {
    const entries = (await readdir(root)).filter((name) => name !== ".git");
    if (entries.length > 0 && !options.force) {
      throw new UsageError(
        `refusing to write into ${root}: it is not empty (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`,
        "choose an empty directory, or pass --force to write into this one",
      );
    }
  }

  await mkdir(root, { recursive: true });
  const files = await copyTree(templateDir, root, templateDir);

  // The template's `project.json` carries the id "my-film"; give the project its own name so two
  // scaffolded films do not produce identically named outputs.
  const projectPath = join(root, "project.json");
  if (existsSync(projectPath)) {
    const doc = JSON.parse(await readFile(projectPath, "utf8")) as { id?: string };
    doc.id = basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "film";
    await writeFile(projectPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }

  const vendored = options.noVendor ? null : await vendorKernel(root);

  const imported: NewResult["imported"] = {};
  if (options.song) imported.song = await importSong(root, options.song);
  if (options.lyrics) imported.lyrics = await importLyrics(root, options.lyrics);

  return {
    root,
    files,
    vendored,
    imported,
    nextSteps: [
      options.song
        ? `cvpw analyze        # -> analysis/audio.json, then LOOK at analysis/overview.png`
        : `put your audio at audio/song.wav, then run \`cvpw analyze\``,
      `write docs/BRIEF.md and docs/CONCEPT.md before writing any scene code`,
      `cvpw storyboard      # resolves every time expression and checks coverage`,
      `cvpw stills --times 0,2,4 --overlay   # then LOOK at the PNGs`,
      `cvpw render --workers 2`,
      `cvpw check --profile deliver`,
    ],
  };
}

/** Copy a tree, honouring the skip list, and report how many files were written. */
async function copyTree(from: string, to: string, templateRoot: string): Promise<number> {
  let written = 0;
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(target, { recursive: true });
      written += await copyTree(source, target, templateRoot);
    } else {
      await copyFile(source, target);
      written++;
    }
  }
  void templateRoot;
  return written;
}

/**
 * Copy the kernel's build output into `vendor/kernel`.
 *
 * `dist/` is required rather than built on demand: a scaffold that silently ran a build would make
 * `cvpw new` take thirty seconds and fail differently on a machine without a toolchain. The error names
 * the command instead.
 */
/**
 * Vendor the framework kernel into an existing project.
 *
 * `cvpw new` does this while scaffolding; this is the same operation for a project that already exists — one
 * cloned from a repository, or an example committed without its build output. A project keeps `vendor/kernel`
 * out of version control because it is a build artifact, and regenerates it here.
 */
export async function vendorKernel(root: string): Promise<{ kernel: string; files: number; hash: string }> {
  if (!existsSync(join(root, "project.json"))) {
    throw new ContractError(
      `no project.json in ${root}; \`cvpw link\` vendors the kernel into an existing project\n` +
        `  use \`cvpw new <dir>\` to create one`,
    );
  }
  const source = join(frameworkRoot(), "packages", "kernel");
  const dist = join(source, "dist");
  if (!existsSync(join(dist, "index.js"))) {
    throw new ContractError(
      `the kernel is not built: ${join(dist, "index.js")} does not exist\n` +
        `  run \`pnpm build\` in ${frameworkRoot()}, then re-run this command`,
    );
  }

  const target = join(root, "vendor", "kernel");
  await mkdir(target, { recursive: true });
  await cp(dist, join(target, "dist"), { recursive: true });
  await copyFile(join(source, "package.json"), join(target, "package.json"));
  if (existsSync(join(source, "README.md"))) {
    await copyFile(join(source, "README.md"), join(target, "README.md"));
  }

  const files = await countFiles(join(target, "dist"));
  const index = await readFile(join(target, "dist", "index.js"));
  const hash = sha256(index).slice(0, 16);

  // Provenance, so a stale copy is detectable. Without this a project that was scaffolded last month
  // silently runs last month's kernel, and the mismatch surfaces as a bug in scene code.
  await writeFile(
    join(target, "PROVENANCE.json"),
    `${JSON.stringify(
      {
        note: "Copied from the framework by `cvpw new`. Do not edit; re-run `cvpw link` to refresh.",
        from: relPath(frameworkRoot(), source),
        indexHash: hash,
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { kernel: target, files, hash };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
    else count++;
  }
  return count;
}

/**
 * Copy the song into the project.
 *
 * A WAV is copied as-is. Anything else is **copied without conversion** and reported, because the analysis
 * can decode it through ffmpeg and converting it here would silently replace the operator's reference with
 * a re-encode. The framework never rewrites the source (`docs/SPEC.md` P6).
 */
async function importSong(root: string, song: string): Promise<string> {
  const source = resolve(song);
  if (!existsSync(source)) throw new UsageError(`no such audio file: ${source}`);
  const info = await stat(source);
  if (info.isDirectory()) throw new UsageError(`${source} is a directory, not an audio file`);

  const extension = source.slice(source.lastIndexOf(".")).toLowerCase() || ".wav";
  const target = join(root, "audio", `song${extension}`);
  await mkdir(join(root, "audio"), { recursive: true });
  await copyFile(source, target);

  const projectPath = join(root, "project.json");
  const doc = JSON.parse(await readFile(projectPath, "utf8")) as {
    audio?: { file?: string };
    timebase?: { mode?: string };
  };
  doc.audio = { ...(doc.audio ?? {}), file: `audio/song${extension}` };
  await writeFile(projectPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  if (extension !== ".wav") {
    log.warn(
      `${extension} copied without conversion. The analysis decodes it through ffmpeg; the source is never rewritten.`,
    );
  }
  return relPath(root, target);
}

/** Copy lyrics in, without deciding whether they may be published. That is `project.json::lyricsText`. */
async function importLyrics(root: string, lyrics: string): Promise<string> {
  const source = resolve(lyrics);
  if (!existsSync(source)) throw new UsageError(`no such lyrics file: ${source}`);
  const extension = source.slice(source.lastIndexOf(".")).toLowerCase() || ".txt";
  const target = join(root, "lyrics", `lyrics${extension}`);
  await mkdir(join(root, "lyrics"), { recursive: true });
  await copyFile(source, target);
  return relPath(root, target);
}

export function describeNew(result: NewResult): string[] {
  return [
    `scaffolded ${result.root}`,
    `  ${result.files} file(s) from the template`,
    result.vendored
      ? `  kernel vendored: ${result.vendored.files} file(s), index hash ${result.vendored.hash}`
      : "  kernel NOT vendored (--no-vendor); the project cannot render until `cvpw link` runs",
    result.imported.song ? `  audio: ${result.imported.song}` : "  audio: none (put one at audio/song.wav)",
    result.imported.lyrics ? `  lyrics: ${result.imported.lyrics}` : "  lyrics: none",
  ];
}

export type { Envelope };
