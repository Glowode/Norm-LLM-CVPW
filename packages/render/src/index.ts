/**
 * @cvpw/render — the headless capture backend.
 *
 * Serve a project, drive several browser pages over CDP, hand every frame to one ordered sink, encode with
 * a probed encoder, and delete everything if anything fails.
 *
 * The dependency direction (`docs/ARCHITECTURE.md`) is deliberate: this package may not import
 * `@cvpw/cli`, and `@cvpw/kernel` may not import this. A render backend that depends on the command line
 * cannot be used by anything else, and the kernel has to run in a plain browser page with no Node globals
 * so that preview and export share one code path.
 *
 * The behaviour here is the direct consequence of what `docs/adr/0007` measured:
 *
 * | Measured | Implemented as |
 * |---|---|
 * | Frames 2..N are byte-identical across sessions, re-renders and chunk boundaries | `render.ts` splits work into contiguous chunks, one per worker |
 * | A session's first two frames are not reproducible, and no warm-up strategy fixes it | `warmupFrames` renders and discards them at the head of the timeline |
 * | Pixel readback is stable, but witnesses the canvas rather than the artefact | `frameHash` is computed from captured bytes |
 * | An encoder can be listed and still fail (`h264_nvenc`, exit `-40`/`-22`) | `probeEncoders` encodes five frames and reads the exit code |
 */

export { Browser, CdpError } from "./cdp.js";
export { startStaticServer, type ServeOptions, type StaticServer } from "./server.js";
export {
  createSink,
  FrameSinkError,
  frameName,
  planChunks,
  type CapturedFrame,
  type FrameSink,
  type FrameSinkOptions,
  type SinkStats,
} from "./sink.js";
export {
  CANDIDATE_ENCODERS,
  EncodeError,
  encode,
  probeEncoders,
  probeOutput,
  type EncodeOptions,
  type EncodeOutcome,
  type EncoderProbe,
} from "./ffmpeg.js";
export {
  render,
  RenderError,
  renderStills,
  type RenderOutcome,
  type RenderProgress,
  type RenderRequest,
} from "./render.js";
export { run, version, type RunResult } from "./exec.js";
