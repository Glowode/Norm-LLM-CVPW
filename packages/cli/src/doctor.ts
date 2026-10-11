/**
 * `cvpw doctor` — what this machine can and cannot do.
 *
 * This is the one command that must work before anything is built, because its whole purpose is to
 * tell an operator whether the rest of the framework can run. It is therefore deliberately independent
 * of the packages that are still contracts: it probes processes and reads facts, and it imports
 * nothing from `@cvpw/render` or `@cvpw/runtime`.
 *
 * Two probes exist because assuming their answer costs real time, and both are ADR-backed:
 *
 * - **Hardware encoders are probed by encoding** (ADR 0006). On this reference machine
 *   `h264_nvenc` is *listed* by ffmpeg and *fails* with exit `-40`, stderr
 *   *"Driver does not support the required nvenc API version. Required: 13.0 Found: 12.2"*.
 * - **The browser's real WebGL renderer is probed** in a headless instance. A software rasteriser is
 *   ~10x slower and its float paths differ, so a render under it is a different artefact.
 */

import { existsSync } from "node:fs";
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";

import { log, resolveTool, run, toolVersion, EXIT, type ToolInfo } from "./shared.js";
import { detectBrowser, headlessProbe } from "./browser.js";

export type Level = "REQUIRED" | "OPTIONAL";
export type Status = "ok" | "missing" | "degraded";

export interface CheckRow {
  group: string;
  name: string;
  level: Level;
  status: Status;
  detail: string;
  /** What the gap costs. Empty when the item is present. Never a vague "may cause problems". */
  cost: string;
  hint?: string;
}

export interface EncoderProbe {
  name: string;
  usable: boolean;
  evidence: string;
}

export interface DoctorResult {
  platform: {
    os: string;
    release: string;
    arch: string;
    node: string;
    cpus: number;
    ramGb: number;
    freeRamGb: number;
    diskFreeGb: number | null;
  };
  tools: ToolInfo[];
  rows: CheckRow[];
  requiredMissing: number;
  requiredDegraded: number;
  renderer: string;
  softwareRenderer: boolean;
  encoder: EncoderProbe;
  summary: string[];
}

/** Free space on the volume holding `path`, in GiB, without spawning `df` or `dir`. */
export function diskFreeGb(path: string): number | null {
  try {
    const st = statfsSync(path) as unknown as { bavail?: number; bfree?: number; bsize?: number };
    const free = st.bavail ?? st.bfree;
    if (free === undefined || st.bsize === undefined) return null;
    return (free * st.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

/**
 * Probe a hardware encoder by encoding five synthetic frames and judging by **exit code**.
 *
 * The error text is preserved verbatim, because "exit -40" is not actionable and
 * "Driver does not support the required nvenc API version. Required: 13.0 Found: 12.2" tells the
 * operator it is a driver problem rather than a missing build option.
 */
export async function probeEncoder(ffmpegPath: string): Promise<EncoderProbe> {
  const r = await run(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
      "-frames:v",
      "5",
      "-c:v",
      "h264_nvenc",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 30_000 },
  );
  if (r.spawnFailed) {
    return { name: "h264_nvenc", usable: false, evidence: `could not run ffmpeg: ${r.error ?? "unknown"}` };
  }
  if (r.code === 0) return { name: "h264_nvenc", usable: true, evidence: "5-frame encode succeeded (exit 0)" };
  const text = (r.stderr.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ") || `exit ${r.code}`).trim();
  return { name: "h264_nvenc", usable: false, evidence: `exit ${r.code}: ${text.slice(0, 300)}` };
}

export interface DoctorOptions {
  /** Skip the browser launch (the slowest probe). Reported as "not probed", never as a pass. */
  quick?: boolean;
  /** Which directory's volume to report free space for. */
  cwd?: string;
}

export async function doctorProbe(options: DoctorOptions = {}): Promise<DoctorResult> {
  const rows: CheckRow[] = [];
  const summary: string[] = [];
  const cwd = options.cwd ?? process.cwd();

  const push = (row: CheckRow): void => {
    rows.push(row);
  };

  // --- runtime ----------------------------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  push({
    group: "runtime",
    name: `node ${process.versions.node}`,
    level: "REQUIRED",
    status: nodeMajor >= 20 ? "ok" : "missing",
    detail: process.execPath,
    cost: nodeMajor >= 20 ? "" : "the CLI and the render backend will not run",
    ...(nodeMajor >= 20 ? {} : { hint: "install Node 20 or newer" }),
  });

  const python = resolveTool("python");
  const pythonVersion = python.path ? await toolVersion(python, ["--version"]) : null;
  const pythonMajorMinor = pythonVersion ? /(\d+)\.(\d+)/.exec(pythonVersion) : null;
  const pythonOk = pythonMajorMinor !== null && Number(pythonMajorMinor[1]) >= 3 && Number(pythonMajorMinor[2]) >= 10;
  push({
    group: "runtime",
    name: pythonVersion ?? "python",
    level: "REQUIRED",
    status: !python.path ? "missing" : pythonOk ? "ok" : "degraded",
    detail: python.path ? `${python.path}${python.source === "env" ? " (from CVPW_PYTHON)" : ""}` : "not on PATH",
    cost: !python.path
      ? "`cvpw analyze` cannot run, so there is no timebase and no measured grid"
      : pythonOk
        ? ""
        : `Python ${pythonMajorMinor?.[1]}.${pythonMajorMinor?.[2]} is older than 3.10; the analysis may not run`,
    ...(python.path && pythonOk ? {} : { hint: "install Python 3.10+" }),
  });

  const git = resolveTool("git");
  const gitVersion = git.path ? await toolVersion(git) : null;
  push({
    group: "runtime",
    name: gitVersion ?? "git",
    level: "REQUIRED",
    status: git.path ? "ok" : "missing",
    detail: git.path ?? "not on PATH",
    // SPEC S4: a project must be a git repository from its first commit.
    cost: git.path ? "" : "stage boundaries cannot be committed or rolled back (docs/SPEC.md S4)",
  });

  // --- media ------------------------------------------------------------------------------------
  const ffmpeg = resolveTool("ffmpeg");
  const ffprobe = resolveTool("ffprobe");
  const ffmpegVersion = ffmpeg.path ? await toolVersion(ffmpeg, ["-version"]) : null;
  const ffprobeVersion = ffprobe.path ? await toolVersion(ffprobe, ["-version"]) : null;

  push({
    group: "media",
    name: `ffmpeg${ffmpegVersion ? ` ${ffmpegVersion.split(" ").slice(0, 3).join(" ")}` : ""}`,
    level: "REQUIRED",
    status: ffmpeg.path ? "ok" : "missing",
    detail: ffmpeg.path ?? "not on PATH",
    cost: ffmpeg.path ? "" : "no video can be encoded at all",
    ...(ffmpeg.path ? {} : { hint: "install ffmpeg and put it on PATH, or set CVPW_FFMPEG" }),
  });
  push({
    group: "media",
    name: `ffprobe${ffprobeVersion ? ` ${ffprobeVersion.split(" ").slice(0, 3).join(" ")}` : ""}`,
    level: "REQUIRED",
    status: ffprobe.path ? "ok" : "missing",
    detail: ffprobe.path ?? "not on PATH",
    cost: ffprobe.path ? "" : "frame counts and durations cannot be measured, so the render gate cannot run",
  });

  // --- encoders ---------------------------------------------------------------------------------
  const encoder: EncoderProbe = ffmpeg.path
    ? await probeEncoder(ffmpeg.path)
    : { name: "h264_nvenc", usable: false, evidence: "ffmpeg is not available, so nothing could be probed" };
  push({
    group: "encoders",
    name: `hardware h264: ${encoder.usable ? "USABLE" : "not usable"}`,
    level: "OPTIONAL",
    status: encoder.usable ? "ok" : "degraded",
    detail: encoder.evidence,
    // The point of the cost column: a missing hardware encoder is not a problem.
    cost: encoder.usable
      ? ""
      : "renders use libx264: slower in wall time, identical in structure, so this costs patience and nothing else",
    ...(encoder.usable
      ? {}
      : { hint: "software encoding is correct — do not chase a GPU encoder to fix a slow render" }),
  });

  // --- browser ----------------------------------------------------------------------------------
  const browser = detectBrowser();
  let renderer = "not probed";
  let softwareRenderer = false;
  if (!browser) {
    push({
      group: "browser",
      name: "chromium-family browser",
      level: "REQUIRED",
      status: "missing",
      detail: "no Chrome, Edge, Chromium or Playwright browser found in the usual locations",
      cost: "nothing can be rendered: every frame is drawn in a browser",
      hint: "install Chrome or Edge, or set CVPW_BROWSER to an executable path",
    });
  } else {
    push({
      group: "browser",
      name: browser.name,
      level: "REQUIRED",
      status: "ok",
      detail: `${browser.path} (found via ${browser.source})`,
      cost: "",
    });
    if (options.quick) {
      push({
        group: "browser",
        name: "webgl renderer: not probed",
        level: "REQUIRED",
        status: "degraded",
        detail: "--quick was given, so the launch was skipped",
        cost: "unknown: a software rasteriser is ~10x slower and produces a different artefact",
        hint: "re-run `cvpw doctor` without --quick before a full render",
      });
    } else {
      const probe = await headlessProbe(browser, { timeoutMs: 120_000 });
      renderer = probe.renderer;
      softwareRenderer = probe.software;
      push({
        group: "browser",
        name: `webgl renderer: ${!probe.ok ? "PROBE FAILED" : probe.software ? "SOFTWARE" : "hardware"}`,
        level: "REQUIRED",
        status: probe.ok ? (probe.software ? "degraded" : "ok") : "missing",
        detail: renderer,
        cost: !probe.ok
          ? "frames cannot be captured"
          : probe.software
            ? "a software rasteriser is roughly 10x slower and its float paths differ, so a render made under it is a different artefact"
            : "",
        ...(probe.ok && !probe.software
          ? {}
          : { hint: "fix the GPU flags or the driver; `cvpw render` refuses a software renderer unless --allow-software is given" }),
      });
    }
  }

  // --- python packages --------------------------------------------------------------------------
  const packages = python.path
    ? await probePythonPackages(python.path)
    : { numpy: null as string | null, soundfile: null as string | null, librosa: null as string | null };
  push({
    group: "optional",
    name: `python numpy${packages.numpy ? ` ${packages.numpy}` : ""}`,
    level: "OPTIONAL",
    status: packages.numpy ? "ok" : "missing",
    detail: packages.numpy ? "importable" : "not importable",
    cost: packages.numpy ? "" : "`cvpw analyze` cannot run at all without numpy",
    ...(packages.numpy ? {} : { hint: "python -m pip install numpy" }),
  });
  push({
    group: "optional",
    name: `python soundfile${packages.soundfile ? ` ${packages.soundfile}` : ""}`,
    level: "OPTIONAL",
    status: packages.soundfile ? "ok" : "missing",
    detail: packages.soundfile ? "importable" : "not importable",
    cost: packages.soundfile
      ? ""
      : "compressed audio goes through the ffmpeg fallback; a lossless WAV is unaffected",
    ...(packages.soundfile ? {} : { hint: "python -m pip install soundfile" }),
  });
  push({
    group: "optional",
    name: `python librosa${packages.librosa ? ` ${packages.librosa}` : ""}`,
    level: "OPTIONAL",
    status: packages.librosa ? "ok" : "missing",
    detail: packages.librosa ? "importable" : "not importable",
    cost: packages.librosa
      ? ""
      : "the numpy tempo path is used instead: it is tested against a synthetic fixture and works, but librosa's beat tracker is more robust on real music",
    ...(packages.librosa ? {} : { hint: "python -m pip install librosa  (optional; try it if the overview plot shows an ambiguous tempo)" }),
  });

  // --- disk -------------------------------------------------------------------------------------
  const freeGb = diskFreeGb(cwd);
  push({
    group: "optional",
    name: `disk free ${freeGb === null ? "unknown" : `${freeGb.toFixed(1)} GiB`}`,
    level: "OPTIONAL",
    status: freeGb === null ? "degraded" : freeGb >= 5 ? "ok" : "degraded",
    detail: `volume holding ${cwd}`,
    cost: freeGb !== null && freeGb < 5 ? "a full-resolution render may exhaust the volume" : "",
    ...(freeGb !== null && freeGb < 5
      ? { hint: "use --preview, or clear space before a full render" }
      : {}),
  });

  const requiredMissing = rows.filter((r) => r.level === "REQUIRED" && r.status === "missing").length;
  const requiredDegraded = rows.filter((r) => r.level === "REQUIRED" && r.status === "degraded").length;
  const requiredOk = rows.filter((r) => r.level === "REQUIRED" && r.status === "ok").length;

  summary.push(
    requiredMissing === 0 && requiredDegraded === 0
      ? `all ${requiredOk} REQUIRED checks passed`
      : `${requiredMissing} REQUIRED missing, ${requiredDegraded} degraded — read the cost column before continuing`,
  );
  summary.push(`encoder: ${encoder.usable ? "h264_nvenc (probed)" : "libx264 (software)"}`);
  if (renderer !== "not probed") {
    summary.push(`renderer: ${renderer}${softwareRenderer ? "   [SOFTWARE]" : ""}`);
  }

  return {
    platform: {
      os: platform(),
      release: release(),
      arch: arch(),
      node: process.versions.node,
      cpus: cpus().length,
      ramGb: totalmem() / 1024 ** 3,
      freeRamGb: freemem() / 1024 ** 3,
      diskFreeGb: freeGb,
    },
    tools: [
      { ...ffmpeg, version: ffmpegVersion },
      { ...ffprobe, version: ffprobeVersion },
      { ...python, version: pythonVersion },
      { ...git, version: gitVersion },
    ].map((t) => ({
      name: t.name,
      path: t.path,
      version: t.version,
      source: t.source,
      ...(t.envVar ? { envVar: t.envVar } : {}),
    })),
    rows,
    requiredMissing,
    requiredDegraded,
    renderer,
    softwareRenderer,
    encoder,
    summary,
  };
}

async function probePythonPackages(
  pythonPath: string,
): Promise<{ numpy: string | null; soundfile: string | null; librosa: string | null }> {
  const script = [
    "import json",
    "out = {}",
    "for name in ('numpy', 'soundfile', 'librosa'):",
    "    try:",
    "        mod = __import__(name)",
    "        out[name] = getattr(mod, '__version__', 'unknown')",
    "    except Exception:",
    "        out[name] = None",
    "print(json.dumps(out))",
  ].join("\n");
  const r = await run(pythonPath, ["-c", script], { timeoutMs: 60_000 });
  if (r.spawnFailed || r.code !== 0) return { numpy: null, soundfile: null, librosa: null };
  try {
    const parsed = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, string | null>;
    return {
      numpy: parsed["numpy"] ?? null,
      soundfile: parsed["soundfile"] ?? null,
      librosa: parsed["librosa"] ?? null,
    };
  } catch {
    return { numpy: null, soundfile: null, librosa: null };
  }
}

/** Render the result for a human. The JSON envelope carries the same data. */
export function printDoctor(result: DoctorResult): void {
  const header = (s: string): string => s.toUpperCase();
  log.info("");
  log.info(`${header("platform")}  ${result.platform.os} ${result.platform.release} (${result.platform.arch})`);
  log.info(
    `  node ${result.platform.node}   ${result.platform.cpus} cpus   ${result.platform.ramGb.toFixed(1)} GiB RAM ` +
      `(${result.platform.freeRamGb.toFixed(1)} free)   ${result.platform.diskFreeGb?.toFixed(1) ?? "?"} GiB disk`,
  );
  log.info("");
  let group = "";
  for (const row of result.rows) {
    if (row.group !== group) {
      group = row.group;
      log.info(header(group));
    }
    const mark = row.status === "ok" ? "ok  " : row.status === "degraded" ? "warn" : "MISS";
    log.info(`  [${mark}] ${row.name}`);
    log.detail(row.detail);
    if (row.cost) {
      log.info(`         cost: ${row.cost}`);
    }
    if (row.hint) log.detail(`hint: ${row.hint}`);
  }
  log.info("");
  for (const line of result.summary) log.info(line);
  log.info("");
  if (result.requiredMissing > 0) {
    log.error("REQUIRED items are missing. The framework cannot run until they are installed.");
  } else if (result.requiredDegraded > 0) {
    log.warn("Some REQUIRED items are degraded. They will run, but not as intended.");
  } else {
    log.info("This machine can run the framework.");
  }
}

export { EXIT, existsSync, join };
