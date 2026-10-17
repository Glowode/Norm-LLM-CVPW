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
