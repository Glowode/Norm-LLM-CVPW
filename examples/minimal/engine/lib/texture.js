/**
 * Procedural, deterministic textures.
 *
 * Built once per page from a seeded generator and cached, because a pattern that is regenerated per frame
 * is both slow and — if it uses any unseeded source — a determinism bug. Nothing here reads a clock or an
 * entropy source, so two workers produce byte-identical textures.
 *
 * The paper grain is the same device a physical print uses to keep large flat areas from looking like
 * vector art, and it is the cheapest single thing that makes a frame read as *made* rather than generated.
 */

import { hash1, rgba } from "../../vendor/kernel/dist/index.js";

/** Cache keyed on the parameters, so a scene asking twice gets one canvas rather than two. */
const cache = new Map();

/**
 * A tileable paper-grain pattern as a CanvasPattern.
 *
 * Returned as a pattern rather than an image so a scene can fill any rect with it, and `texOffset`-style
 * movement is expressed by translating the context, which keeps the pattern itself immutable and shared.
 */
export function paperPattern(g, options = {}) {
  const size = options.size ?? 256;
  const strength = options.strength ?? 0.05;
  const seed = String(options.seed ?? "paper");
  const key = `${size}:${strength}:${seed}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tg = tile.getContext("2d");

  // Fibre: short strokes at seeded angles. Each stroke's geometry depends only on its index, so the tile
  // is identical on every machine.
  tg.lineWidth = 1;
  const strokes = Math.round(size * 2.2);
  for (let i = 0; i < strokes; i++) {
    const x = hash1(`${seed}:x`, i) * size;
    const y = hash1(`${seed}:y`, i) * size;
    const angle = hash1(`${seed}:a`, i) * Math.PI;
    const length = 2 + hash1(`${seed}:l`, i) * 9;
    const dark = hash1(`${seed}:d`, i) > 0.5;
    tg.strokeStyle = dark
      ? `rgba(0,0,0,${(strength * hash1(`${seed}:s`, i)).toFixed(4)})`
      : `rgba(255,255,255,${(strength * hash1(`${seed}:s`, i) * 0.7).toFixed(4)})`;
    tg.beginPath();
    tg.moveTo(x, y);
    tg.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    tg.stroke();
  }

  // A few darker specks, which is what stops the field reading as uniform noise.
  const specks = Math.round(size / 14);
  for (let i = 0; i < specks; i++) {
    const x = hash1(`${seed}:sx`, i) * size;
    const y = hash1(`${seed}:sy`, i) * size;
    const r = 0.5 + hash1(`${seed}:sr`, i) * 1.6;
    tg.fillStyle = rgba("#000000", strength * 1.8 * hash1(`${seed}:sa`, i));
    tg.beginPath();
    tg.arc(x, y, r, 0, Math.PI * 2);
    tg.fill();
  }

  const pattern = g.createPattern(tile, "repeat");
  if (pattern) cache.set(key, pattern);
  return pattern;
}

/** Fill a rect with the paper grain, at a chosen alpha. */
export function paperFill(g, rect, options = {}) {
  const pattern = paperPattern(g, options);
  if (!pattern) return false;
  g.save();
  g.globalAlpha = options.alpha ?? 1;
  g.fillStyle = pattern;
  g.fillRect(rect.x, rect.y, rect.w, rect.h);
  g.restore();
  return true;
}

/**
 * A horizontal gradient with stops placed by role rather than by eye.
 *
 * Exists so a scene writes `linearRamp(g, rect, [ink, mid, amber], [0, 0.6, 1])` instead of three
 * `addColorStop` calls with numbers nobody can later justify — and so the direction is a parameter rather
 * than a duplicated function for each orientation.
 */
export function linearRamp(g, rect, colors, stops, direction = "down") {
  const { x, y, w, h } = rect;
  const [x0, y0, x1, y1] =
    direction === "down"
      ? [x, y, x, y + h]
      : direction === "up"
        ? [x, y + h, x, y]
        : direction === "right"
          ? [x, y, x + w, y]
          : [x + w, y, x, y];

  const gradient = g.createLinearGradient(x0, y0, x1, y1);
  const positions = stops ?? colors.map((_, i) => i / Math.max(colors.length - 1, 1));
  colors.forEach((c, i) => gradient.addColorStop(Math.min(1, Math.max(0, positions[i] ?? 0)), c));
  return gradient;
}
