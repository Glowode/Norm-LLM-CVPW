/**
 * `cvpw` — the command line.
 *
 * Every command follows the same three conventions, because those are what make the framework usable
 * by an agent that only knows how to run a command and read its output (`docs/SPEC.md` P1):
 *
 *   1. exactly one JSON envelope on stdout with `--json`
 *   2. logs on stderr
 *   3. a meaningful exit code: 0 ok, 1 check failed, 2 bad usage, 3 contract violation
 *
 * Two commands are implemented in v0.1 — `doctor` and `env` — because they are the ones that must work
 * before anything else is built, and because they answer questions the rest of the framework depends on
 * (is there a GPU? is the encoder real? is the code page going to corrupt my text?). Every other command
 * is registered with its help text and its full flag surface, and reports honestly that it is not
 * implemented yet rather than pretending to run. See `docs/PROGRESS.md`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { COMMON_FLAGS, getBool, getList, getNumber, getString, parseArgs, renderHelp, type CommandHelp } from "./args.js";
import { doctorProbe, printDoctor } from "./doctor.js";
import { detectBrowser, headlessProbe } from "./browser.js";
import {
  EXIT,
  CheckFailedError,
  ContractError,
  UsageError,
  findProjectRoot,
  frameworkRoot,
  log,
  relPath,
  resolveTool,
  type Envelope,
} from "./shared.js";

interface Command {
  help: CommandHelp;
  /** `true` when `run` is a real implementation rather than a not-implemented notice. */
  implemented: boolean;
  run?(args: ReturnType<typeof parseArgs>, root: string | null): Promise<Envelope>;
}

const COMMANDS: Record<string, Command> = {};

function register(command: Command, aliases: readonly string[] = []): void {
  COMMANDS[command.help.name] = command;
  for (const alias of aliases) COMMANDS[alias] = command;
}

// --- doctor ---------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "doctor",
    summary: "What this machine can and cannot do, before you trust it with a render.",
    usage: "cvpw doctor [--quick] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          {
            name: "quick",
            type: "boolean",
            doc: "Skip the browser launch. Reported as 'not probed', never as a pass.",
          },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw doctor", "cvpw doctor --json", "cvpw doctor --quick"],
    notes: [
      "Hardware encoders are probed by ATTEMPTING an encode. `ffmpeg -encoders` lists h264_nvenc on a",
      "machine where it fails with exit -40, and reporting that as available is reporting a lie.",
      "Exit code 0 means every REQUIRED check passed; REQUIRED gaps exit 1.",
    ],
  },
  async run(args) {
    const result = await doctorProbe({
      quick: getBool(args, "quick"),
      cwd: process.cwd(),
    });
    if (!args.json) printDoctor(result);
    return {
      // Exit 1 for a missing OR degraded REQUIRED item. A degraded one will run and produce a
      // *different artefact* — a software renderer in particular — so a green exit code would tell a
      // script "this machine is fine" when the honest answer is "read the cost column first".
      ok: result.requiredMissing === 0 && result.requiredDegraded === 0,
      command: "doctor",
      schemaVersion: 1,
      result,
      warnings: result.rows
        .filter((r) => r.status !== "ok")
        .map((r) => ({ code: `${r.group}.${r.status}`, message: `${r.name} — ${r.cost || r.detail}` })),
      errors: [],
      summary: result.summary,
    };
  },
});

// --- env ------------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "env",
    summary: "Resolved external tools and versions, and the environment overrides in effect.",
    usage: "cvpw env [--json]",
    groups: [{ title: "flags", flags: [...COMMON_FLAGS] }],
    notes: [
      "Every external tool is discovered and overridable. An absolute hard-coded path makes a framework",
      "unusable on any other machine — including the one it was written on, after a reinstall.",
    ],
  },
  async run(args) {
    const tools = ["ffmpeg", "ffprobe", "python", "git", "node"].map((name) => {
      const t = resolveTool(name);
      return { name, path: t.path, source: t.source, envVar: t.envVar ?? null };
    });
    const browser = detectBrowser();
    const root = frameworkRoot();
    const result = {
      frameworkRoot: root,
      hasSchemas: existsSync(join(root, "schemas")),
      hasTemplates: existsSync(join(root, "templates")),
      hasSkills: existsSync(join(root, "skills")),
      cwd: process.cwd(),
      projectRoot: findProjectRoot(process.cwd()),
      tools,
      browser,
      overrides: Object.fromEntries(
        [
          "CVPW_FFMPEG",
          "CVPW_FFPROBE",
          "CVPW_PYTHON",
          "CVPW_BROWSER",
          "CVPW_BROWSER_CHANNEL",
          "CVPW_BROWSER_ANGLE",
          "CVPW_TMP",
          "CVPW_WORKERS",
          "PYTHONUTF8",
          "PYTHONIOENCODING",
        ]
          .map((k) => [k, process.env[k] ?? null])
          .filter(([, v]) => v !== null),
      ),
    };
    if (!args.json) {
      log.info("");
      log.info(`framework   ${result.frameworkRoot}`);
      log.info(`cwd         ${result.cwd}`);
      log.info(`project     ${result.projectRoot ?? "(none — no project.json above the working directory)"}`);
      log.info("");
      for (const t of tools) {
        const shown = t.path ?? "not found";
        log.info(`  ${t.name.padEnd(9)} ${shown}${t.envVar ? `   [${t.envVar}]` : ""}`);
      }
      log.info(`  ${"browser".padEnd(9)} ${browser ? `${browser.name}  ${browser.path}` : "not found"}`);
      log.info("");
      const overrides = Object.entries(result.overrides) as [string, string][];
      log.info(overrides.length ? `overrides in effect: ${overrides.map(([k, v]) => `${k}=${v}`).join(", ")}` : "no overrides in effect");
      log.info("");
    }
    return {
      ok: true,
      command: "env",
      schemaVersion: 1,
      result,
      warnings: [],
      errors: [],
    };
  },
});

// --- renderer probe (small, but used by every render path) ----------------------------------------

register({
  implemented: true,
  help: {
    name: "renderer",
    summary: "Launch the browser headless and report the WebGL renderer it actually uses.",
    usage: "cvpw renderer [--json]",
    groups: [{ title: "flags", flags: [...COMMON_FLAGS] }],
    notes: [
      "A software rasteriser (SwiftShader / WARP / llvmpipe) is roughly 10x slower AND its float paths",
      "differ, so a render produced under it is a different artefact rather than a slower one.",
      "Exit code 1 when the renderer is software: this is a warning you have to acknowledge.",
    ],
  },
  async run(args) {
    const browser = detectBrowser();
    if (!browser) {
      throw new ContractError(
        "no chromium-family browser found; install Chrome or Edge, or set CVPW_BROWSER to an executable path",
      );
    }
    const probe = await headlessProbe(browser, { timeoutMs: 120_000 });
    const result = { browser: browser.name, path: browser.path, source: browser.source, ...probe };
    if (!args.json) {
      log.info("");
      log.info(`browser   ${browser.name}   ${browser.path}`);
      log.info(`renderer  ${probe.renderer}`);
      log.info(probe.software ? "          [SOFTWARE — renders will be ~10x slower and may differ]" : "          [hardware]");
      log.info("");
    }
    return {
      ok: probe.ok && !probe.software,
      command: "renderer",
      schemaVersion: 1,
      result,
      warnings: probe.ok && probe.software
        ? [{ code: "renderer.software", message: probe.renderer }]
        : probe.ok
          ? []
          : [{ code: "renderer.probe-failed", message: probe.error ?? "unknown" }],
      errors: [],
    };
  },
});

// --- new -----------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "new",
    summary: "Scaffold a project from templates/project.",
    usage: "cvpw new <dir> [--song <file>] [--lyrics <file>] [--template <name>] [--no-vendor] [--force]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "song", type: "value", value: "<file>", doc: "Audio to import. Copied, never converted or edited." },
          { name: "lyrics", type: "value", value: "<file>", doc: "Lyrics to import. Whether they may be published is a separate decision." },
          { name: "template", type: "value", value: "<name>", doc: "Template under templates/.", default: "project" },
          { name: "no-vendor", type: "boolean", doc: "Skip copying the kernel. The project cannot render until `cvpw link` runs." },
          { name: "force", type: "boolean", doc: "Write into a non-empty directory. Announced when used." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw new ../my-film --song song.wav --lyrics lyrics.txt", "cvpw new ../scratch --no-vendor"],
    notes: [
      "The kernel is copied into vendor/kernel so the project is self-contained: a render serves the",
      "project directory, and a relative import escaping that root cannot be loaded by the page.",
    ],
  },
  async run(args) {
    const dir = args.positionals[0];
    if (!dir) throw new UsageError("cvpw new needs a target directory", "for example: cvpw new ../my-film");
    const song = typeof args.flags.get("song") === "string" ? String(args.flags.get("song")) : undefined;
    const lyrics = typeof args.flags.get("lyrics") === "string" ? String(args.flags.get("lyrics")) : undefined;
    const template = typeof args.flags.get("template") === "string" ? String(args.flags.get("template")) : undefined;

    const { scaffold, describeNew } = await import("./commands/new.js");
    const result = await scaffold({
      dir,
      ...(song ? { song } : {}),
      ...(lyrics ? { lyrics } : {}),
      ...(template ? { template } : {}),
      force: getBool(args, "force"),
      noVendor: getBool(args, "no-vendor"),
    });

    const summary = describeNew(result);
    if (!args.json) {
      log.info("");
      for (const line of summary) log.info(line);
      log.info("");
      log.info("next:");
      for (const step of result.nextSteps) log.info(`  ${step}`);
      log.info("");
    }
    return {
      ok: true,
      command: "new",
      schemaVersion: 1,
      project: result.root,
      result,
      warnings: result.vendored
        ? []
        : [{ code: "kernel.not-vendored", message: "the project cannot render until `cvpw link` runs" }],
      errors: [],
      summary,
    };
  },
});

// --- validate ------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "validate",
    summary: "JSON Schema validation of every artifact, plus the checks no single schema can express.",
    usage: "cvpw validate [--all] [--artifact <path>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "all", type: "boolean", doc: "Report missing optional artifacts too, not only present ones." },
          { name: "artifact", type: "value", value: "<path>", doc: "Validate one file." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw validate", "cvpw validate --all --json", "cvpw validate --artifact timeline.json"],
    notes: [
      "Cross-artifact checks are the ones that earn their keep: a cue a timeline references but that no",
      "longer exists, a time expression the timebase cannot substantiate, text outside the whitelist.",
      "All of those produce a finished film that is wrong, which is the worst outcome available.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory; run this inside a project");
    const artifact = typeof args.flags.get("artifact") === "string" ? String(args.flags.get("artifact")) : undefined;
    const { validateProject, validateEnvelope } = await import("./commands/validate.js");
    const result = await validateProject({ root, all: getBool(args, "all"), ...(artifact ? { artifact } : {}) });
    const envelope = validateEnvelope(result);
    if (!args.json) {
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
      log.info(result.ok ? "every artifact validates" : "validation failed — see above");
    }
    return { ...envelope, project: root };
  },
});

// --- stills --------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "stills",
    summary: "Render stills at given times, with a manifest naming the shots active in each.",
    usage: "cvpw stills --times <a,b,c> [--overlay] [--out <dir>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "times", type: "value", value: "<a,b,c>", doc: "Seconds, or time expressions such as cue('chorus').", repeat: true },
          { name: "overlay", type: "boolean", doc: "Burn in time, frame and active shot ids. Review only; never a master." },
          { name: "out", type: "value", value: "<dir>", doc: "Output directory, relative to the project.", default: "review/stills" },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw stills --times 0,2,4 --overlay", "cvpw stills --times \"cue('chorus')\" --overlay"],
    notes: [
      "Writes review/stills/manifest.json naming the time, frame and shots for every image. An agent that",
      "has looked at a PNG but cannot say which shot produced it will edit the wrong file.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const raw = getList(args, "times").flatMap((entry) => entry.split(",")).filter((entry) => entry.trim() !== "");
    if (!raw.length) throw new UsageError("cvpw stills needs --times", "for example: --times 0,2,4");
    const { resolveTimes, runStills } = await import("./commands/render.js");
    const times = await resolveTimes(root, raw);
    const outFlag = typeof args.flags.get("out") === "string" ? String(args.flags.get("out")) : undefined;
    const result = await runStills({
      root,
      times,
      ...(outFlag ? { outDir: join(root, outFlag) } : {}),
      overlay: getBool(args, "overlay"),
    });
    const short = (p: string): string => p.replace(root, "").replace(/^[/\\]/, "").replace(/\\/g, "/");
    const summary = [
      `wrote ${result.files.length} still(s)`,
      ...times.map((entry, i) => `  ${entry.label} -> ${result.files[i] ? short(result.files[i] as string) : "(failed)"}`),
      `  manifest: ${short(result.manifestPath)}`,
      "LOOK AT THEM. A still that was rendered and not opened is not a review.",
    ];
    if (!args.json) {
      log.info("");
      for (const line of summary) log.info(line);
      log.info("");
    }
    return {
      ok: result.files.length === times.length,
      command: "stills",
      schemaVersion: 1,
      project: root,
      artifactsWritten: [...result.files, result.manifestPath],
      result: { files: result.files, manifest: result.manifestPath, times },
      warnings: [],
      errors: [],
      summary,
    };
  },
});

// --- render --------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "render",
    summary: "Frames to MP4, through an ordered sink and a probed encoder.",
    usage: "cvpw render [--name <n>] [--workers <n>] [--from <f>] [--to <f>] [--preview] [--quality <n>] [--allow-software] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "name", type: "value", value: "<n>", doc: "Output basename under render/.", default: "master" },
          { name: "workers", type: "value", value: "<n>", doc: "Concurrent pages. The output MUST NOT depend on this value." },
          { name: "from", type: "value", value: "<frame>", doc: "First frame index." },
          { name: "to", type: "value", value: "<frame>", doc: "Last frame index, exclusive. Defaults to the whole film." },
          { name: "preview", type: "boolean", doc: "Half resolution and a fast encoder. Never delivered as a master." },
          { name: "quality", type: "value", value: "<n>", doc: "Encoder quality: crf for libx264, cq for NVENC." },
          { name: "allow-software", type: "boolean", doc: "Permit a software rasteriser. Off by default: ~10x slower and a different artefact." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw render --workers 2", "cvpw render --preview", "cvpw render --name shot-check --from 0 --to 30"],
    notes: [
      "Frames are hashed from the CAPTURED bytes, not from an in-page pixel read: the witness has to be",
      "the artefact that ships (ADR 0007). Every failure path deletes the output, because a truncated",
      "MP4 passes an existence check and plays for thirty seconds.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { runRender, renderEnvelope } = await import("./commands/render.js");
    const name = typeof args.flags.get("name") === "string" ? String(args.flags.get("name")) : undefined;

    log.info("");
    const outcome = await runRender({
      root,
      ...(name ? { name } : {}),
      ...(getString(args, "workers") !== undefined ? { workers: getNumber(args, "workers") } : {}),
      ...(getString(args, "from") !== undefined ? { from: getNumber(args, "from") } : {}),
      ...(getString(args, "to") !== undefined ? { to: getNumber(args, "to") } : {}),
      ...(getString(args, "quality") !== undefined ? { quality: getNumber(args, "quality") } : {}),
      preview: getBool(args, "preview"),
      allowSoftware: getBool(args, "allow-software"),
      ...(args.json ? {} : { onProgress: (line: string) => log.info(line) }),
    });
    const envelope = renderEnvelope(outcome, root, "render");
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- storyboard ----------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "storyboard",
    summary: "Resolve every time expression, verify coverage, and write timeline.json plus docs/STORYBOARD.md.",
    usage: "cvpw storyboard [--json]",
    groups: [{ title: "flags", flags: [...COMMON_FLAGS] }],
    examples: ["cvpw storyboard", "cvpw storyboard --json"],
    notes: [
      "engine/timeline.js stays the source of truth; timeline.json is DERIVED and must not be hand-edited.",
      "A coverage gap is a failure, not a warning: it renders as a marked black frame.",
      "Runs entirely in Node. If it cannot, the timeline touched the DOM at import time — which is a",
      "contract violation, because a broken expression must be findable without launching a browser.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { buildStoryboard, storyboardEnvelope } = await import("./commands/storyboard.js");
    const result = await buildStoryboard(root);
    const envelope = storyboardEnvelope(result, root);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- check ---------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "check",
    summary: "The gate suite. Reports offenders, never a score.",
    usage: "cvpw check [--only <ids>] [--profile <name>] [--only-block <id>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          {
            name: "only",
            type: "value",
            value: "<ids>",
            doc: "Comma-separated check ids: render.frameContent, scenes.registry, timeline.time, text.whitelist.",
            repeat: true,
          },
          { name: "profile", type: "value", value: "<name>", doc: "all | render | deliver.", default: "all" },
          { name: "only-block", type: "value", value: "<id>", doc: "Restrict the frame checks to one block's range." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw check --only render.frameContent", "cvpw check", "cvpw check --json"],
    notes: [
      "`render.frameContent` (docs/QA.md) is the gate that was missing when a film of near-black passed",
      "reads back what each sampled frame actually contains and fails when a frame is only its background.",
      "Thresholds come from docs/QA.md and project.json::budgets. A project may tighten one, never loosen it.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { runChecks, checkEnvelope } = await import("./commands/check.js");
    const { prepareCapture } = await import("./commands/render.js");

    const capture = await prepareCapture(root);
    const only = getList(args, "only")
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const profile = typeof args.flags.get("profile") === "string" ? String(args.flags.get("profile")) : "all";
    const blockId = typeof args.flags.get("only-block") === "string" ? String(args.flags.get("only-block")) : undefined;

    // `--only-block` restricts the *frame* checks to a block's range, so a block author can gate their own
    // work without measuring somebody else's.
    let range: { from: number; to: number; label: string } | undefined;
    if (blockId) {
      const { buildStoryboard } = await import("./commands/storyboard.js");
      const storyboard = await buildStoryboard(root).catch(() => null);
      const block = storyboard?.blocks.find((entry) => entry.id === blockId);
      if (!block) {
        throw new ContractError(
          `no block named ${JSON.stringify(blockId)} in the storyboard\n` +
            `  blocks: ${storyboard?.blocks.map((entry) => entry.id).join(", ") || "(none)"}`,
        );
      }
      range = { from: Math.round(block.from * capture.fps), to: Math.round(block.to * capture.fps), label: blockId };
    }

    const report = await runChecks(
      { root, fps: capture.fps, duration: capture.duration, ...(range ? { range } : {}), json: args.json },
      { only },
    );
    const envelope = checkEnvelope(report);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- gold ----------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "gold",
    summary: "Take or refresh the determinism baseline at qa/gold.json.",
    usage: "cvpw gold --reason <text> [--sample <n>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "reason", type: "value", value: "<text>", doc: "Why this baseline is being (re)taken. Required." },
          { name: "sample", type: "value", value: "<n>", doc: "How many frames to witness.", default: "24" },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw gold --reason \"first baseline\"", "cvpw gold --reason \"after the palette fix\" --sample 48"],
    notes: [
      "A baseline with no stated reason is indistinguishable from an accident, so --reason is required.",
      "Frames are captured the way a render captures them, walking from the film's start: a frame's pixels",
      "depend on how much work was queued before it, so a witness that jumped straight to frame 200 would",
      "describe a frame nobody ships.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const reason = typeof args.flags.get("reason") === "string" ? String(args.flags.get("reason")) : undefined;
    if (!reason) {
      throw new UsageError(
        "cvpw gold needs --reason",
        "a baseline whose provenance is unknown is indistinguishable from an accident",
      );
    }
    const sample = getString(args, "sample") !== undefined ? getNumber(args, "sample") : 24;
    const { takeGold } = await import("./commands/gold.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    log.info("");
    const result = await takeGold({
      root,
      reason,
      sample,
      ...(args.json ? {} : { onProgress: (frame: number, total: number) => {
        if (frame % 12 === 0 || frame === total) log.info(`  frame ${frame}/${total}`);
      } }),
    });
    await mkdir(dirname(result.path), { recursive: true });
    await writeFile(result.path, `${JSON.stringify(result.document, null, 2)}\n`, "utf8");

    const summary = [
      `wrote ${relPath(root, result.path)}`,
      `  ${Object.keys(result.document.frames).length} frame witnesses at ${result.document.width}x${result.document.height}@${result.document.fps}`,
      `  renderer ${result.document.renderer}`,
      `  reason: ${reason}`,
      "  compare against it with `cvpw check --only determinism`",
    ];
    if (!args.json) {
      log.info("");
      for (const line of summary) log.info(line);
      log.info("");
    }
    return {
      ok: true,
      command: "gold",
      schemaVersion: 1,
      project: root,
      artifactsWritten: [result.path],
      result: result.document,
      warnings: [],
      errors: [],
      summary,
    };
  },
});

// --- not-yet-implemented commands -----------------------------------------------------------------

/**
 * Register a command whose interface is fully specified and whose implementation is pending.
 *
 * Reporting this honestly — with the exact flag surface and a pointer to the design — is the point.
 * A stub that prints "coming soon" wastes the operator's time; a stub that silently does nothing is
 * worse. This one tells you what it would do, which flags it would take, and where to read the design.
 */
function stub(
  name: string,
  summary: string,
  usage: string,
  reference: string,
  flags: CommandHelp["groups"][number]["flags"] = [],
  notes: string[] = [],
): void {
  register({
    implemented: false,
    help: {
      name,
      summary,
      usage,
      groups: [{ title: "flags", flags: [...flags, ...COMMON_FLAGS] }],
      notes: [
        `Not implemented in v0.1. Design: ${reference}`,
        ...notes,
      ],
    },
  });
}





stub(
  "analyze",
  "Audio to a timebase: analysis/audio.json, envelope.json/.f32, overview.png.",
  "cvpw analyze [--audio <file>] [--bpm-range LO,HI] [--json]",
  "docs/WORKFLOW.md stage 2, docs/CONTRACTS.md §4",
  [
    { name: "audio", type: "value", value: "<file>", doc: "Defaults to project.json::audio.file." },
    { name: "bpm-range", type: "value", value: "LO,HI", doc: "Constrain the tempo search, for an octave error." },
    { name: "fps", type: "value", value: "<n>", doc: "Envelope frame rate. Defaults to project.json::output.fps." },
  ],
  [
    "The analysis itself works today: `python -m cvpw_py analyze --audio <f> --out <dir>`.",
    "It is verified against a synthetic ground-truth fixture — see docs/PROGRESS.md.",
  ],
);

stub("cues", "Settle cue guesses onto measured onsets. Never overwrites a manual cue.", "cvpw cues [--json]", "docs/WORKFLOW.md stage 2");
stub("lyrics", "LRC or plain text to lyric timing.", "cvpw lyrics [--join <file>] [--json]", "skills/cvpw-timing/references/02-lyric-timing.md");

stub("assets", "Validate assets/manifest.json. Generation is phase 2.", "cvpw assets [--reindex] [--json]", "docs/WORKFLOW.md stage 4");



stub(
  "sheet",
  "Contact sheets: by interval, or one frame per cue.",
  "cvpw sheet [--from <t> --to <t> --every <s> | --cues] [--cols <n>] [--out <file>] [--json]",
  "docs/WORKFLOW.md stage 6",
  [
    { name: "cues", type: "boolean", doc: "One frame per cue. The single most useful review image." },
    { name: "from", type: "value", value: "<t>", doc: "Start time." },
    { name: "to", type: "value", value: "<t>", doc: "End time." },
    { name: "every", type: "value", value: "<s>", doc: "Interval between frames." },
    { name: "cols", type: "value", value: "<n>", doc: "Sheet columns.", default: 5 },
    { name: "out", type: "value", value: "<file>", doc: "Output image.", default: "review/sheet.jpg" },
  ],
);

stub(
  "review",
  "Contact sheets over a rendered master, plus the review manifest.",
  "cvpw review --mp4 <file> [--step <s>] [--out <dir>] [--json]",
  "docs/QA.md §4",
  [
    { name: "mp4", type: "value", value: "<file>", doc: "The rendered master to review." },
    { name: "step", type: "value", value: "<s>", doc: "Seconds between frames.", default: 1.8 },
  ],
);





stub(
  "lint",
  "Static audit: banned APIs (AST-based), encoding, absolute times, layout literals, text whitelist.",
  "cvpw lint [paths...] [--strict] [--json]",
  "packages/audit/src/index.ts",
  [{ name: "strict", type: "boolean", doc: "Treat absolute-time and layout warnings as errors." }],
  [
    "The analyzer itself works today: packages/audit/src/index.ts, 22 tests covering the evasions",
    "a textual scan misses (const r = Math.random; r(), globalThis.Date.now()).",
  ],
);

stub("handoff", "Seam A|REF|B strips and numeric grades into handoff.report.json.", "cvpw handoff [--list <ids>] [--json]", "docs/CONTRACTS.md §9");
stub("deliver", "Final checks, variants, delivery list.", "cvpw deliver [--variants <list>] [--json]", "docs/QA.md §6");
stub("skill", "Install a skill bundle into an agent platform.", "cvpw skill install --target <claude|dsh|generic> [--json]", "docs/EXTENDING.md recipe 8");

// --- main -----------------------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    printGlobalHelp();
    return first === undefined ? EXIT.USAGE : EXIT.OK;
  }
  if (first === "--version" || first === "-v") {
    log.plain("cvpw 0.1.0");
    return EXIT.OK;
  }

  const command = COMMANDS[first];
  if (!command) {
    log.error(`cvpw: unknown command ${JSON.stringify(first)}`);
    log.info(`run \`cvpw help\` for the command list`);
    return EXIT.USAGE;
  }

  // Every command accepts the same common flags; the parser enforces that they are known.
  const allFlags = command.help.groups.flatMap((g) => g.flags);
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv.slice(1), allFlags, command.help.name);
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(`cvpw ${err.message}`);
      if (err.hint) log.info(err.hint);
      return EXIT.USAGE;
    }
    throw err;
  }

  if (args.help) {
    log.plain(renderHelp(command.help));
    return EXIT.OK;
  }

  const explicitRoot = typeof args.flags.get("project") === "string" ? String(args.flags.get("project")) : null;
  const root = explicitRoot ?? findProjectRoot(process.cwd());

  try {
    if (!command.implemented || !command.run) {
      const envelope: Envelope = {
        ok: false,
        command: command.help.name,
        schemaVersion: 1,
        ...(root ? { project: root } : {}),
        warnings: [],
        errors: [
          {
            code: "not-implemented",
            message: `cvpw ${command.help.name} is specified but not implemented in v0.1`,
          },
        ],
        summary: [
          `usage: ${command.help.usage}`,
          ...(command.help.notes ?? []),
          "see docs/PROGRESS.md for what is done and what is not",
        ],
      };
      emit(envelope, args.json);
      return EXIT.CONTRACT;
    }

    const envelope = await command.run(args, root);
    emit(envelope, args.json);
    return envelope.ok ? EXIT.OK : EXIT.CHECK_FAILED;
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(`cvpw ${err.message}`);
      if (err.hint) log.info(err.hint);
      return EXIT.USAGE;
    }
    if (err instanceof ContractError) {
      const envelope: Envelope = {
        ok: false,
        command: command.help.name,
        schemaVersion: 1,
        ...(root ? { project: root } : {}),
        warnings: [],
        errors: [
          {
            code: "contract",
            message: err.message,
            ...(err.alternatives ? { alternatives: [...err.alternatives] } : {}),
          },
        ],
      };
      emit(envelope, args.json);
      log.error(err.message);
      return EXIT.CONTRACT;
    }
    if (err instanceof CheckFailedError) {
      const envelope: Envelope = {
        ok: false,
        command: command.help.name,
        schemaVersion: 1,
        warnings: [],
        errors: [{ code: "check-failed", message: err.message, offenders: err.offenders } as never],
      };
      emit(envelope, args.json);
      log.error(err.message);
      for (const offender of err.offenders) log.detail(offender);
      return EXIT.CHECK_FAILED;
    }
    log.error(`cvpw ${command.help.name}: unexpected failure`);
    log.detail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return EXIT.CONTRACT;
  }
}

function emit(envelope: Envelope, json: boolean): void {
  if (json) {
    log.plain(JSON.stringify(envelope));
    return;
  }
  for (const warning of envelope.warnings) log.warn(warning.message);
  for (const error of envelope.errors) log.error(error.message);
  for (const line of envelope.summary ?? []) log.info(line);
}

function printGlobalHelp(): void {
  const implemented = Object.values(COMMANDS).filter((c) => c.implemented);
  const pending = Object.values(COMMANDS).filter((c) => !c.implemented);
  const seen = new Set<Command>();
  const uniq = (list: Command[]): Command[] =>
    list.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));

  const lines: string[] = [
    "cvpw — code-based video production, normalized for agents",
    "",
    "USAGE",
    "  cvpw <command> [flags]",
    "",
    "IMPLEMENTED",
  ];
  for (const c of uniq(implemented)) lines.push(`  ${c.help.name.padEnd(11)} ${c.help.summary}`);
  lines.push("", "SPECIFIED, NOT YET IMPLEMENTED");
  for (const c of uniq(pending)) lines.push(`  ${c.help.name.padEnd(11)} ${c.help.summary}`);
  lines.push(
    "",
    "CONVENTIONS",
    "  --json           emit exactly one JSON envelope on stdout; logs go to stderr",
    "  exit codes       0 ok   1 check failed   2 bad usage   3 contract violation",
    "",
    "  A command that is specified but not implemented exits 3 and says so, rather than",
    "  pretending to run. `cvpw <command> --help` shows its full flag surface either way.",
    "",
    "Read first:  AGENTS.md   docs/SPEC.md   docs/WORKFLOW.md   docs/PROGRESS.md",
    "",
  );
  log.plain(lines.join("\n"));
}
