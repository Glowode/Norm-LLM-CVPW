/**
 * Frame content measurement — the gate that was missing.
 *
 * `docs/QA.md` has always required "no empty frames". It was not implemented, and that absence is what let
 * a film of near-black pass `cvpw validate`, a typecheck, and a render that wrote four plausible PNGs. Every
 * other gate asks whether the film is *valid*; this is the only one that asks whether it is *visible*.
 *
 * The measurement is deliberately crude, because a subtle metric would have its own blind spots:
 *
 *   **content fraction** = the share of pixels that differ from the frame's own dominant colour.
 *
 * A blank frame is one flat fill, so its dominant colour is the whole frame and the fraction is 0. A frame
 * with a 25 px dot on it scores ~0.001. An ordinary composed frame scores 0.05–0.6. Reader, that is enough
 * to tell "there is a film here" from "there is a background here", which is the entire job.
 *
 * Measured in-page on the canvas, not from a screenshot. The screenshot path adds JPEG artefacts that make
 * two identical blank frames differ slightly, so a threshold on captured bytes would need slack — and slack
 * is exactly what a gate like this must not have. `getImageData` gives exact pixels. This is a *visibility*
 * check, not a determinism check, so reading the canvas is the correct instrument here; `frameHash` still
 * comes from captured bytes for the reason `docs/adr/0007` gives.
 */

/** What one sampled frame measured. */
export interface FrameContent {
  t: number;
  frame: number;
  /** Fraction of pixels differing from the dominant colour, 0..1. */
  contentFraction: number;
  /** The dominant colour as `#rrggbb`, which is the background in every failure case so far. */
  dominant: string;
  /** How many distinct quantised colours appear. A flat frame is 1. */
  distinctColors: number;
  /** Mean absolute luminance, 0..255. */
  meanLuma: number;
  /** Active shot ids at this time, for naming the offender. */
  shots: string[];
  /** True when the frame carries an engine error card. Always a failure. */
  errorCard: boolean;
}

export interface FrameMetricOptions {
  /** Times to sample, in seconds. */
  times: readonly number[];
  /** Pixels differing by less than this are treated as background. */
  tolerance?: number;
  /** Sample every Nth pixel in each axis. 2 halves the work and does not change the verdict. */
  stride?: number;
  /** Shots to check, as `{id, scene, t0, t1}`; used only to name the offender in the report. */
  shots?: ReadonlyArray<{ id: string; scene?: string; t0: number; t1: number }>;
}

/**
 * The in-page measurement, as a string to evaluate.
 *
 * Written as a single self-contained expression with no closure over Node state, because that is what a CDP
 * `evaluate` can carry. The numbers it needs are interpolated; the logic is not, so there is exactly one
 * copy of the measurement and it cannot drift from the thresholds applied to it.
 */
export function frameMetricsExpression(options: FrameMetricOptions): string {
  const times = JSON.stringify(options.times);
  const tolerance = options.tolerance ?? 10;
  const stride = Math.max(1, Math.floor(options.stride ?? 2));
  const shots = JSON.stringify(options.shots ?? []);

  return `(function () {
  var TIMES = ${times};
  var SHOTS = ${shots};
  var TOL = ${tolerance};
  var STRIDE = ${stride};
  var canvas = document.getElementById("out") || document.querySelector("canvas");
  if (!canvas) return { error: "no canvas element on the page" };
  var g = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;
  var out = [];

  for (var i = 0; i < TIMES.length; i++) {
    var t = TIMES[i];
    window.cvpw.renderFrame(t);
    var data = g.getImageData(0, 0, W, H).data;

    /* Pass 1: histogram of quantised colours, and the luminance total. */
    var hist = Object.create(null);
    var total = 0, count = 0;
    for (var y = 0; y < H; y += STRIDE) {
      for (var x = 0; x < W; x += STRIDE) {
        var p = (y * W + x) * 4;
        var r = data[p], gg = data[p + 1], b = data[p + 2];
        var key = ((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3);
        hist[key] = (hist[key] || 0) + 1;
        total += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        count++;
      }
    }

    /* The dominant quantised colour, then its exact mean, so the reported value is a real colour. */
    var bestKey = -1, bestN = -1, distinct = 0;
    for (var k in hist) { distinct++; if (hist[k] > bestN) { bestN = hist[k]; bestKey = Number(k); } }
    var sr = 0, sg = 0, sb = 0, bn = 0;
    for (var y2 = 0; y2 < H; y2 += STRIDE) {
      for (var x2 = 0; x2 < W; x2 += STRIDE) {
        var p2 = (y2 * W + x2) * 4;
        var key2 = ((data[p2] >> 3) << 10) | ((data[p2 + 1] >> 3) << 5) | (data[p2 + 2] >> 3);
        if (key2 === bestKey) { sr += data[p2]; sg += data[p2 + 1]; sb += data[p2 + 2]; bn++; }
      }
    }
    var br = bn ? sr / bn : 0, bg = bn ? sg / bn : 0, bb = bn ? sb / bn : 0;

    /* Pass 2: how much of the frame is NOT that colour. */
    var content = 0;
    for (var y3 = 0; y3 < H; y3 += STRIDE) {
      for (var x3 = 0; x3 < W; x3 += STRIDE) {
        var p3 = (y3 * W + x3) * 4;
        if (Math.abs(data[p3] - br) + Math.abs(data[p3 + 1] - bg) + Math.abs(data[p3 + 2] - bb) > TOL) content++;
      }
    }

    var hex = "#" + [br, bg, bb].map(function (v) {
      var s = Math.round(v).toString(16); return s.length < 2 ? "0" + s : s;
    }).join("");

    var active = [];
    for (var s = 0; s < SHOTS.length; s++) {
      if (t >= SHOTS[s].t0 && t < SHOTS[s].t1) active.push(SHOTS[s].id);
    }

    out.push({
      t: t, frame: Math.round(t * (window.engine && window.engine.timebase ? window.engine.timebase.fps : 30)),
      contentFraction: count ? content / count : 0,
      dominant: hex,
      distinctColors: distinct,
      meanLuma: count ? total / count : 0,
      shots: active,
      /* The engine marks unassigned time with a NO SHOT card and a scene that threw with an error card.
         Both are contract failures elsewhere; detecting them here as well costs nothing and names the
         frame. NB: no backticks in this comment — it lives inside a template literal, and a backtick
         would close the string. */
      errorCard: !!(window.engine && window.engine.problems && window.engine.problems.length)
    });
  }
  return { frames: out };
})()`;
}

/**
 * Thresholds, from `docs/QA.md` and `project.json::budgets` — never invented in code (`docs/SPEC.md` V5).
 *
 * `emptyContent` is the "no empty frames" rule, and the value is chosen against real frame sizes rather
 * than picked to look strict. On a 1920×1080 frame, 0.0001 is about **200 pixels** — a 14×14 block. So a
 * frame fails only when it carries essentially nothing, which is the failure that actually happened here:
 * a shot drawing its subject in the background colour scores exactly 0.
 *
 * The first draft used 0.0002, which is 400 pixels; on this template that is close enough to the size of a
 * single caption that a legitimate title card would have failed. A gate that fails a correct frame is worse
 * than no gate, because people learn to pass `--force` and then it protects nothing.
 */
export interface SceneCheckThresholds {
  /** At or below this, the frame is background and nothing else. QA.md: `frames.empty`. */
  emptyContent: number;
  /** Below this, the frame has something in it but very little. Reported, never failed. */
  thinContent: number;
  /** A frame this dark, with no content, is certainly a mistake rather than a style. */
  meanLumaFloor: number;
}

export const DEFAULT_SCENE_THRESHOLDS: SceneCheckThresholds = {
  emptyContent: 0.0001,
  thinContent: 0.004,
  meanLumaFloor: 2,
};

export interface SceneFrameVerdict {
  frame: FrameContent;
  level: "ok" | "thin" | "empty";
  reason: string;
}

/**
 * Apply the thresholds.
 *
 * `thin` is deliberately a *report* rather than a failure. A frame carrying one small caption is a
 * legitimate composition, and a gate that failed it would be wrong often enough that people would learn to
 * pass `--force`. `empty` is not a judgement call.
 */
export function judgeFrame(frame: FrameContent, thresholds: SceneCheckThresholds): SceneFrameVerdict {
  if (frame.errorCard) {
    return { frame, level: "empty", reason: "the engine reported a problem while drawing this frame" };
  }
  // `<=` rather than `<`, so that `emptyContent: 0` means "only a frame with literally nothing in it
  // fails". With `<`, a zero threshold would be unsatisfiable — `0 < 0` is false — and a project that
  // asked for zero tolerance would silently get none.
  if (frame.contentFraction <= thresholds.emptyContent) {
    return {
      frame,
      level: "empty",
      reason:
        `the frame is ${(100 * (1 - frame.contentFraction)).toFixed(1)} % ${frame.dominant} and nothing else` +
        ` — the shot drew its background without its subject`,
    };
  }
  if (frame.contentFraction < thresholds.thinContent) {
    return {
      frame,
      level: "thin",
      reason: `only ${(frame.contentFraction * 100).toFixed(3)} % of the frame differs from the background`,
    };
  }
  return { frame, level: "ok", reason: "" };
}

/**
 * Which times to sample.
 *
 * Not evenly spaced in a naive way: the frames worth checking are the ones just after each cut, because a
 * scene that fails usually fails from its first frame, and the first frame is the one an even sample is
 * most likely to miss. So each shot contributes its own first, middle and last frame, plus a uniform
 * baseline so a scene that breaks only in the middle is still caught.
 */
export function sampleTimes(
  shots: ReadonlyArray<{ t0: number; t1: number }>,
  duration: number,
  perShot = 3,
  baseline = 12,
): number[] {
  const times = new Set<number>();
  for (let i = 0; i < baseline; i++) {
    times.add(Number((((i + 0.5) / baseline) * duration).toFixed(4)));
  }
  for (const shot of shots) {
    const span = shot.t1 - shot.t0;
    if (span <= 0) continue;
    for (let i = 0; i < perShot; i++) {
      // Offset by a frame and a half so the sample is inside the shot rather than exactly on the cut,
      // where two shots overlap by design.
      const fraction = perShot === 1 ? 0.5 : (i + 0.5) / perShot;
      const t = shot.t0 + span * fraction;
      if (t > 0 && t < duration) times.add(Number(t.toFixed(4)));
    }
    // The frame after the cut, which is where a transition bug shows.
    const afterCut = shot.t0 + 0.05;
    if (afterCut > 0 && afterCut < duration) times.add(Number(afterCut.toFixed(4)));
  }
  return [...times].sort((a, b) => a - b);
}
