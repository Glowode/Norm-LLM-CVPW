/**
 * `open` — an almost-empty frame with one pulse in it.
 *
 * The scene's job in a film is to establish that something is alive before anything is said. It is
 * deliberately the least busy scene in the template: with nothing else to look at, the first beat reads
 * as an event, and later scenes can afford to be louder.
 *
 * Every value is a pure function of `f.t`. The rings' geometry is closed-form, so a worker seeking to any
 * frame gets the same picture as a worker that walked there.
 */

import { scene, TAU } from "../../vendor/kernel/dist/index.js";
import { decayHit, envelope, hash1, progress, rgba } from "../lib/draw.js";

export default scene({
  name: "open",
  doc: "An almost-empty field with a pulse that grows into concentric rings. Establishes the beat.",
  argsSchema: {
    pulse: { type: "number", min: 0, max: 2, default: 0.4, doc: "How hard each beat hits." },
    rings: { type: "integer", min: 0, max: 12, default: 3, doc: "Rings emitted per beat." },
    hue: { type: "number", min: 0, max: 1, default: 0.08, doc: "0 = palette amber, 1 = palette accent." },
    label: { type: "string", default: "01", doc: "Small corner label. Text must be in project.json::textWhitelist." },
  },

  draw({ g, f, args, cx }) {
    const { width: W, height: H } = f.layout.space;
    // Colours come from ROLES via `f.color()`, never from a palette index.
    //
    // This file previously read `f.style.palette.colors[0]` for its accent. In a palette ordered dark to
    // light — which is the conventional order, and the order `styles/minimal-paper.js` uses — index 0 is
    // the BACKGROUND. So the scene drew its core in exactly the colour behind it. The frames contained a
    // vignette and nothing else, nothing threw, `engine.problems` stayed empty, and every gate passed.
    // `docs/PROGRESS.md` has the bisection; `SceneFrame.color` exists so this cannot recur.
    const ink = f.color("ink");
    const amber = f.color("amber");
    const accent = f.color("ember");
    const tint = args.hue > 0.5 ? accent : amber;

    // --- background ----------------------------------------------------------------------------
    // A flat fill, not a gradient: the grid scene introduces the palette, and a gradient here would
    // spend the contrast the second shot needs.
    g.fillStyle = ink;
    g.fillRect(0, 0, W, H);

    // A very slow vignette so the frame is not literally flat. Keyed on time, not on the frame index,
    // because it is meant to be continuous rather than to step.
    const breathe = 0.5 + 0.5 * Math.sin((f.t / Math.max(f.layout.space.height, 1)) * TAU * 0.4);
    g.save();
    const vignette = g.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.75);
    vignette.addColorStop(0, rgba(ink, 0));
    vignette.addColorStop(1, rgba(ink, 0.55 + 0.1 * breathe));
    g.fillStyle = vignette;
    g.fillRect(0, 0, W, H);
    g.restore();

    // --- the pulse ------------------------------------------------------------------------------
    // `f.lt` is the shot's own elapsed time, so the pulse is measured from the shot's start rather than
    // from the film's. `f.t` is still the only thing that determines the picture — `lt` is derived from it.
    const period = 0.5; // two pulses per second at the fixture's tempo; replace with a bar length
    const beatIndex = Math.floor(f.lt / period);
    const age = f.lt - beatIndex * period;
    const hit = decayHit(age, 0.11) * args.pulse;

    const cx0 = f.layout.width / 2;
    const cy0 = f.layout.height / 2;

    // The core is drawn directly onto the frame with an explicit shadow, NOT through `cx.layer()`.
    //
    // `cx.layer({shadow})` was the first attempt, because that is what the layer API is for. **It was not
    // the problem.** Replacing it with the direct draw below changed the output by nothing measurable — the
    // frame is still blank, and `engine.problems` is still empty. See `docs/PROGRESS.md` "Not done" §3 for
    // the measurements and for what has been ruled out.
    //
    // The real cause is still open. It is NOT `cx.layer`, it is NOT a thrown error, and it is NOT a missing
    // `f.layout.type()` — `burst` uses all three and renders correctly. The next step is to bisect: draw a
    // hard-coded circle with no envelope and no `layout.type()` here, confirm it appears in a pixel read,
    // then add each piece back until the frame goes blank again.
    //
    // Left as a direct draw rather than reverted to `cx.layer`, because a direct draw is verifiable by
    // reading pixels and that is the only property that matters while the cause is unknown.
    const coreRadius = f.layout.type(14) * (1 + hit * 1.6);
    g.save();
    g.shadowColor = rgba(tint, 0.75);
    g.shadowBlur = f.layout.type(26);
    g.fillStyle = rgba(tint, 0.85);
    g.beginPath();
    g.arc(cx0, cy0, coreRadius, 0, TAU);
    g.fill();
    g.restore();
    void cx;

    // --- rings ----------------------------------------------------------------------------------
    // Three rings per beat at staggered ages, so the pulses read as a continuing rhythm rather than as a
    // single object that resets. Each ring is one arc: no per-segment work, no accumulation.
    const ringCount = args.rings * 3;
    for (let i = 0; i < ringCount; i++) {
      const stagger = i * (period / ringCount);
      const ringAge = age + stagger;
      const life = envelope(ringAge, 0.02, period * 2.4);
      if (life <= 0.01) continue;

      const travel = progress(ringAge, 0, period * 2.4);
      const radius = f.layout.type(20) + travel * f.layout.type(220);
      const alpha = life * 0.28 * (1 - travel * 0.35);
      // A per-ring wobble, seeded on the ring's index and the beat it belongs to, so a ring keeps its own
      // shape for its whole life instead of crawling.
      const wobble = 1 + (hash1(`ring:${i}`, beatIndex) * 2 - 1) * 0.03;

      g.save();
      g.globalAlpha = alpha;
      g.strokeStyle = tint;
      g.lineWidth = Math.max(1, f.layout.type(2.5) * life);
      g.beginPath();
      g.arc(cx0, cy0, radius * wobble, 0, TAU);
      g.stroke();
      g.restore();
    }

    // --- a caption the first frame carries -------------------------------------------------------
    // Present from frame zero so a still taken at t=0 is not an empty rectangle. Inside the safe area,
    // and above the subtitle band, which `cvpw check --text` verifies.
    const label = String(args.label ?? "01");
    g.save();
    g.font = `500 ${f.layout.type(22)}px ui-monospace, monospace`;
    g.fillStyle = rgba(amber, 0.5);
    g.textAlign = "left";
    g.textBaseline = "top";
    g.fillText(label, f.layout.space.safe, f.layout.space.safe);
    g.restore();
  },
});
