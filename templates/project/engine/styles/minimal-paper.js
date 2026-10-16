/**
 * `minimal-paper` — the template's default style.
 *
 * A style is a *bundle*: a palette with named roles, per-scene argument defaults, the post values it
 * implies, and any constants a scene may read. Scenes ask the style for colours by **role** rather than by
 * index, which is what lets a new style restyle a whole film without touching a line of scene code.
 *
 * ## Adding a style
 *
 * One file plus one line in `styles/manifest.js`. Do not edit a scene to support it; if a scene needs a
 * new colour, it should ask for a new *role*, and every style then has to answer — which is the point,
 * because a style that cannot answer is a style that has not been finished.
 */

import { style } from "../../vendor/kernel/dist/index.js";

/** Palette roles every style must answer. A scene asking for a role that is missing falls back, loudly. */
const ROLES = {
  /** The darkest colour. Fills the frame behind everything. */
  ink: "#140b1e",
  /** The dominant colour. Light and heat; the thing the audience looks at. */
  amber: "#ffa552",
  /** A second accent, for a burst or a held core that has to read against `amber`. */
  ember: "#ff6b3d",
  /** Light surfaces: paper, type, titles. */
  paper: "#f3ead8",
  /** A cool counterweight, for structure rather than for heat. */
  slate: "#5a6b8c",
  /** Muted type, for labels and credits. Never used for anything the audience must read at speed. */
  muted: "#8a8aa0",
};

export default style({
  name: "minimal-paper",
  doc: "Dusk palette on a paper field. Dark, warm, restrained: one accent at a time.",

  palette: {
    // Ordered dark to light. A scene indexing this should prefer `roles`; the array exists for gradients.
    colors: ["#140b1e", "#2a1830", "#6b3a4a", "#c96a4a", "#ffa552", "#f3ead8"],
    roles: ROLES,
  },

  // Per-scene argument defaults. A shot's own `args` win; anything neither here nor in the shot falls back
  // to the scene's `argsSchema` default. Keeeping these here rather than in the scene is what lets one
  // style make every scene quieter and another make them louder.
  defaults: {
    open: { pulse: 0.4, rings: 3, hue: 0.08, label: "01" },
    grid: { density: 7, hue: 0.55, snap: 0.14, travel: 0.9 },
    burst: { count: 90, hue: 0.08, reach: 0.42, life: 1.9, flash: 0.55, word: "CHORUS" },
    hold: { settle: 1.1, drift: 11, rule: 0.85 },
  },

  // The grade this style implies. A shot may override any of these; the last active shot's values win, so
  // a transition never averages two grades into a third that neither shot asked for.
  post: {
    vignette: 0.34,
    grain: 0.035,
  },

  tokens: {
    /** The paper grain's strength, read by scenes that draw their own texture. */
    paperStrength: 0.055,
    /** How much a scene should darken its own background before drawing on top of it. */
    backgroundLift: 0.08,
  },
});
