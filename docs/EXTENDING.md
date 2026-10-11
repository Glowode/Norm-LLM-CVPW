# EXTENDING — the accumulation guide

**Status:** normative (authority level 4 — [SPEC](./SPEC.md) §1). Recipes are procedure; the rules they
cite belong to [SPEC](./SPEC.md) and [CONTRACTS](./CONTRACTS.md) and win over any wording here.

The framework grows by **registration**, never by surgery ([SPEC](./SPEC.md) §0). Every recipe has the same
shape: files to add, rules that bite immediately, **what else you MUST update**, **how to verify**. A
*project* problem wants a scene arg, a style value or a `project.json` knob — not this document.

## 1. Add a scene

**Justify a new scene by a new visual idea, never by a new parameter set.** If the shot differs from an
existing scene only in numbers, extend that scene's `argsSchema` instead (see *Extending instead* below):
two scenes whose `draw` bodies differ by constants are one scene with two args, and the second drifts when
the look changes ([WORKFLOW](./WORKFLOW.md) stage 5 escape hatch).

```js
// engine/scenes/prism.js
import { scene } from '../lib/registry.js';       // re-export of @cvpw/kernel/plugin
scene('prism', {
  argsSchema: { type: 'object', additionalProperties: false, required: [], properties: {
    hue:    { type: 'number',  minimum: 0, maximum: 1,  default: 0.55 },
    shards: { type: 'integer', minimum: 3, maximum: 48, default: 12 } } },
  preload: async (api) => { /* fonts/images, once per page */ },
  init:    (api, args) => { /* per-shot setup; no clock, no entropy */ },
  draw:    (ctx, args, t, api) => {
    const { x, y, w, h } = api.layout;                 // design space, never 1920/1080 (C7)
    const s = api.style();                             // palette, not hex literals (§2)
    const n = api.hash1(args.hue, api.frameIndex(t));  // seeded, per frame (D5)
  }
});
// engine/scenes/manifest.js — the only other file a new scene touches
export const scenes = ['./beat.js', './titles.js', './prism.js'];
```
```jsonc
// timeline.json — the shot that uses it
{ "id": "b03_prism", "scene": "prism", "at": "b(16,2)", "to": "S('bridge')", "block": "b03",
  "moment": "the chorus breaks into glass and reassembles on the downbeat", "args": { "hue": 0.62 } }
```
`draw` is pure in `t` (D1–D2); randomness comes from `api.hash1` seeded with `frameIndex(t)`; positions from
`api.layout`; on-screen text from `project.json::textWhitelist` (C6); cost inside
`project.json::budgets.msPerFrame`. **Extending instead**: add a property and a default to `argsSchema`, read
it in `draw`, verify with the same four commands — an argument added without a default breaks every timeline
that omits it, and a shot that must never use it means you want a scene.

**What else you MUST update**
- `engine/scenes/manifest.js` — without the line the scene is unregistered and `validate` fails ([CONTRACTS](./CONTRACTS.md) §8).
- the shot's `moment` and its `docs/STORYBOARD.md` row — a shot without one fails `storyboard` (C3).
- `docs/BRIEF.md` — if the scene carries a signature moment, the brief's moment list names it.
- `tests/fixtures/` — if a fixture timeline references the scene, add it there too.
- `review/` — a still you have actually opened (V3).

**How to verify**

```bash
cvpw validate                  # argsSchema covers the args used; an unknown arg key fails
cvpw lint                      # AST determinism, encoding, layout literals, text whitelist
cvpw check --scenes            # every scene/shot alone: pageerror, console.error, empty frames
cvpw stills --times 2.02,2.4,3.1 --shot b03_prism --overlay --out review/prism
# then OPEN review/prism/*.png. An empty frame at some t passes lint and fails check --scenes.
```
## 2. Add a style

A style is the unit of aesthetic accumulation: palette + defaults + post parameters, no geometry ([SPEC](./SPEC.md) §2).

```js
// engine/styles/night.js
import { style } from '../lib/registry.js';
style('night', {
  palette:  { bg: '#05070d', ink: '#e8eef7', accent: '#3d5afe' },
  defaults: { hue: 0.62, grain: 0.04, ease: 'outCubic' },   // merged under a shot's args
  post:     { vignette: 0.35, bloom: 0.12, lut: 'night' }   // per-style post chain
});
```
**Scenes read it** with `api.style()` (active) or `api.style('night')` (explicit); a scene MUST NOT
hard-code a palette value, and a style MUST NOT carry absolute pixel geometry — that is layout, and keeping
it out is what makes a vertical variant a layout change rather than a rewrite (C7). **The project selects
it** in `project.json`, never in scene code: `style` is the intended key, and until it is catalogued in
[CONTRACTS](./CONTRACTS.md) §2 and `schemas/project.schema.json` it MUST live under `extensions.style`,
because unknown top-level keys are rejected (A4). **A variant keeps its style** — a variant changes `output`
and the layout insets, never the look.

**What else you MUST update**
- `engine/styles/manifest.js`, and `docs/CONCEPT.md` — palette and typography are a style's authored half.
- [CONTRACTS](./CONTRACTS.md) §2 plus `schemas/project.schema.json` if `style` becomes a first-class key.
- the variant rows in `project.json`; a published look changed after a master ships is a new variant (D9).

**How to verify**: `cvpw stills --times 1.0,4.0 --out review/style-night` and `cvpw sheet --cues --out
review/style-night-cues.jpg`, then read both. Changing the active style moves every frame hash, so
`cvpw check --gold` MUST be re-baselined deliberately (`--update-gold`) with the reason in `docs/PROGRESS.md`.

## 3. Add a handoff / a seam

**Register the seam in `handoff.json` BEFORE either block is written** — a seam discovered after both sides
exist is a rewrite of both.

```jsonc
// handoff.json
{ "seams": [{ "id": "s02_beat|s03_outro", "t": "b(4,0)", "mode": "pixel",
  "lastFrameOf": "s02_beat", "firstFrameOf": "s03_outro",
  "contract": { "camera": { "drift": { "amp": 5, "speed": 0.35, "seed": 3 }, "zoom": 1.0, "rot": 0.0 },
                "env": "studio", "layers": ["bg", "fg"], "fx": { "shake": 0, "flash": 0, "grain": "engine" } },
  "measured": { "diffAB": null, "diffARef": null, "diffBRef": null, "checkedAt": null, "grade": "unchecked" } }] }
```
```js
// BOTH sides, in their own scene files
const seam = api.handoff('s02_beat|s03_outro');   // throws when unregistered — never default it
api.camera().apply(seam.contract.camera);
api.env(seam.contract.env);
```
Neither side may hard-code camera, environment, layer order or fx values (C4); `measured` is written
**only** by `cvpw handoff` ([CONTRACTS](./CONTRACTS.md) §9). Two rules:

1. **The later shot owns a transition.** `transition.overlap > 0` is drawn by the later shot; the earlier
   one ends at its own edge (C1). Overlap with no owner is a defect, not a style.
2. **A seam MUST NOT also be registered as a hard cut.** A planned hard cut and an invisible seam are
   mutually exclusive, and QA classifies jumps differently for each ([CONTRACTS](./CONTRACTS.md) §9).

**What else you MUST update**
- `docs/BLOCKS.md` entry and exit state for both blocks.
- `timeline.json`: the two shots are non-overlapping with no transition at the seam time.
- `docs/INTEGRATION_NOTES.md` if the contract changes once both sides exist — that change is the integrator's (S2).
- `qa/exemptions.json` only if the seam grades `ALIGN` and the operator exempts it with a date, reason, observed delta and owner (V6); widening the threshold in code is not an option (V5).

**How to verify**: `cvpw handoff --list "s02_beat|s03_outro"` writes A|REF|B strips and numeric grades, with
grain forced off ([CONTRACTS](./CONTRACTS.md) §9) — a project whose seam needs grain has mis-specified its
contract. Grades: `diff < 0.01` → `ok`; `< 0.03` → `minor`; else `ALIGN`, which MUST fail the gate. Then
**look at the strip**: the number says how close, the image says whether the join is invisible.

## 4. Add an artifact contract

```jsonc
// schemas/beatgrid.schema.json — JSON Schema 2020-12, $id-anchored, strict (A2–A4)
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://cvpw.dev/schemas/beatgrid.schema.json",
  "type": "object", "additionalProperties": false, "required": ["$schema", "schemaVersion", "fps"],
  "properties": { "$schema": { "type": "string" }, "schemaVersion": { "type": "integer", "const": 1 },
                  "fps": { "type": "integer" }, "extensions": { "type": "object" }, "notes": { "type": "string" } } }
```
1. **Schema** in `schemas/`, `$id`-anchored, `additionalProperties: false`, requiring `$schema` and an integer `schemaVersion` (A2–A3).
2. **Catalogue row** in [CONTRACTS](./CONTRACTS.md) §1: artifact, written by, read by, kind (`authored` / `derived` / `mixed`). An `authored` artifact MUST NOT be overwritten without an announced `--force`.
3. **Validator registration** in `packages/cli/src/cmd/validate.ts`: path pattern → schema, plus the A1 checks (UTF-8 without BOM, LF endings).
4. **A failure-mode entry** in [CONTRACTS](./CONTRACTS.md): what breaks, what it looks like, how to detect it. **An artifact added without a documented failure mode is incomplete** ([CONTRACTS](./CONTRACTS.md) §11) — every contract here exists because a specific failure was observed in practice.
5. **Fixtures** in `tests/fixtures/<name>/`: one valid file, plus one invalid file per rejection rule (unknown key, wrong type, wrong `schemaVersion`).
6. **Conformance test** in `tests/integration/<name>.conformance.test.ts`: the valid fixture passes and each invalid fixture fails **with the expected message**.

**Additive or breaking (A3).** An additive, backward-compatible change goes under `extensions` and MUST NOT
bump `schemaVersion`. A breaking change MUST bump it and MUST ship a migration in
`packages/cli/src/cmd/validate.ts` plus a note in [CONTRACTS](./CONTRACTS.md): either upgrade an old artifact
on read, or fail naming both versions — never silently reinterpret old data.

**What else you MUST update**: the writer and reader packages (referenced from
[ARCHITECTURE](./ARCHITECTURE.md) §10); the `--json` envelope of every command that emits it;
[QA](./QA.md) if it feeds a gate.

**How to verify**

```bash
pnpm vitest run tests/integration/<name>.conformance.test.ts
cvpw validate --all      # in a project carrying the artifact
```
## 5. Add a CLI command

```ts
// packages/cli/src/cmd/beatgrid.ts
export const name = 'beatgrid';
export const usage = 'cvpw beatgrid [--json]';
export async function run(argv: string[], io: Io): Promise<number> {
  io.log('beatgrid: reading analysis/audio.json');          // stderr
  const data = await build(argv);
  io.out(JSON.stringify({ ok: true, cmd: name, version: '1', data, warnings: [], errors: [] }));
  return 0;
}
```
**The `--json` envelope contract** (P1, V2): with `--json`, stdout carries **exactly one** JSON object —
`{ ok, cmd, version, data, warnings[], errors[] }` — and nothing else, ever. Logs, progress and human
summaries go to **stderr**. **Exit codes** (agents branch on the difference): `0` ok; `1` a check ran and
did not pass; `2` bad usage — unknown flag, missing argument, wrong combination; `3` contract violation — an
artifact violated its schema, or a required input is absent. **Registration** is a line in the command table
(`packages/cli/src/cmd/index.ts`), which feeds `cvpw --help`.

**What else you MUST update**: the stage section in [WORKFLOW](./WORKFLOW.md) if it belongs to a stage (a new
*stage* is appended, never inserted, and stage numbers are stable); the command tables in `README.md` and
`AGENTS.md`; `skills/cvpw/references/` if an agent must know when to run it; a test under `tests/`.

**How to verify**: `cvpw beatgrid --json 2>/dev/null` prints one parseable object on stdout and no log
lines; `cvpw beatgrid --nope; echo $?` prints `2`.

## 6. Add a QA check

```ts
// packages/cli/src/check/text.hold.ts
import { check } from '@cvpw/kernel/plugin';
check('text.hold', {
  threshold: 'qa:text.hold',                    // resolved from docs/QA.md — never an inline number
  run: async ({ project, timeline }) => {
    const offenders = [];                       // [{ shotId, time, observed }]
    return { ok: offenders.length === 0, observed: `${minHold.toFixed(2)} s`, offenders };
  }
});
```
- **Check id**: `area.metric`, lowercase, stable forever — it appears in `qa/report.json`, in `qa/exemptions.json` and in the delivery report, so renaming one invalidates every historical exemption.
- **Threshold source**: [QA](./QA.md) or `project.json::budgets`, **never invented in code** ([SPEC](./SPEC.md) V5). A project needing a different number changes `project.json` and says why.
- **Report row** ([CONTRACTS](./CONTRACTS.md) §10): `{ id, threshold, observed, ok, offenders[] }` inside the `--json` envelope (V2).
- **A failure names the offending times and ids** — `offenders: [{ shotId: "b05_drop", time: 61.2, observed: 0.18 }]`. An agent cannot fix a failure it cannot localise.
- **Registration**: `packages/cli/src/check/<id>.ts`, imported by `packages/cli/src/cmd/check.ts`, with the id added to the enum in `schemas/qa-report.schema.json`.

**What else you MUST update**: the [QA](./QA.md) row (threshold, what it protects, what to do when it fails); the delivery checklist if it gates delivery; a failing and a passing fixture.

**How to verify**: `cvpw check --json` carries the new row with `id`, `threshold`, `observed`, `ok` and
`offenders`; `cvpw check` exits 1 on the failing fixture and 0 on the passing one.

## 7. Add an analysis pass

```python
# python/src/cvpw_py/beatgrid.py
def settle(cues, onsets, *, tol_s: float = 0.06) -> dict:
    out = []          # deterministic: no wall clock, no entropy, no dict-order dependence
    return {"cues": out,
            "notes": "cvpw_py.beatgrid@1; nearest-onset settlement, tol 60 ms; "
                     "known error: moves any cue whose true attack is off-grid by up to tol_s"}
```
The pass is **deterministic** — no wall clock, no entropy, no iteration-order dependence, numbers rounded to
the precision the contract declares; it writes only its declared outputs; every artifact carries a `notes`
provenance string ([SPEC](./SPEC.md) A7); any tolerance comes from [QA](./QA.md), `project.json` or an explicit
CLI argument, never from a module default that silently becomes policy. Encoding is UTF-8 on every file handle,
`PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` when the CLI spawns it, temp paths ASCII-only (P4). The **CLI
entry** is a command (recipe [5](#5-add-a-cli-command)) reporting the artifact through the `--json` envelope.

**Principle: an analysis pass with no ground-truth fixture is untested.** A synthetic signal with a known
answer is the only way to tell a correct result from a plausible one:

```python
# python/tests/test_beatgrid.py
def test_settles_to_known_onsets():
    cues, onsets = [1.000, 2.000], synth_onsets([1.030, 1.980])   # ground truth: +30 ms, -20 ms
    out = settle(cues, onsets, tol_s=0.06)
    assert [round(c["t"], 3) for c in out["cues"]] == [1.030, 1.980]
```
**What else you MUST update**: [CONTRACTS](./CONTRACTS.md) for any new artifact it writes (recipe [4](#4-add-an-artifact-contract)); the stage section in [WORKFLOW](./WORKFLOW.md); `cvpw doctor` if it needs an optional dependency, with the cost of the gap (P7).

**How to verify**: `python -m pytest python/tests`; `PYTHONUTF8=1 cvpw analyze --json` reports the `notes`;
and run it twice into different output directories and diff the artifacts byte for byte.

## 8. Add a skill or a skill reference

```
skills/cvpw-qa/
  SKILL.md
  references/{gates.md,thresholds.md,failure-modes.md,delivery.md}
  scripts/{check.sh,sheet.sh}          # documented shims over cvpw
```
**Frontmatter carries ONLY `name` + `description`** (P2); everything else is a heading in the body.

```yaml
---
name: cvpw-qa
description: >-
  Run and interpret Norm-LLM-CVPW quality gates: frame counts, A/V sync, gold-hash determinism, flash
  safety, seam grades, delivery checks. Use when the user asks to check, QA, verify or troubleshoot a
  cvpw render or a failing gate ("cvpw check", "QA 检查", "渲染检查", "确定性检查", "チェック").
  Do NOT use for authoring scenes, writing lyrics or designing a storyboard — use cvpw or cvpw-timing.
---
```
The description MUST carry **English and CJK trigger phrases** and MUST name **explicit negative triggers**: a
skill that claims everything is chosen for nothing. **Progressive disclosure** — the body stays short and ends
in a references table carrying "read when" conditions:

| Reference | Read when |
|---|---|
| `references/gates.md` | you need the full check list and what each check protects |
| `references/thresholds.md` | a gate failed and you need to know where the number comes from |
| `references/failure-modes.md` | a gate failed and you need the observed cause, not the symptom |
| `references/delivery.md` | you are producing final files and the delivery report |

**Scripts MUST be documented shims over `cvpw`**: the same arguments as the CLI, `--print` prints the
command instead of running it, and nothing is implemented that `cvpw` cannot do. Skills MUST work with no
Node project present (P2), so a shim prints the command instead of crashing when `cvpw` is absent:

```bash
# skills/cvpw-qa/scripts/check.sh — Usage: check.sh [--print] [cvpw check args...]
cmd=(cvpw check "$@"); [[ "${1:-}" == "--print" ]] && { echo "${cmd[*]}"; exit 0; }
command -v cvpw >/dev/null || { echo "cvpw not on PATH; run: ${cmd[*]}" >&2; exit 2; }
exec "${cmd[@]}"
```
**What else you MUST update**: the skills table in `README.md` and `AGENTS.md`, and a script test if the shim does anything beyond passing arguments. Skill bodies stay English (P3).

**How to verify**: read `SKILL.md` as if you had no memory of this repo and follow it to the first command it
names — if you need a file it does not point at, the references table is wrong. Then run
`bash skills/cvpw-qa/scripts/check.sh --print` and confirm it prints a runnable command.

## 9. Add a project template

`templates/project/` is the scaffold: `project.json`,
`engine/{index.html,timeline.js,scenes/,lib/,styles/}`, `docs/`, `cues/`, `tools/`, `review/`, `render/`.

**What MUST be in it**: `project.json` validating against `schemas/project.schema.json` with a `timebase.mode`
and a populated `textWhitelist` (possibly empty, with a reason — C6); `timeline.json` covering exactly
`[0, duration)` with a `moment` on every shot (C2–C3); at least one registered scene and one style, each with
an `argsSchema` and a manifest line; no absolute paths (A5), UTF-8 without BOM, LF (A1), no lyric text (T7).

**The template MUST run end to end out of the box.** `cvpw new` → `cvpw validate` → `cvpw lint` →
`cvpw check --scenes` → `cvpw render --preview` MUST all succeed on the scaffold as committed, with no
network access (P8) and no input beyond what the template ships.

**The selftest obligation.** `cvpw selftest` scaffolds into a temporary directory, runs that sequence
against the result and asserts the frame count and a frame hash; it is wired into `pnpm test` under
`tests/e2e/` and MUST pass before a template change is merged. A template that has not been selftested is
broken in a way nobody notices until a new user hits it.

**What else you MUST update**: `examples/minimal/` if the first-run experience changes; the quickstart commands in `README.md` and `AGENTS.md`; `tests/e2e/`.

**How to verify**: `pnpm run selftest`, then scaffold by hand into an empty directory and follow `AGENTS.md`
§3 without deviating.

## 10. Graduating an experiment into the framework

One commit per step. Never skip a step, and never promote straight into the template.

1. **Experiment in a project** — the scene, style or tool lives in one project's `engine/` and touches nothing shared. If it needs a shared edit, it is not ready (S1–S2).
2. **Prove it with a fixture** — a minimal timeline under `tests/fixtures/` that exercises it and fails loudly when it regresses.
3. **Add the contract** — if it introduced a new artifact or key, recipe [4](#4-add-an-artifact-contract). Contracts come before promotion: a capability that is not a contract is a file no other project can use.
4. **Add the skill** — a reference telling an agent when to reach for it and what it refuses to do (recipe [8](#8-add-a-skill-or-a-skill-reference)).
5. **Reference it from `templates/project/`** — only now does it become the default, because a capability promoted into the template is inherited by every new project. If it is not good enough to be the default, it stays in `examples/minimal/`.

**Promotion MUST NOT move the frame hashes of existing projects silently.** If it does, that is a change to a
published effect and D9 applies: a new variant, not an in-place edit. The reverse direction is allowed and
encouraged — a capability that turns out to be project-specific is demoted out of the template, with the
reason in `docs/PROGRESS.md`.

**What else you MUST update**: `docs/PROGRESS.md` (what was promoted and why), the fixture and conformance
test the promotion added, and `README.md` if the advertised surface changed.

**How to verify**: `pnpm test` (fixture + conformance), `cvpw check --gold` on `examples/minimal/`, and a
fresh `cvpw new` plus `pnpm run selftest`.

## 11. Anti-patterns

| Anti-pattern | What it looks like | Do this instead |
|---|---|---|
| **Editing a shared file instead of registering** | a new `case` in the engine's scene switch, a colour appended to a shared palette module, an `if (project.id === …)` in `render.ts` | register: a file plus one manifest line (§1, §2). A shared edit needs the integrator and a recorded request (S2) |
| **A knob added to the engine instead of `project.json`** | a constant in `engine.ts` or a private CLI flag that exactly one project needs | project knobs live in `project.json` (or `extensions` until catalogued); something only one project wants is that project's scene arg |
| **A check with an invented threshold** | a number inside the check body because the documented one "felt wrong" | the threshold comes from [QA](./QA.md) or `project.json::budgets` (V5); change the budget and say why in `docs/PROGRESS.md` |
| **A docs-only feature** | a rule described in Markdown with no schema, no validator, no fixture and no command behind it | it does not exist, and that is worse than missing because an agent will rely on it. Ship schema + validator + fixture + command with the doc, or do not write the doc |
| **A style hard-coded into a scene** | hex values, easing curves and grain amounts written inside `draw` | read `api.style()`; a scene that cannot be restyled cannot be reused, and a variant becomes a rewrite (C7) |
| **A scene reading wall-clock time** | `Date.now()`, `performance.now()`, animation started at load, a module-level mutable cache | the frame is a function of `t` alone (D1–D2). `cvpw lint` catches it as `determinism.bannedApi`; a real simulation declares `stateful: true` with `reset()` + `step()` |
| **A per-project constant inside a shared tool** | one project's seam threshold or safe inset compiled into `@cvpw/render` | shared tools take the value from `project.json`, [QA](./QA.md) or an argument; a constant in a shared tool is silently every project's policy |

If a change teaches an eighth anti-pattern, add it here in the same pull request as the change.
