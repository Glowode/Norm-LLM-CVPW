/**
 * ffmpeg as an encoder and muxer. Not as a compositor.
 *
 * Three rules from the framework spec are implemented here and nowhere else:
 *
 * - **Probe before use** (`docs/SPEC.md` P6, ADR 0006). `h264_nvenc` is *listed* by ffmpeg on the
 *   reference machine and *fails* on it, with a driver/API-version error. Selecting an encoder because
 *   `ffmpeg -encoders` mentions it produces a render that dies at frame 3000, or worse, a file that
 *   looks finished. So the encoder is chosen by attempting a five-frame encode and reading the exit code.
 * - **A failed render deletes its own output.** A zero-byte or half-length MP4 is the worst possible
 *   outcome: it passes an existence check, plays for the first thirty seconds, and lies. Every failure
 *   path in this module removes the file it was writing.
 * - **Colour is tagged, not hoped for.** BT.709 with an explicit matrix conversion, because an untagged
 *   H.264 file is interpreted differently by different players and a film that looks right on the machine
 *   that made it is not obviously a film that looks right anywhere else.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { run } from "./exec.js";

/** The encoders this framework will select, in preference order. */
export const CANDIDATE_ENCODERS = ["h264_nvenc", "libx264"] as const;

export interface EncoderProbe {
  name: string;
  usable: boolean;
  /** Why *this* encoder succeeded or failed, in its own words. */
  evidence: string;
  /** Every candidate tried before this one and why each was rejected. Empty for the first choice. */
  rejected?: Array<{ name: string; reason: string }>;
  /** The encoder's own ffmpeg arguments, when usable. */
  args?: string[];
}

export interface ProbeOptions {
  ffmpeg: string;
  /** Try only these, in order. Defaults to {@link CANDIDATE_ENCODERS}. */
  candidates?: readonly string[];
  /** Quality target. Interpreted per encoder: `-cq` for NVENC, `-crf` for x264. */
  quality?: number;
  timeoutMs?: number;
}

/**
 * Encoder arguments per codec.
 *
 * The two families do not share a quality flag, and pretending they do is how a "fallback" quietly
 * produces a visually different film. Each entry is explicit about which knob means quality.
 */
function encoderArgs(name: string, quality: number): string[] {
  switch (name) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", String(quality)];
    case "libx264":
      return ["-c:v", "libx264", "-preset", "slow", "-crf", String(quality)];
    case "prores_ks":
      return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"];
    default:
      return ["-c:v", name];
  }
}

/**
 * Choose an encoder by encoding with it.
 *
 * Returns the first candidate whose five-frame encode exits 0. When none does, returns the last failure
 * with its evidence rather than throwing, because "no hardware encoder" is a normal machine state and the
 * caller's next move is to report it, not to crash.
 */
export async function probeEncoders(options: ProbeOptions): Promise<EncoderProbe> {
  const quality = options.quality ?? 18;
  const candidates = options.candidates ?? CANDIDATE_ENCODERS;
  const rejected: Array<{ name: string; reason: string }> = [];
  let last: EncoderProbe = { name: "none", usable: false, evidence: "no candidate encoders were supplied" };

  for (const name of candidates) {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
      "-frames:v",
      "5",
      ...encoderArgs(name, quality),
      "-f",
      "null",
      "-",
    ];
    const result = await run(options.ffmpeg, args, { timeoutMs: options.timeoutMs ?? 30_000 });
    if (result.spawnFailed) {
      const reason = `could not run ffmpeg: ${result.error ?? "unknown"}`;
      rejected.push({ name, reason });
      last = { name, usable: false, evidence: reason, rejected: [...rejected] };
      continue;
    }
    if (result.code === 0) {
      return {
        name,
        usable: true,
        evidence: `a 5-frame test encode succeeded`,
        // Carried forward so the report says WHY this encoder and not an earlier one. Without it a fallback
        // to libx264 reads as a success with no explanation, and an operator on a machine with a working
        // GPU has no way to find out that the GPU path was tried and failed.
        rejected: [...rejected],
        args: encoderArgs(name, quality),
      };
    }
    const text = (result.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `exit ${result.code}`).trim();
    const reason = `exit ${result.code}: ${text.slice(0, 300)}`;
    rejected.push({ name, reason });
    last = { name, usable: false, evidence: reason, rejected: [...rejected] };
  }

  return last;
}

export interface EncodeOptions {
  ffmpeg: string;
  /** Directory holding the numbered frames. */
  frameDir: string;
  /** Zero-padded pattern, e.g. `f%06d.jpg`. */
  pattern: string;
  fps: number;
  width: number;
  height: number;
  output: string;
  /** Absolute path of an audio file to mux. Never edited; see `offsetSeconds`. */
  audio?: string;
  /**
   * Lead-in applied AT MUX TIME. Editing the audio to achieve this is forbidden (`docs/SPEC.md` P6),
   * because it destroys the reference every measurement was taken against.
   */
  offsetSeconds?: number;
  /** Encoder arguments, from {@link probeEncoders}. */
  encoderArgs: string[];
  /** Total frames expected. Verified against the file afterwards. */
  frames: number;
  /** Explicit ffprobe path. Defaults to the binary sitting beside `ffmpeg`. */
  ffprobe?: string;
  /** Tag colour as BT.709. Off only for an intentionally untagged intermediate. */
  tagColour?: boolean;
  timeoutMs?: number;
}

export interface EncodeOutcome {
  output: string;
  bytes: number;
  /** Frame count ffprobe reports. Compared against `options.frames` by the caller's gate. */
  probeFrames: number | null;
  durationSec: number | null;
  /** The full ffmpeg argument list, recorded so a render can be reproduced by hand. */
  command: string[];
}

export class EncodeError extends Error {
  constructor(message: string, readonly command: string[]) {
    super(message);
    this.name = "EncodeError";
  }
}

/**
 * Encode a frame sequence, optionally muxing audio, and never leave a partial file behind.
 *
 * The frame rate is passed as a rational (`fps/1`) rather than a decimal. ffmpeg accepts `30` and
 * `30000/1001` but a float such as `29.97` is interpreted as `2997/100`, which is not NTSC and produces a
 * file whose duration is very slightly wrong — the kind of error that only shows up as a slow drift
 * between picture and sound three minutes in.
 */
export async function encode(options: EncodeOptions): Promise<EncodeOutcome> {
  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    `${options.fps}/1`,
    "-i",
    join(options.frameDir, options.pattern),
  ];

  const inputs: string[] = ["-map", "0:v"];
  if (options.audio) {
    const offset = options.offsetSeconds ?? 0;
    if (offset !== 0) {
      // `-itsoffset` must precede the input it applies to: it shifts that input's timestamps.
      args.push("-itsoffset", offset.toFixed(6));
    }
    args.push("-i", options.audio);
    inputs.push("-map", "1:a");
  }

  args.push(...inputs);
  args.push(...options.encoderArgs);

  if (options.tagColour !== false) {
    args.push(
      "-vf",
      "scale=out_color_matrix=bt709:out_range=limited,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    );
  } else {
    args.push("-vf", "format=yuv420p");
  }

  if (options.audio) {
// `apad` lets the audio be SHORTER than the picture without the muxer truncating the film — the honest
    // alternative to padding the source file. But `apad` pads with silence *indefinitely* by default, so it
    // MUST be paired with `-shortest`: without it the video input ends when the frame sequence runs out while
    // the padded audio never does, and ffmpeg waits forever. That was a real hang — a 240-frame render had to
    // be killed after ten minutes and left a 49 MB file with no moov atom, which is precisely the truncated
    // master `render.frameCount` exists to catch.
    //
    // `-shortest` makes the finite stream the limiting one, which after padding is always the video.
    args.push("-af", "apad", "-c:a", "aac", "-b:a", "256k", "-shortest");
  }

  const isProRes = options.encoderArgs.includes("prores_ks");
  if (!isProRes) {
    args.push(
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(options.fps * 2),
      "-movflags",
      "+faststart",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
    );
  }

  args.push(options.output);

  try {
    await runWithProgress(options.ffmpeg, args, options.timeoutMs ?? 60 * 60 * 1000);
  } catch (error) {
    // The rule: a failed render must not leave a plausible-looking artefact.
    await rm(options.output, { force: true }).catch(() => undefined);
    throw error instanceof EncodeError
      ? error
      : new EncodeError(error instanceof Error ? error.message : String(error), [options.ffmpeg, ...args]);
  }

  if (!existsSync(options.output)) {
    throw new EncodeError(`ffmpeg reported success but produced no file at ${options.output}`, [
      options.ffmpeg,
      ...args,
    ]);
  }

  const info = await stat(options.output);
  if (info.size === 0) {
    await rm(options.output, { force: true }).catch(() => undefined);
    throw new EncodeError(`ffmpeg produced a zero-byte file at ${options.output}`, [options.ffmpeg, ...args]);
  }

// `ffprobe` is a DIFFERENT BINARY from `ffmpeg`, and this used to pass the ffmpeg path here. ffprobe's
  // arguments mean nothing to ffmpeg, so every probe failed and the failure was swallowed into
  // `probeFrames: null` — which meant the post-encode frame-count check never ran, for any render, while
  // looking like it had. `render.frameCount` only caught truncated masters because the CLI probes separately.
  //
  // The sibling binary is the reliable default: every standard build ships ffprobe beside ffmpeg. An explicit
  // override exists for a build that does not.
  const ffprobe = options.ffprobe ?? join(dirname(options.ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const probed = await probeOutput(ffprobe, options.output);
  return {
    output: options.output,
    bytes: info.size,
    probeFrames: probed.frames,
    durationSec: probed.duration,
    command: [options.ffmpeg, ...args],
  };
}

/** Frame count and duration reported by ffprobe. Used by the `render.frameCount` gate. */
export async function probeOutput(
  ffprobe: string,
  file: string,
): Promise<{ frames: number | null; duration: number | null }> {
  const result = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames,duration",
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 120_000 },
  );
  if (result.spawnFailed || result.code !== 0) return { frames: null, duration: null };
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ nb_read_frames?: string; duration?: string }> };
    const stream = parsed.streams?.[0];
    return {
      frames: stream?.nb_read_frames ? Number(stream.nb_read_frames) : null,
      duration: stream?.duration ? Number(stream.duration) : null,
    };
  } catch {
    return { frames: null, duration: null };
  }
}

/**
 * Run a child process to completion, forwarding stderr only on failure.
 *
 * Separate from the general-purpose runner because ffmpeg is the one child whose output is long, whose
 * exit code is the whole answer, and whose stderr is worth keeping verbatim when it fails — it names the
 * codec, the frame and the reason.
 */
function runWithProgress(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new EncodeError(error instanceof Error ? error.message : String(error), [command, ...args]));
      return;
    }

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new EncodeError(`ffmpeg did not finish within ${timeoutMs} ms`, [command, ...args]));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new EncodeError(`could not start ffmpeg: ${error.message}`, [command, ...args]));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").filter(Boolean).slice(-6).join("\n");
        reject(
          new EncodeError(`ffmpeg exited with code ${code}\n${tail || "(no stderr)"}`, [command, ...args]),
        );
      }
    });
  });
}
