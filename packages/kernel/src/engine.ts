/**
 * The engine — the thing that turns a scalar `t` into pixels.
 *
 * Design notes that matter:
 *
 * - `renderFrame(t)` is the single entry point used by **both** the live preview and the offline
 *   exporter. If those two paths ever diverge, "the render matches the preview" becomes a claim
 *   instead of a fact.
 * - Time expressions are resolved once, at load, and cached. Resolution errors are collected rather
 *   than thrown during draw, so a project with one broken shot still renders the other 99 and reports
 *   the failure where an operator will see it.
 * - A shot that throws is isolated: the engine paints an error card **and** records the shot id. A
 *   failed scene must never take the film down, and must never be silently invisible.
 * - Offscreen layers come from a pool with leak detection, because an unbounded layer canvas is the
 *   most common way a project quietly runs out of memory on frame 3000.
 */

import { Layout, layoutFromOutput, type DesignSpace } from "./layout.js";
import {
  resolveSceneArgs,
  scenes,
  styles,
  type ArgsValue,
  type AssetResolver,
  type LayerOptions,
  type MaskOptions,
  type PostParams,
  type SceneDrawArgs,
  type SceneDrawContext,
  type SceneFrame,
  type SceneStyle,
} from "./plugin.js";
import { Timebase, TimeExpressionError, type Resolution } from "./time.js";
import type { TimebaseData } from "./timebase.js";
import { clamp01, hexToRgb, mixHex } from "./util.js";
import { createGLPost, wantsGLPost, type GLPost } from "./glpost.js";

/** One shot in the edit, after time resolution. */
export interface ResolvedShot {
  id: string;
  scene: string;
  style: string;
  /** Canonical start time, seconds. */
  t0: number;
  /** Canonical end time, seconds. Exclusive. */
  t1: number;
  frameFrom: number;
  frameTo: number;
  args: ArgsValue;
  post: PostParams;
  stateful: boolean;
  /** The `moment` sentence. Required by `cvpw storyboard`; the engine only carries it for tooling. */
  moment?: string;
  /** Source expression, kept for `render/report.json::resolvedTimes`. */
  atExpression: string;
}

/** A shot cannot be resolved, or its declaration is invalid. */
export interface ShotProblem {
  shotId: string;
  reason:
    | "unknown-scene"
    | "unknown-style"
    | "bad-args"
    | "bad-time"
    | "empty-range"
    | "out-of-order"
    | "draw-error"
    | "overlap-without-transition";
  message: string;
  alternatives?: readonly { id: string; t: number; delta?: number }[];
}

export interface EngineMeta {
  duration: number;
  fps: number;
  width: number;
  height: number;
  frames: number;
  /** The 2-D renderer string plus the WebGL2 renderer, as the browser reports them. */
  renderer: string;
  /** True when the browser fell back to a software rasteriser. Renders are ~10x slower. */
  software: boolean;
  scenes: string[];
  styles: string[];
  warnings: string[];
  problems: readonly ShotProblem[];
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Device pixel ratio: the supersampling factor. `1` for a native render. */
  dpr?: number;
  output: DesignSpace;
  timebase: TimebaseData;
  shots: readonly ShotDeclaration[];
  style: string;
  assets?: AssetResolver;
  /** Disable the film-grain finish pass. Seam comparison MUST run with grain off. */
  noGrain?: boolean;
  /** Burn time, frame and active shot ids into the frame. Review only; never in a master. */
  overlay?: boolean;
  /** Sub-frames per output frame, spread across the shutter. 1 = off. */
  samples?: number;
  /** Shutter fraction of a frame interval. 0.5 is a 180° shutter. */
  shutter?: number;
  /** Enforce that no draw happens with a wall-clock source. Development aid; see `audit`. */
  strict?: boolean;
}

/** A shot as authored in `timeline.json`, before resolution. */
export interface ShotDeclaration {
  id: string;
  scene: string;
  at: string;
  to?: string;
  moment?: string;
  block?: string;
  style?: string;
  args?: ArgsValue;
  post?: PostParams;
  stateful?: boolean;
  transition?: { type: string; overlap?: number };
  handoff?: { out?: string | null };
}

interface LayerPoolEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  inUse: boolean;
}

/** The page-facing API. Everything a tool needs, and nothing else. */
export interface CvpwPageApi {
  ready: Promise<EngineMeta>;
  renderFrame(t: number): void;
  meta: EngineMeta;
  probe(t: number, draw: (args: Parameters<NonNullable<import("./plugin.js").SceneDefinition["draw"]>>[0]) => void): void;
  frameHash(t: number): string;
}

const MAX_LAYERS = 8;

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  readonly layout: Layout;
  readonly timebase: Timebase;
  readonly dpr: number;
  readonly samples: number;
  readonly shutter: number;
  readonly styleName: string;
  readonly styleDef: SceneStyle;

  private readonly options: EngineOptions;
  private readonly layers: LayerPoolEntry[] = [];
  private readonly shotProblems: ShotProblem[] = [];
  private readonly warnings: string[] = [];
  /** The WebGL2 post chain, created on first use. Null until a frame actually needs it. */
  private glPost: GLPost | null = null;
  private readonly resolutions = new Map<string, Resolution>();
  private resolved: ResolvedShot[] = [];
  private metaResult: EngineMeta | undefined;

  constructor(options: EngineOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.dpr = options.dpr ?? 1;
    this.samples = Math.max(1, Math.floor(options.samples ?? 1));
    this.shutter = options.shutter ?? 0.5;
    this.styleName = options.style;
    this.styleDef = styles.require(options.style);

    const ctx = options.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("the canvas has no 2-D context");
    this.g = ctx;

    this.layout = new Layout(options.output);
    this.canvas.width = Math.round(options.output.width * this.dpr);
    this.canvas.height = Math.round(options.output.height * this.dpr);
    if (this.canvas.width % 2 !== 0) this.warnings.push(`canvas width ${this.canvas.width} is odd; yuv420p needs even dimensions`);
    if (this.canvas.height % 2 !== 0) this.warnings.push(`canvas height ${this.canvas.height} is odd; yuv420p needs even dimensions`);

    this.timebase = new Timebase(options.timebase);
    this.resolveShots();
  }

  // --- loading ----------------------------------------------------------------------------------

  /**
   * Load fonts and preload every scene's assets, then declare readiness.
   *
   * `window.cvpw.ready` MUST NOT resolve before this finishes: a frame rendered before fonts settle
   * uses a fallback face, so the first frames of a render would not match the rest — a determinism
   * leak that only shows up as a slightly different title card.
   */
  async load(): Promise<EngineMeta> {
    if (this.metaResult) return this.metaResult;

    if (typeof document !== "undefined" && "fonts" in document) {
      try {
        await (document as Document & { fonts: FontFaceSet }).fonts.ready;
      } catch (err) {
        this.warnings.push(`document.fonts.ready failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const used = new Set(this.resolved.map((s) => s.scene));
    const assets = this.options.assets;
    for (const name of used) {
      const definition = scenes.get(name);
      if (!definition?.preload) continue;
      if (!assets) {
        this.warnings.push(`scene ${name} declares preload() but no asset resolver was supplied`);
        continue;
      }
      try {
        await definition.preload(assets);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.shotProblems.push({ shotId: `${name} (preload)`, reason: "unknown-scene", message });
        this.warnings.push(`scene ${name} failed to preload: ${message}`);
      }
    }

    for (const name of used) {
      const definition = scenes.get(name);
      if (!definition?.init) continue;
      try {
        definition.init({ layout: this.layout, style: this.styleDef });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.shotProblems.push({ shotId: `${name} (init)`, reason: "unknown-scene", message });
      }
    }

    // Warm the canvas so the first drawn frame of a render is not measurably different: an
    // ImageBitmap's first draw differs from its second, and that difference otherwise lands on
    // frame 0 and on the first frame after every shot change.
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.fillStyle = "#000";
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.metaResult = this.describe();
    return this.metaResult;
  }

  private describe(): EngineMeta {
    const renderer = detectRenderer();
    return {
      duration: this.timebase.duration,
      fps: this.timebase.fps,
      width: this.options.output.width,
      height: this.options.output.height,
      frames: this.timebase.frames,
      renderer: renderer.name,
      software: renderer.software,
      scenes: scenes.names(),
      styles: styles.names(),
      warnings: [...this.warnings],
      problems: [...this.shotProblems],
    };
  }

  get meta(): EngineMeta {
    return this.metaResult ?? this.describe();
  }

  get problems(): readonly ShotProblem[] {
    return this.shotProblems;
  }

  /** Resolved shots, for `cvpw storyboard` and `render/report.json::resolvedTimes`. */
  get shotList(): readonly ResolvedShot[] {
    return this.resolved;
  }

  get resolvedTimes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.resolved) out[s.id] = s.t0;
    return out;
  }

  // --- time resolution --------------------------------------------------------------------------

  private resolveShots(): void {
    const declarations = [...this.options.shots];
    const rows: ResolvedShot[] = [];

    for (let i = 0; i < declarations.length; i++) {
      const decl = declarations[i] as ShotDeclaration;
      const next = declarations[i + 1];

      if (scenes.get(decl.scene) === undefined) {
        this.shotProblems.push({
          shotId: decl.id,
          reason: "unknown-scene",
          message: `no scene named ${JSON.stringify(decl.scene)}; registered: ${scenes.names().join(", ") || "(none)"}`,
        });
        continue;
      }
      const styleName = decl.style ?? this.styleName;
      if (styles.get(styleName) === undefined) {
        this.shotProblems.push({
          shotId: decl.id,
          reason: "unknown-style",
          message: `no style named ${JSON.stringify(styleName)}; registered: ${styles.names().join(", ") || "(none)"}`,
        });
        continue;
      }

      let t0: number;
      try {
        const r = this.resolve(decl.at);
        t0 = r.t;
      } catch (err) {
        this.shotProblems.push(this.timeProblem(decl, err));
        continue;
      }

      let t1: number;
      if (decl.to !== undefined) {
        try {
          t1 = this.resolve(decl.to).t;
        } catch (err) {
          this.shotProblems.push(this.timeProblem(decl, err));
          continue;
        }
      } else if (next) {
        try {
          t1 = this.resolve(next.at).t;
        } catch (err) {
          this.shotProblems.push(this.timeProblem(decl, err));
          continue;
        }
      } else {
        t1 = this.timebase.duration;
      }

      if (!(t1 > t0)) {
        this.shotProblems.push({
          shotId: decl.id,
          reason: "empty-range",
          message: `resolves to an empty or reversed range [${t0.toFixed(3)}, ${t1.toFixed(3)})`,
        });
        continue;
      }

      let args: ArgsValue = {};
      try {
        args = resolveSceneArgs(decl.scene, styleName, decl.args);
      } catch (err) {
        this.shotProblems.push({
          shotId: decl.id,
          reason: "bad-args",
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      rows.push({
        id: decl.id,
        scene: decl.scene,
        style: styleName,
        t0,
        t1,
        frameFrom: this.timebase.frameIndex(t0),
        frameTo: this.timebase.frameIndex(t1),
        args,
        post: { ...(this.styleDef.post ?? {}), ...(decl.post ?? {}) },
        stateful: decl.stateful === true,
        ...(decl.moment !== undefined ? { moment: decl.moment } : {}),
        atExpression: decl.at,
      });
    }

    // Ordering and overlap are the author's business, but a machine can see them, so it reports them.
    let prevEnd = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ResolvedShot;
      if (row.t0 < prevEnd - 1e-6) {
        const decl = declarations.find((d) => d.id === row.id);
        const overlap = prevEnd - row.t0;
        const owned = decl?.transition !== undefined && (decl.transition.overlap ?? 0) >= 0;
        this.shotProblems.push({
          shotId: row.id,
          reason: owned ? "overlap-without-transition" : "overlap-without-transition",
          message: owned
            ? `overlaps the previous shot by ${overlap.toFixed(3)}s and declares a transition; the LATER shot owns drawing it`
            : `overlaps the previous shot by ${overlap.toFixed(3)}s without declaring a transition`,
        });
      }
      if (row.t0 < 0) {
        this.shotProblems.push({ shotId: row.id, reason: "bad-time", message: `starts at ${row.t0.toFixed(3)}s, before 0` });
      }
      if (row.t0 > prevEnd + 1e-6 && i > 0) {
        this.shotProblems.push({
          shotId: row.id,
          reason: "empty-range",
          message: `leaves a gap [${prevEnd.toFixed(3)}, ${row.t0.toFixed(3)}) with no active shot`,
        });
      }
      prevEnd = Math.max(prevEnd, row.t1);
    }
    if (rows.length && (rows[0] as ResolvedShot).t0 > 1e-6) {
      this.shotProblems.push({
        shotId: (rows[0] as ResolvedShot).id,
        reason: "empty-range",
        message: `the first shot starts at ${(rows[0] as ResolvedShot).t0.toFixed(3)}s, not 0`,
      });
    }
    if (rows.length && Math.abs(prevEnd - this.timebase.duration) > 1e-3) {
      this.shotProblems.push({
        shotId: "timeline",
        reason: "empty-range",
        message: `the last shot ends at ${prevEnd.toFixed(3)}s but the duration is ${this.timebase.duration.toFixed(3)}s`,
      });
    }

    this.resolved = rows;
  }

  private timeProblem(decl: ShotDeclaration, err: unknown): ShotProblem {
    if (err instanceof TimeExpressionError) {
      return {
        shotId: decl.id,
        reason: "bad-time",
        message: err.message,
        alternatives: err.alternatives,
      };
    }
    return {
      shotId: decl.id,
      reason: "bad-time",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  private resolve(expression: string): Resolution {
    const cached = this.resolutions.get(expression);
    if (cached) return cached;
    const r = this.timebase.resolve(expression);
    this.resolutions.set(expression, r);
    return r;
  }

  // --- drawing ----------------------------------------------------------------------------------

  /**
   * Draw the frame at output time `t`.
   *
   * With `samples > 1` the frame is the average of sub-frames spread across the shutter window.
   * Sub-frames are clamped so they never cross into a neighbouring shot: crossing would blend two
   * unrelated pictures and produce a ghost at exactly the cut, which is the opposite of what motion
   * blur is for.
   */
  renderFrame(t: number): void {
    const clamped = Math.max(0, Math.min(this.timebase.duration - 1e-6, t));

    if (this.samples <= 1) {
      this.renderOnce(clamped, this.g, this.canvas.width, this.canvas.height, false);
      // **This branch used to return here, and that one line is why the whole grade was dead.**
      //
      // `samples` defaults to 1, so every ordinary render took this path — while `finish()`, which applies
      // `post.vignette`, `post.tint`, `post.grain` and `post.bloom`, was only called at the end of the
      // motion-blur branch below. Confirmed with a counter inside `finish`: after rendering a frame of a shot
      // declaring `post: { bloom: 0.35 }`, the counter was still `undefined`.
      //
      // Everything this hid: no project has ever had its declared grade applied; `noGrain` never mattered;
      // `docs/QA.md`'s "seam comparison must run with grain off" was satisfied by grain never running at all;
      // and `drawOverlay` was skipped here too, so `--overlay` stills carried no overlay.
      const active = this.activeShots(this.timebase.frameIndex(clamped));
      this.finish(this.g, active, this.timebase.frameIndex(clamped));
      if (this.options.overlay) this.drawOverlay(this.g, clamped, active);
      return;
    }

    // Sub-frames are drawn into rotating temporary layers and averaged with incremental alpha
    // (1/(i+1)), which gives every sub-frame equal weight without needing to store them all.
    const dt = 1 / this.timebase.fps;
    const span = this.shutter * dt;
    const segmentStart = this.segmentStart(clamped);
    const g = this.g;

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = "#000";
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();

    for (let i = 0; i < this.samples; i++) {
      const offset = this.samples === 1 ? 0 : (i / (this.samples - 1) - 0.5) * span;
      const sub = Math.max(segmentStart, clamped + offset);
      const tmp = this.acquire();
      this.renderOnce(sub, tmp.ctx, tmp.canvas.width, tmp.canvas.height, true);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1 / (i + 1);
      g.drawImage(tmp.canvas, 0, 0);
      g.restore();
      this.release(tmp);
    }

    const active = this.activeShots(this.timebase.frameIndex(clamped));
    this.finish(g, active, this.timebase.frameIndex(clamped));
    if (this.options.overlay) this.drawOverlay(g, clamped, active);
  }

  /** The start of the shot segment containing `t`; sub-frames may not precede it. */
  private segmentStart(t: number): number {
    const frame = this.timebase.frameIndex(t);
    for (const s of this.resolved) {
      if (frame >= s.frameFrom && frame < s.frameTo) return s.t0;
    }
    return 0;
  }

  /** Every shot live at a frame index. */
  private activeShots(frame: number): ResolvedShot[] {
    return this.resolved.filter((s) => frame >= s.frameFrom && frame < s.frameTo);
  }

  /** Draw one picture at time `t` into an explicit target. No finish pass, no overlay. */
  private renderOnce(
    t: number,
    g: CanvasRenderingContext2D,
    width: number,
    height: number,
    compositing: boolean,
  ): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.fillStyle = "#000";
    g.fillRect(0, 0, width, height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const frame = this.timebase.frameIndex(t);
    const active = this.activeShots(frame);

    if (active.length === 0 && !compositing) {
      this.drawNoShot(g, t);
    }

    for (const shot of active) {
      const definition = scenes.get(shot.scene);
      if (!definition) continue;
      const shotStyle = styles.require(shot.style);
      const sceneFrame: SceneFrame = {
        t,
        lt: t - shot.t0,
        frame,
        fps: this.timebase.fps,
        layout: this.layout,
        style: shotStyle,
        // Throws on an unknown role rather than returning a fallback. See the note on `SceneFrame.color`:
        // the failure this prevents is a scene drawing its subject in the background colour, which reports
        // nothing and survives every gate.
        color(role: string): string {
          const value = shotStyle.palette.roles[role];
          if (typeof value !== "string" || value.length === 0) {
            throw new Error(
              `style ${JSON.stringify(shotStyle.name)} has no colour role ${JSON.stringify(role)}; ` +
                `it defines ${Object.keys(shotStyle.palette.roles).join(", ") || "(none)"}. ` +
                `Add the role to the style rather than falling back to a guess.`,
            );
          }
          return value;
        },
      };
      const cx = this.makeDrawContext(t, shot, g);
      try {
        g.save();
        definition.draw({ g, f: sceneFrame, args: shot.args, cx });
        g.restore();
      } catch (err) {
        try {
          g.restore();
        } catch {
          /* the scene may have unbalanced save/restore; the error card below is the report */
        }
        this.shotProblems.push({
          shotId: shot.id,
          reason: "draw-error",
          message: `draw() threw at t=${t.toFixed(3)}: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.drawErrorCard(g, shot.id, err);
      }
    }

    if (this.layers.some((l) => l.inUse)) {
      const leaked = this.layers.filter((l) => l.inUse).length;
      this.warnings.push(`${leaked} layer(s) leaked by a scene at t=${t.toFixed(3)}`);
      for (const l of this.layers) l.inUse = false;
    }
  }

  private makeDrawContext(t: number, shot: ResolvedShot, target: CanvasRenderingContext2D): SceneDrawContext {
    const self = this;
    return {
      canvas: this.canvas,
      ctx: target,
      layer(options: LayerOptions, draw: (gg: CanvasRenderingContext2D) => void): void {
        self.withLayer(target, options, draw);
      },
      mask(
        maskFn: (gg: CanvasRenderingContext2D) => void,
        drawFn: (gg: CanvasRenderingContext2D) => void,
        options: MaskOptions = {},
      ): void {
        self.withMask(target, t, maskFn, drawFn, options);
      },
      shotId: shot.id,
    };
  }

  private withLayer(
    target: CanvasRenderingContext2D,
    options: LayerOptions,
    draw: (g: CanvasRenderingContext2D) => void,
  ): void {
    const layer = this.acquire();
    const lg = layer.ctx;
    lg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    lg.globalAlpha = 1;
    lg.globalCompositeOperation = "source-over";
    lg.filter = "none";
    lg.clearRect(0, 0, this.layout.width, this.layout.height);
    try {
      draw(lg);
    } finally {
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = options.alpha ?? 1;
      target.globalCompositeOperation = options.blend ?? "source-over";
      if (options.blurPx) target.filter = `blur(${options.blurPx * this.dpr}px)`;
      target.drawImage(layer.canvas, 0, 0);
      if (options.shadow) {
        const spec =
          typeof options.shadow === "number"
            ? { blur: options.shadow, dx: 0, dy: options.shadow * 0.35 }
            : options.shadow;
        target.globalAlpha = (options.alpha ?? 1) * 0.55;
        target.filter = `blur(${Math.max(1, spec.blur) * this.dpr}px)`;
        target.drawImage(layer.canvas, spec.dx * this.dpr, spec.dy * this.dpr);
      }
      target.restore();
      if (options.tint) {
        // Tinting a composited layer in place is not possible with a single pass: a `multiply`
        // would colour the whole frame, not just the layer's pixels. Compositing the tint back
        // through the layer's own alpha is what keeps it local.
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.globalCompositeOperation = "multiply";
        target.globalAlpha = options.tint.alpha;
        target.fillStyle = options.tint.color;
        target.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
        target.globalCompositeOperation = "destination-in";
        target.globalAlpha = 1;
        target.drawImage(layer.canvas, 0, 0);
        target.restore();
      }
      this.release(layer);
    }
  }

  private withMask(
    target: CanvasRenderingContext2D,
    t: number,
    maskFn: (g: CanvasRenderingContext2D) => void,
    drawFn: (g: CanvasRenderingContext2D) => void,
    options: MaskOptions,
  ): void {
    void t;
    const maskLayer = this.acquire();
    const drawLayer = this.acquire();
    try {
      const mg = maskLayer.ctx;
      mg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      mg.clearRect(0, 0, this.layout.width, this.layout.height);
      mg.globalCompositeOperation = "source-over";
      mg.fillStyle = "#fff";
      mg.globalAlpha = 1;
      mg.filter = options.feather ? `blur(${options.feather * this.dpr}px)` : "none";
      maskFn(mg);
      mg.filter = "none";

      const dg = drawLayer.ctx;
      dg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      dg.clearRect(0, 0, this.layout.width, this.layout.height);
      dg.globalCompositeOperation = "source-over";
      dg.globalAlpha = 1;
      dg.filter = "none";
      drawFn(dg);

      dg.setTransform(1, 0, 0, 1, 0, 0);
      dg.globalCompositeOperation = options.invert ? "destination-out" : "destination-in";
      dg.drawImage(maskLayer.canvas, 0, 0);
      dg.globalCompositeOperation = "source-over";

      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = options.alpha ?? 1;
      target.globalCompositeOperation = options.blend ?? "source-over";
      target.drawImage(drawLayer.canvas, 0, 0);
      target.restore();
    } finally {
      this.release(drawLayer);
      this.release(maskLayer);
    }
  }

  /**
   * Whole-frame finish: vignette, tint, grain.
   *
   * Only the last active shot's post values apply, so a transition does not average two unrelated
   * grades into a third that neither shot asked for. `frame` is passed in rather than read from a
   * field, because grain must be keyed on the output frame (`docs/SPEC.md` D6).
   */
  private finish(g: CanvasRenderingContext2D, active: readonly ResolvedShot[], frame: number): void {
    const post = active.length ? (active[active.length - 1] as ResolvedShot).post : {};
    const w = this.canvas.width;
    const h = this.canvas.height;

    if (post.vignette && post.vignette > 0) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const gradient = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.72);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, `rgba(0,0,0,${clamp01(post.vignette)})`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, w, h);
      g.restore();
    }
    if (post.tint) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = clamp01(post.tint.alpha);
      g.fillStyle = post.tint.color;
      g.fillRect(0, 0, w, h);
      g.restore();
    }
    if (!this.options.noGrain && post.grain && post.grain > 0) {
      this.drawGrain(g, post.grain, frame);
    }


    // `bloom` was declared in `timeline.schema.json`, used by the template's own timeline, and **silently
    // ignored** — the schema accepted it, so nothing warned. That is the exact class of defect this framework
    // forbids (A4: a key is caught, never quietly dropped), and it went unnoticed for as long as it did because
    // validation was doing its job on the wrong side of the boundary.
    //
    // This is a real bloom, not a stand-in: a blurred copy of the frame screened over itself lifts highlights
    // into a halo. It is NOT physically correct — a film-grade bloom thresholds the bright areas first and
    // blurs them at several radii, which needs a WebGL chain and is why `docs/ARCHITECTURE.md` reserves that for
    // phase 2. What it does is make the declared value control something visible, which is the minimum a
    // contract owes its callers.
    // WebGL2 first. A thresholded, multi-radius bloom is what the effect actually IS — Canvas2D cannot express it,
    // which is why `docs/ARCHITECTURE.md` reserved this for phase 2. The chain owns its own canvas because a
    // canvas that already has a 2D context cannot also hand out a WebGL2 one, so the result comes back here.
    let glApplied = false;
    if (wantsGLPost(post)) {
      this.glPost ??= createGLPost();
      const post2d = this.glPost;
      if (post2d.available && post2d.canvas) {
        // FLUSH FIRST. Canvas2D drawing is queued and returns immediately, so uploading the canvas as a texture
        // can capture a frame whose draw calls have not all executed — the same defect that made `--workers`
        // change the film earlier in this project, reappearing at a new seam. One pixel read forces rasterisation.
        g.getImageData(0, 0, 1, 1);
        glApplied = post2d.apply(
          this.canvas,
          {
            bloom: post.bloom,
            chromatic: post.chromatic,
            saturate: post.saturate,
            brightness: post.brightness,
            contrast: post.contrast,
          },
          w,
          h,
        );
        if (glApplied) {
          g.save();
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = "copy";
          g.drawImage(post2d.canvas, 0, 0);
          g.restore();
        }
      }
    }
    // Canvas2D fallback: cruder, and it stays because a machine that lost its GPU must still render the film. A
    // post chain that fails closed would make the framework unrunnable for a cosmetic reason.
    if (post.bloom && post.bloom > 0 && !glApplied) {
      const layer = this.acquire();
      const lg = layer.ctx;
      lg.setTransform(1, 0, 0, 1, 0, 0);
      lg.globalCompositeOperation = "source-over";
      lg.globalAlpha = 1;
      lg.filter = "none";
      lg.clearRect(0, 0, w, h);
      lg.drawImage(this.canvas, 0, 0);

      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "screen";
      g.globalAlpha = clamp01(post.bloom);
      // The blur radius scales with the frame so a 4K render blooms by the same proportion, not by the same
      // pixels — the same reasoning as `layout.type()`.
      g.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) * 0.012))}px)`;
      g.drawImage(layer.canvas, 0, 0);
      g.filter = "none";
      g.restore();
      this.release(layer);
    }

    // Anything a project declares that this engine does not honour is named, once, as a warning. The keys are
    // checked against the set actually implemented above, so adding a key to the schema without implementing it
    // produces a complaint rather than a silent no-op.
    const honoured = new Set(["vignette", "tint", "grain", "bloom"]);
    for (const key of Object.keys(post)) {
      if (honoured.has(key)) continue;
      const message = `post.${key} is declared but this engine does not implement it, so it has no effect`;
      if (!this.warnings.includes(message)) this.warnings.push(message);
    }
  }

  /**
   * Deterministic film grain.
   *
   * A hash-based pattern rather than an image, so the grain of a given frame is a function of the
   * frame index alone and two workers agree. It is intentionally keyed on `frame`, never on `t`
   * (`docs/SPEC.md` D6) — otherwise grain crawls within a single motion-blurred frame.
   */
  private drawGrain(g: CanvasRenderingContext2D, amount: number, frame: number): void {
    const strength = Math.round(clamp01(amount) * 255);
    if (strength <= 0) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const step = Math.max(1, Math.round(this.dpr * 2));
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.globalCompositeOperation = "overlay";
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const n = hashGrain(x, y, frame);
        if (n === 0) continue;
        g.fillStyle = n > 0 ? `rgba(255,255,255,${(n * strength) / 255})` : `rgba(0,0,0,${(-n * strength) / 255})`;
        g.fillRect(x, y, step, step);
      }
    }
    g.restore();
  }

  private drawNoShot(g: CanvasRenderingContext2D, t: number): void {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#1b1b24";
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = "#8a8aa0";
    g.font = `${Math.round(this.dpr * 28)}px monospace`;
    g.fillText(`NO SHOT @ t=${t.toFixed(3)}`, Math.round(this.dpr * 40), Math.round(this.dpr * 60));
    g.restore();
    this.warnings.push(`no active shot at t=${t.toFixed(3)}`);
  }

  private drawErrorCard(g: CanvasRenderingContext2D, shotId: string, err: unknown): void {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "rgba(150,20,20,0.85)";
    g.fillRect(0, 0, this.canvas.width, Math.round(this.dpr * 90));
    g.fillStyle = "#fff";
    g.font = `${Math.round(this.dpr * 26)}px monospace`;
    g.fillText(`[${shotId}] ${err instanceof Error ? err.message : String(err)}`.slice(0, 120), Math.round(this.dpr * 20), Math.round(this.dpr * 56));
    g.restore();
  }

  /**
   * Debug overlay: time, frame, active shot ids, resolution. Review images are otherwise ambiguous —
   * an agent looking at a contact sheet cannot tell which shot produced a defect, and guessing is
   * how the wrong file gets edited.
   */
  private drawOverlay(g: CanvasRenderingContext2D, t: number, active: readonly ResolvedShot[]): void {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.round(this.dpr * 22);
    g.font = `${size}px monospace`;
    const lines = [
      `t=${t.toFixed(3)}  f=${this.timebase.frameIndex(t)}/${this.timebase.frames}`,
      `out=${this.options.output.width}x${this.options.output.height}@${this.timebase.fps} dpr=${this.dpr}`,
      `shot=${active.map((s) => s.id).join("+") || "NONE"}`,
      `scene=${active.map((s) => s.scene).join("+") || "-"} style=${this.styleName}`,
    ];
    const pad = Math.round(this.dpr * 12);
    const lineHeight = size + Math.round(this.dpr * 6);
    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, g.measureText(line).width);
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, 0, maxWidth + pad * 2, lineHeight * lines.length + pad);
    g.fillStyle = "#ffe28e";
    lines.forEach((line, i) => {
      g.fillText(line, pad, pad + size + i * lineHeight);
    });
    g.restore();
  }

  /**
   * Draw one reference frame with an externally supplied draw function.
   *
   * This is the seam-verification path: a handoff contract ships a `drawSeam()` reference
   * implementation, and a seam check compares the film's own frame at `T` against this reference.
   * It deliberately bypasses time-expression resolution and the finish pass, because the reference
   * is meant to be reproducible before the film around it works.
   */
  probe(t: number, draw: (args: SceneDrawArgs) => void): void {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.fillStyle = "#000";
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const frame = this.timebase.frameIndex(t);
    const synthetic: SceneFrame = {
      t,
      lt: 0,
      frame,
      fps: this.timebase.fps,
      layout: this.layout,
      style: this.styleDef,
      color: (role: string): string => {
        const value = this.styleDef.palette.roles[role];
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(
            `style ${JSON.stringify(this.styleDef.name)} has no colour role ${JSON.stringify(role)}`,
          );
        }
        return value;
      },
    };
    const probeShot: ResolvedShot = {
      id: "__probe__",
      scene: "__probe__",
      style: this.styleName,
      t0: t,
      t1: t,
      frameFrom: frame,
      frameTo: frame + 1,
      args: {},
      post: {},
      stateful: false,
      atExpression: String(t),
    };
    g.save();
    draw({ g, f: synthetic, args: {}, cx: this.makeDrawContext(t, probeShot, g) });
    g.restore();
  }

  /**
   * A cheap deterministic content hash of the current canvas, as `djb2` over a sparse pixel sample.
   *
   * Sparse and quantised on purpose: it must be stable across GPUs, and its job is to notice that
   * something changed, not to be a checksum. `qa/gold.json` stores these values.
   */
  frameHash(): string {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const data = this.g.getImageData(0, 0, w, h).data;
    let hash = 5381;
    // 64x64 grid over the frame: enough to catch a moved element, immune to one-pixel dither.
    const gx = 64;
    const gy = 64;
    for (let j = 0; j < gy; j++) {
      const y = Math.floor(((j + 0.5) / gy) * h);
      for (let i = 0; i < gx; i++) {
        const x = Math.floor(((i + 0.5) / gx) * w);
        const o = (y * w + x) * 4;
        const r = (data[o] as number) >> 3;
        const gg = (data[o + 1] as number) >> 3;
        const b = (data[o + 2] as number) >> 3;
        hash = (((hash << 5) + hash) ^ (r * 1024 + gg * 32 + b)) >>> 0;
      }
    }
    return hash.toString(16).padStart(8, "0");
  }

  // --- layer pool ------------------------------------------------------------------------------

  private acquire(): LayerPoolEntry {
    for (const entry of this.layers) {
      if (!entry.inUse) {
        entry.inUse = true;
        return entry;
      }
    }
    if (this.layers.length >= MAX_LAYERS) {
      throw new Error(
        `the offscreen layer pool is exhausted (${MAX_LAYERS}); a scene is nesting ctx.layer() calls, or leaked one`,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const ctx2 = canvas.getContext("2d", { alpha: true });
    if (!ctx2) throw new Error("could not create an offscreen 2-D context");
    const entry: LayerPoolEntry = { canvas, ctx: ctx2, inUse: true };
    this.layers.push(entry);
    return entry;
  }

  private release(entry: LayerPoolEntry): void {
    entry.inUse = false;
    // Reset every piece of mutable context state a scene could have left behind. A pooled canvas
    // that keeps a stale `filter` or `globalCompositeOperation` produces a bug in the *next* shot,
    // which is the hardest kind of defect to attribute.
    const g = entry.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
  }
}

/** Mix a hex colour for scene use, re-exported so scenes need only import the kernel. */
export { mixHex, hexToRgb };

/** Hash for the grain pattern. Signed -1..1, keyed on (x, y, frame). */
function hashGrain(x: number, y: number, frame: number): number {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(frame + 1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  const v = (h >>> 0) / 2147483648 - 1;
  return Math.abs(v) < 0.35 ? 0 : v;
}

interface RendererInfo {
  name: string;
  software: boolean;
}

const SOFTWARE_MARKERS = ["swiftshader", "warp", "llvmpipe", "software", "basic render", "microsoft basic"];

/**
 * Detect the real renderer, from WebGL2 where available and from the 2-D context's capabilities.
 *
 * The distinction between GPU and software rasterisation is not cosmetic: a software renderer is
 * roughly ten times slower and its float behaviour differs, so a render produced under it is a
 * different artefact. `cvpw doctor` reports it and the renderer refuses it unless told otherwise.
 */
export function detectRenderer(): RendererInfo {
  if (typeof document === "undefined") return { name: "none (no document)", software: false };
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") as WebGL2RenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      const lower = name.toLowerCase();
      return { name, software: SOFTWARE_MARKERS.some((m) => lower.includes(m)) };
    }
    const canvas2d = probe.getContext("2d");
    const name = canvas2d ? "Canvas2D only (no WebGL2)" : "unknown";
    return { name, software: false };
  } catch (err) {
    return { name: `probe failed: ${err instanceof Error ? err.message : String(err)}`, software: false };
  }
}

/** Build the page API object. The template's entry module calls this and nothing else. */
export async function bootEngine(options: EngineOptions): Promise<{ engine: Engine; api: CvpwPageApi }> {
  const engine = new Engine(options);
  const ready = engine.load();

  const api: CvpwPageApi = {
    ready,
    meta: engine.meta,
    renderFrame(t: number) {
      engine.renderFrame(t);
    },
    probe(t, draw) {
      engine.probe(t, draw);
    },
    frameHash(t: number) {
      engine.renderFrame(t);
      return engine.frameHash();
    },
  };

  await ready;
  api.meta = engine.meta;
  return { engine, api };
}

export { layoutFromOutput };
