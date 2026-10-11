/**
 * A tiny argument parser with real help output.
 *
 * Deliberately hand-rolled rather than pulled from npm: the CLI must work on a fresh checkout with no
 * dependency resolution, and an agent asking `cvpw <cmd> --help` must get a useful answer even when
 * the build is stale. It also gives us one place to enforce the shared conventions — `--json` on
 * every command, `--project` to name a root, and a consistent error for an unknown flag.
 */

import { UsageError } from "./shared.js";

export interface FlagSpec {
  /** Canonical name, without the leading dashes. */
  name: string;
  /** Single-character alias, without the leading dash. */
  short?: string;
  /** `boolean` never consumes a value; `value` requires one; `optional` consumes one if present. */
  type: "boolean" | "value" | "optional";
  doc: string;
  /** Shown in help when the value is not obvious. */
  value?: string;
  /** Repeatable; collected into an array. */
  repeat?: boolean;
  /** A default, shown in help. */
  default?: string | number | boolean;
}

/**
 * A flag's value. A number appears only from a `default`, never from parsing: the command line is text,
 * so `--workers 2` stores the string `"2"`. `getNumber` converts, and is the only place that should.
 */
export type FlagValue = string | number | boolean | string[];

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, FlagValue>;
  /** `--help` or `-h` was present. */
  help: boolean;
  /** `true` when `--json` was present, which every command honours. */
  json: boolean;
}

function normaliseName(raw: string): string {
  // Accept --some-flag and treat it as `some-flag`; also accept --someFlag via the short map only.
  return raw.replace(/^--?/, "");
}

export function parseArgs(
  argv: readonly string[],
  specs: readonly FlagSpec[],
  commandName: string,
): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  const flags = new Map<string, FlagValue>();
  for (const spec of specs) {
    // A numeric default (e.g. `workers: 2`) stays a number in the map; `getNumber` and `getString`
    // both accept it, so a caller is never surprised by "2" versus 2.
    if (spec.default !== undefined) flags.set(spec.name, spec.default);
  }

  const positionals: string[] = [];
  let help = false;
  let i = 0;

  const setFlag = (spec: FlagSpec, value: string | boolean): void => {
    if (spec.repeat) {
      const existing = flags.get(spec.name);
      const list = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
      list.push(String(value));
      flags.set(spec.name, list);
      return;
    }
    flags.set(spec.name, value);
  };
  while (i < argv.length) {
    const token = argv[i] as string;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      i++;
      continue;
    }

    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
      const spec = byName.get(rawName);
      if (!spec) {
        throw new UsageError(
          `${commandName}: unknown flag --${rawName}`,
          `known flags: ${[...byName.keys()].map((n) => `--${n}`).join(", ")}`,
        );
      }
      if (spec.type === "boolean") {
        setFlag(spec, inlineValue === undefined ? true : inlineValue !== "false");
        i++;
        continue;
      }
      if (inlineValue !== undefined) {
        setFlag(spec, inlineValue);
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
        if (spec.type === "value") {
          throw new UsageError(`${commandName}: --${rawName} requires a value`);
        }
        setFlag(spec, true);
        i++;
        continue;
      }
      setFlag(spec, next);
      i += 2;
      continue;
    }

    if (token.startsWith("-") && token.length === 2) {
      const short = token.slice(1);
      const spec = byShort.get(short);
      if (!spec) {
        throw new UsageError(
          `${commandName}: unknown flag -${short}`,
          `known short flags: ${[...byShort.keys()].map((n) => `-${n}`).join(", ") || "(none)"}`,
        );
      }
      if (spec.type === "boolean") {
        setFlag(spec, true);
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && !/^-\d/.test(next))) {
        if (spec.type === "value") throw new UsageError(`${commandName}: -${short} requires a value`);
        setFlag(spec, true);
        i++;
        continue;
      }
      setFlag(spec, next);
      i += 2;
      continue;
    }

    positionals.push(normaliseName(token));
    i++;
  }

  return { command: commandName, positionals, flags, help, json: flags.get("json") === true };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[v.length - 1];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

export function getNumber(args: ParsedArgs, name: string): number | undefined {
  const v = getString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got ${JSON.stringify(v)}`);
  return n;
}

export function getBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

/** `true` when the flag was supplied at all, whatever its value. Useful for `--only`-style options. */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function getList(args: ParsedArgs, name: string): string[] {
  const v = args.flags.get(name);
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

// --- help rendering -------------------------------------------------------------------------------

export interface CommandHelp {
  name: string;
  summary: string;
  usage: string;
  /** Grouped flags, so help stays readable as the surface grows. */
  groups: Array<{ title: string; flags: readonly FlagSpec[] }>;
  examples?: readonly string[];
  notes?: readonly string[];
}

/** The flags every command accepts. Listed once so no command forgets them. */
export const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", doc: "Emit exactly one JSON envelope on stdout. The only stable interface." },
  {
    name: "project",
    type: "value",
    value: "<dir>",
    doc: "Project root. Defaults to walking up from the working directory for a project.json.",
  },
  { name: "help", short: "h", type: "boolean", doc: "Show this help." },
];

export function renderHelp(help: CommandHelp): string {
  const lines: string[] = [`${help.name} — ${help.summary}`, "", "USAGE", `  ${help.usage}`, ""];
  for (const group of help.groups) {
    if (!group.flags.length) continue;
    lines.push(group.title.toUpperCase());
    const width = Math.max(
      ...group.flags.map((f) => {
        const short = f.short ? `-${f.short}, ` : "    ";
        const value = f.type === "boolean" ? "" : ` ${f.value ?? "<value>"}`;
        return short.length + f.name.length + value.length + 2;
      }),
    );
    for (const f of group.flags) {
      const short = f.short ? `-${f.short}, ` : "    ";
      const value = f.type === "boolean" ? "" : ` ${f.value ?? "<value>"}`;
      const left = `${short}--${f.name}${value}`;
      const pad = " ".repeat(Math.max(1, width - left.length));
      const suffix = f.default !== undefined ? ` (default: ${String(f.default)})` : "";
      lines.push(`  ${left}${pad}${f.doc}${suffix}`);
    }
    lines.push("");
  }
  if (help.examples?.length) {
    lines.push("EXAMPLES");
    for (const e of help.examples) lines.push(`  ${e}`);
    lines.push("");
  }
  if (help.notes?.length) {
    lines.push("NOTES");
    for (const n of help.notes) lines.push(`  ${n}`);
    lines.push("");
  }
  lines.push(
    "EXIT CODES",
    "  0  ok                  1  a check failed",
    "  2  bad usage           3  contract violation",
    "",
  );
  return lines.join("\n");
}
