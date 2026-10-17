/**
 * `cvpw lint` — the fast static audit.
 *
 * `cvpw check` proves a film is *right*; `lint` proves it has not committed the mistakes that make a film
 * irreproducible before a single frame is drawn. It is the cheap half of the same argument, and it runs in
 * milliseconds because it never opens a browser.
 *
 * The rule set is `@cvpw/audit`'s, and it is the rule set `docs/SPEC.md` D1–D3 and `docs/QA.md` name. Every
 * finding carries a file, a line and a rule id, because "the lint is failing" is not actionable and
 * "engine/scenes/grid.js:41 uses Date.now()" is.
 *
 * **`lint` and `check` MUST agree on the static rules they share** (`docs/QA.md`). That is why this command
 * does not re-implement any rule: it runs the same `auditFile` the check suite runs, so the two cannot drift.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { auditFile, classify, summarise, RULES, type Finding, type RuleId, type Severity } from "@cvpw/audit";

import { ContractError, projectPaths, readJson, relPath, walkFiles, type Envelope } from "../shared.js";

export interface LintOptions {
  root: string;
  /** Report only these rules. */
  only?: readonly string[];
  /** Downgrade everything to warnings, so a first pass on an old project is informative rather than fatal. */
  warnOnly?: boolean;
  /** Directories to scan, relative to the project root. */
  include?: readonly string[];
}

export interface LintResult {
  root: string;
  findings: Finding[];
  files: number;
  errors: number;
  warnings: number;
  /** Rules that exist but produced nothing, so a reader can see the coverage rather than trust it. */
  applied: string[];
}

/**
 * Where a project's code lives.
 *
 * Deliberately narrow. Linting `analysis/` or `audio/` would report on files the framework did not write and
 * cannot fix, and a lint that cries about things nobody can act on is a lint people stop reading.
 */
const DEFAULT_INCLUDE = ["engine", "tools"];

export async function lintProject(options: LintOptions): Promise<LintResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) {
    throw new ContractError(
      `no project.json in ${options.root}; run this inside a project, or pass --project <dir>`,
    );
  }

  const dirs = options.include ?? DEFAULT_INCLUDE;
  const findings: Finding[] = [];
  const rulesSeen = new Set<string>();
  let files = 0;

  for (const dir of dirs) {
    const absolute = join(options.root, dir);
    const relative = await walkFiles(absolute, { extensions: [".js", ".mjs", ".ts", ".json", ".css", ".html"] }).catch(
      () => [],
    );
    for (const rel of relative) {
      const full = join(absolute, rel);
      const source = await readFile(full, "utf8");
      files++;
      const bytes = await readFile(full);
      const found = auditFile({ file: normalize(join(dir, rel)), kind: classify(full), text: source, bytes });
      for (const finding of found) {
        rulesSeen.add(finding.rule);
        if (options.only?.length && !options.only.includes(finding.rule)) continue;
        findings.push(finding);
      }
    }
  }

  const filtered = options.warnOnly
    ? findings.map((finding) => ({ ...finding, severity: "warning" as Severity }))
    : findings;

  // Errors first, then by file, then by line: a reader fixes the top of the list and works down.
  filtered.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return {
    root: options.root,
    findings: filtered,
    files,
    errors: filtered.filter((finding) => finding.severity === "error").length,
    warnings: filtered.filter((finding) => finding.severity === "warning").length,
    applied: [...rulesSeen].sort(),
  };
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Every rule the audit knows, with its severity. Used by `cvpw lint --list-rules` and the help text. */
export function ruleCatalogue(): Array<{ id: string; severity: Severity; description: string }> {
  return (Object.keys(RULES) as RuleId[]).map((id) => ({
    id,
    severity: RULES[id].severity,
    description: RULES[id].doc,
  }));
}

export function lintEnvelope(result: LintResult, root: string): Envelope {
  const byRule = new Map<string, number>();
  for (const finding of result.findings) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);

  const summary: string[] = [
    `  ${result.files} file(s) scanned in ${DEFAULT_INCLUDE.join(", ")}`,
    `  ${result.errors} error(s), ${result.warnings} warning(s)`,
  ];
  if (result.findings.length === 0) {
    summary.push("  no findings");
  } else {
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      summary.push(`    ${rule}: ${count}`);
    }
    summary.push("");
    for (const finding of result.findings.slice(0, 20)) {
      summary.push(`  ${finding.severity === "error" ? "error" : "warn "}  ${finding.file}:${finding.line}  ${finding.rule}`);
      summary.push(`         ${finding.message}`);
    }
    if (result.findings.length > 20) summary.push(`  … and ${result.findings.length - 20} more`);
  }

  return {
    ok: result.errors === 0,
    command: "lint",
    schemaVersion: 1,
    project: root,
    result: {
      files: result.files,
      errors: result.errors,
      warnings: result.warnings,
      findings: result.findings,
      applied: result.applied,
    },
    warnings: result.findings
      .filter((finding) => finding.severity === "warning")
      .map((finding) => ({ code: finding.rule, message: `${finding.file}:${finding.line} ${finding.message}` })),
    errors: result.findings
      .filter((finding) => finding.severity === "error")
      .map((finding) => ({ code: finding.rule, message: `${finding.file}:${finding.line} ${finding.message}` })),
    summary,
  };
}

export { relPath, summarise, readJson };
