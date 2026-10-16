/**
 * `burst` — the chorus lands.
 *
 * The loudest scene in the template, and the one with the most ways to go wrong. Three deliberate
 * restraints, each of which is a rule from `docs/SPEC.md` rather than a style preference:
 *
 * - **Particles are stateless and closed-form.** Position is computed from `(seed, index, age)` directly,
 *   never integrated frame to frame. That is what lets a worker seek straight to frame 800 and get the
 *   same picture as one that walked there, and it is why there is no `stateful: true` here.
 * - **The flash is one frame's worth of brightness, not a strobe.** The photosensitivity budget
 *   (`docs/QA.md` `flash.rate`) is a hard gate, not a taste question, so the flash decays over ~0.18 s and
 *   happens once per shot rather than per beat.
 * - **It ends on a held image.** A burst that fades out leaves nothing; a burst that resolves into a
 *   stable composition hands the next shot something to cut from.
 */

import { scene, TAU } from "../../vendor/kernel/dist/index.js";
import { clamp01, decayHit, hash1, hashRange, rgba, ringPoint } from "../lib/draw.js";

export default scene({
  name: "burst",
  doc: "A ring of particles is thrown outward on the cut, settling into a held halo.",
  argsSchema: {
    count: { type: "integer", min: 0, max: 400, default: 90, doc: "Particles. Budget: ~150 is where this stops being cheap." },
    hue: { type: "number", min: 0, max: 1, default: 0.08, doc: "0 = palette amber, 1 = palette accent." },
    reach: { type: "number", min: 0.05, max: 1.2, default: 0.42, doc: "How far out they travel, as a fraction of the width." },
    life: { type: "number", min: 0.2, max: 6, default: 1.9, doc: "Seconds before a particle has fully settled." },
    flash: { type: "number", min: 0, max: 1, default: 0.55, doc: "Peak brightness of the opening flash. Keep it a single event." },
    word: {
      type: "string",
      default: "CHORUS",
      maxLength: 24,
      doc: "The on-screen word. MUST appear in project.json::textWhitelist, or `cvpw check --text` fails.",
    },
  },

  draw({ g, f, args, cx }) {
    const { width: W, height: H } = f.layout.space;
    const ink = f.color("ink");
    const amber = f.color("amber");
    const accent = f.color("ember");
    const tint = args.hue > 0.5 ? accent : amber;

    g.fillStyle = ink;
    g.fillRect(0, 0, W, H);

    const centreX = W / 2;
    const centreY = H / 2;

    // --- the halo ---------------------------------------------------------------------------------
    // A soft radial wash that is at its brightest at the cut and settles. Drawn first so the particles
    // read as coming out of it rather than sitting on top of it.
    const settle = clamp01(f.lt / Math.max(args.life, 1e-6));
    const haloAlpha = 0.32 * (1 - settle * 0.55);
    const halo = g.createRadialGradient(centreX, centreY, 0, centreX, centreY, W * 0.42);
    halo.addColorStop(0, rgba(tint, haloAlpha * 1.4));
    halo.addColorStop(0.55, rgba(tint, haloAlpha * 0.5));
    halo.addColorStop(1, rgba(tint, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);

    // --- particles --------------------------------------------------------------------------------
    // Each particle's distance is an *ease-out* of its own age, so the field decelerates as a body rather
    // than each particle stopping at the same moment. The per-particle life multiplier is seeded on the
    // index, which keeps the leading edge ragged — a uniform front reads as a resizing circle.
    const maxReach = W * args.reach;
    for (let i = 0; i < args.count; i++) {
      const lifeScale = 0.55 + hash1("life", i) * 0.75;
      const age = f.lt / lifeScale;
      if (age <= 0) continue;
      const travel = clamp01(age / Math.max(args.life, 1e-6));
      if (travel >= 1) {
        // Settled: draw the resting position rather than skipping, because the held end state is the
        // point of the shot and an empty frame at the end would read as the scene having failed.
      }
      const eased = 1 - Math.pow(1 - travel, 3);
      const base = ringPoint(centreX, centreY, 0, i, args.count, `burst:${i}`, 0);
      const radius = eased * maxReach * (0.7 + hash1("reach", i) * 0.6);

      const x = centreX + Math.cos(base.angle) * radius;
      const y = centreY + Math.sin(base.angle) * radius * 0.72; // squashed: a circle in 16:9 reads as a UI element
      const size = f.layout.type(3 + hashRange("size", i, 0, 7)) * (1 - travel * 0.35);
      const alpha = (1 - travel) * 0.9 + 0.1;

      g.save();
      g.globalAlpha = clamp01(alpha);
      g.fillStyle = hash1("tone", i) > 0.72 ? accent : tint;
      g.beginPath();
      // Square particles, rotated by their own angle: cheaper than arcs at this count and it reads as
      // debris rather than as a diagram.
      g.translate(x, y);
      g.rotate(base.angle + travel * 1.4);
      g.fillRect(-size / 2, -size / 2, size, size);
      g.restore();
    }

    // --- the opening flash ------------------------------------------------------------------------
    // One event, decaying fast, and it is the LAST thing drawn so it affects the whole frame. A flash per
    // beat would breach the photosensitivity budget and would also be less effective: an audience notices
    // the first one.
    const flash = decayHit(f.lt, 0.055) * args.flash;
    if (flash > 0.01) {
      g.save();
      g.globalCompositeOperation = "screen";
      g.fillStyle = rgba("#ffffff", clamp01(flash));
      g.fillRect(0, 0, W, H);
      g.restore();
    }

    // --- the held core ----------------------------------------------------------------------------
    // What the frame settles into. On its own layer with a shadow so it keeps a body against the halo.
    // Drawn directly, for the reason recorded at length in `intro.js` and in `docs/PROGRESS.md`:
    // `cx.layer()` composed nothing here either, silently.
    const corePulse = 1 + decayHit(f.lt, 0.2) * 0.35;
    g.save();
    g.shadowColor = rgba(amber, 0.8);
    g.shadowBlur = f.layout.type(30);
    g.fillStyle = rgba(amber, 0.92);
    g.beginPath();
    g.arc(centreX, centreY, f.layout.type(17) * corePulse, 0, TAU);
    g.fill();
    g.restore();
    void cx;

    // --- the caption ------------------------------------------------------------------------------
    const word = String(args.word ?? "CHORUS");
    g.save();
    g.font = `600 ${f.layout.type(30)}px ui-sans-serif, system-ui, sans-serif`;
    g.fillStyle = rgba(accent, clamp01(0.35 + flash));
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.letterSpacing = `${f.layout.type(6)}px`;
    g.fillText(word, centreX, f.layout.space.subtitleBand + f.layout.type(40));
    g.restore();
  },
});
