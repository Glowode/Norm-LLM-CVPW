/**
 * The static half of the determinism guarantee (`docs/SPEC.md` D2, D4).
 *
 * Why an AST and not a regular expression: the prior-art projects scanned for
 * `Math.random(` / `Date.now(` textually, and a one-line alias defeats that entirely —
 * `const r = Math.random; r()` contains no `Math.random(` call, and `globalThis["Date"]["now"]()`
 * contains no `Date.now(`. Both are the same bug. Walking the syntax tree also lets us tell a
 * *read* of a value from a *use* of a banned clock, which is the difference between a false failure
 * on every file and a rule people trust.
 *
 * The rules are deliberately narrow. A linter that fires on legitimate code gets switched off, and
 * a switched-off linter is worse than no linter because it creates the impression of safety.
 */

import { parse, type Node } from "acorn";
import * as walk from "acorn-walk";

/**
 * acorn-walk's generic visitors are not parameterised, so handlers are typed loosely here and
 * narrowed inside each case. Kept local rather than pulling in `@types/acorn-walk`: the audit cares
 * about a handful of node shapes, and the `AnyNode` accessors below make those shapes explicit.
 */
type Visitor = Record<string, (...args: never[]) => void>;
type AncestorVisitor = Record<string, (...args: never[]) => void>;

export type Severity = "error" | "warning";

export type RuleId =
  | "determinism.bannedApi"
  | "determinism.bannedGlobal"
  | "determinism.unseededRandom"
  | "encoding.replacementChar"
  | "encoding.bom"
  | "encoding.crlf"
  | "encoding.problemChar"
  | "time.absoluteLiteral"
  | "layout.rawDimension"
  | "state.moduleMutable"
  | "import.forbiddenSubpackage"
  | "syntax.parseError";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** Project-relative, forward-slashed. */
  file: string;
  line: number;
  column: number;
  message: string;
  /** The offending source text, truncated. Useful in a report and in an agent's next action. */
  snippet: string;
  /** What to do instead. Every finding must be actionable, or it is noise. */
  hint: string;
}

export interface AuditOptions {
  /** Project root, used only to make reported paths relative. */
  root?: string;
  /**
   * `strict` treats `time.absoluteLiteral` and `layout.rawDimension` as errors. The default is
   * warnings, because a stub project legitimately has neither a timebase nor a layout yet.
   */
  strict?: boolean;
  /** Extra glob-free path substrings to skip, e.g. a vendored library inside the project. */
  ignore?: readonly string[];
}

interface Rule {
  id: RuleId;
  severity: Severity;
  /** Human description, shown by `cvpw lint --rules`. */
  doc: string;
}

export const RULES: Record<RuleId, Rule> = {
  "determinism.bannedApi": {
    id: "determinism.bannedApi",
    severity: "error",
    doc: "No wall-clock, entropy, or timer API in the frame-drawing path (SPEC D2).",
  },
  "determinism.bannedGlobal": {
    id: "determinism.bannedGlobal",
    severity: "error",
    doc: "No reference to a wall-clock or entropy host object, even without a call.",
  },
  "determinism.unseededRandom": {
    id: "determinism.unseededRandom",
    severity: "error",
    doc: "Randomness must come from @cvpw/kernel's seeded generators (SPEC D2).",
  },
  "encoding.replacementChar": {
    id: "encoding.replacementChar",
    severity: "error",
    doc: "U+FFFD means text was already destroyed by a mis-decode; fix the bytes, do not retype.",
  },
  "encoding.bom": {
    id: "encoding.bom",
    severity: "error",
    doc: "UTF-8 without BOM, on every platform (SPEC A1).",
  },
  "encoding.crlf": {
    id: "encoding.crlf",
    severity: "error",
    doc: "LF line endings only (SPEC A1).",
  },
  "encoding.problemChar": {
    id: "encoding.problemChar",
    severity: "warning",
    doc: "A character outside the expected repertoire for this file's language.",
  },
  "time.absoluteLiteral": {
    id: "time.absoluteLiteral",
    severity: "warning",
    doc: "A bare numeric time in authored code; use a time expression (SPEC T2).",
  },
  "layout.rawDimension": {
    id: "layout.rawDimension",
    severity: "warning",
    doc: "A raw design-space dimension; use engine/lib/layout helpers (SPEC C7).",
  },
  "state.moduleMutable": {
    id: "state.moduleMutable",
    severity: "warning",
    doc: "Module-level mutable state is a frame-to-frame dependency in disguise (SPEC D3).",
  },
  "import.forbiddenSubpackage": {
    id: "import.forbiddenSubpackage",
    severity: "error",
    doc: "The kernel may not import render/runtime/audit/cli (ARCHITECTURE dependency rule).",
  },
  "syntax.parseError": {
    id: "syntax.parseError",
    severity: "error",
    doc: "The file must parse.",
  },
};

// --- API-reference tables ------------------------------------------------------------------------

/** `Object.method` pairs that must never appear in the frame-drawing path. */
const BANNED_MEMBER_CALLS: readonly (readonly [string, string, string])[] = [
  ["Math", "random", "use rng()/hash1() from @cvpw/kernel so the value is reproducible"],
  ["Date", "now", "use the frame time `f.t` or `f.frame`"],
  ["Date", "UTC", "constructing a Date is a wall-clock read; use the frame time"],
  ["Date", "parse", "constructing a Date is a wall-clock read; use the frame time"],
  ["performance", "now", "use `f.t`; the frame time is the only time that exists in a draw"],
  ["performance", "mark", "timing belongs in tools, not in the frame-drawing path"],
  ["crypto", "getRandomValues", "use rng()/hash1() from @cvpw/kernel"],
  ["crypto", "randomUUID", "use hash32() over an explicit key"],
];

/**
 * Globals that must never be referenced in the frame-drawing path.
 *
 * A global that also appears in {@link BANNED_MEMBER_CALLS} (such as `Date` or `performance`) is NOT
 * listed here: the MemberExpression handler already covers both its direct calls and its aliases, and
 * listing it twice would report one problem as two findings.
 */
const BANNED_GLOBALS: readonly (readonly [string, string])[] = [
  ["requestAnimationFrame", "the engine drives frames; a scene must not schedule one"],
  ["cancelAnimationFrame", "the engine drives frames"],
  ["setTimeout", "no timers in a draw; motion is a function of `t`"],
  ["setInterval", "no timers in a draw; motion is a function of `t`"],
  ["setImmediate", "no deferred work in a draw"],
  ["queueMicrotask", "no deferred work in a draw"],
];

/** Design-space literals that should come from the layout instead (`docs/SPEC.md` C7). */
const DESIGN_DIMENSIONS: readonly number[] = [1920, 1080, 3840, 2160, 720, 1280, 2560, 1440];

/**
 * Host objects whose *bare reference* is itself the bug.
 *
 * Deliberately narrower than {@link BANNED_MEMBER_CALLS}: a member expression is handled by the
 * MemberExpression rule, which reports both the call and the alias. Only objects with no legitimate
 * use at all belong here. `crypto` is excluded because it is a plausible *name* for a project's own
 * value, and a false positive here would make the whole rule set untrustworthy.
 */
const BANNED_BARE_GLOBALS: readonly string[] = ["Date", "performance"];

/** Packages the kernel must not import (ARCHITECTURE dependency rule). */
const FORBIDDEN_IMPORTS: readonly string[] = ["@cvpw/render", "@cvpw/runtime", "@cvpw/audit", "@cvpw/cli"];

export interface AuditFileInput {
  /** Project-relative, forward-slashed path. */
  file: string;
  /** The decoded source text. */
  text: string;
  /** The raw bytes, when encoding rules should also run. */
  bytes?: Uint8Array;
  /** Which rule set applies. Scenes/timeline are audited; tools and the player are not. */
  kind: "scene" | "timeline" | "engine-lib" | "tool" | "other";
}

/** Audit one file. Pure: no I/O, so it is trivially testable and cannot be slow. */
export function auditFile(input: AuditFileInput, options: AuditOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const strict = options.strict === true;
  const { file, text, bytes } = input;

  if (options.ignore?.some((needle) => file.includes(needle))) return findings;

  findings.push(...checkEncoding(file, text, bytes));

  const audited = input.kind === "scene" || input.kind === "timeline" || input.kind === "engine-lib";
  if (!audited) return findings;

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(text, {
      ecmaVersion: 2023,
      sourceType: "module",
      locations: true,
      // Allow top-level `return` in a scratch file; everything else must be real syntax.
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    const e = err as { loc?: { line: number; column: number }; message: string };
    findings.push({
      rule: "syntax.parseError",
      severity: "error",
      file,
      line: e.loc?.line ?? 1,
      column: (e.loc?.column ?? 0) + 1,
      message: e.message,
      snippet: "",
      hint: "fix the syntax; nothing else in this file can be checked until it parses",
    });
    return findings;
  }

  const locate = (node: unknown): { line: number; column: number } => {
    const n = node as { loc?: { start: { line: number; column: number } } };
    return { line: n.loc?.start.line ?? 1, column: (n.loc?.start.column ?? 0) + 1 };
  };

  const lineText = (line: number): string => (text.split("\n")[line - 1] ?? "").trim().slice(0, 160);

  const add = (
    rule: RuleId,
    node: unknown,
    message: string,
    hint: string,
    severityOverride?: Severity,
  ): void => {
    const { line, column } = locate(node);
    findings.push({
      rule,
      severity: severityOverride ?? RULES[rule].severity,
      file,
      line,
      column,
      message,
      snippet: lineText(line),
      hint,
    });
  };

  // --- banned member calls: `Math.random()`, `Date.now()`, `globalThis.Math.random()` -----------
  const bannedByObject = new Map(BANNED_MEMBER_CALLS.map(([obj, member, hint]) => [`${obj}.${member}`, hint]));
  const bannedObjects = new Set(BANNED_MEMBER_CALLS.map(([obj]) => obj));
  const bannedMemberNames = new Set(BANNED_MEMBER_CALLS.map(([, member]) => member));

  // Aliasing detection: `const r = Math.random` — the reference is what matters, not the call.
  const bannedAliasNames = new Set<string>();

  type AnyNode = {
    type: string;
    loc?: { start: { line: number; column: number } };
    [key: string]: unknown;
  };

  const memberName = (node: unknown): string | undefined => {
    const n = node as AnyNode | undefined;
    if (!n || n.type !== "MemberExpression" || n.computed === true) return undefined;
    const prop = n.property as AnyNode | undefined;
    return prop && prop.type === "Identifier" ? (prop.name as string) : undefined;
  };

  const objectIsBannedGlobal = (node: unknown): string | undefined => {
    const n = node as AnyNode | undefined;
    if (!n) return undefined;
    if (n.type === "Identifier" && bannedObjects.has(n.name as string)) return n.name as string;
    // `globalThis.Math`, `window.performance`, `self.Date`
    if (n.type === "MemberExpression" && n.computed !== true) {
      const obj = n.object as AnyNode | undefined;
      const prop = n.property as AnyNode | undefined;
      if (
        obj?.type === "Identifier" &&
        ["globalThis", "window", "self", "global"].includes(obj.name as string) &&
        prop?.type === "Identifier" &&
        bannedObjects.has(prop.name as string)
      ) {
        return prop.name as string;
      }
    }
    return undefined;
  };

  walk.ancestor(ast as unknown as Node, {
    MemberExpression(node: unknown, _state: unknown, ancestors: unknown[]) {
      const n = node as AnyNode;
      const prop = memberName(node);
      if (!prop) return;
      const globalName = objectIsBannedGlobal(n.object);
      if (!globalName) return;
      const key = `${globalName}.${prop}`;
      const hint = bannedByObject.get(key);
      if (!hint) return;

      // A direct call is reported as a call; anything else (an alias, a stored reference, a read) is
      // a reference. Separating them keeps one bug from producing two findings, and keeps the
      // alias case visible — which is precisely what a textual scan cannot see.
      const parent = ancestors[ancestors.length - 2] as AnyNode | undefined;
      const isDirectCallee =
        parent?.type === "CallExpression" && (parent.callee as AnyNode | undefined) === (n as AnyNode);

      if (isDirectCallee) {
        add("determinism.bannedApi", node, `${key}() is not allowed in the frame-drawing path`, hint);
      } else {
        add(
          "determinism.bannedGlobal",
          node,
          `${key} is referenced here`,
          `${hint}; aliasing or reading a clock/entropy source defeats a textual scan, which is why this rule walks the syntax tree`,
        );
      }
    },
    Identifier(node: unknown, _state: unknown, ancestors: unknown[]) {
      const n = node as AnyNode;
      const name = n.name as string;
      // Skip a member-expression property position: `${x}.Date` is not a use of the global.
      const parent = ancestors[ancestors.length - 2] as AnyNode | undefined;
      if (parent?.type === "MemberExpression" && parent.property === node && parent.computed !== true) return;
      // A bare reference to a banned host object (`const clock = Date;`) is an alias, not a call.
      if (BANNED_BARE_GLOBALS.includes(name)) {
        add(
          "determinism.bannedGlobal",
          node,
          `${name} is referenced here`,
          "reading a clock or entropy host object is the same bug as calling it; use `f.t` for time and rng()/hash1() for randomness",
        );
        return;
      }
      const entry = BANNED_GLOBALS.find(([g]) => g === name);
      if (!entry) return;
      add("determinism.bannedGlobal", node, `${name} is not allowed in the frame-drawing path`, entry[1]);
    },
    VariableDeclarator(node: unknown) {
      const n = node as AnyNode;
      const init = n.init as AnyNode | undefined;
      const id = n.id as AnyNode | undefined;
      if (!init || !id || id.type !== "Identifier") return;
      if (init.type !== "MemberExpression") return;
      const prop = memberName(init);
      const globalName = objectIsBannedGlobal(init.object);
      if (prop && globalName && bannedByObject.has(`${globalName}.${prop}`)) {
        bannedAliasNames.add(id.name as string);
      }
    },
    ImportDeclaration(node: unknown) {
      const n = node as AnyNode;
      const source = n.source as AnyNode | undefined;
      if (!source || typeof source.value !== "string") return;
      const value = source.value as string;
      if (FORBIDDEN_IMPORTS.some((f) => value === f || value.startsWith(`${f}/`))) {
        add(
          "import.forbiddenSubpackage",
          node,
          `${value} must not be imported from here`,
          "the kernel is browser-only and dependency-free; see docs/ARCHITECTURE.md for the layer rule",
        );
      }
    },
    Literal(node: unknown) {
      const n = node as AnyNode;
      const value = n.value;
      if (typeof value === "number" && DESIGN_DIMENSIONS.includes(value)) {
        add(
          "layout.rawDimension",
          node,
          `${value} looks like a design-space dimension`,
          "use the layout helpers (layout.width, layout.type(48), layout.fromUnit(...)) so a vertical variant is a layout change, not a rewrite",
          strict ? "error" : "warning",
        );
      }
    },
  } as unknown as AncestorVisitor);

  // A call through an alias is reported at the call site, where the author can act on it.
  walk.simple(ast as unknown as Node, {
    CallExpression(node: unknown) {
      const n = node as AnyNode;
      const callee = n.callee as AnyNode | undefined;
      if (callee?.type !== "Identifier") return;
      const name = callee.name as string;
      if (!bannedAliasNames.has(name)) return;
      add(
        "determinism.bannedApi",
        node,
        `${name}() is an alias of a banned clock/entropy source`,
        "remove the alias; use `f.t` for time and rng()/hash1() for randomness",
      );
    },
  } as unknown as Visitor);

  // --- absolute-time literals -------------------------------------------------------------------
  // Only inside `draw()` bodies, and only when assigned to something that reads like a time.
  // A blanket rule would fire on every radius and count in a scene, which is how linters get
  // switched off.
// `dur` and `duration` are deliberately absent. A duration is a *length*, not a moment, and the grammar
  // expresses moments with `at`/`to` — so a timeline's `duration: 8` is the one number in the file that
  // cannot be a time expression, because "the whole film" has no bar or cue to name. Flagging it produced a
  // warning on every correctly-written project, which is how a lint teaches people to ignore it.
  const timeish = /(^|[^A-Za-z0-9_])(at|time|start|end|t0|t1|offset|when|hit|cut|beat|bar)$/i;
  walk.simple(ast as unknown as Node, {
    Property(node: unknown) {
      const n = node as AnyNode;
      const key = n.key as AnyNode | undefined;
      const value = n.value as AnyNode | undefined;
      if (!key || !value) return;
      const name = key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String(key.value) : "";
      if (!name || !timeish.test(name)) return;
      if (value.type !== "Literal" || typeof value.value !== "number") return;
      add(
        "time.absoluteLiteral",
        node,
        `\`${name}: ${value.value}\` is a bare numeric time`,
        'use a time expression: "b(bar,beat)", "cue(\'id\')", "L(n)", "VOX(\'word\')" — or quote it as "12.5s" to make the choice explicit',
        strict ? "error" : "warning",
      );
    },
  } as unknown as Visitor);

  // --- module-level mutable state ---------------------------------------------------------------
  // A `let`/`var` at module scope that is assigned inside a function is frame-to-frame state in
  // disguise. `const` is fine: a frozen lookup table is the intended way to share data.
  const program = ast as unknown as AnyNode;
  const body = program.body as AnyNode[] | undefined;
  if (body) {
    for (const node of body) {
      if (node.type !== "VariableDeclaration") continue;
      if (node.kind === "const") continue;
      const decls = (node.declarations as AnyNode[] | undefined) ?? [];
      const names = decls
        .map((d) => (d.id as AnyNode | undefined)?.name)
        .filter((x): x is string => typeof x === "string");
      if (!names.length) continue;
      // Only report when some function actually writes to it.
      let written = false;
      walk.simple(ast as unknown as Node, {
        AssignmentExpression(n: unknown) {
          const a = n as AnyNode;
          const left = a.left as AnyNode | undefined;
          if (left?.type === "Identifier" && names.includes(left.name as string)) written = true;
        },
        UpdateExpression(n: unknown) {
          const a = n as AnyNode;
          const arg = a.argument as AnyNode | undefined;
          if (arg?.type === "Identifier" && names.includes(arg.name as string)) written = true;
        },
      } as unknown as Visitor);
      if (written) {
        add(
          "state.moduleMutable",
          node,
          `module-level \`${node.kind} ${names.join(", ")}\` is written from a function`,
          "state that survives a frame makes a frame depend on render order (SPEC D3); declare the shot `stateful: true` and use reset()/step(), or make the value a `const` lookup table",
        );
      }
    }
  }

  return findings;
}

/** Byte-level integrity checks. These run on every file, whatever its kind. */
function checkEncoding(file: string, text: string, bytes?: Uint8Array): Finding[] {
  const out: Finding[] = [];
  const push = (
    rule: RuleId,
    line: number,
    column: number,
    message: string,
    hint: string,
    severity: Severity = RULES[rule].severity,
  ): void => {
    out.push({ rule, severity, file, line, column, message, snippet: "", hint });
  };

  if (bytes && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    push("encoding.bom", 1, 1, "file starts with a UTF-8 BOM", "strip the BOM; SPEC A1 requires UTF-8 without BOM");
  }

  let crlfAt = -1;
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) {
      crlfAt = i;
      break;
    }
  }
  if (crlfAt >= 0) {
    const before = text.slice(0, crlfAt);
    const line = before.split("\n").length;
    push("encoding.crlf", line, 1, "file contains CRLF line endings", "save as LF; .gitattributes enforces it in this repo");
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const idx = line.indexOf("\uFFFD");
    if (idx >= 0) {
      push(
        "encoding.replacementChar",
        i + 1,
        idx + 1,
        "U+FFFD (the replacement character) is present, so this text was already destroyed by a mis-decode",
        "recover the original bytes (re-checkout or re-export with the correct encoding); retyping by hand will silently change the text",
      );
    }
  }

  // A cheap heuristic for private-use and unassigned blocks, which almost always mean a wrong
  // codepage was applied (this is what CP936 mojibake produces when it *does* decode as UTF-8).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    for (let c = 0; c < line.length; c++) {
      const code = line.codePointAt(c);
      if (code === undefined) continue;
      if ((code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0x10fffd)) {
        push(
          "encoding.problemChar",
          i + 1,
          c + 1,
          `private-use character U+${code.toString(16).toUpperCase()} (a classic wrong-codepage artefact)`,
          "check the file's declared encoding and the source it was exported from",
          "warning",
        );
      }
      if (code > 0xffff) c++; // surrogate pair
    }
  }

  return out;
}

/** Audit a whole project. I/O lives here, not in {@link auditFile}. */
export async function auditProject(
  files: readonly string[],
  readFile: (path: string) => Promise<Uint8Array>,
  options: AuditOptions & { kinds?: (path: string) => AuditFileInput["kind"] } = {},
): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const kind = options.kinds?.(file) ?? classify(file);
    all.push(...auditFile({ file, text, bytes, kind }, options));
  }
  return all;
}

/**
 * Decide which rule set applies, from the path.
 *
 * The distinction matters: a tool legitimately uses `Date` for timing, and the player legitimately
 * uses `requestAnimationFrame`. Auditing them as if they were scenes would produce a wall of false
 * errors, and a linter people stop reading is worse than none.
 */
export function classify(path: string): AuditFileInput["kind"] {
  const p = path.replace(/\\/g, "/");
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "other";
  if (/(^|\/)tools\//.test(p)) return "tool";
  if (/(^|\/)engine\/(core|lib)\//.test(p)) return "engine-lib";
  if (/(^|\/)engine\/scenes\//.test(p)) return "scene";
  if (/(^|\/)engine\/timeline\.(js|ts|mjs)$/.test(p)) return "timeline";
  if (/(^|\/)engine\/styles\//.test(p)) return "other";
  if (/(^|\/)(player|preview|ui)\//.test(p)) return "other";
  return "other";
}

export interface AuditSummary {
  files: number;
  errors: number;
  warnings: number;
  byRule: Record<string, number>;
  findings: Finding[];
}

export function summarise(findings: readonly Finding[], files: number): AuditSummary {
  const byRule: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    if (f.severity === "error") errors++;
    else warnings++;
  }
  return { files, errors, warnings, byRule, findings: [...findings] };
}
