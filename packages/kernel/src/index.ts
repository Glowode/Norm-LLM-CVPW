/**
 * @cvpw/kernel — the browser-side render core.
 *
 * Dependency rule (`docs/ARCHITECTURE.md`): this package MUST NOT import `@cvpw/render`,
 * `@cvpw/runtime`, `@cvpw/audit`, `@cvpw/cli` or `cvpw_py`, and MUST NOT use Node globals. The
 * preview in a browser tab and the offline exporter run this same code, and that equivalence is
 * what makes "a frame is a pure function of time" a fact rather than a hope.
 */

export {
  Timebase,
  TimeExpressionError,
  normaliseWord,
  type Alternative,
  type Resolution,
  type TimeExpressionReason,
} from "./time.js";

export {
  TOLERANCE,
  type Bar,
  type Cue,
  type CueSource,
  type Impact,
  type LyricLineTiming,
  type LyricWordTiming,
  type Onset,
  type Section,
  type Stop,
  type Tempo,
  type TimebaseData,
} from "./timebase.js";

export {
  fbm1,
  fbm2,
  frameIndex,
  frameJitter,
  hash1,
  hash2,
  hash32,
  hashInt,
  hashPick,
  hashRange,
  mulberry32,
  noise1,
  noise2,
  rng,
  rngN,
} from "./rng.js";

export {
  TAU,
  clamp,
  clamp01,
  easeInCubic,
  easeInExpo,
  easeInOutCubic,
  easeInOutQuad,
  easeInQuad,
  easeLinear,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  easeOutExpo,
  easeOutQuad,
  easing,
  hexToRgb,
  hit,
  hits,
  invLerp,
  lerp,
  luminance,
  mixHex,
  osc,
  pulse,
  ramp,
  remap,
  remapClamped,
  rgba,
  round,
  sameFrame,
  springStep,
  squash,
  stepEase,
  window01,
} from "./util.js";

export {
  Layout,
  layoutFromOutput,
  type Anchor,
  type DesignSpace,
  type LayoutProfile,
  type Rect,
  type UnitRect,
} from "./layout.js";

export {
  ArgsError,
  checks,
  registerCheck,
  registerTransport,
  registryManifest,
  resolveSceneArgs,
  scene,
  scenes,
  style,
  styles,
  transports,
  validateArgs,
  type ArgsSchema,
  type ArgSpec,
  type ArgsValue,
  type AssetResolver,
  type CheckDescriptor,
  type LayerOptions,
  type MaskOptions,
  type PostParams,
  type SceneDefinition,
  type SceneDrawArgs,
  type SceneDrawContext,
  type SceneFrame,
  type SceneInitContext,
  type SceneStyle,
  type TransportDescriptor,
} from "./plugin.js";

export {
  bootEngine,
  detectRenderer,
  Engine,
  type CvpwPageApi,
  type EngineMeta,
  type EngineOptions,
  type ResolvedShot,
  type ShotDeclaration,
  type ShotProblem,
} from "./engine.js";
export { createGLPost } from "./glpost.js";
export type { GLPost, GLPostParams } from "./glpost.js";
