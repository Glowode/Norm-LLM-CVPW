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
          {
            name: "write-report",
            type: "boolean",
            doc: "Also write qa/report.json, the artifact `cvpw deliver` reads. Never truncates an existing one on failure.",
          },
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
    if (getBool(args, "write-report")) {
      const { qaReportDocument } = await import("./commands/check.js");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(root, "qa"), { recursive: true });
      await writeFile(
        join(root, "qa", "report.json"),
        `${JSON.stringify(qaReportDocument(report), null, 2)}
`,
        "utf8",
      );
      log.info(`  wrote qa/report.json (${report.outcomes.length} check(s))`);
    }
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

// --- lint ----------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "lint",
    summary: "The fast static audit: banned APIs, encoding, absolute times, layout literals.",
    usage: "cvpw lint [--only <rules>] [--warn-only] [--rules] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "only", type: "value", value: "<rules>", doc: "Comma-separated rule ids.", repeat: true },
          { name: "warn-only", type: "boolean", doc: "Report everything as a warning, for a first pass on an old project." },
          { name: "rules", type: "boolean", doc: "List the rule catalogue and exit." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw lint", "cvpw lint --rules", "cvpw lint --warn-only"],
    notes: [
      "Shares its rule set with `cvpw check` by calling the same audit, so the two cannot disagree.",
      "Scans engine/ and tools/ only: a finding in a file the framework did not write and cannot fix is",
      "noise, and a lint people stop reading protects nothing.",
    ],
  },
  async run(args, root) {
    const { lintProject, lintEnvelope, ruleCatalogue } = await import("./commands/lint.js");
    if (getBool(args, "rules")) {
      const catalogue = ruleCatalogue();
      if (!args.json) {
        log.info("");
        for (const rule of catalogue) log.info(`  ${rule.severity === "error" ? "error" : "warn "}  ${rule.id}`);
        log.info("");
        for (const rule of catalogue) log.info(`    ${rule.description}`);
        log.info("");
      }
      return {
        ok: true,
        command: "lint",
        schemaVersion: 1,
        result: { rules: catalogue },
        warnings: [],
        errors: [],
        summary: catalogue.map((rule) => `${rule.severity} ${rule.id}`),
      };
    }
    if (!root) throw new ContractError("no project.json found above the working directory");
    const only = getList(args, "only").flatMap((entry) => entry.split(",")).map((s) => s.trim()).filter(Boolean);
    const result = await lintProject({
      root,
      ...(only.length ? { only } : {}),
      warnOnly: getBool(args, "warn-only"),
    });
    const envelope = lintEnvelope(result, root);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- analyze -------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "analyze",
    summary: "Audio to a measured timebase: beats, bars, sections, cues, and an overview plot.",
    usage: "cvpw analyze [--audio <file>] [--fps <n>] [--bpm <n>] [--first-beat <s>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "audio", type: "value", value: "<file>", doc: "Override project.json::audio.file." },
          { name: "fps", type: "value", value: "<n>", doc: "Output frame rate for the feature envelope." },
          { name: "bpm", type: "value", value: "<n>", doc: "Force a tempo, to correct an octave error." },
          { name: "first-beat", type: "value", value: "<s>", doc: "Force the grid's phase." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw analyze", "cvpw analyze --bpm 119.7 --first-beat 0.02"],
    notes: [
      "The analysis is required, not a convenience: without beats[] and bars[], every b() and h() cannot",
      "resolve and the film collapses to hand-timed numbers.",
      "It NEVER rewrites the source audio (SPEC P6). It reads the file and writes only into analysis/.",
      "An octave error in the tempo is obvious on analysis/overview.png and invisible in the JSON.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { analyze, analyzeEnvelope } = await import("./commands/analyze.js");
    const audio = typeof args.flags.get("audio") === "string" ? String(args.flags.get("audio")) : undefined;
    log.info("");
    const result = await analyze({
      root,
      ...(audio ? { audio } : {}),
      ...(getString(args, "fps") !== undefined ? { fps: getNumber(args, "fps") } : {}),
      ...(getString(args, "bpm") !== undefined ? { bpm: getNumber(args, "bpm") } : {}),
      ...(getString(args, "first-beat") !== undefined ? { firstBeat: getNumber(args, "first-beat") } : {}),
      ...(args.json ? {} : { onProgress: (line: string) => log.info(line) }),
    });
    const envelope = analyzeEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- skill ---------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "skill",
    summary: "Install the agent skill bundles into a platform.",
    usage: "cvpw skill install --target <claude|dsh|generic> [--dest <dir>] [--only <names>] [--force] [--json]",
    groups: [
      {
        title: "subcommands",
        flags: [{ name: "install", type: "boolean", doc: "Copy the bundles. The only subcommand today." }],
      },
      {
        title: "flags",
        flags: [
          { name: "target", type: "value", value: "<claude|dsh|generic>", doc: "Platform layout. Required." },
          { name: "dest", type: "value", value: "<dir>", doc: "Destination for --target generic." },
          { name: "only", type: "value", value: "<names>", doc: "Install only these bundles.", repeat: true },
          { name: "force", type: "boolean", doc: "Replace an existing installation." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: [
      "cvpw skill install --target claude",
      "cvpw skill install --target generic --dest ./skills",
    ],
    notes: [
      "Copies rather than symlinks: a link into the framework makes the skill depend on a checkout the",
      "platform may not be able to read, which is the opposite of portable.",
      "Refuses to overwrite an existing bundle without --force, because replacing silently would discard a",
      "local edit somebody made.",
    ],
  },
  async run(args) {
    const sub = args.positionals[0];
    if (sub !== "install") {
      throw new UsageError(
        sub ? `unknown skill subcommand: ${sub}` : "cvpw skill needs a subcommand",
        "the only subcommand is `install`",
      );
    }
    const target = args.flags.get("target");
    if (typeof target !== "string") throw new UsageError("cvpw skill install needs --target", "claude | dsh | generic");
    if (!["claude", "dsh", "generic"].includes(target)) {
      throw new UsageError(`unknown --target ${target}`, "claude | dsh | generic");
    }
    const dest = typeof args.flags.get("dest") === "string" ? String(args.flags.get("dest")) : undefined;
    const only = getList(args, "only").flatMap((entry) => entry.split(",")).map((s) => s.trim()).filter(Boolean);

    const { installSkills } = await import("./commands/skill.js");
    const result = await installSkills({
      target: target as "claude" | "dsh" | "generic",
      ...(dest ? { dest } : {}),
      ...(only.length ? { only } : {}),
      force: getBool(args, "force"),
    });

    const summary = [
      `installed ${result.installed.length} skill bundle(s) into ${result.root}`,
      ...result.installed.map((skill) => `  ${skill.name}  (${skill.files} file(s))`),
      "",
      "read in this order:",
      ...result.readingOrder.map((line) => `  ${line}`),
    ];
    if (!args.json) {
      log.info("");
      for (const line of summary) log.info(line);
      log.info("");
    }
    return {
      ok: true,
      command: "skill",
      schemaVersion: 1,
      artifactsWritten: result.installed.map((skill) => skill.to),
      result,
      warnings: [],
      errors: [],
      summary,
    };
  },
});

// --- cues ----------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "cues",
    summary: "Settle cue guesses onto measured onsets. Never overwrites a manual cue.",
    usage: "cvpw cues [--tolerance <s>] [--dry-run] [--force] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "tolerance", type: "value", value: "<s>", doc: "How close an event must be, in seconds.", default: "0.04" },
          { name: "dry-run", type: "boolean", doc: "Report what would move, write nothing." },
          { name: "force", type: "boolean", doc: "Also move `manual` cues. Announced, because it destroys a human decision." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw cues --dry-run", "cvpw cues", "cvpw cues --tolerance 0.08"],
    notes: [
      "A `manual` cue is refused, not skipped quietly: a human who placed a cut by ear has information the",
      "analysis does not, and a tool that corrects it is destroying the only authoritative cue in the file.",
      "A cue with no measured evidence nearby stays `initial`, because relabelling a guess as measured makes",
      "the `cues.settled` gate stop asking.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { settleCues, cuesEnvelope } = await import("./commands/cues.js");
    const dryRun = getBool(args, "dry-run");
    const result = await settleCues({
      root,
      ...(getString(args, "tolerance") !== undefined ? { toleranceSec: getNumber(args, "tolerance") } : {}),
      force: getBool(args, "force"),
      dryRun,
    });
    const envelope = cuesEnvelope(result, dryRun);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- lyrics --------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "lyrics",
    summary: "LRC or plain text to lyric timing — and text, only if it is licensed.",
    usage: "cvpw lyrics [--input <file>] [--force] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "input", type: "value", value: "<file>", doc: "LRC or plain text. Defaults to the single file in lyrics/." },
          { name: "force", type: "boolean", doc: "Replace existing lyric timing." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw lyrics", "cvpw lyrics --input lyrics/song.lrc", "cvpw lyrics --force"],
    notes: [
      "Timing is always written; TEXT only when project.json::lyricsLicence is set (SPEC T7). Timing is a",
      "fact about the recording; the words are somebody's property.",
      "Plain text has no timestamps, so lines are spread across DETECTED vocal activity and marked",
      "`estimated`. With no detected vocal the command refuses rather than inventing an even spread.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { buildLyrics, lyricsEnvelope } = await import("./commands/lyrics.js");
    const input = typeof args.flags.get("input") === "string" ? String(args.flags.get("input")) : undefined;
    const result = await buildLyrics({ root, ...(input ? { input } : {}), force: getBool(args, "force") });
    const envelope = lyricsEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- sheet ---------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "sheet",
    summary: "Build a numbered contact sheet from review/stills.",
    usage: "cvpw sheet [--from <dir>] [--out <file>] [--columns <n>] [--cell-width <px>] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "from", type: "value", value: "<dir>", doc: "Stills directory.", default: "review/stills" },
          { name: "out", type: "value", value: "<file>", doc: "Output PNG.", default: "review/sheet.png" },
          { name: "columns", type: "value", value: "<n>", doc: "Cells across.", default: "4" },
          { name: "cell-width", type: "value", value: "<px>", doc: "Cell width in pixels.", default: "480" },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw sheet", "cvpw sheet --columns 5 --cell-width 384"],
    notes: [
      "Made from stills, not instead of them: run `cvpw stills` first.",
      "Writes review/sheet.json numbering every cell with its time and shot ids, because a contact sheet",
      "without an index shows you that something is wrong and refuses to tell you where.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { buildSheet, sheetEnvelope } = await import("./commands/sheet.js");
    const from = typeof args.flags.get("from") === "string" ? String(args.flags.get("from")) : undefined;
    const out = typeof args.flags.get("out") === "string" ? String(args.flags.get("out")) : undefined;
    const result = await buildSheet({
      root,
      ...(from ? { from } : {}),
      ...(out ? { out } : {}),
      ...(getString(args, "columns") !== undefined ? { columns: getNumber(args, "columns") } : {}),
      ...(getString(args, "cell-width") !== undefined ? { cellWidth: getNumber(args, "cell-width") } : {}),
    });
    const envelope = sheetEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- review --------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "review",
    summary: "Record that somebody looked, what they saw, and whether it is signed off.",
    usage: "cvpw review [--finding <still|issue|action|verdict>] [--looked <file>] [--note <text>] [--accept] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          {
            name: "finding",
            type: "value",
            value: "<still|issue|action|verdict>",
            doc: "One finding as four pipe-separated fields; verdict is ok, fix or hold.",
            repeat: true,
          },
          { name: "looked", type: "value", value: "<file>", doc: "A still that was actually opened.", repeat: true },
          { name: "note", type: "value", value: "<text>", doc: "Free text about the pass." },
          { name: "accept", type: "boolean", doc: "Sign off. Only takes effect when the verdict is ok." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: [
      "cvpw review --looked t0_500.png --looked t4_500.png --accept",
      "cvpw review --finding \"t2_000.png|grid reads as a mesh, not a grid|raised density 7->9|fix\"",
    ],
    notes: [
      "`--looked` is the point: a review whose manifest does not say what was seen is indistinguishable",
      "from one that never happened (SPEC V1-V3).",
      "`accepted` is not `ok`. A film can be fine and not yet signed off, and conflating them is how an",
      "unapproved cut gets published.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { recordReview, reviewEnvelope } = await import("./commands/review.js");
    const findings = getList(args, "finding").map((raw) => {
      const [still, issue, action, verdict] = raw.split("|").map((part) => part.trim());
      if (!still || !issue || !action || !verdict) {
        throw new UsageError(
          `malformed --finding: ${raw}`,
          "four pipe-separated fields: <still>|<issue>|<action>|<ok|fix|hold>",
        );
      }
      if (!["ok", "fix", "hold"].includes(verdict)) {
        throw new UsageError(`unknown verdict "${verdict}" in --finding`, "ok | fix | hold");
      }
      return { still, issue, action, verdict: verdict as "ok" | "fix" | "hold" };
    });
    const looked = getList(args, "looked");
    const note = typeof args.flags.get("note") === "string" ? String(args.flags.get("note")) : undefined;
    const result = await recordReview({
      root,
      findings,
      looked,
      ...(note ? { note } : {}),
      accept: getBool(args, "accept"),
    });
    const envelope = reviewEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- handoff -------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "handoff",
    summary: "Measure the pixel seams declared in handoff.json.",
    usage: "cvpw handoff [--only <ids>] [--json]",
    groups: [{ title: "flags", flags: [{ name: "only", type: "value", value: "<ids>", doc: "Seam ids.", repeat: true }, ...COMMON_FLAGS] }],
    examples: ["cvpw handoff", "cvpw handoff --only s02-s03"],
    notes: [
      "`handoff.json` is AUTHORED, never written here: which shots meet and which class each seam is are",
      "editorial decisions, and a tool that inferred them would be wrong exactly where nobody checked.",
      "Grain is off for the measurement, because with it on you measure the noise generator.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { measureHandoffs, handoffEnvelope } = await import("./commands/handoff.js");
    const only = getList(args, "only").flatMap((entry) => entry.split(",")).map((s) => s.trim()).filter(Boolean);
    const result = await measureHandoffs({ root, ...(only.length ? { only } : {}) });
    const envelope = handoffEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- deliver -------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "deliver",
    summary: "The last gate: master, report, accepted review, licences, variants.",
    usage: "cvpw deliver [--variants <names>] [--force] [--json]",
    groups: [
      {
        title: "flags",
        flags: [
          { name: "variants", type: "value", value: "<names>", doc: "Variant names to include.", repeat: true },
          { name: "force", type: "boolean", doc: "Write delivery.json even when blocked, for diagnosis." },
          ...COMMON_FLAGS,
        ],
      },
    ],
    examples: ["cvpw deliver", "cvpw deliver --variants vertical"],
    notes: [
      "A blocker is a stop, not a warning. Each one has shipped a bad film somewhere.",
      "A truncated MP4 passes an existence check and plays for thirty seconds, so the frame count in the",
      "file is compared against the count the sink wrote.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { deliver, deliverEnvelope } = await import("./commands/deliver.js");
    const variants = getList(args, "variants").flatMap((entry) => entry.split(",")).map((s) => s.trim()).filter(Boolean);
    const result = await deliver({ root, ...(variants.length ? { variants } : {}), force: getBool(args, "force") });
    const envelope = deliverEnvelope(result);
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
  },
});

// --- assets --------------------------------------------------------------------------------------

register({
  implemented: true,
  help: {
    name: "assets",
    summary: "Validate assets/manifest.json: present, hash-matched, licensed, sourced.",
    usage: "cvpw assets [--json]",
    groups: [{ title: "flags", flags: [...COMMON_FLAGS] }],
    examples: ["cvpw assets", "cvpw assets --json"],
    notes: [
      "Asset GENERATION is phase 2 and is not here. This is the gate.",
      "A project with no assets is valid: the reference template is entirely procedural, so a missing",
      "manifest reports 'nothing to validate' rather than failing.",
      "A licence is required because an unlicensed asset has to be replaced at delivery; a source because",
      "without one the asset cannot be regenerated and next month's render differs for no recorded reason.",
    ],
  },
  async run(args, root) {
    if (!root) throw new ContractError("no project.json found above the working directory");
    const { validateAssets, assetsEnvelope } = await import("./commands/assets.js");
    const envelope = assetsEnvelope(await validateAssets(root));
    if (!args.json) {
      log.info("");
      for (const line of envelope.summary ?? []) log.info(line);
      log.info("");
    }
    return envelope;
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
