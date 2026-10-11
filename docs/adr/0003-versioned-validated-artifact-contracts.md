# ADR 0003 — Versioned, validated artifact contracts

## Status
Accepted, 2026-01.

## Context
Every stage boundary is a file: `analysis/audio.json`, `cues/cues.json`, `timeline.json`,
`handoff.json`, `render/report.json`, `qa/report.json`. Producer and consumer are often written in
different languages (TypeScript in the browser and CLI, Python in analysis) and at different times by
different agents. All six projects under `reference/` move data across those boundaries as
convention-only JSON: none ships a schema file and none depends on a validation library. The result is a
failure class every one of them hit — a renamed or misspelled field does not fail, it falls back to a
default, and the mistake surfaces as a wrong picture hours later. Type annotations cannot help, because
they do not exist at the moment another process reads the bytes.

## Decision
Every artifact MUST be a single JSON object carrying `$schema` and an integer `schemaVersion`
([SPEC](../SPEC.md) A2–A4, [CONTRACTS](../CONTRACTS.md) §1). Validation is a gate at every boundary
(`contract.validate`); unknown top-level keys MUST be rejected.

- Additive, backward-compatible changes MUST NOT bump `schemaVersion`; they go under `extensions`.
- Breaking changes MUST bump it and MUST ship a migration plus a note in `docs/CONTRACTS.md` (A3).
- Schemas live in `schemas/`, `$id`-anchored, `additionalProperties: false`; where a schema and
  [CONTRACTS](../CONTRACTS.md) disagree, the document wins and the schema is a bug.
- A stage consuming an invalid artifact MUST refuse to run ([WORKFLOW](../WORKFLOW.md)).
- Artifacts MUST NOT contain absolute host paths, usernames or machine-specific values (A5).

## Consequences
**Positive**
- A typo fails at the boundary that introduced it, with a JSON pointer, instead of becoming a default.
- Cross-language consumers agree by construction: the schema, not a type definition, is the contract.
- Breaking changes appear as a version bump plus a migration, not as a behaviour mystery.
- Validation runs before a render, so a malformed artifact costs seconds instead of a render pass.

**Negative**
- Every new field costs a schema edit and a fixture; the friction is deliberate.
- Strictness rejects harmless extra keys, so side notes must use `extensions` or a report field.
- Schema and [CONTRACTS](../CONTRACTS.md) describe one thing twice and can drift; the authority order
  resolves conflicts, but the drift is still work.

**Neutral, and needs monitoring**
- A `schemaVersion` bump without a migration fixture is the failure to watch for.
- `extensions` MUST NOT become an unvalidated dumping ground; a shared key belongs in the schema.
- A new artifact MUST arrive with its failure mode documented ([CONTRACTS](../CONTRACTS.md) §11).

## Alternatives considered
- **Convention-only JSON**, as in all six prior-art projects. Rejected: a renamed field breaks the
  consumer silently, and no reference project could detect the break before rendering.
- **Types as the source of truth, with no runtime check.** Rejected: TypeScript and Python types do not
  survive a file boundary written by another language, a human or a model; the bytes on disk are what the
  next stage reads, so the check must be on the bytes.
- **Permissive schemas** (extra keys ignored, unknown keys logged). Rejected: they cannot catch typos, and
  a typo falling back to a default was an observed failure in every reference project.

## References
- [SPEC](../SPEC.md) §3 (A1–A7), §1 (authority order), §10 (compliance); [CONTRACTS](../CONTRACTS.md)
  §1, §10, §11; [QA](../QA.md) §2 (`contract.validate`, `encoding.utf8`).
- Prior art: the six projects under [reference/](../../reference/) — convention-only JSON, no schema file
  and no validator dependency in any of them.
