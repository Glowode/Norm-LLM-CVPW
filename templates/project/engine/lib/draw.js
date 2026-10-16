/**
 * Scene-local helpers.
 *
 * Two rules learned the hard way, both enforced by `cvpw lint`:
 *
 * - **No design-space numbers in a scene.** Ask the layout. `layout.type(48)` is "48 px at the project's
 *   declared height", so a vertical variant is a layout change rather than a rewrite, and a 4K render is
 *   the same film rather than a different one.
 * - **No clock, no unseeded randomness.** Every value here is a pure function of its arguments, and the
 *   randomness comes from the kernel's seeded generators keyed on an explicit string or the frame index.
 */

import { clamp01, easing, hash1, hashRange, mixHex, rgba } from "../../vendor/kernel/dist/index.js";

/** A palette role, with a fallback so a style that omits a role still renders rather than throwing. */
export function role(style, name, fallback) {
  return style.palette.roles[name] ?? fallback;
}

/** A palette colour by index, wrapping, so a scene never indexes past the end. */
export function colour(style, index) {
  const colors = style.palette.colors;
  return colors[((index % colors.length) + colors.length) % colors.length];
}

/**
 * A 0→1 envelope that rises over `attack` seconds and falls over `release`, peaking at 1.
 *
 * Written once because every scene in this template needs the same shape for "the beat happened", and
 * three subtly different versions of it across three scenes is how a film ends up feeling uneven for no
 * reason anyone can name.
 */
export function envelope(age, attack, release) {
  if (age < 0) return 0;
  if (age < attack) return attack <= 0 ? 1 : age / attack;
  const decay = (age - attack) / Math.max(release, 1e-6);
  return clamp01(1 - decay);
}

/** An exponentially decaying hit, starting at full strength at age 0. */
export function decayHit(age, halfLife) {
  if (age < 0) return 0;
  return Math.pow(0.5, age / Math.max(halfLife, 1e-6));
}

/** Ease a value by name, so an easing choice lives in a scene's args rather than in a magic curve. */
export function ease(name, x) {
  return easing(name)(clamp01(x));
}

/**
 * Position a point on a ring around a centre, with a deterministic per-index jitter.
 *
 * The jitter is seeded on `(seed, index)` rather than on time, so a particle's offset is a fixed property
 * of the particle. Seeding on time would make the whole field crawl, which reads as noise rather than as
 * motion, and is the mistake `docs/SPEC.md` D5 exists to prevent.
 */
export function ringPoint(cx, cy, radius, index, count, seed, jitter = 0) {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2 + hash1(seed, index) * 0.4;
  const r = radius * (1 + (jitter === 0 ? 0 : (hash1(seed, index + 977) * 2 - 1) * jitter));
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, angle };
}

/** How far a value travels between two times, clamped. The single expression of "progress through this". */
export function progress(t, from, to) {
  if (to <= from) return t >= to ? 1 : 0;
  return clamp01((t - from) / (to - from));
}

/**
 * Draw a centred string, clamped inside the safe area.
 *
 * Text that runs off the edge is the most common defect in a frame that otherwise passes every gate, and
 * it is invisible in a thumbnail. So the width is measured and the size reduced to fit rather than
 * trusting that the string is short enough.
 */
export function drawFittedText(g, text, centreX, y, size, maxWidth, style) {
  let measured = g.measureText(text).width;
  let fontSize = size;
  if (measured > maxWidth && measured > 0) {
    fontSize = Math.max(8, Math.floor((size * maxWidth) / measured));
    g.font = g.font.replace(/\d+(\.\d+)?px/, `${fontSize}px`);
    measured = g.measureText(text).width;
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(text, centreX, y);
  return { width: measured, height: fontSize };
}

export { clamp01, hash1, hashRange, mixHex, rgba };
