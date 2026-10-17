/**
 * Registries — the accumulation mechanism.
 *
 * Scenes, styles, transports and checks are **registered**, never patched into the core. Adding a
 * new visual idea is one file plus one manifest line; the spine does not grow a special case for it.
 * That is the difference between a framework that accumulates and one that accretes
 * (`docs/SPEC.md` §0, `docs/EXTENDING.md`).
 *
 * Registration happens at module load. Every registry validates its entry immediately, so a broken
 * registration fails at startup rather than at frame 4000.
 */

// --- argument schemas ---------------------------------------------------------------------------

/**
 * A deliberately small argument-schema language.
 *
 * Why not JSON Schema or Zod: a scene's args are tiny, the kernel must stay dependency-free, and the
 * one property that matters is **rejecting unknown keys**. Every reference project lost time to a
 * misspelled arg that silently fell back to a default, so an unknown key is a hard error here.
 */
export type ArgSpec =
  | { type: "number"; min?: number; max?: number; default?: number; doc?: string }
  | { type: "integer"; min?: number; max?: number; default?: number; doc?: string }
  | { type: "string"; enum?: readonly string[]; default?: string; doc?: string }
  | { type: "boolean"; default?: boolean; doc?: string }
  | { type: "color"; default?: string; doc?: string }
  | { type: "numberArray"; length?: number; min?: number; max?: number; default?: readonly number[]; doc?: string }
  | { type: "time"; default?: string; doc?: string }
  | { type: "any"; default?: unknown; doc?: string };

export type ArgsSchema = Record<string, ArgSpec>;

export type ArgsValue = Record<string, unknown>;

export class ArgsError extends Error {
  constructor(
    readonly scene: string,
    readonly problems: readonly string[],
  ) {
    super(`scene ${JSON.stringify(scene)} has invalid args:\n  ${problems.join("\n  ")}`);
    this.name = "ArgsError";
  }
}

/**
 * Validate (and default-fill) a scene's args.
 *
 * Unknown keys are an error, not a warning. Missing keys take the spec's default, and a missing key
 * with no default is an error — a scene may not silently start without a value it declared.
 */
export function validateArgs(scene: string, schema: ArgsSchema, args: ArgsValue | undefined): ArgsValue {
  const input = args ?? {};
  const problems: string[] = [];
  const out: ArgsValue = {};

  for (const key of Object.keys(input)) {
    if (!(key in schema)) {
      const known = Object.keys(schema);
      const suggestion = nearestKey(key, known);
      problems.push(
        `unknown arg ${JSON.stringify(key)}${suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : ""}; known args: ${known.join(", ") || "none"}`,
      );
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const present = key in input;
    const value = present ? input[key] : spec.default;
    if (value === undefined) {
      problems.push(`missing required arg ${JSON.stringify(key)} (${spec.type})${spec.doc ? ` — ${spec.doc}` : ""}`);
      continue;
    }
    const problem = checkOne(key, spec, value);
    if (problem) problems.push(problem);
    else out[key] = coerce(key, spec, value);
  }

  if (problems.length) throw new ArgsError(scene, problems);
  return out;
}

function checkOne(key: string, spec: ArgSpec, value: unknown): string | undefined {
  const bad = (want: string): string =>
    `arg ${JSON.stringify(key)} must be ${want}, got ${describe(value)}`;
  switch (spec.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("a finite number");
      if (spec.min !== undefined && value < spec.min) return bad(`>= ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return bad(`<= ${spec.max}`);
      return undefined;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return bad("an integer");
      if (spec.min !== undefined && value < spec.min) return bad(`>= ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return bad(`<= ${spec.max}`);
      return undefined;
    case "string":
      if (typeof value !== "string") return bad("a string");
      if (spec.enum && !spec.enum.includes(value)) {
        return `${bad(`one of ${spec.enum.join(", ")}`)}; got ${JSON.stringify(value)}`;
      }
      return undefined;
    case "boolean":
      if (typeof value !== "boolean") return bad("a boolean");
      return undefined;
    case "color":
      return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
        ? undefined
        : bad("a hex colour such as #ffb347");
    case "numberArray": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return bad("an array of finite numbers");
      }
      if (spec.length !== undefined && value.length !== spec.length) {
        return bad(`an array of length ${spec.length}, got ${value.length}`);
      }
      return undefined;
    }
    case "time": {
      if (typeof value !== "string") return bad("a time expression string");
      // Shape check only; resolution against the timebase happens where a timebase exists.
      if (value.trim() === "") return bad("a non-empty time expression");
      return undefined;
    }
    case "any":
      return undefined;
  }
}

function coerce(_key: string, _spec: ArgSpec, value: unknown): unknown {
  // Deliberately a no-op today: values are already the right runtime type after `checkOne`.
  // It exists as the single place a future coercion (e.g. `"1"` → `1` for a number arg read from a
  // query string) would live, so that coercion never creeps into validation.
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Levenshtein-ish nearest key, for error messages only. */
function nearestKey(input: string, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const k of keys) {
    const score = similar(input.toLowerCase(), k.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

function similar(a: string, b: string): number {
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (!shorter.length) return 0;
  let hits = 0;
  for (let i = 0; i < shorter.length; i++) if (longer.includes(shorter[i] as string)) hits++;
  return hits / longer.length;
}

// --- scenes -------------------------------------------------------------------------------------

/** What a scene is handed for one shot's frame. All members are derived from time, never state. */
export interface SceneFrame {
  /** Output time in seconds, always the *default* timeline (canonical) time. */
  t: number;
  /** Seconds since this shot started. */
  lt: number;
  /** The output frame index. Per-frame decisions MUST key off this, not `floor(t*fps)`. */
  frame: number;
  fps: number;
  /** Layout for this project's output. Never hard-code 1920/1080 (`docs/SPEC.md` C7). */
  layout: import("./layout.js").Layout;
  /** The style this shot resolved, already merged (style defaults + shot overrides). */
  style: SceneStyle;
  /**
   * A colour from the style's palette **by role**, e.g. `f.color("amber")`.
   *
   * This exists because the alternative — indexing `f.style.palette.colors` positionally — is a silent
   * failure that cost a full session to find. A palette is ordered, and the conventional order is dark to
   * light, so `colors[0]` is the *background*. Three scenes in `templates/project` read `colors[0]` for
   * their accent and therefore drew their subject in the exact colour behind it: the frames contained a
   * vignette and nothing else, no error was thrown, `engine.problems` stayed empty, and every gate passed.
   *
   * **This method throws when the role is unknown**, and that asymmetry is the point. A missing role is a
   * style that has not been finished, and the failure to catch is not "the colour was slightly off" but
   * "the subject was invisible and everyone believed the render". There is deliberately no fallback
   * parameter: a caller that wants a default can write `f.style.palette.roles.amber ?? "#ff00ff"` and own
   * that decision explicitly, in the one place it is being made.
   *
   * The positional array remains available on `texture.js`'s ramps, where a gradient genuinely wants an
   * ordered light-to-dark sequence and the order is the argument.
   */
  color(role: string): string;
  /** The seeded generators are NOT passed in: import them from `rng.js` so keys stay explicit. */
}

export interface SceneDrawContext {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /**
   * The id of the shot being drawn. Present so a scene can build a deterministic key that is unique
   * per shot (`ctx.rng("spark")` must differ between two shots using the same scene).
   */
  readonly shotId: string;
  /**
   * Draw into an offscreen layer and composite it back. Offscreens are pooled; a leak is reported
   * by the engine rather than silently exhausting memory.
   */
  layer(options: LayerOptions, draw: (g: CanvasRenderingContext2D) => void): void;
  /**
   * Draw `drawFn` clipped to the region `maskFn` fills. `feather` softens the edge.
   */
  mask(
    maskFn: (g: CanvasRenderingContext2D) => void,
    drawFn: (g: CanvasRenderingContext2D) => void,
    options?: MaskOptions,
  ): void;
}

export interface LayerOptions {
  /** Drop-shadow blur in design units, or a full spec. `0` disables. */
  shadow?: number | { blur: number; dx: number; dy: number; color?: string };
  /** Multiply the layer by a colour, e.g. to push a background darker. */
  tint?: { color: string; alpha: number };
  alpha?: number;
  blend?: GlobalCompositeOperation;
  blurPx?: number;
}

export interface MaskOptions {
  feather?: number;
  invert?: boolean;
  alpha?: number;
  blend?: GlobalCompositeOperation;
}

export interface SceneDrawArgs {
  /** The 2-D context, already transformed into design space. */
  g: CanvasRenderingContext2D;
  /** The frame being drawn. */
  f: SceneFrame;
  /** Validated args: the schema's defaults merged with the shot's values. */
  args: ArgsValue;
  /** Layer/mask helpers, so a scene never reaches for an offscreen canvas itself. */
  cx: SceneDrawContext;
}

export interface SceneDefinition {
  name: string;
  /** Shown by `cvpw storyboard --list-scenes` and by the args-mismatch error. */
  doc?: string;
  argsSchema?: ArgsSchema;
  /**
   * Decode images/fonts. Called once, before the first frame, so that no frame ever waits on I/O —
   * which is both a determinism requirement and the reason a still is fast.
   */
  preload?(assets: AssetResolver): Promise<void> | void;
  /** Called once after preload, for building reusable geometry. Must not depend on time. */
  init?(ctx: SceneInitContext): void;
  /**
   * Draw one frame. MUST fully overwrite the region it draws in — a scene that leaves the previous
   * shot's pixels behind is the most common source of ghosting at a cut.
   */
  draw(args: SceneDrawArgs): void;
}

export interface SceneInitContext {
  layout: import("./layout.js").Layout;
  style: SceneStyle;
}

/** Resolves a project-relative asset path to something drawable. Supplied by the engine. */
export interface AssetResolver {
  image(path: string): Promise<HTMLImageElement>;
  text(path: string): Promise<string>;
  json<T>(path: string): Promise<T>;
}

// --- styles -------------------------------------------------------------------------------------

export interface SceneStyle {
  name: string;
  doc?: string;
  /** Ordered palette. Scenes index it or look up by role; a style guarantees at least one entry. */
  palette: {
    /** `#rrggbb` strings, darkest to lightest by convention. */
    colors: readonly string[];
    /** Named roles, e.g. `ink`, `accent`, `paper`. Scenes should prefer roles to indices. */
    roles: Readonly<Record<string, string>>;
  };
  /** Default values for scene args, keyed by scene name then arg name. */
  defaults?: Readonly<Record<string, ArgsValue>>;
  /** Post-processing values this style implies. Individual shots may override them. */
  post?: PostParams;
  /** Free-form, style-specific constants. A scene reading these should document the dependency. */
  tokens?: Readonly<Record<string, number | string | boolean>>;
}

export interface PostParams {
  vignette?: number;
  /** 0 = off. Applied as a multiply over the whole frame. */
  grain?: number;
  /** Bloom strength, 0..1. Applied by the WebGL2 chain: thresholded, blurred at two radii, added. */
  bloom?: number;
  /** Radial RGB separation, 0..1, strongest at the frame edges. WebGL2 chain only. */
  chromatic?: number;
  /** Whole-frame tint. */
  tint?: { color: string; alpha: number };
  saturate?: number;
  brightness?: number;
  contrast?: number;
}

// --- transports and checks ----------------------------------------------------------------------

export interface TransportDescriptor {
  name: string;
  doc: string;
  /** Implemented in `@cvpw/render`; the kernel only names the choices so a project can select one. */
  implemented: boolean;
}

export interface CheckDescriptor {
  id: string;
  doc: string;
  stage: number;
  /** Where the threshold comes from. A check may never invent one (`docs/SPEC.md` V5). */
  thresholdSource: "docs/QA.md" | "project.json::budgets";
  waiverAllowed: boolean;
}

// --- the registries -----------------------------------------------------------------------------

class Registry<T> {
  private readonly items = new Map<string, T>();

  constructor(
    private readonly kind: string,
    private readonly nameOf: (item: T) => string,
  ) {}

  register(item: T, options: { override?: boolean } = {}): T {
    const name = this.nameOf(item);
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      throw new Error(`${this.kind} name must match ^[A-Za-z][A-Za-z0-9_-]*$, got ${JSON.stringify(name)}`);
    }
    const existing = this.items.get(name);
    if (existing && !options.override) {
      throw new Error(`${this.kind} ${JSON.stringify(name)} is already registered; pass {override:true} to replace it deliberately`);
    }
    this.items.set(name, item);
    return item;
  }

  get(name: string): T | undefined {
    return this.items.get(name);
  }

  /** Throws with the full list, which is what an author needs when a name is misspelled. */
  require(name: string): T {
    const item = this.items.get(name);
    if (!item) {
      const known = this.names();
      throw new Error(
        `no ${this.kind} named ${JSON.stringify(name)}; registered: ${known.join(", ") || "(none)"}`,
      );
    }
    return item;
  }

  has(name: string): boolean {
    return this.items.has(name);
  }

  names(): string[] {
    return [...this.items.keys()].sort();
  }

  all(): T[] {
    return [...this.items.values()];
  }

  /** Testing/tooling only: empty the registry so a fixture can register its own set. */
  clear(): void {
    this.items.clear();
  }
}

export const scenes = new Registry<SceneDefinition>("scene", (s) => s.name);
export const styles = new Registry<SceneStyle>("style", (s) => s.name);
export const transports = new Registry<TransportDescriptor>("transport", (t) => t.name);
export const checks = new Registry<CheckDescriptor>("check", (c) => c.id);

/** Register a scene. Returns it, so a module can `export default scene({...})`. */
export function scene(definition: SceneDefinition): SceneDefinition {
  if (typeof definition.draw !== "function") {
    throw new Error(`scene ${JSON.stringify(definition.name)} must define draw()`);
  }
  return scenes.register(definition);
}

/** Register a style. A style must carry at least one colour. */
export function style(definition: SceneStyle): SceneStyle {
  if (!definition.palette?.colors?.length) {
    throw new Error(`style ${JSON.stringify(definition.name)} must declare at least one palette colour`);
  }
  for (const c of definition.palette.colors) {
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
      throw new Error(`style ${JSON.stringify(definition.name)} has a non-hex colour ${JSON.stringify(c)}`);
    }
  }
  return styles.register(definition);
}

/** Merge a style's defaults for a scene with a shot's explicit args, then validate. */
export function resolveSceneArgs(
  sceneName: string,
  styleName: string,
  shotArgs: ArgsValue | undefined,
): ArgsValue {
  const definition = scenes.require(sceneName);
  const styleDef = styles.require(styleName);
  const styleDefaults = styleDef.defaults?.[sceneName] ?? {};
  const merged: ArgsValue = { ...styleDefaults, ...(shotArgs ?? {}) };
  return validateArgs(sceneName, definition.argsSchema ?? {}, merged);
}

export function registerTransport(descriptor: TransportDescriptor): TransportDescriptor {
  return transports.register(descriptor);
}

export function registerCheck(descriptor: CheckDescriptor): CheckDescriptor {
  return checks.register(descriptor);
}

/**
 * A snapshot of what is registered, for `cvpw doctor`, `cvpw storyboard --list-scenes` and the
 * review report. Included in `render/report.json` so a rendered file can be traced to the code set
 * that produced it.
 */
export function registryManifest(): {
  scenes: string[];
  styles: string[];
  transports: string[];
  checks: string[];
} {
  return {
    scenes: scenes.names(),
    styles: styles.names(),
    transports: transports.names(),
    checks: checks.names(),
  };
}
