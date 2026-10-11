/**
 * @cvpw/runtime — load a project's engine and timeline in Node, with no DOM.
 *
 * **Status: contract only.** Declared so the dependency graph is honest and the interface is
 * reviewable; the implementation is not written yet (`docs/PROGRESS.md`).
 *
 * Why this package has to exist at all: `cvpw storyboard` and `cvpw validate` must resolve every time
 * expression and check coverage **without launching a browser**. If the only way to find out whether a
 * timeline is valid were to render it, a coverage gap would be discovered minutes into a render instead
 * of a second into a check. So the scene modules are loaded under Node, with drawing stubbed out.
 *
 * The consequence for scene authors, and the reason it is in `docs/SPEC.md`:
 *
 * > Nothing in a scene module may touch the DOM at import time, or while the shot list is built.
 *
 * A scene that calls `document.createElement` at module scope works in the browser and breaks
 * `cvpw storyboard` — which is a confusing failure to receive from a file that renders perfectly. The
 * asset resolver passed to `preload()` therefore returns nulls under Node, and a scene that needs real
 * assets at load time needs restructuring rather than a special case here.
 */

import type { SceneDefinition, ShotDeclaration, TimebaseData } from "@cvpw/kernel";

/** One shot after resolution, with everything the storyboard and the gates need. */
export interface LoadedShot extends ShotDeclaration {
  /** Resolved start in canonical seconds. */
  t0: number;
  /** Resolved end in canonical seconds. Exclusive. */
  t1: number;
  /** The expression `t0` came from, retained so a re-cut's effect is reviewable. */
  atExpression: string;
  frameFrom: number;
  frameTo: number;
}

/** Everything a Node-side consumer needs, and nothing a browser would need. */
export interface LoadedProject {
  root: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  style: string;
  shots: LoadedShot[];
  /** Problems that would stop a render, in the same shape the engine reports them. */
  problems: LoadedProblem[];
  /** Non-fatal observations the author should read. */
  warnings: string[];
}

export interface LoadedProblem {
  shotId: string;
  reason:
    | "unknown-scene"
    | "unknown-style"
    | "bad-args"
    | "bad-time"
    | "empty-range"
    | "out-of-order"
    | "draw-error"
    | "overlap-without-transition";
  message: string;
  /** Up to three concrete alternatives, for a time expression that could not be resolved. */
  alternatives?: readonly { id: string; t: number; delta?: number }[];
}

/** How to load a project. Paths are absolute. */
export interface LoadOptions {
  root: string;
  /** Absolute path of the module that registers scenes, loaded for its side effects. */
  scenesEntry: string;
  /** Absolute path of the module that registers styles. */
  stylesEntry?: string;
  /** The timeline to load, usually `<root>/timeline.json`. */
  timeline: string;
  /** The timebase, usually built from `analysis/audio.json` plus `cues/cues.json`. */
  timebase: TimebaseData;
  /** Scene name to definition, for callers that have already loaded the modules themselves. */
  registry?: ReadonlyMap<string, SceneDefinition>;
}

/**
 * Load a project without a browser.
 *
 * **Not implemented in v0.1.** The intended behaviour: import `scenesEntry` and `stylesEntry` for their
 * registration side effects with `document` undefined, read `timeline.json`, resolve every `at`/`to`
 * through `@cvpw/kernel`'s `Timebase`, and collect every failure as a `LoadedProblem` rather than
 * throwing on the first — because a timeline with three broken times should report three, not send the
 * author round the loop three times.
 */
export async function loadProject(options: LoadOptions): Promise<LoadedProject> {
  throw new RuntimeNotImplementedError(`loadProject(${JSON.stringify(options.root)})`);
}

/**
 * Render the storyboard table and the machine-readable partition without a browser.
 *
 * **Not implemented in v0.1.** Intended to write `docs/STORYBOARD.md` and `docs/BLOCKS.md` from the
 * same resolved data the engine uses, so the document and the film cannot disagree — which they
 * invariably do when the table is maintained by hand.
 */
export async function writeStoryboard(project: LoadedProject, outDir: string): Promise<string[]> {
  void project;
  void outDir;
  throw new RuntimeNotImplementedError("writeStoryboard");
}

/** Thrown by every entry point in this package until the implementation lands. */
export class RuntimeNotImplementedError extends Error {
  readonly code = 3;
  constructor(what: string) {
    super(
      `@cvpw/runtime is contract-only in v0.1: ${what} is not implemented yet.\n` +
        `  The interfaces in packages/runtime/src/index.ts are the specification; ` +
        `docs/ARCHITECTURE.md describes the DOM-free loading contract.\n` +
        `  See docs/PROGRESS.md — "Not done — and why".`,
    );
    this.name = "RuntimeNotImplementedError";
  }
}
