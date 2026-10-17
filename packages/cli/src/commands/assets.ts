/**
 * `cvpw assets` — validate the asset manifest.
 *
 * Asset *generation* is phase 2 and is not here. What is here is the gate: every file a scene loads must be
 * declared, present, hash-verified, and carry a `licence` and a `source`.
 *
 * Those last two are not bureaucracy. An asset without a licence is an asset nobody can publish, and finding
 * that out at delivery means re-rendering the film. An asset without a source cannot be replaced or checked,
 * so the same frame gets regenerated differently next month and nobody knows why it changed.
 *
 * **A project with no assets is valid.** Not every film has any — the reference template is entirely
 * procedural — so a missing manifest is reported as "nothing to validate" rather than as a failure. A gate
 * that fails on a legitimate project is a gate that gets switched off.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ContractError, projectPaths, readJson, relPath, sha256, type Envelope } from "../shared.js";

export interface AssetProblem {
  code: string;
  asset: string;
  message: string;
}

export interface AssetEntry {
  path?: string;
  sha256?: string;
  licence?: string;
  source?: string;
  note?: string;
}

export interface AssetsResult {
  root: string;
  manifest: string | null;
  declared: number;
  verified: number;
  problems: AssetProblem[];
  /** Declared files that are present and hash-match, with their real hashes. */
  ok: Array<{ path: string; sha256: string }>;
}

export async function validateAssets(root: string): Promise<AssetsResult> {
  const paths = projectPaths(root);
  if (!existsSync(paths.projectJson)) throw new ContractError(`no project.json in ${root}`);

  const manifestPath = join(root, "assets", "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      root,
      manifest: null,
      declared: 0,
      verified: 0,
      problems: [],
      ok: [],
    };
  }

  const doc = (await readJson(manifestPath)) as { assets?: AssetEntry[]; entries?: AssetEntry[] };
  const entries = doc.assets ?? doc.entries ?? [];

  const problems: AssetProblem[] = [];
  const ok: AssetsResult["ok"] = [];

  for (const entry of entries) {
    const asset = entry.path ?? "(unnamed)";
    if (!entry.path) {
      problems.push({ code: "asset.nameless", asset, message: "an entry has no `path`" });
      continue;
    }
    if (!entry.licence) {
      problems.push({
        code: "asset.no-licence",
        asset,
        message: "no `licence`: an asset nobody may publish is one that has to be replaced at delivery",
      });
    }
    if (!entry.source) {
      problems.push({
        code: "asset.no-source",
        asset,
        message: "no `source`: without one the asset cannot be regenerated or checked, and next month's render differs for no recorded reason",
      });
    }

    const full = join(root, entry.path);
    if (!existsSync(full)) {
      problems.push({ code: "asset.missing", asset, message: `declared but not on disk: ${entry.path}` });
      continue;
    }
    const bytes = await readFile(full);
    const actual = sha256(bytes);
    if (entry.sha256 && entry.sha256 !== actual) {
      problems.push({
        code: "asset.sha256-mismatch",
        asset,
        message: `declared sha256 ${entry.sha256.slice(0, 16)}… but the file hashes to ${actual.slice(0, 16)}…`,
      });
      continue;
    }
    if (!entry.sha256) {
      problems.push({
        code: "asset.no-hash",
        asset,
        message: `no pinned sha256. Record ${actual} so a changed asset is detectable rather than invisible`,
      });
    }
    ok.push({ path: entry.path, sha256: actual });
  }

  // An undeclared file in assets/ is reported, because a scene that loads it is loading something nobody
  // reviewed — but only as a problem if the directory has a manifest at all, which it does here.
  const { readdir } = await import("node:fs/promises");
  const onDisk = (await readdir(join(root, "assets"), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relPath(join(root, "assets"), join(entry.parentPath ?? (entry as unknown as { path: string }).path ?? "", entry.name)))
    .map((path) => `assets/${path.replace(/\\/g, "/")}`)
    .filter((path) => !path.endsWith("manifest.json"));
  const declaredPaths = new Set(entries.map((entry) => (entry.path ?? "").replace(/\\/g, "/")));
  for (const path of onDisk) {
    if (!declaredPaths.has(path)) {
      problems.push({
        code: "asset.undeclared",
        asset: path,
        message: "present in assets/ but not in the manifest, so nothing recorded its licence or origin",
      });
    }
  }

  return {
    root,
    manifest: relPath(root, manifestPath),
    declared: entries.length,
    verified: ok.length,
    problems,
    ok,
  };
}

export function assetsEnvelope(result: AssetsResult): Envelope {
  const summary =
    result.manifest === null
      ? [
          "no assets/manifest.json — nothing to validate",
          "  a project with no asset files is valid; this template is entirely procedural",
        ]
      : [
          `${result.manifest}: ${result.declared} asset(s), ${result.verified} verified`,
          ...(result.problems.length === 0
            ? ["  every declared asset is present, hash-matched, licensed and sourced"]
            : [`  ${result.problems.length} problem(s)`]),
          ...result.problems.slice(0, 12).map((problem) => `  ${problem.code}: ${problem.asset} — ${problem.message}`),
        ];
  return {
    ok: result.problems.length === 0,
    command: "assets",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [],
    result,
    warnings: [],
    errors: result.problems.map((problem) => ({
      code: problem.code,
      message: `${problem.asset}: ${problem.message}`,
    })),
    summary,
  };
}
// --- generation -----------------------------------------------------------------------------------

/**
 * `cvpw assets generate` — write the files a manifest declares, and record what came out.
 *
 * The manifest could already name a `generator` and a `prompt`; nothing read them, which is the same
 * declared-but-inert shape this project has now fixed six times. This is the reader.
 *
 * The determinism rule is enforced here rather than assumed: a generator that is a pure function of its declared
 * params produces the same bytes twice, and the command checks that by generating into a buffer twice and
 * comparing before it writes anything. An asset whose bytes depend on when it was generated cannot carry a
 * meaningful `sha256`, and `assets.manifest` would then fail at a random later date for no recorded reason.
 */
export interface GeneratedFile {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  deterministic: boolean;
}

export interface GenerateResult {
  written: GeneratedFile[];
  skipped: Array<{ id: string; reason: string }>;
  problems: Array<{ asset: string; message: string }>;
}

export async function generateAssets(root: string): Promise<GenerateResult> {
  const { generate } = await import("@cvpw/kernel");
  const { encodePng } = await import("../png.js");
  const { createHash } = await import("node:crypto");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  const manifestPath = join(root, "assets", "manifest.json");
  const result: GenerateResult = { written: [], skipped: [], problems: [] };
  let dirty = false;
  if (!existsSync(manifestPath)) return result;

  const manifest = (await readJson(manifestPath)) as {
    assets?: Array<{ id?: string; path?: string; generator?: string; params?: Record<string, unknown> }>;
  };

  for (const asset of manifest.assets ?? []) {
    const id = asset.id ?? "(unnamed)";
    if (!asset.generator) {
      result.skipped.push({ id, reason: "no `generator` — this asset is supplied by hand" });
      continue;
    }
    if (asset.generator !== "paper" && asset.generator !== "flat") {
      result.problems.push({
        asset: id,
        message: `unknown generator ${JSON.stringify(asset.generator)}; this framework implements "paper" and "flat"`,
      });
      continue;
    }
    if (!asset.path) {
      result.problems.push({ asset: id, message: "no `path`, so there is nowhere to write the generated file" });
      continue;
    }

    const params = asset.params ?? {};
    const first = generate(asset.generator, params);
    const second = generate(asset.generator, params);
    const a = encodePng(first.rgba, first.width, first.height);
    const b = encodePng(second.rgba, second.width, second.height);
    const deterministic = a.equals(b);
    if (!deterministic) {
      result.problems.push({
        asset: id,
        message:
          "generating the same params twice produced different bytes, so no sha256 of this asset can be trusted. " +
          "A generator must be a pure function of its declared params (docs/SPEC.md D1-D4).",
      });
      continue;
    }

    const target = join(root, asset.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, a);
    const sha256 = createHash("sha256").update(a).digest("hex");
    (asset as { sha256?: string }).sha256 = sha256;
    dirty = true;
    result.written.push({ id, path: asset.path, bytes: a.length, sha256, deterministic });
  }

  // Write the manifest back with the hashes it now pins. Without this the command closes half a loop: it produces
  // bytes and reports their hash, then `assets` immediately fails with `asset.no-hash` asking the author to paste
  // in the number the tool just computed. A tool that knows the answer must not ask the question.
  if (dirty) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return result;
}