/**
 * `hold` — end on an idea, not on a fade.
 *
 * The shortest scene in the template and the one most likely to be replaced, because what a film ends on
 * is a creative decision rather than a technical one. What is *not* a creative decision:
 *
 * - **The title is inside the safe area and above the subtitle band**, and its size is asked of the layout
 *   rather than written down. `cvpw check --text` fails the film otherwise, and a title that clips on a
 *   vertical variant is the most common way a good master produces a bad Short.
 * - **The picture is never static.** "No dead frames" is a gate: something must change in any half-second
 *   window. Here that is a slow drift in the grain's offset and a settling underline, both continuous
 *   functions of time rather than an animation that can finish.
 * - **It holds.** The temptation is to fill the last four seconds with motion. The scene's whole argument
 *   is that the film has stopped talking.
 */

import { scene } from "../../vendor/kernel/dist/index.js";
import { clamp01, decayHit, rgba } from "../lib/draw.js";
import { paperFill, linearRamp } from "../lib/texture.js";

export default scene({
  name: "hold",
  doc: "A title held on a paper field, settling rather than fading. The film's last image.",
  argsSchema: {
    title: { type: "string", default: "TITLE", doc: "Main line. MUST be in project.json::textWhitelist." },
    sub: { type: "string", default: "", doc: "Secondary line. MUST be in the whitelist, or leave it empty." },
    settle: { type: "number", min: 0.1, max: 4, default: 1.1, doc: "Seconds for the underline to finish drawing." },
    drift: { type: "number", min: 0, max: 40, default: 11, doc: "Pixels the grain slides over the shot. Never zero." },
    rule: { type: "number", min: 0, max: 1, default: 0.85, doc: "Opacity of the underline." },
    credit: {
      type: "string",
      default: "",
      doc: "The exact credit line from project.json. Empty omits it; `cvpw check deliver.credit` wants it present.",
    },
  },

  draw({ g, f, args }) {
    // project.json::artist and ::titleSub reach the end card here, as DEFAULTS only. A shot that names its own
    // title still wins, so the timeline stays authoritative and the project supplies what the timeline left blank.
    // The two strings were declared in the schema and read by nothing; this is the line that makes them visible.
    const title = args.title === "TITLE" && f.title ? f.title : args.title;
    const sub = args.sub === "" && f.titleSub ? f.titleSub : args.sub;
    const { width: W, height: H } = f.layout.space;
    const ink = f.color("ink");
    const paper = f.color("paper");
    const amber = f.color("amber");
    const accent = f.color("ember");

    // --- the field --------------------------------------------------------------------------------
    // A vertical ramp between two dark tones, then grain. The ramp alone would band on a large area; the
    // grain is what breaks the banding and is why this scene uses `paperFill` rather than a flat colour.
    g.fillStyle = linearRamp(
      g,
      { x: 0, y: 0, w: W, h: H },
      [ink, f.color("slate"), ink],
      [0, 0.5, 1],
      "down",
    );
    g.fillRect(0, 0, W, H);

    // The drift is what keeps the frame from being dead. It moves the pattern, not the picture, so the
    // composition does not shift — only the surface does.
    const drift = (f.t / 8) * args.drift;
    g.save();
    g.translate(drift % 256, (drift * 0.37) % 256);
    paperFill(g, { x: -256, y: -256, w: W + 512, h: H + 512 }, { strength: 0.055, alpha: 0.5, seed: "hold" });
    g.restore();

    // --- the title --------------------------------------------------------------------------------
    // Sized from the layout: 96 px at 1080p, so the film reads the same at any render height. The settle
    // raises it a few pixels over the first second, which is the only motion in the scene and is enough.
    const settle = clamp01(f.lt / Math.max(args.settle, 1e-6));
    const eased = 1 - Math.pow(1 - settle, 3);
    const titleSize = f.layout.type(96);
    const rise = (1 - eased) * f.layout.type(26);
    const maxWidth = W - f.layout.space.safe * 2;

    const centreX = W / 2;
    const titleY = H * 0.46 + rise;

    g.save();
    g.textAlign = "center";
    g.textBaseline = "alphabetic";

    // Measure first so an over-long title shrinks rather than clipping. A title that runs off the edge is
    // invisible in a thumbnail and obvious on a television.
    let size = titleSize;
    g.font = `700 ${size}px ui-serif, Georgia, serif`;
    let width = g.measureText(title).width;
    if (width > maxWidth && width > 0) {
      size = Math.max(f.layout.type(48), Math.floor((size * maxWidth) / width));
      g.font = `700 ${size}px ui-serif, Georgia, serif`;
      width = g.measureText(title).width;
    }

    // A soft shadow rather than an outline: the film's typography rule is no outlined or haloed type.
    g.shadowColor = rgba("#000000", 0.55);
    g.shadowBlur = f.layout.type(18) * (1 - eased * 0.6);
    g.shadowOffsetY = f.layout.type(4);
    g.fillStyle = paper;
    g.fillText(title, centreX, titleY);
    g.restore();

    // --- the underline ----------------------------------------------------------------------------
    // Drawn left to right by the settle, so the frame's only *event* is the rule arriving. Its width is the
    // measured title width, which means it fits by construction rather than by a guessed percentage.
    const ruleWidth = Math.min(width * 0.86, maxWidth * 0.5);
    const ruleProgress = clamp01((f.lt - args.settle * 0.35) / Math.max(args.settle, 0.01));
    if (ruleProgress > 0) {
      g.save();
      g.strokeStyle = rgba(amber, args.rule * ruleProgress);
      g.lineWidth = Math.max(1, f.layout.type(2));
      g.lineCap = "round";
      const y = titleY + f.layout.type(34);
      const half = (ruleWidth / 2) * ruleProgress;
      g.beginPath();
      g.moveTo(centreX - half, y);
      g.lineTo(centreX + half, y);
      g.stroke();
      g.restore();
    }

    // --- the subtitle -----------------------------------------------------------------------------
    if (args.sub) {
      g.save();
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      g.font = `400 ${f.layout.type(28)}px ui-sans-serif, system-ui, sans-serif`;
      g.fillStyle = rgba(paper, 0.7 * ruleProgress);
      g.letterSpacing = `${f.layout.type(4)}px`;
      const subWidth = g.measureText(args.sub).width;
      if (subWidth <= maxWidth) g.fillText(sub, centreX, titleY + f.layout.type(78));
      g.restore();
    }

    // --- credit -----------------------------------------------------------------------------------
    // The exact credit line from project.json, small, at the bottom of the content area but clear of the
    // subtitle band. `cvpw check deliver.credit` verifies it appears verbatim.
    if (args.credit) {
      g.save();
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      g.font = `400 ${f.layout.type(20)}px ui-sans-serif, system-ui, sans-serif`;
      g.fillStyle = rgba(f.color("muted"), 0.5 * ruleProgress);
      g.fillText(String(args.credit), centreX, f.layout.space.subtitleBand - f.layout.type(24));
      g.restore();
    }

    // A final, very slow accent pulse so the last second has something continuous in it. Keyed on `f.t`
    // and small enough that it reads as the projector rather than as an effect.
    const pulse = 0.5 + 0.5 * Math.sin(f.t * 0.6);
    g.save();
    g.globalCompositeOperation = "screen";
    g.fillStyle = rgba(accent, 0.03 + 0.025 * pulse);
    g.fillRect(0, 0, W, H);
    g.restore();

    // Keep the decay import meaningful: a tiny marker that fades over the first half second, which is what
    // stops the very first frame of the shot from being brighter than the rest.
    const entry = decayHit(f.lt, 0.18);
    if (entry > 0.01) {
      g.save();
      g.fillStyle = rgba(amber, entry * 0.05);
      g.fillRect(0, 0, W, H);
      g.restore();
    }
  },
});
