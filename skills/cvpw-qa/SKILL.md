---
name: cvpw-qa
description: >-
  Verify a Norm-LLM-CVPW video with evidence: run the gate suite and read the numbers, review the images
  an agent must actually open, and deliver a master with an honest account of what was verified, what is
  uncertain and what was not done. Use it whenever the question is "is this right?" — running cvpw check,
  reading qa/report.json, a failing gate, a threshold question, gold-hash determinism, frame counts, A/V
  sync, seam grades, flash and photosensitivity, waivers and exemptions, stills and contact sheets, the
  review loop, render and mux, colour tags, variants, the delivery checklist, or a suspiciously small MP4.
  Triggers: "run the gates", "QA", "check the render", "verify", "determinism check", "is it safe",
  "review the stills", "deliver", "ship it", 检查, 质检, 验收, 门禁, 确定性, 渲染检查, 交付,
  チェック, 検証, 書き出し. Not for establishing the timebase, timing lyrics or curating cues — use
  cvpw-timing. Not for authoring scenes, styles or a storyboard — use cvpw. Not an aesthetic director:
  this skill measures, reviews and reports; it does not decide what the film is, and a green report is
  never a substitute for looking.
---

# cvpw-qa — gates, the review loop, delivery

This skill covers the evidence half of the pipeline: the gate suite, the loop that produces quality, and
the checklist that gets a file out the door without lying about it. The normative sources are
[`../../docs/QA.md`](../../docs/QA.md) (thresholds and the review protocol),
[`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stages 5–7 (procedure and the gate-flag mapping) and
[`../../docs/SPEC.md`](../../docs/SPEC.md) §7 (V1–V7).

## The one rule this whole skill exists for

> **Verification is evidence-based: a numeric gate result AND an agent that has looked at the images.
> Neither half is sufficient.** ([`../../docs/SPEC.md`](../../docs/SPEC.md) V1–V3)

A frame count proves the render finished; it does not prove the film is any good. An opinion about a still
proves nothing about the other 240 frames. The gates exist to make looking cheap, targeted and honest —
not to replace it. A gate that passes while nobody has seen the frames has verified nothing at all.

Corollary: **a stage is done when a gate produced a number, not when the code "should work".** "It should
be fine" is not a status. Run the check, read `--json`, quote the observed value.

## The three-layer determinism story

Determinism is the load-bearing invariant ([`../../docs/SPEC.md`](../../docs/SPEC.md) §4), and it is checked
three different ways because each layer catches what the others cannot:

| Layer | Mechanism | Catches | Cannot catch |
|---|---|---|---|
| **Static** | AST audit of the frame-drawing path (`cvpw lint`) → `determinism.bannedApi` | `Math.random`, `Date.now`, `performance.now`, timers — the *source* of nondeterminism, before anything runs | A seeded generator used inconsistently; a stateful scene; a driver difference |
| **Runtime** | Seeded generators in the kernel, `stateful` scenes with `reset()`/`step()`, `frameIndex(t)` | Per-frame flicker at joins, crawling noise, order-dependent sub-frames | A scene that is pure but wrong |
| **Empirical** | `cvpw check --gold` frame-hash comparison; `determinism.workerCount` (identical hashes for `--workers 1` and `--workers 3`) | Everything the first two missed: environment drift, GPU float rounding, a shared-file edit that restyled another block | *Why* it changed — a hash has no explanation |

**A gold hash is a witness, not a checksum.** It does not tell you the film is correct; it tells you the
film is *the same film you looked at before*. That is why updating gold is a reviewed decision with three
legitimate reasons and a written reason in each
([`../../docs/QA.md`](../../docs/QA.md) §5): a deliberate visual change; a determinism bug was fixed, so the
old gold encoded the bug; a recorded environment change whose drift is understood and measured. Updating
gold to make a red check go green — no image looked at, no reason written — is the same failure as deleting
a test.

## Gates: the flags and the check ids

`cvpw check` takes gate **flags**; each flag runs one or more **check ids**. The ids are the strings that
appear in `qa/report.json`, in `qa/exemptions.json` and in the delivery report
([`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stage 7, [`../../docs/QA.md`](../../docs/QA.md) §2).

| Flag | Check ids |
|---|---|
| `--contract` | `contract.validate`, `encoding.utf8`, `determinism.bannedApi`, `text.whitelist` |
| `--determinism` | `determinism.gold`, `determinism.workerCount` |
| `--timeline` | `timeline.coverage`, `timeline.moment`, `timeline.absoluteTimes`, `timeline.pacing` |
| `--scenes` | `scene.errors`, `scene.emptyFrames`, `scene.perf` |
| `--text` | `text.safeArea`, `text.legibility` |
| `--lyrics` | `lyrics.alignment` |
| `--frames` | `render.frameCount`, `render.noDeadFrames` |
| `--av-sync` | `av.sync` |
| `--handoff` | `handoff.pixel` |
| `--flash` | `flash.rate` |
| `--assets` | `assets.manifest` |
| `--publish` | `publish.lyricText`, `deliver.credit` |

```bash
cvpw check --profile all --json               # the default; no rendered master needed
cvpw check --profile render --json            # adds --frames, --av-sync, --handoff, --flash
cvpw check --profile deliver --json           # everything, including --assets and --publish
cvpw check --only b05 --json                  # every gate, restricted to one block's time range
cvpw check --gate <checkId> --json            # force one named gate
cvpw lint --json                              # the four static ids, fast
```

**Flags versus ids, in one sentence:** `--flash` is a flag, `flash.rate` is a check id, and
`qa/exemptions.json::check` names the **id**. Also note `--only <block>` restricts every gate to one
block's range — that is how a block author gets a fast, honest signal without rendering the film.

**Thresholds never come from a flag.** They come from [`../../docs/QA.md`](../../docs/QA.md) and
`project.json::budgets`. A number that appears only inside `packages/` is a bug
([`../../docs/SPEC.md`](../../docs/SPEC.md) V5). A check id that does not exist is an error, not a silent
skip.

Full per-gate detail — what each id measures, its default, how to run it alone, what failure looks like,
what to do — is in [`./references/01-gates.md`](./references/01-gates.md).

## Two forbidden moves

**MUST NOT retry a failing gate.** If a check fails intermittently, the intermittency *is* the defect:
unseeded randomness, a wall-clock read, carried state, or an environment difference. Re-running until the
failure hides produces a green report with no information in it, which is worse than a red one. Record what
was observed, then find the cause. `determinism.workerCount` and `determinism.gold` exist to make the
randomness visible instead of merely intermittent ([`../../docs/QA.md`](../../docs/QA.md) §6).

**MUST NOT widen a threshold in code.** Change `project.json::budgets` or `docs/QA.md` and say why in
`docs/PROGRESS.md`. Changing a threshold without a reason is indistinguishable from hiding a defect.

## Waivers and exemptions

A **waiver** is a check that failed and was accepted anyway. It is a dated, justified, owned decision that
appears in the delivery report — not a mute button ([`../../docs/SPEC.md`](../../docs/SPEC.md) V6).

```jsonc
// qa/exemptions.json — all seven fields are required; a missing one fails validation
{ "$schema": "schemas/exemptions.schema.json", "schemaVersion": 1,
  "exemptions": [
    { "check": "handoff.pixel", "target": "s07|s08", "date": "2026-01-20",
      "reason": "GPU float rounding differs by 1/255 on 12 pixels of the sky gradient",
      "observed": "0.031", "owner": "integrator", "expires": null } ] }
```

- Every waiver MUST have `date`, `reason`, `observed` and `owner`; a reason that restates the check id
  fails validation.
- Every waiver MUST appear in `qa/report.json::waived` and in the delivery summary, verbatim — including
  the checks whose QA row says "waiver allowed? **no**". Those MUST NOT be waived; the remedy is to fix the
  thing or change the project (a declared inset, a whitelist entry, a licence statement).
- A waiver whose `expires` date has passed MUST be re-confirmed or removed. A stale waiver is a silent
  tolerance wearing a date.
- **Prefer a documented exemption to a silent tolerance.** A date, a reason and an owner cost one line and
  preserve the meaning of every other green check.

## The gate that cannot run

A gate whose input does not exist yet MUST be reported as **`skipped`, with the reason** — never as a pass
([`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stage 7). A report full of passes where three gates were
skipped is not a green report; it is a report about three gates. See
[`./references/01-gates.md`](./references/01-gates.md) §"gates that cannot run yet".

## Recipe: the shortest honest verification of a change

```bash
cvpw validate --all                                  # never build on an invalid artifact
cvpw lint --json                                     # static ids; must agree with cvpw check
cvpw check --only <block> --json                     # the block you changed
cvpw stills --times <first-frame-after-each-cut, main event, last-frame-before-each-end> --overlay
#   open the PNGs; write down what you saw
cvpw check --gold --json                             # untouched ranges still hash the same
```

Then, and only then, say what changed. A review with no populated `review/report.json` has not happened.

## References — read the one the moment needs

| file | read when |
|---|---|
| [`references/01-gates.md`](./references/01-gates.md) | You are running a gate, a check id failed, you need the default threshold and where it comes from, or you are deciding whether to waive. |
| [`references/02-review-loop.md`](./references/02-review-loop.md) | You are producing stills, sheets or a review pass, or you need to turn "it looks a bit off" into a defect note someone can act on. |
| [`references/03-delivery.md`](./references/03-delivery.md) | You are rendering a master, probing an encoder, muxing audio, making a variant, or writing the delivery report. |

Framework-level and normative: [`../../docs/QA.md`](../../docs/QA.md) (the gate table and the review
protocol), [`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stages 5–7,
[`../../docs/SPEC.md`](../../docs/SPEC.md) §4 and §7,
[`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §10 (report shapes). Your platform may ship these
alongside the skill; if not, they are in the framework repository the skill came from. If a link here 404s,
say so rather than guessing at the threshold it would have contained.
