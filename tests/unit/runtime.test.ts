import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject, writeStoryboard, type LoadedProject } from "../../packages/runtime/src/index.js";
import { scene } from "../../packages/kernel/src/plugin.js";
import type { SceneDefinition } from "../../packages/kernel/src/plugin.js";

const dirs: string[] = [];

async function makeProject(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cvpw-runtime-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A scene whose draw never runs under Node, because nothing here draws. */
function probeScene(name: string, argsSchema?: SceneDefinition["argsSchema"]): SceneDefinition {
  return scene({
    name,
    doc: "test scene",
    ...(argsSchema ? { argsSchema } : {}),
    draw() {
      void 0;
    },
  });
}

const TIMEBASE = {
  duration: 8,
  fps: 30,
  beats: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  beatsSmooth: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  bars: [
    { index: 0, start: 0.5, end: 2.5, beats: 4, pickup: false, bpm: 120 },
    { index: 1, start: 2.5, end: 4.5, beats: 4, pickup: false, bpm: 120 },
  ],
  sections: [],
  onsets: [],
  impacts: [],
  stops: [],
  cues: [{ id: "chorus", t: 4, source: "manual" as const }],
};

/**
 * The loader's whole reason for existing: resolve an edit without a browser, and report **every** problem
 * rather than the first. A timeline with three broken times should report three, not send the author round
 * the loop three times.
 */
describe("loadProject — resolution without a browser", () => {
  it("resolves bar, half-beat and cue expressions against the timebase", async () => {
    probeScene("open");
    const root = await makeProject({
      "timeline.json": {
        duration: 8,
        shots: [
          { id: "a", scene: "open", at: "b(0,0)", to: "b(1,0)" },
          { id: "b", scene: "open", at: "cue('chorus')", to: "p(1.0)" },
        ],
      },
    });
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", { name: "open", draw() {} } as unknown as SceneDefinition]]),
    });
    expect(loaded.problems).toEqual([]);
    expect(loaded.shots).toHaveLength(2);
    // b(0,0) is the first beat of bar 0.
    expect(loaded.shots[0]?.t0).toBeCloseTo(0.5, 6);
    expect(loaded.shots[0]?.t1).toBeCloseTo(2.5, 6);
    // The cue resolves to 4.0 and p(1.0) is the whole film.
    expect(loaded.shots[1]?.t0).toBeCloseTo(4, 6);
    expect(loaded.shots[1]?.t1).toBeCloseTo(8, 6);
  });

  it("collects every bad time expression rather than throwing on the first", async () => {
    const root = await makeProject({
      "timeline.json": {
        duration: 8,
        shots: [
          { id: "a", scene: "open", at: "b(9,0)" },
          { id: "b", scene: "open", at: "cue('nonexistent')" },
          { id: "c", scene: "open", at: "L(99)" },
        ],
      },
    });
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", { name: "open", draw() {} } as unknown as SceneDefinition]]),
    });
    expect(loaded.problems).toHaveLength(3);
    expect(loaded.problems.every((problem) => problem.reason === "bad-time")).toBe(true);
    // A named offender for each, so the author knows which line to fix.
    expect(loaded.problems.map((problem) => problem.shotId)).toEqual(["a", "b", "c"]);
  });

  it("reports an unknown scene by name, listing what is registered", async () => {
    const root = await makeProject({
      "timeline.json": { duration: 8, shots: [{ id: "a", scene: "typo", at: "b(0,0)" }] },
    });
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", { name: "open", draw() {} } as unknown as SceneDefinition]]),
    });
    expect(loaded.problems[0]?.reason).toBe("unknown-scene");
    expect(loaded.problems[0]?.message).toContain("open");
  });

  it("reports a missing timeline as a load error naming the command that writes it", async () => {
    const root = await makeProject({});
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map(),
    });
    expect(loaded.problems[0]?.reason).toBe("load-error");
    expect(loaded.problems[0]?.message).toContain("cvpw storyboard");
  });

  it("warns about a coverage gap rather than failing, because a gap is still renderable", async () => {
    const root = await makeProject({
      "timeline.json": { duration: 8, shots: [{ id: "a", scene: "open", at: "b(0,0)", to: "b(1,0)" }] },
    });
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", { name: "open", draw() {} } as unknown as SceneDefinition]]),
    });
    expect(loaded.problems).toEqual([]);
    // The first shot starts at 0.5 s, so [0, 0.5) has no shot.
    expect(loaded.warnings.some((warning) => warning.includes("gap"))).toBe(true);
  });

  it("rejects a shot's args the way the engine would, per shot", async () => {
    const root = await makeProject({
      "timeline.json": {
        duration: 8,
        shots: [{ id: "a", scene: "open", at: "b(0,0)", args: { nonsense: 1 } }],
      },
    });
    const definition = {
      name: "open",
      argsSchema: { rings: { type: "integer" as const, min: 0, max: 12, default: 3 } },
      draw() {},
    } as unknown as SceneDefinition;
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", definition]]),
    });
    expect(loaded.problems[0]?.reason).toBe("bad-args");
    expect(loaded.problems[0]?.shotId).toBe("a");
  });

  it("fills a shot's args from the style defaults the browser would use", async () => {
    const root = await makeProject({
      "project.json": { output: { width: 1080, height: 1920, fps: 30 }, style: "minimal-paper" },
      "timeline.json": { duration: 8, shots: [{ id: "a", scene: "open", at: "b(0,0)", to: "p(1.0)" }] },
    });
    const definition = {
      name: "open",
      argsSchema: { rings: { type: "integer" as const, min: 0, max: 12, default: 3 } },
      draw() {},
    } as unknown as SceneDefinition;
    const loaded = await loadProject({
      root,
      scenesEntry: join(root, "nope.js"),
      timeline: join(root, "timeline.json"),
      timebase: TIMEBASE,
      registry: new Map([["open", definition]]),
    });
    expect(loaded.shots[0]?.args).toEqual({ rings: 3 });
    // The output size comes from project.json, so a vertical variant is a loader concern too.
    expect(loaded.width).toBe(1080);
    expect(loaded.height).toBe(1920);
  });
});

describe("writeStoryboard", () => {
  it("writes a table that cannot disagree with the resolved data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cvpw-sb-"));
    dirs.push(dir);
    const project: LoadedProject = {
      root: "/x",
      duration: 8,
      fps: 30,
      width: 1920,
      height: 1080,
      style: "minimal-paper",
      registered: ["open"],
      problems: [],
      warnings: [],
      shots: [
        {
          id: "s01",
          scene: "open",
          at: "b(0,0)",
          atExpression: "b(0,0)",
          t0: 0.5,
          t1: 2.5,
          frameFrom: 15,
          frameTo: 75,
          args: {},
        },
      ],
    };
    const [path] = await writeStoryboard(project, dir);
    const markdown = await readFile(path as string, "utf8");
    expect(markdown).toContain("0.500–2.500 s");
    expect(markdown).toContain("`b(0,0)`");
    expect(markdown).toContain("15–75");
  });

  it("lists problems when there are any, so a broken run is readable without the JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cvpw-sb2-"));
    dirs.push(dir);
    const project: LoadedProject = {
      root: "/x",
      duration: 8,
      fps: 30,
      width: 1920,
      height: 1080,
      style: "minimal-paper",
      registered: [],
      problems: [{ shotId: "s01", reason: "bad-time", message: "no cue named \"chorus\"" }],
      warnings: [],
      shots: [],
    };
    const [path] = await writeStoryboard(project, dir);
    const markdown = await readFile(path as string, "utf8");
    expect(markdown).toContain("## Problems");
    expect(markdown).toContain("no cue named");
  });
});
