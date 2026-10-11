/**
 * Shared plumbing for the CLI: the JSON envelope, the exit codes, UTF-8 file I/O, and the
 * environment resolution that every external tool goes through.
 *
 * Two rules from `docs/SPEC.md` are implemented here and nowhere else:
 *
 * - **P1** — every command emits exactly one JSON envelope with `--json`, logs to stderr, and uses a
 *   meaningful exit code. That is what makes the framework usable by an agent that only knows how to
 *   run a command and read its output.
 * - **P4** — encoding is hostile. Every read and write specifies UTF-8, `PYTHONUTF8` and
 *   `PYTHONIOENCODING` are set for any Python we spawn, and every temp path handed to an external
 *   process is ASCII-only.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

// --- exit codes -----------------------------------------------------------------------------------

/**
 * Exit codes are part of the contract (`docs/SPEC.md` P1). A caller distinguishes "your artifacts are
 * broken" from "you typed the command wrong" without parsing prose.
 */
export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1,
  USAGE: 2,
  CONTRACT: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// --- the JSON envelope ----------------------------------------------------------------------------

export interface EnvelopeWarning {
  code: string;
  message: string;
  detail?: unknown;
}

export interface EnvelopeError {
  code: string;
  message: string;
  /** Up to three concrete alternatives the caller could use instead. */
  alternatives?: Array<{ id: string; t?: number; delta?: number; note?: string }>;
  detail?: unknown;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  command: string;
  schemaVersion: 1;
  /** Absolute path of the project the command acted on, when there is one. */
  project?: string;
  /** Artifacts written, project-relative and forward-slashed. */
  artifactsWritten?: string[];
  /** The command's own result. Shape is per-command and documented in its help. */
  result?: T;
  warnings: EnvelopeWarning[];
  errors: EnvelopeError[];
  /** Free-form, human-readable summary lines. Printed to stderr in text mode. */
  summary?: string[];
}

export class UsageError extends Error {
  readonly code = EXIT.USAGE;
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class ContractError extends Error {
  readonly code = EXIT.CONTRACT;
  readonly alternatives: EnvelopeError["alternatives"];
  constructor(message: string, alternatives?: EnvelopeError["alternatives"]) {
    super(message);
    this.name = "ContractError";
    this.alternatives = alternatives;
  }
}

export class CheckFailedError extends Error {
  readonly code = EXIT.CHECK_FAILED;
  readonly offenders: string[];
  constructor(message: string, offenders: string[] = []) {
    super(message);
    this.name = "CheckFailedError";
    this.offenders = offenders;
  }
}

// --- logging --------------------------------------------------------------------------------------

const useColor = process.stderr.isTTY === true && process.env["NO_COLOR"] === undefined;
const dim = (s: string): string => (useColor ? `\u001b[2m${s}\u001b[0m` : s);
const red = (s: string): string => (useColor ? `\u001b[31m${s}\u001b[0m` : s);
const yellow = (s: string): string => (useColor ? `\u001b[33m${s}\u001b[0m` : s);
const green = (s: string): string => (useColor ? `\u001b[32m${s}\u001b[0m` : s);

/** Logs go to stderr, always. stdout is reserved for the JSON envelope (SPEC P1). */
export const log = {
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  step(msg: string): void {
    process.stderr.write(`${green("›")} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${yellow("!")} ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${red("✗")} ${msg}\n`);
  },
  detail(msg: string): void {
    process.stderr.write(`${dim(`  ${msg}`)}\n`);
  },
  plain(msg: string): void {
    process.stdout.write(`${msg}\n`);
  },
};

// --- UTF-8 file I/O -------------------------------------------------------------------------------

/** Read a text file as UTF-8. Throws with the path, because "invalid JSON" without a path is useless. */
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new ContractError(`cannot read ${path}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
}

/** Read and parse JSON, reporting the parse position so a trailing comma is findable. */
export async function readJson<T = unknown>(path: string): Promise<T> {
  const text = await readText(path);
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch (err) {
    const e = err as Error & { lineNumber?: number; columnNumber?: number };
    const where =
      e.lineNumber !== undefined ? ` at line ${e.lineNumber}, column ${e.columnNumber ?? 0}` : "";
    throw new ContractError(`${path} is not valid JSON${where}: ${e.message}`);
  }
}

/**
 * Strip `//` and `/* *\/` comments from JSONC.
 *
 * String-aware: a naive regex eats `https://…` inside a string, which is exactly the bug that makes
 * people conclude "JSONC is a trap". Kept minimal because our own artifacts are plain JSON; this
 * exists so the *documentation* examples can be pasted into a file and still load.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Write text as UTF-8 with LF endings and no BOM (`docs/SPEC.md` A1).
 *
 * `\r\n` is normalised to `\n` on the way out, not on the way in, so that a file authored on Windows
 * cannot silently violate the contract.
 */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const normalised = text.replace(/\r\n/g, "\n");
  await writeFile(path, normalised, { encoding: "utf8" });
}

/** Write JSON: 2-space indent, LF, trailing newline, and a `$schema` first if given. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function pathExists(path: string): Promise<boolean> {
  return existsSync(path);
}

export async function dirStats(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(p: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(p);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(p, name);
      let info: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        info = await stat(full);
      } catch {
        continue; // raced with a delete; ignore
      }
      if (info.isDirectory()) await walk(full);
      else {
        files++;
        bytes += info.size;
      }
    }
  }
  await walk(path);
  return { files, bytes };
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// --- paths ----------------------------------------------------------------------------------------

/** Forward-slashed, project-relative path. Every path in an artifact goes through this (SPEC A5). */
export function relPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

export function absPath(root: string, relativePath: string): string {
  return isAbsolute(relativePath) ? normalize(relativePath) : resolve(root, relativePath);
}

/**
 * Walk a directory tree, returning project-relative forward-slashed paths.
 *
 * Uses plain `readdir` plus `stat` rather than `withFileTypes`. That is one syscall more per entry and
 * it sidesteps a real portability trap: `Dirent` is generic over its name type in current `@types/node`,
 * and the default changed between versions, so an annotated `Dirent[]` compiles against one toolchain
 * and fails against the next. A tree walk is not a hot path, and a framework whose tooling breaks on a
 * routine dependency bump is a framework nobody upgrades.
 */
export async function walkFiles(
  root: string,
  options: { skip?: RegExp; extensions?: readonly string[] } = {},
): Promise<string[]> {
  const out: string[] = [];
  const skip = options.skip ?? /(^|\/)(node_modules|\.git|dist|\.cache)\//;
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = relPath(root, full);
      if (skip.test(`${rel}/`) || skip.test(rel)) continue;
      let isDir = false;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue; // raced with a delete; not worth failing a lint run over
      }
      if (isDir) await walk(full);
      else if (!options.extensions || options.extensions.some((e) => name.endsWith(e))) out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * An ASCII-only temp directory.
 *
 * `docs/SPEC.md` P4: a non-ASCII temp path breaks a browser profile directory outright and reaches
 * ffmpeg as a mangled argument. This workspace's own root contains non-ASCII in most real projects,
 * so every path handed to an external process is built from here.
 */
export function asciiTempDir(tag: string, rootOverride?: string): string {
  const base = rootOverride ?? process.env["CVPW_TMP"] ?? join(tmpdir(), "cvpw");
  const safeTag = tag.replace(/[^A-Za-z0-9_.-]/g, "_");
  const path = join(base, safeTag);
  if (!isAscii(path)) {
    return join(tmpdir(), "cvpw", safeTag);
  }
  return path;
}

export function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\u0000-\u007F]/.test(s);
}

// --- environment ----------------------------------------------------------------------------------

export interface ToolInfo {
  name: string;
  path: string | null;
  version: string | null;
  /** How the path was resolved, so `doctor` can explain an override. */
  source: "env" | "path" | "missing";
  envVar?: string;
}

const TOOL_ENV_VARS: Record<string, string> = {
  ffmpeg: "CVPW_FFMPEG",
  ffprobe: "CVPW_FFPROBE",
  python: "CVPW_PYTHON",
  node: "CVPW_NODE",
  git: "CVPW_GIT",
};

/**
 * Resolve an external tool: an explicit environment override first, then PATH.
 *
 * Never an absolute hard-coded path (`docs/SPEC.md` P5) — the prior-art projects that hard-coded
 * `/Users/<someone>/...` are unusable anywhere else, including on the machine they were written on
 * after a reinstall.
 */
export function resolveTool(name: string): ToolInfo {
  const envVar = TOOL_ENV_VARS[name];
  const override = envVar ? process.env[envVar] : undefined;
  if (override) {
    return {
      name,
      path: override,
      version: null,
      source: existsSync(override) ? "env" : "missing",
      envVar,
    };
  }
  const found = whichSync(name);
  return { name, path: found, version: null, source: found ? "path" : "missing", envVar };
}

/** Locate an executable on PATH without spawning a shell. */
export function whichSync(command: string): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  const pathEnv = process.env["PATH"] ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** `true` when the process could not be started at all, which is different from a non-zero exit. */
  spawnFailed: boolean;
  error?: string;
}

/**
 * Run an external process with UTF-8 forced.
 *
 * Python in particular: the reference machine's console code page is 936, so without
 * `PYTHONUTF8=1` a Python child that prints a `€` or a CJK character dies with `UnicodeEncodeError`.
 * That failure looks like a bug in the script and is actually a bug in how it was launched.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...options.env,
      },
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({
        code: -1,
        stdout: "",
        stderr: "",
        spawnFailed: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            finish({ code: -1, stdout, stderr, spawnFailed: false, error: `timed out after ${options.timeoutMs} ms` });
          }, options.timeoutMs)
        : undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      finish({ code: -1, stdout, stderr, spawnFailed: true, error: err.message });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr, spawnFailed: false });
    });
  });
}

/** The version string of a tool, or null. Never throws: `doctor` must survive a broken install. */
export async function toolVersion(tool: ToolInfo, args: readonly string[] = ["--version"]): Promise<string | null> {
  if (!tool.path) return null;
  const r = await run(tool.path, args, { timeoutMs: 15_000 });
  if (r.spawnFailed) return null;
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const first = text.split("\n").find((l) => l.trim().length > 0);
  return first?.trim() ?? null;
}

// --- project discovery ----------------------------------------------------------------------------

export interface ProjectPaths {
  root: string;
  projectJson: string;
  timeline: string;
  cues: string;
  lyrics: string;
  lyricsTiming: string;
  handoff: string;
  handoffReport: string;
  analysisAudio: string;
  envelopeJson: string;
  envelopeBin: string;
  sectionsOverride: string;
  handoffs: string;
  assetsManifest: string;
  reviewReport: string;
  renderReport: string;
  qaReport: string;
  gold: string;
  exemptions: string;
  docs: string;
  engine: string;
  render: string;
  review: string;
}

/** The canonical file layout of a project (`docs/CONTRACTS.md` §1). */
export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    projectJson: join(root, "project.json"),
    timeline: join(root, "timeline.json"),
    cues: join(root, "cues", "cues.json"),
    lyrics: join(root, "cues", "lyrics.json"),
    lyricsTiming: join(root, "cues", "lyrics.timing.json"),
    handoff: join(root, "handoff.json"),
    handoffReport: join(root, "handoff.report.json"),
    analysisAudio: join(root, "analysis", "audio.json"),
    envelopeJson: join(root, "analysis", "envelope.json"),
    envelopeBin: join(root, "analysis", "envelope.f32"),
    sectionsOverride: join(root, "analysis", "sections.json"),
    handoffs: join(root, "review", "handoff"),
    assetsManifest: join(root, "assets", "manifest.json"),
    reviewReport: join(root, "review", "report.json"),
    renderReport: join(root, "render", "report.json"),
    qaReport: join(root, "qa", "report.json"),
    gold: join(root, "qa", "gold.json"),
    exemptions: join(root, "qa", "exemptions.json"),
    docs: join(root, "docs"),
    engine: join(root, "engine"),
    render: join(root, "render"),
    review: join(root, "review"),
  };
}

/** Find the project root by walking up from `start` looking for `project.json`. */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The framework root, derived from this module's location — never from the working directory. */
export function frameworkRoot(): string {
  // dist/shared.js -> packages/cli -> packages -> <root>
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return resolve(here, "..", "..", "..");
}

export function schemasDir(): string {
  return join(frameworkRoot(), "schemas");
}

export function templatesDir(): string {
  return join(frameworkRoot(), "templates");
}

export function skillsDir(): string {
  return join(frameworkRoot(), "skills");
}

// --- misc -----------------------------------------------------------------------------------------

/** Parse a comma-separated list, trimming and dropping empties. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a comma-separated list of numbers, with the flag name for a useful error. */
export function splitNumbers(value: string | undefined, flag: string): number[] {
  return splitList(value).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new UsageError(`${flag} expects numbers, got ${JSON.stringify(s)}`);
    return n;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}
