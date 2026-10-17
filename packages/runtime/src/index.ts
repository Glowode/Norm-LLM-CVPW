/**
 * @cvpw/runtime — load a project's engine and timeline in Node, with no DOM.
 *
 * Why this package has to exist: `cvpw storyboard` and `cvpw check` must resolve every time expression and
 * verify coverage **without launching a browser**. If the only way to find out whether a timeline is valid
 * were to render it, a coverage gap would be discovered minutes into a render instead of milliseconds into a
 * check.
 *
 * The consequence for scene authors, and the reason it is in `docs/SPEC.md`:
 *
 * > Nothing in a scene module may touch the DOM at import time, or while the shot list is built.
 *
 * A scene that calls `document.createElement` at module scope works in the browser and breaks this loader —
 * which is a confusing failure to receive from a file that renders perfectly. Rather than paper over it, the
 * loader installs a **tripwire** `document`: a module that touches it at import time gets a named error that
 * says which module and why, instead of a `ReferenceError` from three layers down.
 *
 * ## What is deliberately NOT here
 *
 * No canvas, no drawing, no layout measurement. `loadProject` answers questions about the *edit* — what
 * shots, when, with which scenes, and what is wrong with them. Anything that needs pixels needs a browser,
 * and pretending otherwise would mean a second renderer with its own bugs.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  scenes,
  styles,
  Timebase,
  validateArgs,
  type SceneDefinition,
  type ShotDeclaration,
  type TimeExpressionError,
  type TimebaseData,
} from "@cvpw/kernel";

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
  /** The scene's resolved args, after style defaults and shot overrides. */
  args: Record<string, unknown>;
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
  /** Scene names actually registered by the entry module, for a caller that wants to compare. */
  registered: string[];
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
    | "overlap-without-transition"
    | "draw-error"
    | "load-error";
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
/**
   * The project's vendored kernel, whose registries the scene modules register into. Defaults to
   * `<root>/vendor/kernel/dist/index.js`. See the note in `loadProject` for why this cannot be this
   * package's own kernel copy.
   */
  kernelEntry?: string;
  /** Scene name to definition, for callers that have already loaded the modules themselves. */
  registry?: ReadonlyMap<string, SceneDefinition>;
}

/**
 * Install a `document` that fails loudly, for the duration of a dynamic import.
 *
 * A scene module that reaches for the DOM at import time must fail with a sentence about *why* that is
 * forbidden, not with `ReferenceError: document is not defined` — which reads as a broken toolchain and sends
 * people looking in the wrong place. Restored in a `finally` so a caller that loads two modules gets the real
 * global state back between them.
 */
async function importWithTripwire(url: string, what: string): Promise<void> {
  const globals = globalThis as unknown as { document?: unknown };
  const had = "document" in globals;
  const previous = globals.document;
  globals.document = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `${what} touched \`document.${String(property)}\` at import time.\n` +
            `  Nothing in a scene or style module may touch the DOM at import time (docs/SPEC.md C5): the ` +
            `same module has to load under Node for \`cvpw storyboard\` and \`cvpw validate\`, which run ` +
            `without a browser.\n` +
            `  Move the DOM access inside draw(), or into an init() hook that only the browser calls.`,
        );
      },
    },
  );
  try {
    await import(url);
  } finally {
    if (had) globals.document = previous;
    else delete globals.document;
  }
}

/** Read a JSON file, or null. Used for the project's knobs, which are optional in this loader. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load a project without a browser.
 *
 * Collects **every** failure rather than throwing on the first, because a timeline with three broken times
 * should report three, not send the author round the loop three times.
 */
/**
 * The registries the scene modules actually register into.
 *
 * **The project's kernel, not this package's.** A project vendors its kernel into `vendor/kernel/`, and its
 * scene modules import *that* copy — so `scene({...})` registers into the vendored kernel's registry. This
 * package imports its own `@cvpw/kernel`, which is a different module instance with a different registry. The
 * first version of this loader therefore imported the manifest successfully and then reported every scene as
 * unknown, which looks exactly like a broken manifest.
 *
 * Node caches modules by resolved URL, so importing the same file gives the same registry. That is also the
 * honest model: the browser runs the vendored kernel, so a loader that disagreed with it would be validating
 * a film nobody renders.
 */
async function resolveProjectKernel(options: LoadOptions): Promise<{
  scenes: typeof scenes;
  styles: typeof styles;
  warnings: string[];
}> {
  if (options.registry) return { scenes, styles, warnings: [] };
  const entry = options.kernelEntry ?? join(options.root, "vendor", "kernel", "dist", "index.js");
  try {
    const loaded = (await import(pathToFileURL(entry).href)) as { scenes: typeof scenes; styles: typeof styles };
    if (!loaded.scenes || !loaded.styles) throw new Error("the module has no scenes/styles registries");
    return { scenes: loaded.scenes, styles: loaded.styles, warnings: [] };
  } catch (error) {
    return {
      scenes,
      styles,
      warnings: [
        `could not use the project's vendored kernel at ${entry} (${error instanceof Error ? error.message : String(error)}), ` +
          `so scene names are checked against this package's registry instead. A project scaffolded by ` +
          `\`cvpw new\` has one; if it is missing, re-scaffold or copy vendor/kernel in.`,
      ],
    };
  }
}

export async function loadProject(options: LoadOptions): Promise<LoadedProject> {
  const problems: LoadedProblem[] = [];
  const warnings: string[] = [];

  const kernel = await resolveProjectKernel(options);
  warnings.push(...kernel.warnings);
  const projectScenes = kernel.scenes;
  const projectStyles = kernel.styles;

  // --- scenes and styles ------------------------------------------------------------------------
  if (!options.registry) {
    if (!existsSync(options.scenesEntry)) {
      problems.push({
        shotId: "(engine)",
        reason: "load-error",
        message: `scene entry not found: ${options.scenesEntry}`,
      });
    } else {
      try {
        await importWithTripwire(pathToFileURL(options.scenesEntry).href, "engine/scenes/manifest.js");
      } catch (error) {
        problems.push({
          shotId: "(engine)",
          reason: "load-error",
          message: `could not load scenes: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (options.stylesEntry && existsSync(options.stylesEntry)) {
      try {
        await importWithTripwire(pathToFileURL(options.stylesEntry).href, "engine/styles/manifest.js");
      } catch (error) {
        problems.push({
          shotId: "(engine)",
          reason: "load-error",
          message: `could not load styles: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const registered = options.registry ? [...options.registry.keys()] : projectScenes.names();
  if (registered.length === 0 && problems.length === 0) {
    warnings.push(
      "no scenes were registered. Importing a scene module registers it as a side effect, so the entry " +
        "module may be importing files that export a definition without calling scene({...}).",
    );
  }

  // --- project knobs, timeline, timebase --------------------------------------------------------
  const project = await readJson(join(options.root, "project.json"));
  const output = (project?.["output"] ?? {}) as { width?: number; height?: number; fps?: number };
  const styleName =
    (typeof project?.["style"] === "string" ? (project["style"] as string) : undefined) ??
    projectStyles.names()[0] ??
    "unknown";

  if (projectStyles.names().length > 0 && !projectStyles.names().includes(styleName)) {
    problems.push({
      shotId: "(project)",
      reason: "unknown-style",
      message:
        `project.json declares style ${JSON.stringify(styleName)} but only ${projectStyles.names().join(", ")} ` +
        `are registered`,
    });
  }

  const timebase = new Timebase(options.timebase);
  const duration = options.timebase.duration ?? 0;

  interface RawTimeline {
    duration?: number;
    shots?: Array<Record<string, unknown>>;
  }
  let timeline: RawTimeline;
  try {
    timeline = JSON.parse(await readFile(options.timeline, "utf8")) as RawTimeline;
  } catch (error) {
    problems.push({
      shotId: "(timeline)",
      reason: "load-error",
      message:
        `could not read ${options.timeline}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Run \`cvpw storyboard\` to write it.`,
    });
    return {
      root: options.root,
      duration,
      fps: options.timebase.fps ?? output.fps ?? 30,
      width: output.width ?? 1920,
      height: output.height ?? 1080,
      style: styleName,
      shots: [],
      problems,
      warnings,
      registered,
    };
  }

  const shots: LoadedShot[] = [];
  const declarations = timeline.shots ?? [];

  for (const [index, raw] of declarations.entries()) {
    const id = typeof raw["id"] === "string" ? (raw["id"] as string) : `#${index}`;
    const sceneName = typeof raw["scene"] === "string" ? (raw["scene"] as string) : "";
    const at = typeof raw["at"] === "string" ? (raw["at"] as string) : null;

    if (!sceneName) {
      problems.push({ shotId: id, reason: "unknown-scene", message: "the shot declares no `scene`" });
      continue;
    }
    const definition = options.registry ? options.registry.get(sceneName) : projectScenes.get(sceneName);
    if (!definition) {
      problems.push({
        shotId: id,
        reason: "unknown-scene",
        message: `no scene named ${JSON.stringify(sceneName)}; registered: ${registered.join(", ") || "(none)"}`,
      });
      continue;
    }
    if (!at) {
      problems.push({ shotId: id, reason: "bad-time", message: "the shot declares no `at` expression" });
      continue;
    }

    let t0: number;
    try {
      t0 = timebase.resolve(at).t;
    } catch (error) {
      const failure = error as TimeExpressionError;
      problems.push({
        shotId: id,
        reason: "bad-time",
        message: failure.message ?? String(error),
        ...(failure.alternatives ? { alternatives: failure.alternatives } : {}),
      });
      continue;
    }

    const toExpression = typeof raw["to"] === "string" ? (raw["to"] as string) : undefined;
    const nextAt = index + 1 < declarations.length ? declarations[index + 1]?.["at"] : undefined;
    let t1: number;
    if (toExpression) {
      try {
        t1 = timebase.resolve(toExpression).t;
      } catch (error) {
        const failure = error as TimeExpressionError;
        problems.push({
          shotId: id,
          reason: "bad-time",
          message: failure.message ?? String(error),
          ...(failure.alternatives ? { alternatives: failure.alternatives } : {}),
        });
        continue;
      }
    } else if (typeof nextAt === "string") {
      try {
        t1 = timebase.resolve(nextAt).t;
      } catch {
        t1 = timeline.duration ?? duration;
      }
    } else {
      t1 = timeline.duration ?? duration;
    }

    if (t1 <= t0) {
      problems.push({
        shotId: id,
        reason: "empty-range",
        message: `resolves to an empty or reversed range [${t0.toFixed(3)}, ${t1.toFixed(3)})`,
      });
      continue;
    }

    // Args: style defaults, then the shot's own, then validated. A rejection is reported per shot rather
    // than thrown, so three bad shots produce three problems.
    let resolvedArgs: Record<string, unknown> = {};
    try {
      const styleDefaults = (projectStyles.get(styleName)?.defaults?.[sceneName] ?? {}) as Record<string, unknown>;
      const merged = { ...styleDefaults, ...((raw["args"] as Record<string, unknown> | undefined) ?? {}) };
      resolvedArgs = validateArgs(sceneName, definition.argsSchema ?? {}, merged) as Record<string, unknown>;
    } catch (error) {
      problems.push({
        shotId: id,
        reason: "bad-args",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    shots.push({
      ...(raw as unknown as ShotDeclaration),
      id,
      scene: sceneName,
      t0,
      t1,
      atExpression: at,
      frameFrom: timebase.frameIndex(t0),
      frameTo: timebase.frameIndex(t1),
      args: resolvedArgs,
    });
  }

  // --- ordering and coverage --------------------------------------------------------------------
  for (let i = 1; i < shots.length; i++) {
    const previous = shots[i - 1] as LoadedShot;
    const current = shots[i] as LoadedShot;
    if (current.t0 < previous.t0) {
      problems.push({
        shotId: current.id,
        reason: "out-of-order",
        message: `starts at ${current.t0.toFixed(3)} s, before ${previous.id} at ${previous.t0.toFixed(3)} s`,
      });
    }
  }

  const total = timeline.duration ?? duration;
  let cursor = 0;
  for (const shot of shots) {
    if (shot.t0 > cursor + 1e-3) {
      warnings.push(
        `gap [${cursor.toFixed(3)}, ${shot.t0.toFixed(3)}) before ${shot.id} renders as a marked black frame`,
      );
    }
    cursor = Math.max(cursor, shot.t1);
  }
  if (shots.length > 0 && total > 0 && Math.abs(cursor - total) > 1e-3) {
    warnings.push(`the last shot ends at ${cursor.toFixed(3)} s but the timeline is ${total.toFixed(3)} s`);
  }

  return {
    root: options.root,
    duration: total,
    fps: options.timebase.fps ?? output.fps ?? 30,
    width: output.width ?? 1920,
    height: output.height ?? 1080,
    style: styleName,
    shots,
    problems,
    warnings,
    registered,
  };
}

/**
 * Render the storyboard table and the machine-readable partition without a browser.
 *
 * Deliberately minimal: `cvpw storyboard` owns the canonical documents, and this is the same data for a
 * caller that already has a `LoadedProject`. Two formatters writing the same file would drift, so this
 * returns the *markdown* and lets the caller decide where it goes.
 */
export async function writeStoryboard(project: LoadedProject, outDir: string): Promise<string[]> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  const lines: string[] = [
    "# STORYBOARD",
    "",
    `Duration **${project.duration.toFixed(3)} s** at **${project.fps} fps** — ` +
      `${Math.round(project.duration * project.fps)} frames.`,
    `${project.shots.length} shot(s), style \`${project.style}\`.`,
    "",
  ];
  if (project.problems.length > 0) {
    lines.push("## Problems", "", "| shot | kind | detail |", "|---|---|---|");
    for (const problem of project.problems) {
      lines.push(`| \`${problem.shotId}\` | ${problem.reason} | ${problem.message.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  if (project.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of project.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  lines.push("| # | id | scene | at | resolved | frames |", "|---|---|---|---|---|---|");
  project.shots.forEach((shot, index) => {
    lines.push(
      `| ${index + 1} | \`${shot.id}\` | \`${shot.scene}\` | \`${shot.atExpression}\` | ` +
        `${shot.t0.toFixed(3)}–${shot.t1.toFixed(3)} s | ${shot.frameFrom}–${shot.frameTo} |`,
    );
  });
  lines.push("");

  const path = join(outDir, "STORYBOARD.md");
  await writeFile(path, lines.join("\n"), "utf8");
  return [path];
}

/** The scene names this process has registered, for a caller that wants to check before loading. */
export function registeredScenes(): string[] {
  return scenes.names();
}

/** Remove every registration. Exists so tests do not leak state between cases. */
export function clearRegistries(): void {
  scenes.clear();
  styles.clear();
}

export { dirname, resolve };
