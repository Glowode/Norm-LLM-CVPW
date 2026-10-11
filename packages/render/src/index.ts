/**
 * @cvpw/render — the headless capture backend.
 *
 * **Status: contract only.** The interfaces below are the design that `docs/ARCHITECTURE.md` specifies
 * and `docs/QA.md` measures against; the implementations are not written yet. They are declared here,
 * with no behaviour, for two reasons:
 *
 * 1. `@cvpw/cli` depends on this package, so the dependency graph has to be honest for the workspace to
 *    install. A package that exists in `package.json` but not on disk is a broken checkout, not a
 *    smaller one.
 * 2. An interface that is written down is reviewable. The most consequential decision in this whole
 *    package — the frame **ordering invariant** — is a correctness property, and it belongs in a type
 *    a reader can check rather than in a comment inside a worker loop.
 *
 * Nothing here imports anything. When the implementation lands, these declarations stay and gain
 * adjacent implementations; the shape should not need to change.
 */

/** How a captured frame reaches the encoder. */
export type TransportName = "filesystem" | "stream";

/** One captured frame, on its way to the encoder. */
export interface CapturedFrame {
  /** Ascending output frame index. The sink's ordering contract is expressed in terms of this. */
  index: number;
  /** Encoded bytes (JPEG/PNG) or raw RGB. `encoding` says which. */
  data: Uint8Array;
  encoding: "jpeg" | "png" | "rgb24";
  width: number;
  height: number;
  /** How long the page took to draw and read back this frame. Diagnostics, never a decision input. */
  ms: number;
}

/**
 * A frame sink is a serialising, ordering-preserving writer.
 *
 * **The ordering invariant, stated as the reason this interface exists:**
 *
 * > Frames MAY be rendered concurrently by any number of workers, in any order. Frames MUST be written
 * > to the encoder strictly in ascending `index`, with a bounded look-ahead. The output MUST therefore
 * > be identical for one worker and for eight, and independent of how fast the machine is.
 *
 * Without this, `--workers` becomes a knob that changes the film, and a re-render at a different worker
 * count cannot be compared against a previous one — which destroys the gold-frame gate, which is the
 * *only* empirical check on determinism. So this is not an optimisation detail; it is load-bearing.
 *
 * A sink that cannot honour it MUST fail loudly rather than write frames out of order.
 */
export interface FrameSink {
  readonly name: TransportName;
  /** Reserve a frame's position. Returns once the sink is willing to accept `index`. */
  reserve(index: number): Promise<void>;
  /** Hand over a finished frame. May be called out of order; MUST be written in order. */
  write(frame: CapturedFrame): Promise<void>;
  /** Flush and close. MUST reject if any index in the reserved range was never written. */
  close(): Promise<void>;
  /** Delete any partial output. A failed render must never leave a plausible-looking file. */
  abort(): Promise<void>;
}

/** What the backend needs to know to render. Derived from `project.json` and the CLI's flags. */
export interface RenderRequest {
  /** Absolute path of the project root. */
  root: string;
  /** Absolute path of the entry page, or a served URL. */
  entry: string;
  width: number;
  height: number;
  fps: number;
  /** Supersampling factor. `2` renders at twice the linear resolution and lets ffmpeg downscale. */
  dpr: number;
  /** Inclusive first frame index. */
  from: number;
  /** Exclusive last frame index. */
  to: number;
  /** Number of concurrent pages. Output MUST NOT depend on this value. */
  workers: number;
  transport: TransportName;
  /** Sub-frames per output frame, for motion blur. `1` disables it. */
  samples?: number;
  /** Shutter fraction of a frame interval. */
  shutter?: number;
  /** Disable the grain pass. Seam comparison and hashing MUST run with grain off. */
  noGrain?: boolean;
  /** Absolute path of the destination file. */
  output: string;
  /** Absolute path of an audio file to mux, if the film has one. */
  audio?: string;
  /** Seconds of lead-in applied AT MUX TIME. Never by editing the source file (SPEC P6). */
  audioOffset?: number;
  /** Permitted to run under a software rasteriser. Off by default. */
  allowSoftware?: boolean;
  /** Encoder to attempt first. Probed before use; falls back to `libx264` on failure. */
  codec?: "auto" | "h264_nvenc" | "libx264" | "prores_ks";
  crf?: number;
}

/** What a render produced. Becomes `render/report.json` (`docs/CONTRACTS.md` §10). */
export interface RenderOutcome {
  output: string;
  frames: number;
  codec: string;
  codecRequested: string;
  /** The probe's evidence: exit code or message. `ffmpeg -encoders` is not evidence (ADR 0006). */
  codecProbe: string;
  renderer: string;
  software: boolean;
  msPerFrame: { avg: number; p50: number; p95: number; max: number };
  /** Frame index to content hash, at the sampled times. */
  frameHashes: Record<string, string>;
  warnings: string[];
  errors: string[];
}

/** The encoder selection is a probe result, not a configuration value. */
export interface EncoderProbe {
  name: string;
  usable: boolean;
  /** The probe's own output, preserved verbatim so a failure is diagnosable later. */
  evidence: string;
}

// --- not implemented ------------------------------------------------------------------------------

/** Thrown by every entry point in this package until the implementation lands. */
export class RenderNotImplementedError extends Error {
  readonly code = 3;
  constructor(what: string) {
    super(
      `@cvpw/render is contract-only in v0.1: ${what} is not implemented yet.\n` +
        `  The interfaces in packages/render/src/index.ts are the specification; ` +
        `docs/ARCHITECTURE.md §7 and docs/QA.md define the behaviour to implement.\n` +
        `  See docs/PROGRESS.md — "Not done — and why".`,
    );
    this.name = "RenderNotImplementedError";
  }
}
