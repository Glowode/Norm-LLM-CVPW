/**
 * The engine entry point.
 *
 * One job: read the project's artifacts, register its scenes and styles, hand everything to
 * `@cvpw/kernel`'s engine, and publish `window.cvpw`. Everything the framework requires of a page lives
 * in the contract published at the bottom of this file.
 *
 * Three details are load-bearing and easy to get wrong:
 *
 * 1. **`window.cvpw` is not assigned until fonts and assets are ready.** A frame drawn with a fallback
 *    face is a different picture, and the difference lands on the first frames of a render — exactly
 *    where nobody looks. If `ready` resolves early, the opening title card is subtly wrong forever.
 * 2. **The timebase is assembled from the artifacts, not invented here.** `beats` and `bars` come from
 *    `analysis/audio.json`, the named moments from `cues/cues.json`. A time expression resolves against
 *    that assembly, so re-analysing the audio moves every cut that references it.
 * 3. **A missing artifact is a warning, not a crash** — except where it would silently change the film.
 *    With no `analysis/audio.json` there is no grid, so `b()` and `h()` genuinely cannot resolve and the
 *    engine will say so per shot. That is the intended failure: loud, named, and impossible to ignore.
 */

import { bootEngine } from "../vendor/kernel/dist/index.js";

import { timeline } from "./timeline.js";
import { sceneManifest } from "./scenes/manifest.js";
import { styleManifest } from "./styles/manifest.js";

/**
 * Project-relative path to a URL.
 *
 * **This is not a detail.** The page lives at `/engine/index.html`, and inside a module a bare
 * `fetch("project.json")` resolves against the *document's* directory — so it requests
 * `/engine/project.json`, which does not exist. The failure is silent in a particularly nasty way: a
 * `fetch` that 404s inside a `try` looks exactly like a file that was never written, so the engine
 * reports "project.json is absent" while the file sits in the project root, and an operator goes looking
 * for a missing file that is not missing.
 *
 * So every artifact read goes through here. `import.meta.url` is this module's own URL, which is stable
 * wherever the engine is served from, and one `..` steps out of `engine/` to the project root.
 */
const PROJECT_ROOT = new URL("../", import.meta.url);
const projectPath = (relative) => new URL(String(relative).replace(/^\/+/, ""), PROJECT_ROOT).href;

/** Fetch a project-relative text file, or null. Reports WHY, because a silent 404 reads as a missing file. */
async function loadText(path) {
  const url = projectPath(path);
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      console.warn(`[cvpw] ${path} -> HTTP ${response.status} ${response.statusText} at ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.warn(`[cvpw] ${path} could not be fetched from ${url}: ${error.message}`);
    return null;
  }
}

async function loadJson(path) {
  const text = await loadText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn(`[cvpw] ${path} is not valid JSON: ${error.message}`);
    return null;
  }
}

/**
 * Load `analysis/envelope.json` and its binary companion.
 *
 * A mismatch between the sidecar and the blob degrades to zeros with a named warning rather than
 * throwing, because a preview must survive a missing analysis — and because a throw here would take the
 * whole page down for a feature a scene may not even use.
 */
async function loadFeatures() {
  const meta = await loadJson("analysis/envelope.json");
  if (!meta) return null;
  try {
    const response = await fetch(projectPath("analysis/envelope.f32"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const expected = meta.frames * (meta.channels?.length ?? 0) * 4;
    if (buffer.byteLength !== expected) {
      console.warn(
        `[cvpw] analysis/envelope.f32 is ${buffer.byteLength} bytes but envelope.json describes ${expected}; ` +
          `features degrade to zero. Re-run \`cvpw analyze\` — the sidecar and the blob describe different runs.`,
      );
      return null;
    }
    return { meta, data: new Float32Array(buffer) };
  } catch (error) {
    console.warn(`[cvpw] analysis/envelope.f32 unavailable (${error.message}); features degrade to zero`);
    return null;
  }
}

/**
 * Read `analysis/sections.json`, whose two accepted shapes are deliberately forgiving.
 *
 * The compact `[firstBar, lastBar, label]` form exists because it is far easier to hand-edit than a nested
 * object, and the whole point of this file is that a human corrects the automatic grouping in it.
 */
async function loadSections(bars) {
  const override = await loadJson("analysis/sections.json");
  if (!override) return null;
  const rows = Array.isArray(override?.sections) ? override.sections : override;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const barStart = (index) => bars.find((b) => b.index === index)?.start ?? 0;
  return rows.map((row, i) => {
    if (Array.isArray(row)) {
      const [first, last, label] = row;
      return {
        index: i,
        name: String(label ?? `section${i}`),
        start: barStart(Number(first)),
        end: barStart(Number(last) + 1) || timeline.duration,
        manual: true,
      };
    }
    return {
      index: i,
      name: String(row.name ?? `section${i}`),
      start: Number(row.start ?? 0),
      end: Number(row.end ?? timeline.duration),
      energy: row.energy,
      confidence: row.confidence ?? 1,
      manual: true,
    };
  });
}

async function main() {
  // --- register everything the timeline references ------------------------------------------------
  // **Importing IS registering.** The kernel's `scene({...})` and `style({...})` helpers register their
  // definition as a side effect of being called, so a scene file registers itself the moment it is
  // imported, and the manifest's only job is to name the files. Calling `scenes.register()` on what the
  // module exported would be a second registration of the same name — which the registry correctly
  // refuses, with an error that reads like a duplicate-name bug rather than a bootstrap one.
  //
  // So this loop exists to *load* the modules and to confirm they arrived. It also names any file that
  // imported successfully but registered nothing, because a scene file whose export is misspelled
  // otherwise fails silently and surfaces much later as "unknown scene" at frame 900.
  const expectRegistered = (loaded, singular, plural) => {
    const definitions = [].concat(loaded?.[plural] ?? loaded?.[singular] ?? []);
    return definitions.length;
  };

  for (const module of sceneManifest) {
    const loaded = await module;
    const count = expectRegistered(loaded, "default", "scenes");
    const name = loaded?.default?.name ?? loaded?.scenes?.[0]?.name;
    if (count === 0 || typeof name !== "string") {
      throw new Error(
        `a module in engine/scenes/manifest.js registered nothing. Each scene file must call ` +
          `scene({ name, draw }) at import time and export the result — exporting a plain object is not enough.`,
      );
    }
  }
  for (const module of styleManifest) {
    const loaded = await module;
    const count = expectRegistered(loaded, "default", "styles");
    const name = loaded?.default?.name ?? loaded?.styles?.[0]?.name;
    if (count === 0 || typeof name !== "string") {
      throw new Error(
        `a module in engine/styles/manifest.js registered nothing. Each style file must call ` +
          `style({ name, palette }) at import time and export the result.`,
      );
    }
  }

  // --- assemble the timebase from the artifacts --------------------------------------------------
  const audio = await loadJson("analysis/audio.json");
  const cueDoc = await loadJson("cues/cues.json");
  const lyricsTiming = await loadJson("cues/lyrics.timing.json");
  const features = await loadFeatures();

  const warnings = [];
  if (!audio) {
    warnings.push(
      "analysis/audio.json is absent, so there is no beat grid: every b() and h() time expression will " +
        "fail. Run `cvpw analyze`, or set project.json::timebase.mode to \"manual\" and use cues.",
    );
  }
  if (!cueDoc) {
    warnings.push("cues/cues.json is absent, so no named cue resolves. Run `cvpw cues`.");
  }

  const bars = audio?.bars ?? [];
  const sections = (await loadSections(bars)) ?? audio?.sections ?? [];

  const timebase = {
    duration: audio?.duration ?? timeline.duration,
    fps: audio?.fps ?? 30,
    ...(audio?.tempo ? { tempo: audio.tempo } : {}),
    ...(audio?.meter ? { meter: audio.meter } : {}),
    beats: audio?.beats ?? [],
    beatsSmooth: audio?.beatsSmooth ?? audio?.beats ?? [],
    bars,
    sections,
    onsets: audio?.onsets ?? [],
    impacts: audio?.impacts ?? [],
    stops: audio?.stops ?? [],
    cues: cueDoc?.cues ?? [],
    lyricLines: lyricsTiming?.lines ?? [],
    words: (lyricsTiming?.lines ?? []).flatMap((line) =>
      (line.words ?? []).map((word) => ({
        word: word.text ?? "",
        start: word.start,
        end: word.end,
        line: line.i,
      })),
    ),
  };

  const canvas = document.getElementById("out");
  if (!canvas) throw new Error("#out canvas is missing from engine/index.html");

  const project = (await loadJson("project.json")) ?? {};
  if (!project.output) {
    warnings.push("project.json is absent or has no `output` block; falling back to 1920x1080 at 30 fps");
  }
  const output = {
    width: Number(project.output?.width ?? 1920),
    height: Number(project.output?.height ?? 1080),
    safe: Number(project.output?.safe ?? Math.round((project.output?.height ?? 1080) * 0.0533)),
    subtitleBand: Number(
      project.output?.subtitleBand ?? Math.round((project.output?.height ?? 1080) * 0.852),
    ),
  };

  const { engine, api } = await bootEngine({
    canvas,
    output,
    timebase,
    shots: timeline.shots,
    style: project.style ?? "minimal-paper",
    dpr: Number(new URLSearchParams(location.search).get("dpr") ?? 1),
    samples: Number(new URLSearchParams(location.search).get("samples") ?? 1),
    noGrain: new URLSearchParams(location.search).has("nograin"),
    overlay: new URLSearchParams(location.search).has("overlay"),
  });

  for (const warning of [...warnings, ...engine.meta.warnings]) console.warn(`[cvpw] ${warning}`);
  for (const problem of engine.problems) console.error(`[cvpw] ${problem.shotId}: ${problem.message}`);

  // **A problem the engine resolved for itself is fatal, and this is the important part of the bootstrap.**
  //
  // `engine.problems` holds shots whose time expression did not resolve and shots whose args the scene
  // rejected. Both have an obvious "sensible" fallback — skip the shot, drop the bad key — and both are
  // refused here on purpose. A shot that failed to resolve renders as nothing, so the film comes out with a
  // hole in it that plays perfectly: no error, no crash, and a black gap that an operator notices three
  // renders later, if at all. Failing at load costs a second and names the shot.
  //
  // There is deliberately no `?lenient` escape. The whole argument of this framework is that a wrong film
  // which looks finished is worse than no film, and this is the cheapest place in the pipeline to enforce
  // it — before a single frame is drawn. Fix the timebase or the timeline; do not relax this.
  if (engine.problems.length > 0) {
    const lines = engine.problems.map((problem) => `  ${problem.shotId}: ${problem.message}`).join("\n");
    throw new Error(
      `the timeline has ${engine.problems.length} problem(s), so the film would have holes in it:\n${lines}\n` +
        `  run \`cvpw storyboard\` to see all of them, and fix the timeline or the timebase.`,
    );
  }

  // The page contract. `window.cvpw` is published only once `ready` has resolved, so a capture tool that
  // waits for it can never photograph a half-loaded page.
  window.cvpw = api;
  window.engine = engine;
  window.cvpwFeatures = features;
  window.ready = true;
}

main().catch((error) => {
  console.error("[cvpw] the engine failed to start:", error);
  // A visible failure beats a blank canvas: an operator looking at a still will see this, and a capture
  // tool will find it in the console rather than inferring it from a black frame.
  const canvas = document.getElementById("out");
  if (canvas) {
    const g = canvas.getContext("2d");
    g.fillStyle = "#1b1b24";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#ff6b6b";
    g.font = `${Math.round(canvas.height * 0.04)}px monospace`;
    g.fillText("engine failed to start", 40, 70);
    g.fillStyle = "#c8c8d8";
    g.font = `${Math.round(canvas.height * 0.025)}px monospace`;
    const message = String(error?.message ?? error);
    g.fillText(message.slice(0, Math.floor(canvas.width / (canvas.height * 0.015))), 40, 130);
    g.fillText("see the browser console for the full error", 40, 180);
  }
  throw error;
});
