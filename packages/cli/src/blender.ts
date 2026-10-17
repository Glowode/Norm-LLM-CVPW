/**
 * The Blender bridge — discovery, version gating, and the seam a future adapter fills.
 *
 * ## The version rule, and why it is a gate rather than a warning
 *
 * Only Blender **5.0 and newer** is supported. That floor is not a preference: the framework's scenes are
 * authored against a specific geometry and shading API, and a bridge that "works" on 4.x produces a render that
 * is subtly wrong in ways no gate can see — a shifted normal, a different colour transform. A version check that
 * warns is a version check that gets ignored; this one refuses.
 *
 * ## Directory names lie; binaries do not
 *
 * Measured on the reference machine, under `D:\Program Files\Blender Foundation`:
 *
 * ```
 *   Blender 5.0    blender.exe
 *   blender 5.1    blender.exe
 *   blender 5.2.0  blender.exe
 *   blender 5.2.2  blender.exe
 * ```
 *
 * Note the casing: `Blender 5.0` against `blender 5.1`. Any discovery that trusts the folder name is one rename
 * away from picking the wrong build, and a folder named `blender 5.2.2` could hold 5.0. So the folder is only a
 * hint for *where to look*; the version always comes from `blender --version`, which prints:
 *
 * ```
 *   Blender 5.2.2 LTS
 *           build date: 2026-09-15
 * ```
 *
 * ## What this module does and does not do
 *
 * It finds the binary, proves it is new enough, and reports what it is. It does **not** render anything: the
 * concrete invocation is the adapter's job, written for the machine in front of you — the same reasoning as
 * `asr.ts`. The `BlenderBridge` interface below is the shape such an adapter fills.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The oldest Blender this framework will drive. */
export const BLENDER_MIN: readonly [number, number, number] = [5, 0, 0];

export interface BlenderVersion {
  major: number;
  minor: number;
  patch: number;
  /** True when the binary reports LTS. Not a requirement, but worth recording. */
  lts: boolean;
  /** The raw first line, kept because it is the evidence for the fields above. */
  banner: string;
}

/**
 * Parse the first line of `blender --version`.
 *
 * Returns null rather than a guess when the line is not a Blender banner — a bridge that silently accepts an
 * unparseable version would gate on nothing at all.
 */
export function parseBlenderVersion(output: string): BlenderVersion | null {
  const first = output.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const match = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(first);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    lts: /\bLTS\b/i.test(first),
    banner: first.trim(),
  };
}

/** Compare two versions as `[major, minor, patch]`. Negative when `a` is older. */
export function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] as number) - (b[i] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isSupported(version: BlenderVersion): boolean {
  return compareVersions([version.major, version.minor, version.patch], BLENDER_MIN) >= 0;
}

export interface BlenderInstall {
  /** Directory the binary was found in. A hint, not a version source. */
  directory: string;
  executable: string;
  version: BlenderVersion;
  supported: boolean;
}

/**
 * Find every Blender under `root` and read each one's real version.
 *
 * A directory without `blender.exe` is skipped silently — half-installed and unrelated folders are normal, and
 * warning about them would train people to ignore warnings. A binary that runs but prints something unrecognisable
 * is reported, because that is the case where silence would be a lie.
 */
export async function discoverBlender(root: string): Promise<{
  installs: BlenderInstall[];
  problems: Array<{ path: string; message: string }>;
}> {
  const installs: BlenderInstall[] = [];
  const problems: Array<{ path: string; message: string }> = [];
  if (!existsSync(root)) {
    return { installs, problems: [{ path: root, message: "the Blender root does not exist on this machine" }] };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    // `withFileTypes` typing varies across Node versions; `isDirectory` is the reliable read.
    if (typeof entry.isDirectory === "function" && entry.isDirectory()) {
      candidates.push(join(root, entry.name));
    }
  }
  // The root itself may be an install (a portable extraction), so try it too — last, so a versioned subdirectory
  // always wins when both exist.
  candidates.push(root);

  for (const directory of candidates) {
    const executable = join(directory, "blender.exe");
    if (!existsSync(executable)) continue;
    try {
      const { stdout, stderr } = await run(executable, ["--version"], { timeout: 30_000, windowsHide: true });
      const version = parseBlenderVersion(`${stdout}${stderr}`);
      if (!version) {
        problems.push({ path: executable, message: "ran, but printed no recognisable Blender version banner" });
        continue;
      }
      installs.push({ directory, executable, version, supported: isSupported(version) });
    } catch (error) {
      problems.push({
        path: executable,
        message: error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error),
      });
    }
  }

  return { installs, problems };
}

/**
 * Choose which install to drive.
 *
 * Highest supported version wins, and an LTS build breaks a tie — a long-term-support release is the one whose API
 * will still be there next month, which matters because the framework's Blender adaptation is expected to keep
 * moving (5.3 is already scheduled).
 */
export function selectBlender(installs: readonly BlenderInstall[]): BlenderInstall | null {
  const usable = installs.filter((install) => install.supported);
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => {
    const byVersion = compareVersions(
      [b.version.major, b.version.minor, b.version.patch],
      [a.version.major, a.version.minor, a.version.patch],
    );
    if (byVersion !== 0) return byVersion;
    return Number(b.version.lts) - Number(a.version.lts);
  })[0] as BlenderInstall;
}

/**
 * The seam.
 *
 * Deliberately almost empty. What a bridge invocation looks like — headless flags, a scene path, frame ranges, an
 * output pattern, how a failure is reported — depends on the Blender side of the contract, and that contract is
 * still moving (5.3 next month). Freezing it now would freeze it wrong.
 *
 * What is already certain is captured above: where the binary is, and that it is new enough to be worth talking to.
 */
export interface BlenderBridge {
  readonly install: BlenderInstall;
  /** One line describing what this bridge needs, shown before a human is asked to wait for a render. */
  readonly requires: string;
  /** Render an authored `.blend` to frames. The concrete arguments are the adapter's business. */
  render(request: { blendPath: string; outputDir: string; frames: string }): Promise<{ frames: number }>;
}

/**
 * The driver, written against MEASURED behaviour rather than assumed behaviour.
 *
 * Everything below was learned by running the real binary on the reference machine, and each item
 * changed the design:
 *
 *   a script that raises STILL EXITS 0
 *     -> the exit code cannot decide success; the script must print a sentinel
 *
 *   Blender echoes the source lines of a --python file
 *     -> a sentinel must match a line that STARTS with it, or the driver's own text matches itself
 *
 *   64x64 sphere render took 29.6 s
 *     -> startup plus EEVEE shader compilation dominates, not pixels, so the cost model is
 *        per-invocation and a bridge must batch frames rather than launch once per frame
 *
 *   --factory-startup plus read_factory_settings(use_empty=True)
 *     -> reproducible scene setup, independent of the user's saved preferences
 *
 *   the output path goes through an environment variable
 *     -> avoids quoting a Windows path with spaces into a Python string
 */
export const SENTINEL = "CVPW_BRIDGE_OK";

/** A failure is a message, never a boolean: "it did not work" is not actionable. */
export class BlenderError extends Error {
  constructor(
    message: string,
    readonly detail: { exitCode: number | null; log: string; scriptPath?: string },
  ) {
    super(message);
    this.name = "BlenderError";
  }
}

export interface RenderRequest {
  /** Absolute path to a `.blend`, or omitted to drive a scene built by the script itself. */
  blendPath?: string;
  /** Target image path. Must be ASCII on Windows; code page 936 mangles anything else. */
  outputPath: string;
  /** Python run inside Blender. Must print `SENTINEL` on a line of its own as its last step. */
  script: string;
  /** Milliseconds. Five minutes is generous for one frame and short enough to fail loudly. */
  timeoutMs?: number;
  /**
   * How many image files the run must leave behind. When set, a shortfall is a `BlenderError`.
   *
   * This exists because a reached sentinel proves only that the script finished. Measured, on this machine:
   * a run with `render.filepath` set to a bare directory exited 0, printed the sentinel, and wrote **zero**
   * files. Without a count, that is a silent empty render — and the frames would have flowed onward into an
   * encoder that dutifully produced a zero-frame film.
   */
  expectFrames?: number;
}

export interface RenderOutcome {
  /** Milliseconds wall clock. Recorded because the cost model is per-invocation. */
  elapsedMs: number;
  /** Blender's own output, kept for the same reason a build log is kept. */
  log: string;
}

/**
 * THE COST MODEL, measured on the reference machine, because it decides the whole API shape.
 *
 * ```
 *   1 frame,  1 invocation   4.7 s
 *   6 frames, 1 invocation   6.9 s   ->  6 PNG files, animation=True
 *   6 frames, 6 invocations  28.2 s  (4.7 s x 6, extrapolated from the single-frame run)
 * ```
 *
 * Solving those two numbers gives roughly **4.2 s fixed and 0.45 s marginal per frame**. The fixed
 * cost is Blender starting up and compiling EEVEE shaders; it is paid once per invocation and is
 * ~10x the cost of a small frame.
 *
 * For a 240-frame film: batched is about 112 s, unbatched about 19 minutes. So this module offers
 * exactly one way to render a sequence, and it is the batched one. An API that allowed per-frame
 * invocation would be an API that makes a 19-minute render look normal.
 */
export const COST_MODEL = { fixedMs: 4200, perFrameMs: 450 } as const;

/** Estimate how long a batched render will take, so a caller can warn before starting one. */
export function estimateRenderMs(frames: number): number {
  return COST_MODEL.fixedMs + Math.max(0, frames) * COST_MODEL.perFrameMs;
}

/**
 * Build the Python that renders a frame range in one invocation.
 *
 * `animation=True` is what batches: Blender renders the range internally, writing one file per frame,
 * instead of the caller launching the process per frame and paying the fixed cost each time.
 *
 * `filepath` ends WITHOUT an extension or frame number, because Blender appends `%04d` from the
 * scene's frame number. Passing a full filename produces `frame_0001.png0001.png`, which is a real
 * mistake and a confusing one.
 */
export function buildAnimationScript(options: {
  outputPrefix: string;
  frameStart: number;
  frameEnd: number;
  resolution: number;
  /** Body that builds the scene. Runs before the render call. */
  setup: string;
}): string {
  return [
    "import bpy, os",
    "bpy.ops.wm.read_factory_settings(use_empty=True)",
    "s = bpy.context.scene",
    's.render.engine = "BLENDER_EEVEE"',
    `s.render.resolution_x = ${options.resolution}`,
    `s.render.resolution_y = ${options.resolution}`,
    "s.render.resolution_percentage = 100",
    's.render.image_settings.file_format = "PNG"',
    // A directory path needs a trailing separator, or Blender treats it as a filename PREFIX and writes
    // nothing where the caller is looking. Measured: passing a bare directory produced exit 0, a reached
    // sentinel, and ZERO files. So the separator is forced here rather than left to the caller.
    'p = os.environ["CVPW_OUT"]',
    's.render.filepath = p if p.endswith(("/", "\\\\")) else p + "/"',
    `s.frame_start = ${options.frameStart}`,
    `s.frame_end = ${options.frameEnd}`,
    options.setup,
    "bpy.ops.render.render(animation=True)",
    `print("${SENTINEL}")`,
  ].join("\n");
}

/**
 * Run one Blender invocation, deciding success by sentinel and never by exit code.
 *
 * This is the whole bridge: everything a caller needs is "start the binary, hand it a script, and say honestly
 * whether the script finished". Frame ranges, cameras and shaders are the script's business, and keeping them
 * there is what lets the Blender side evolve without this file changing.
 */
export async function runBlender(install: BlenderInstall, request: RenderRequest): Promise<RenderOutcome> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const work = await mkdtemp(join(tmpdir(), "cvpw-bl-"));
  const scriptPath = join(work, "driver.py");
  await writeFile(scriptPath, request.script, "utf8");

  const args = ["--background", "--factory-startup"];
  if (request.blendPath) args.push(request.blendPath);
  args.push("--python", scriptPath);

  const started = Date.now();
  let log = "";
  let code: number | null = null;
  try {
    const result = await run(install.executable, args, {
      timeout: request.timeoutMs ?? 300_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CVPW_OUT: request.outputPath, PYTHONUTF8: "1", CVPW_SENTINEL: SENTINEL },
    });
    log = result.stdout ?? "";
    code = 0;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    log = `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message ?? String(error)}`;
    code = typeof failure.code === "number" ? failure.code : null;
  }
  const startedAt = started;
  const elapsedMs = Date.now() - started;
  await rm(work, { recursive: true, force: true }).catch(() => undefined);

  // The sentinel must start its line: Blender echoes the script source, so a looser match would find the string
  // inside the driver file's own text and report success for a script that never ran.
  const reached = log.split(/\r?\n/).some((line) => line.trimStart().startsWith(SENTINEL));
  if (!reached) {
    throw new BlenderError(
      `Blender did not reach ${SENTINEL} (exit ${code ?? "none"}). The exit code is not the signal here: ` +
        `Blender exits 0 even when a script raises, which is why this is decided by the sentinel alone.`,
      { exitCode: code, log: log.slice(-4000), scriptPath },
    );
  }

  // A sentinel proves the script finished, not that it produced anything. Count what is on disk when the caller
  // said how much to expect.
  if (typeof request.expectFrames === "number") {
    const { readdir, stat } = await import("node:fs/promises");
    const { dirname, extname } = await import("node:path");
    // Resolve the counted directory the same way the render does. A path with no extension is a DIRECTORY, even
    // when it does not exist yet — falling back to `dirname` there counts an unrelated parent folder and turns a
    // silent empty render into a pass. Measured: this exact bug let a zero-output run satisfy `expectFrames: 2`
    // because the temp directory around it happened to hold other PNGs.
    const looksLikeDirectory = extname(request.outputPath) === "";
    const directory = looksLikeDirectory
      ? request.outputPath
      : request.outputPath.endsWith("/") || request.outputPath.endsWith("\\")
        ? request.outputPath
        : dirname(request.outputPath);
    let produced = 0;
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!/\.(png|exr|jpg|jpeg)$/i.test(entry)) continue;
      const info = await stat(join(directory, entry)).catch(() => null);
      // Only files this run could have written. A reused output directory is normal — a re-render goes to the
      // same place — and counting the previous run's frames would let a render that produced nothing inherit
      // their evidence. The two-second slack absorbs a filesystem whose timestamps are coarser than the clock.
      if (info && info.size > 0 && info.mtimeMs >= startedAt - 2000) produced++;
    }
    if (produced < request.expectFrames) {
      throw new BlenderError(
        `Blender reached ${SENTINEL} but left ${produced} image(s) in ${directory}, expected ` +
          `${request.expectFrames}. A sentinel proves the script finished, not that it wrote anything: a ` +
          `bare directory in render.filepath is treated as a filename prefix and produces exactly this.`,
        { exitCode: code, log: log.slice(-4000), scriptPath },
      );
    }
  }
  return { elapsedMs, log };
}
