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

import { COMMON_FLAGS, getBool, parseArgs, renderHelp, type CommandHelp } from "./args.js";
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
  "new",
  "Scaffold a project from templates/project.",
  "cvpw new <dir> [--song <file>] [--lyrics <file>] [--template <name>] [--force]",
  "docs/WORKFLOW.md stage 0",
  [
    { name: "song", type: "value", value: "<file>", doc: "Audio to import. Never modified by a tool." },
    { name: "lyrics", type: "value", value: "<file>", doc: "LRC or plain text lyrics." },
    { name: "template", type: "value", value: "<name>", doc: "Template under templates/.", default: "project" },
    { name: "force", type: "boolean", doc: "Write into a non-empty directory. Announced when used." },
  ],
  ["templates/project/ does not exist yet, so there is nothing to copy. See docs/PROGRESS.md."],
);

stub(
  "validate",
  "JSON Schema validation of every artifact in a project.",
  "cvpw validate [--all] [--artifact <path>] [--json]",
  "docs/CONTRACTS.md §1 and schemas/",
  [
    { name: "all", type: "boolean", doc: "Validate every known artifact, not just the ones present." },
    { name: "artifact", type: "value", value: "<path>", doc: "Validate one file." },
  ],
  ["The schema registry and the AJV validator are implemented in src/validate.ts; only the command wiring is pending."],
);

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
stub("storyboard", "timeline.json plus docs/STORYBOARD.md, with every time expression resolved.", "cvpw storyboard [--json]", "docs/WORKFLOW.md stage 3");
stub("assets", "Validate assets/manifest.json. Generation is phase 2.", "cvpw assets [--reindex] [--json]", "docs/WORKFLOW.md stage 4");

stub(
  "stills",
  "Render stills at given times, optionally with the debug overlay.",
  "cvpw stills --times <a,b,c> [--only <block>] [--overlay] [--out <dir>] [--json]",
  "docs/WORKFLOW.md stage 6",
  [
    { name: "times", type: "value", value: "<a,b,c>", doc: "Times in seconds, or time expressions." },
    { name: "only", type: "value", value: "<block>", doc: "Restrict to one block's time range." },
    { name: "overlay", type: "boolean", doc: "Burn in time, frame and active shot ids." },
    { name: "out", type: "value", value: "<dir>", doc: "Output directory.", default: "review/stills" },
  ],
);

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
  "render",
  "Frames to MP4, with an ordered sink and a probed encoder.",
  "cvpw render [--name <n>] [--workers <n>] [--only <block>] [--preview] [--json]",
  "docs/ARCHITECTURE.md §7, ADR 0004, ADR 0006",
  [
    { name: "name", type: "value", value: "<n>", doc: "Output basename.", default: "master" },
    { name: "workers", type: "value", value: "<n>", doc: "Concurrent pages. Output MUST NOT depend on this.", default: 2 },
    { name: "only", type: "value", value: "<block>", doc: "Render one block's range." },
    { name: "preview", type: "boolean", doc: "Half resolution, fast encoder. Never delivered as a master." },
    { name: "allow-software", type: "boolean", doc: "Permit a software rasteriser. Off by default." },
  ],
  [
    "@cvpw/render is contract-only: the FrameSink and RenderRequest interfaces are written down,",
    "including the ordering invariant that makes --workers output-neutral; the worker loop is not.",
  ],
);

stub(
  "check",
  "The gate suite: twelve flags, twenty-four check ids.",
  "cvpw check [--contract|--determinism|--timeline|--scenes|--text|--lyrics|--frames|--av-sync|--handoff|--flash|--assets|--publish] [--profile all|render|deliver] [--only <block>] [--json]",
  "docs/QA.md §2, docs/WORKFLOW.md stage 7",
  [
    { name: "profile", type: "value", value: "all|render|deliver", doc: "How far the suite goes.", default: "all" },
    { name: "only", type: "value", value: "<block>", doc: "Restrict every gate to one block's range." },
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
