/**
 * Layout — the anti-hard-coding layer.
 *
 * Scenes MUST NOT contain raw `1920`/`1080` arithmetic (`docs/SPEC.md` C7). They ask this module for
 * a rect in the *design space*, and this module is the only place that knows the numbers. That is
 * what makes a vertical variant a layout change rather than a rewrite: the same scene, a different
 * {@link LayoutProfile}, a different film.
 */

export interface DesignSpace {
  width: number;
  height: number;
  /** Minimum inset from every edge for anything that must not be clipped. */
  safe: number;
  /**
   * The bottom band reserved for subtitles. Content whose `y` is at or below this value, in a
   * sung/section, would collide with subtitles and is therefore decoration-only (`docs/SPEC.md` C8).
   */
  subtitleBand: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rectangle in normalised space: `[0,1]` across and down, measured from the top-left.
 * Normalised values are what a style stores, because they survive a resolution change.
 */
export interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Anchor =
  | "topLeft"
  | "top"
  | "topRight"
  | "left"
  | "center"
  | "right"
  | "bottomLeft"
  | "bottom"
  | "bottomRight";

/** The project's output profile plus the design space derived from it. */
export interface LayoutProfile {
  space: DesignSpace;
  /** Multiply a design-space length by this to get output pixels. Always 1 for a native render. */
  scale: number;
}

const ANCHOR_UV: Record<Anchor, readonly [number, number]> = {
  topLeft: [0, 0],
  top: [0.5, 0],
  topRight: [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  bottomLeft: [0, 1],
  bottom: [0.5, 1],
  bottomRight: [1, 1],
};

export class Layout {
  readonly space: DesignSpace;
  readonly orientation: "landscape" | "portrait" | "square";

  constructor(space: DesignSpace) {
    if (!(space.width > 0) || !(space.height > 0)) {
      throw new Error(`layout needs a positive design space, got ${space.width}x${space.height}`);
    }
    this.space = space;
    const ratio = space.width / space.height;
    this.orientation = ratio > 1.05 ? "landscape" : ratio < 0.95 ? "portrait" : "square";
  }

  get width(): number {
    return this.space.width;
  }

  get height(): number {
    return this.space.height;
  }

  /** The longest edge, the natural unit for type sizing that must read at a glance. */
  get longEdge(): number {
    return Math.max(this.space.width, this.space.height);
  }

  /** The content rect after the safe inset. */
  get safeRect(): Rect {
    const s = this.space.safe;
    return { x: s, y: s, w: this.width - 2 * s, h: this.height - 2 * s };
  }

  /**
   * The usable height for content that must not collide with subtitles.
   *
   * In a portrait film the subtitle band is a much larger fraction of the frame, and this is the
   * value that keeps a title from being eaten by the subtitle layer.
   */
  get contentHeight(): number {
    return Math.max(0, this.space.subtitleBand - this.space.safe);
  }

  /**
   * A fraction of the design space as a rect.
   * `w`/`h` default to the full safe width and the band above the subtitles.
   */
  band(top: number, bottom: number, options: { w?: number; x?: number } = {}): Rect {
    const w = options.w ?? this.width;
    const x = options.x ?? (this.width - w) / 2;
    const y = top;
    const h = bottom - top;
    if (h <= 0) throw new Error(`band() needs bottom > top, got top=${top} bottom=${bottom}`);
    return { x, y, w, h };
  }

  /**
   * Position a block of `w`x`h` (in design units) against an anchor inside the safe rect.
   *
   * The `place(anchor, w, h)` / `fromUnit(unitRect, anchor)` pair is the only sanctioned way to turn
   * a position into coordinates. Round-tripping them must be exact, so both use the same anchor
   * convention: the anchor point is where the rect's own anchor sits.
   */
  place(anchor: Anchor, w: number, h: number, margin = this.space.safe): Rect {
    const [ux, uy] = ANCHOR_UV[anchor];
    const innerW = this.width - 2 * margin;
    const x = margin + ux * Math.max(0, innerW - w);
    const y = margin + uy * Math.max(0, this.contentHeight - h);
    return { x, y, w, h };
  }

  /** A centred rect of the given size. */
  center(w: number, h: number): Rect {
    return { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };
  }

  /** Convert a normalised rect to design units. This is how styles store positions. */
  fromUnit(u: UnitRect, anchor: Anchor = "topLeft"): Rect {
    const w = u.w * this.width;
    const h = u.h * this.height;
    const x = u.x * this.width;
    const y = u.y * this.height;
    const [ax, ay] = ANCHOR_UV[anchor];
    return { x: x - ax * w, y: y - ay * h, w, h };
  }

  /** Convert a design-space rect back to normalised space, for e.g. a handoff contract. */
  toUnit(r: Rect, anchor: Anchor = "topLeft"): UnitRect {
    const [ax, ay] = ANCHOR_UV[anchor];
    return {
      x: (r.x + ax * r.w) / this.width,
      y: (r.y + ay * r.h) / this.height,
      w: r.w / this.width,
      h: r.h / this.height,
    };
  }

  /**
   * A type size that reads on this canvas.
   *
   * `minPx` is expressed in *output* pixels at the project's declared height, so a port to another
   * resolution keeps the same apparent size rather than the same number. The QA gate for legibility
   * (`docs/QA.md` `text.legibility`) is defined in these same terms.
   */
  type(minPx: number): number {
    return (minPx / this.space.height) * this.longEdge;
  }

  /**
   * The vertical re-centring factor for a variant.
   *
   * A 16:9 composition placed into a 9:16 frame does not simply scale: the subject usually needs to
   * move up, because the subtitle band and the safe areas are proportionally larger. Returning it as
   * an explicit number keeps the decision visible instead of burying a `+ 0.08` in a scene.
   */
  get verticalBias(): number {
    if (this.orientation === "portrait") return -0.05;
    return 0;
  }

  /**
   * `true` when a rect lies inside the safe area and above the subtitle band.
   * Used by `cvpw lint` and by `cvpw check text.safeArea`.
   */
  isLegible(r: Rect, options: { allowSubtitleBand?: boolean } = {}): boolean {
    const s = this.space.safe;
    if (r.x < s || r.y < s) return false;
    if (r.x + r.w > this.width - s) return false;
    if (r.y + r.h > this.height - s) return false;
    if (!options.allowSubtitleBand && r.y + r.h > this.space.subtitleBand) return false;
    return true;
  }
}

/** Build a layout from a project's `output` block. */
export function layoutFromOutput(output: {
  width: number;
  height: number;
  safe?: number;
  subtitleBand?: number;
}): Layout {
  return new Layout({
    width: output.width,
    height: output.height,
    safe: output.safe ?? Math.round(output.height * 0.0533), // 96 px at 1080p
    subtitleBand: output.subtitleBand ?? Math.round(output.height * 0.852), // 920 px at 1080p
  });
}
