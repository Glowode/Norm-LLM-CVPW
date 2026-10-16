/**
 * `grid` — the beat becomes visible.
 *
 * The one idea a shot like this has to earn: the grid has to *arrive on* a beat rather than merely exist.
 * So the whole scene is built around a single snap — a scale and opacity step that lands exactly on the
 * cut and settles — and the cells carry a travelling highlight afterwards so the frame stays alive without
 * anything moving very much.
 *
 * This is the scene that teaches the audience the tempo, which means it is the scene most damaged by a
 * wrong beat grid. If the snap looks late, the analysis is late; check `analysis/overview.png` before
 * touching this file.
 */

import { scene } from "../../vendor/kernel/dist/index.js";
import { clamp01, decayHit, hash1, progress, rgba } from "../lib/draw.js";

export default scene({
  name: "grid",
  doc: "A grid snaps into existence on a beat, then a highlight travels through its cells.",
  argsSchema: {
    density: { type: "integer", min: 2, max: 24, default: 7, doc: "Cells across. Grows with the frame." },
    hue: { type: "number", min: 0, max: 1, default: 0.55, doc: "0 = palette amber, 1 = palette accent." },
    snap: { type: "number", min: 0.02, max: 0.6, default: 0.14, doc: "Seconds the arrival takes to settle." },
    travel: { type: "number", min: 0, max: 3, default: 0.9, doc: "Speed of the travelling highlight, cells/second." },
  },

  draw({ g, f, args }) {
    const { width: W, height: H } = f.layout.space;
    const ink = f.color("ink");
    const amber = f.color("amber");
    const accent = f.color("ember");
    const tint = args.hue > 0.5 ? accent : amber;

    g.fillStyle = ink;
    g.fillRect(0, 0, W, H);

    // --- the arrival ------------------------------------------------------------------------------
    // `progress` over [0, snap] gives the settle; the overshoot is deliberate and small, because a grid
    // that arrives perfectly smoothly reads as a fade rather than as an instrument switching on.
    const arrival = progress(f.lt, 0, args.snap);
    const overshoot = arrival < 1 ? 1 + Math.sin(arrival * Math.PI) * 0.06 : 1;
    const settle = 0.55 + 0.45 * arrival;

    const cols = args.density;
    const rows = Math.max(2, Math.round((cols * H) / W));
    const cellW = W / cols;
    const cellH = H / rows;

    // A single beat pulse, decaying from the shot start, that the cells inherit. Keyed on `f.lt` so the
    // snap and the brightness are the same event rather than two effects that happen to coincide.
    const beat = decayHit(f.lt, 0.16);

    g.save();
    g.globalAlpha = settle;
    // The whole grid scales about the centre, so the arrival is felt at the edges first — which is what
    // makes it read as the frame being drawn rather than as a colour change.
    g.translate(W / 2, H / 2);
    g.scale(overshoot, overshoot);
    g.translate(-W / 2, -H / 2);

    const lineWidth = Math.max(1, f.layout.type(1.6));
    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= cols; col++) {
        const x = col * cellW;
        const y = row * cellH;

        // Stagger each cell's appearance by its distance from the centre: 60 ms per ring, capped, so the
        // grid precipitates outward. Without this the arrival is one frame of everything at once.
        const cxDist = Math.hypot(col / cols - 0.5, row / rows - 0.5);
        const delay = clamp01(cxDist / 0.71) * args.snap * 1.6;
        const cellArrival = progress(f.lt, delay, delay + args.snap);
        if (cellArrival <= 0) continue;

        // The travelling highlight: a diagonal wave whose phase is a function of time, so it is
        // continuous rather than stepped, and identical for any worker seeking to this frame.
        const wave = 0.5 + 0.5 * Math.sin((col + row) * 0.6 - f.t * args.travel * 2.2);
        const intensity = cellArrival * (0.14 + 0.5 * wave * wave) + beat * 0.25;

        g.strokeStyle = rgba(tint, clamp01(intensity) * 0.5);
        g.lineWidth = lineWidth;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + cellW, y);
        g.stroke();

        // Every fourth line is heavier, which is what turns a mesh into a *grid* a viewer can count.
        if (col % 4 === 0) {
          g.strokeStyle = rgba(tint, clamp01(intensity) * 0.35 + 0.1);
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x, H);
          g.stroke();
        }
        if (row % 4 === 0) {
          g.strokeStyle = rgba(tint, clamp01(intensity) * 0.35 + 0.1);
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(W, y);
          g.stroke();
        }
      }
    }

    // A few cells lit from within, chosen deterministically per cell so they do not flicker between
    // frames. This is the only place the scene uses a hash, and it is keyed on the cell, never on time.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const pick = hash1("cell", row * 97 + col * 13);
        if (pick < 0.955) continue;
        const cellArrival = progress(f.lt, clamp01(Math.hypot(col / cols - 0.5, row / rows - 0.5) / 0.71) * args.snap * 1.6, args.snap * 2.5);
        if (cellArrival <= 0) continue;
        const brightness = (pick - 0.955) / 0.045;
        g.fillStyle = rgba(tint, clamp01(brightness * 0.22 * cellArrival + beat * 0.1));
        g.fillRect(col * cellW + lineWidth, row * cellH + lineWidth, cellW - lineWidth * 2, cellH - lineWidth * 2);
      }
    }
    g.restore();

    // --- the readout ------------------------------------------------------------------------------
    // Deliberately small and in the corner: the grid is the subject, and a label the size of a title would
    // compete with it. Text stays inside the safe inset and above the subtitle band.
    g.save();
    g.font = `500 ${f.layout.type(20)}px ui-monospace, monospace`;
    g.fillStyle = rgba(f.color("slate"), 0.45 + 0.25 * beat);
    g.textAlign = "left";
    g.textBaseline = "bottom";
    const metrics = `${cols}\u00d7${rows}`;
    g.fillText(metrics, f.layout.space.safe, f.layout.space.subtitleBand - f.layout.type(8));
    g.restore();
  },
});
