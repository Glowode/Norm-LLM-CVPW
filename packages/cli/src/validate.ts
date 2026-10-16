/**
 * Artifact validation against `schemas/`.
 *
 * `docs/SPEC.md` A4: unknown top-level keys are rejected. That single rule catches the whole class of
 * failure where a misspelled field silently falls back to a default — the thing every prior-art
 * project lost time to. It is implemented here by loading the real JSON Schema files rather than by
 * checking fields ad hoc, so the schema and the validator cannot drift.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

// The 2020-12 dialect build, not the default `ajv` entry point. Our schemas declare
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`, and plain Ajv only knows draft-07, so
// `compile()` fails with `no schema with key or ref` for every file. Importing the dialect that matches
// what the schemas actually say is the fix; rewriting the schemas to draft-07 to suit the default import
// would mean giving up 2020-12 keywords for no gain.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { readJson, schemasDir } from "./shared.js";

export interface ValidationIssue {
  /** JSON pointer to the offending node, e.g. `/output/fps`. */
  pointer: string;
  /** The schema keyword that failed: `additionalProperties`, `required`, `enum`, … */
  keyword: string;
  message: string;
  /** The offending value, when it is small enough to print. */
  value?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  /** The artifact path that was validated, project-relative where possible. */
  artifact: string;
  /** The schema key it was validated against, e.g. `project`. */
  schema?: string;
  issues: ValidationIssue[];
}

interface SchemaEntry {
  key: string;
  file: string;
  schema: Record<string, unknown> & { $id: string };
  validate: ValidateFunction;
}

export class SchemaRegistry {
  private byKey = new Map<string, SchemaEntry>();
  private byId = new Map<string, SchemaEntry>();

  static async load(dir: string = schemasDir()): Promise<SchemaRegistry> {
    const registry = new SchemaRegistry();
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      // `schemaVersion: 1` in every artifact is our own versioning axis, on top of JSON Schema.
      allowUnionTypes: true,
    });
    addFormats(ajv);

    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".schema.json"));
    } catch {
      // A missing schemas directory is a contract violation, not something to work around: without
      // it there is no way to tell a valid artifact from a plausible one.
      throw new Error(`no schemas directory at ${dir}; the framework checkout is incomplete`);
    }

    for (const file of files.sort()) {
      const key = file.replace(/\.schema\.json$/, "");
      const schema = (await readJson(join(dir, file))) as SchemaEntry["schema"];
      const entry: SchemaEntry = { key, file, schema, validate: ajv.compile(schema) };
      registry.byKey.set(key, entry);
      if (schema.$id) registry.byId.set(schema.$id, entry);
    }
    return registry;
  }

  keys(): string[] {
    return [...this.byKey.keys()].sort();
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): SchemaEntry | undefined {
    return this.byKey.get(key);
  }

  /**
   * Validate `value` against a named schema.
   *
   * The `$schema` field in the artifact is advisory; the caller names the schema it expects. That is
   * deliberate: a file claiming to be a timeline while being validated as a project is exactly the
   * kind of confusion this framework exists to remove.
   */
  validateArtifact(key: string, artifact: string, value: unknown): ValidationResult {
    const entry = this.byKey.get(key);
    if (!entry) {
      return {
        ok: false,
        artifact,
        issues: [
          {
            pointer: "",
            keyword: "schema",
            message: `no schema named ${JSON.stringify(key)}; available: ${this.keys().join(", ")}`,
          },
        ],
      };
    }
    const ok = entry.validate(value) as boolean;
    const issues = ok ? [] : (entry.validate.errors ?? []).map(toIssue);
    return { ok: Boolean(ok), artifact, schema: key, issues };
  }

  /** Validate an artifact that names its own `$schema`, resolving the path to a known schema key. */
  validateByDeclaration(artifact: string, value: unknown): ValidationResult {
    const declared = (value as { $schema?: unknown })?.$schema;
    if (typeof declared !== "string") {
      return {
        ok: false,
        artifact,
        issues: [{ pointer: "", keyword: "required", message: "missing $schema (docs/SPEC.md A2)" }],
      };
    }
    const key = schemaKeyFromDeclaration(declared);
    if (!key) {
      return {
        ok: false,
        artifact,
        issues: [
          {
            pointer: "/$schema",
            keyword: "enum",
            message: `$schema ${JSON.stringify(declared)} does not name a known schema; expected one of ${this.keys().join(", ")}`,
            value: declared,
          },
        ],
      };
    }
    return this.validateArtifact(key, artifact, value);
  }
}

/** `schemas/project.schema.json`, `https://…/project.schema.json` and `#/project` all map to `project`. */
export function schemaKeyFromDeclaration(declared: string): string | null {
  const cleaned = declared.replace(/\\/g, "/").split("/").pop() ?? declared;
  const m = /^([a-z0-9-]+)\.schema\.json$/i.exec(cleaned);
  return m ? (m[1] as string).toLowerCase() : null;
}

function toIssue(error: ErrorObject): ValidationIssue {
  const value = (error as ErrorObject & { data?: unknown }).data;
  const printable =
    value === undefined || (typeof value === "object" && value !== null)
      ? undefined
      : (value as string | number | boolean | null);
  let message = error.message ?? "invalid";
  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    message = `unknown key ${JSON.stringify(extra)} (docs/SPEC.md A4: unknown keys are rejected, not ignored)`;
  }
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    message = `missing required key ${JSON.stringify(missing)}`;
  }
  return {
    pointer: error.instancePath || "",
    keyword: error.keyword,
    message,
    ...(printable !== undefined ? { value: printable } : {}),
  };
}

/** Format an issue for a log line. */
export function formatIssue(issue: ValidationIssue): string {
  const where = issue.pointer === "" ? "(root)" : issue.pointer;
  const value = issue.value !== undefined ? ` — got ${JSON.stringify(issue.value)}` : "";
  return `${where}: ${issue.message}${value}`;
}
