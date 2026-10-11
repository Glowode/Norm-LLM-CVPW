# 02 — principles, and how to catch yourself breaking them

The rules in [`docs/SPEC.md`](../../../docs/SPEC.md) and [`docs/CONTRACTS.md`](../../../docs/CONTRACTS.md)
are the *what*; this file is the *why*, and the *how to notice* that you are violating one mid-task. Every
principle below exists because a specific failure was observed in a real project — none are style preferences.
Read the section governing your decision, then answer its audit question honestly.

---

## 1. A frame is a pure function of time

**What it is.** `draw(ctx, args, t, api)` computes everything from `t`, `args` and immutable inputs (config,
assets, timebase). No wall clock, no entropy, no animation started at load, no mutable module state carried
between frames (D1–D3).

**Why.** Everything downstream is a *consequence* of this property: parallel rendering by frame index, frame
skipping, pixel-level seam comparison, motion-blur sub-sampling, resumable renders, local edits. Break purity
and you lose the ability to render frame 4,000 without frames 0–3,999, and every distributed-render
guarantee with it. The observed failure is a render that differed between workers, which nobody could
reproduce, because the picture depended on when the worker started.

**In your own work this looks like:** you wrote `performance.now()` "just for the shimmer", or cached a value
in a module-level `let` on first draw. Audit question: *if I render frame 100 first and frame 99 second, is
the output byte-identical?* `cvpw check --determinism` exists to answer it for you.

## 2. Time is an expression, not a number

**What it is.** A time in authored code is a **string** resolved against the timebase — `"b(32,0)"`,
`"cue('chorus')"`, `"L(12)"`, `"VOX('sudden')"`, `"S('bridge')"`, `"p(0.85)"`. Bare seconds are
permitted only as `"12.5"`/`"12.5s"` and MUST raise a warning (T2–T3).

**Why.** A literal second is a claim about the music that nothing can check. It prevents the re-analysis
death spiral: the grid gets fixed and 200 hand-typed timestamps are now all slightly wrong, with no way to
tell which. An expression *re-resolves* against the new grid. Strict resolution — throw rather than fall
back — makes "the beat grid is law" a machine property rather than a slogan: no shot can silently sit 40 ms
off the beat.

**In your own work this looks like:** you typed `"4.02"` because it looked right next to `cue('chorus')`.
Audit question: *could I re-run `cvpw analyze` on a re-mastered file and have this shot still land
correctly?* If it would drift, it should have been an expression.

## 3. Strict beats permissive

**What it is.** Unknown keys are errors. Unresolvable times throw. Odd dimensions fail. Off-whitelist text
fails. A missing `moment` fails. A frame-count mismatch fails. Everywhere, the strict reading wins.

**Why.** Permissiveness has one benefit — the first run works — and one cost: the failure is deferred to a
moment when it is expensive and unattributable. The observed failure is the misspelled key: `huee` fell back
to the default and rendered a plausible frame in the wrong colour, found weeks later in a review pass with no
signal pointing at the typo. Strictness converts a deferred, silent, expensive failure into an immediate,
loud, cheap one.

**In your own work this looks like:** you are about to write `?? default`, `|| fallback`, or `try { … } catch
{ /* ignore */ }` around a resolution or a validation. Audit question: *if this value is wrong, what will
tell me?* If the answer is "nothing", you are building the deferred failure.

## 4. The beat grid is law; `bpm` is only a label

**What it is.** Cuts derive from measured `beats[]`/`bars[]`. `bpm` is metadata for humans and for a
starting guess. `n * 60 / bpm` MUST NOT produce a cut time (T4–T5). `bars[].index` is authoritative — do
not assume `bars[i].index == i`, because a pickup bar is real.

**Why.** Tempo drifts: live takes, rubato, a track mastered without quantisation. A constant period is
correct at the start and wrong at the end, and wrong *smoothly* — nothing jumps, so nothing looks broken and
the film slides off the music. The observed failure is a film 180 ms late by the last chorus, unfixable
locally.

**In your own work this looks like:** you computed a beat time in your head or a scratch script. Audit
question: *did this number come from the analysis output, or from arithmetic I did?* Interpolate between
measured beats for a fine offset; never extrapolate a period.

## 5. Unknown keys are rejected

**What it is.** Every artifact schema sets `additionalProperties: false`; every scene declares an
`argsSchema` with `additionalProperties: false`; an unknown key is a hard failure naming the key and the
shot id (A4).

**Why.** A permissive schema accepts a typo and a genuine extension with equal enthusiasm, so the artifact
silently accumulates keys nothing reads, and nobody can later tell which keys matter. Rejection also makes
the artifact self-documenting: everything present is something a tool consumed. The observed failure is a
`timeline.json` carrying three keys no code path read, one of which its author believed controlled the
shot's colour.

**In your own work this looks like:** a validation error and the thought "I'll just add the key to the schema
so it passes". Audit question: *who reads this key?* If nobody yet, it is not a key — it is a note for
`docs/PROGRESS.md`, or a declared `note` field.

## 6. Determinism is enforced in three layers, not trusted

**What it is.** Static (AST rules in `@cvpw/audit`, run by `cvpw lint`), runtime (seeded generators,
`reset()`/`step()` replay, `frameIndex(t)`), and empirical (`cvpw check --gold` against a committed
`qa/gold.json`).

**Why.** Each layer is blind to something the others see. A regex cannot see aliasing (`const clock =
performance.now`) and cries wolf on `Math.random` inside a comment, so it needs an allowlist — and the
allowlist silently becomes the real policy, which is why the static layer parses and resolves bindings
instead. Static cannot see entropy arriving through a dependency; runtime cannot see GPU float rounding;
only the empirical layer catches "something changed and I do not know what". The observed failure is a
project that passed lint, passed review, and rendered two different files on two machines.

**In your own work this looks like:** you ran `cvpw lint`, saw it pass, and concluded determinism was
established. Audit question: *which of the three layers has actually run on this change?* A clean lint is one
third of an answer; `--gold` is the other two thirds.

## 7. Layers, not one canvas

**What it is.** The film's layers are environment, actor/foreground, text, post. A scene MAY draw several,
but the engine MUST keep text on its own layer (C5).

**Why.** Text rendered through the same filter chain as the picture is text that scales, blurs and degrades
with the picture — unreadable exactly when the shot is most dynamic, which is when a lyric most needs to be
read. The observed failure is a chorus whose lyric line was caught by the background's motion blur and
became illegible for 12 frames, at the emotional peak of the film.

**In your own work this looks like:** you drew a label inside the scene's main transform "because it needs to
track the object". Audit question: *is this text crisp at the frame where the shot moves fastest?* If you
have to render that still to find out, render it — the answer is often no.

## 8. Restraint, then bursts

**What it is.** For a song, chorus shots are short and verse shots long; at least three genuine holds of
≥ 1.0 s; no run of more than six shots of equal length (`timeline.pacing`).

**Why.** Contrast is the mechanism by which intensity is communicated. A film with no restraint has no
bursts, because a burst is only legible against something quieter. The observed failure is a film where
every shot is 1.2 s: flat and exhausting at once, and no gate can call any individual shot *wrong*. This is
the one principle whose violation is invisible to every other check, which is why `timeline.pacing` exists
as its own gate.

**In your own work this looks like:** you are writing the sixth shot of the same length in a row because the
section "needs energy". Audit question: *what is the longest shot in this section, and the shortest?* If
those numbers are close, the section has one speed.

## 9. "Typos become defaults" is the enemy

**What it is.** The named failure, in one place: somewhere, a misspelled argument fell back to a default and
consumed a day. Every rejection rule in this framework — unknown keys, unknown scenes, unknown cues,
unregistered styles — is the same defence wearing different clothes.

**Why.** A default is invisible. A typo that hits a default produces output that is plausible, wrong, and
attributable to nothing. The cost is not the day spent finding it; it is the confidence lost in every other
green check, because you now know a green check can be green about the wrong thing.

**In your own work this looks like:** you are adding a default value to make a failing shot render. Audit
question: *is this default a meaningful choice, or a way to stop the error?* A default that only fires on a
mistake is a bug with a friendlier message.

## 10. Measure, do not guess
**What it is.** Frame cost, flash rate, A/V lag, seam delta — report the number **and where it came from**.
A claim about a picture is a hypothesis until a gate has produced a value (V5).

**Why.** Every unmeasured claim in a report transfers to the next agent as a false premise. The observed
failure is a delivery report stating "performance is fine", written from the impression that previews felt
smooth, on a film whose `msPerFrame.p95` was 92 ms against a 40 ms budget — the render had been running
three times slower than real time for a week.

**In your own work this looks like:** you wrote "fast", "clean", "fine" or "works" in a report. Audit
question: *what number backs this sentence, and which artifact contains it?* If no `--json` output carries
it, the sentence is an opinion and should be labelled as one.

## 11. Thresholds have exactly one home

**What it is.** Every threshold lives in [`docs/QA.md`](../../../docs/QA.md) or
`project.json::budgets`. A number that appears only inside `packages/` is a bug: nobody can review it and
nobody can change it on purpose (V5). A check reads its threshold by name (`qa:flash.rate`), never inline.

**Why.** A threshold in two places will disagree with itself, and a user will find the disagreement by
filing a bug about inconsistent grading. The observed failure is a seam that graded `minor` in
`cvpw handoff` and `ALIGN` in a review script, with two constants in two files, neither the documented one.

**In your own work this looks like:** you typed `0.03` into a script, a notebook, or a review checklist.
Audit question: *if this number changes in `docs/QA.md`, does my code change with it?* If not, you have
created a second home.

## 12. A documented exemption beats a silent tolerance

**What it is.** A waiver has a `date`, a `reason`, an `observed` value and an `owner`, and it appears in the
delivery report. An exemption that a project cannot justify is a signal that the gate set does not match
the film (V6).

**Why.** Every silent tolerance erodes every other green check: once one check may pass while failing, "all
checks pass" means nothing and nobody can tell which checks are load-bearing. A documented exemption
preserves the information — a reviewer learns that this seam is 1/255 off on 12 pixels of sky gradient
because of GPU float rounding, which is useful. A silent tolerance teaches nothing and hides the same thing.

**In your own work this looks like:** you widened a tolerance, skipped a check, or deleted an assertion
because it was inconvenient. Audit question: *could someone reading only the reports tell that I did this?*
If not, it is silent, and it is forbidden.

## 13. Evidence, not assertion

**What it is.** A stage is finished when it has produced **both** halves: a numeric, machine-readable gate
result, and an agent that has actually opened the images (V1–V3). Neither half is sufficient.

**Why.** A frame count proves the render finished, not that it is any good. An opinion about a still proves
nothing about the other 6,000 frames. Gates exist to make looking cheap and honest, not to replace it — and
the manifest in `review/report.json` is what makes the looking auditable afterwards. The observed failure is
a review that approved a shot whose first frame flashed the previous shot's colours, because the reviewer
opened only the midpoint.

**In your own work this looks like:** you are about to write "I reviewed the stills" without a populated
manifest, or to report a pass without the `--json`. Audit question: *can the next agent see what I looked
at, at what time, and what the number was?* If not, the work is not verifiable and is therefore not done.

## 14. Blocks have one owner

**What it is.** A block is a contiguous time range with exactly one owner and disjoint files. Shared files
— `engine/core`, `engine/lib`, `timeline.json`, `handoff.json`, styles, `project.json` — belong to the
integrator (S1–S2).

**Why.** Shared-file edits let one author silently restyle another's work, and the cost is unbounded because
it surfaces at the end. The observed failure is two authors editing `timeline.json` concurrently: both edits
survived, one shot's `at` was duplicated, and the coverage error appeared only after both blocks had been
authored against the broken partition.

**In your own work this looks like:** you are about to open a file that is not in your block's list "just to
fix one value". Audit question: *does `docs/BLOCKS.md` list this file for my block?* If not, write the
request into `docs/INTEGRATION_NOTES.md` and work around it meanwhile.

## 15. Write to disk early

**What it is.** Write files as you go, keep a progress log from the first commit, and on takeover inspect
what is on disk and run the relevant check **before** re-running anything (S3).

**Why.** Long agent runs get interrupted — context limits, crashes, a user who closes the window. The work
that survives is the work already written. The observed failure is an agent that spent forty minutes on a
scene in memory, was interrupted, and started again from zero; worse is the takeover agent who re-ran
analysis and overwrote a hand-curated `sections.json`, the previous author's most valuable output.

**In your own work this looks like:** you have been working for a while without a file changing on disk, or
you are about to re-run a command on a directory you have not inspected. Audit question: *if I stopped
existing right now, what would the next agent find, and what would they mistakenly redo?*

## 16. Every deviation is recorded

**What it is.** Anything that departs from [`docs/SPEC.md`](../../../docs/SPEC.md) or from
[`docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) goes into `docs/PROGRESS.md` with a reason
([`docs/SPEC.md`](../../../docs/SPEC.md) §10).

**Why.** An undocumented deviation is indistinguishable from a bug. The next agent then has two options —
repeat the mistake, or "fix" a deliberate decision — and both cost more than the sentence it would have taken
to write it down. This is why it is compliance rule 5, not optional bookkeeping.

**In your own work this looks like:** you did something the spec does not describe, and it worked. Audit
question: *if the next agent saw this, would they know it was on purpose?* Write the sentence now, while
you still remember the reason; in an hour you will only remember the change.

## 17. Accumulate by registration, not by patching

**What it is.** New scenes, styles, checks, artifacts and skills arrive as a new file plus one manifest
line. A shared edit is a request to the integrator
([`docs/EXTENDING.md`](../../../docs/EXTENDING.md)).

**Why.** A monolith grows by accretion: each patch is locally reasonable and globally entangled, and the
cost is paid by everyone later. Registration keeps capability *composable* — a scene can be removed,
replaced or reused because nothing refers to it by position or by a branch. The observed failure is an engine
with a scene switch containing one project's special case, which every later project had to read.

**In your own work this looks like:** you added a `case` to a switch, an `if (project.id === …)` to a
shared file, or a colour to a shared palette module. Audit question: *does this change require every other
project to know about my project?* If yes, stop and register instead.

## 18. Verify untouched work numerically

**What it is.** After any change, compare the ranges you did not mean to touch against `qa/gold.json`
(`cvpw check --gold`).

**Why.** "My edit was local" is the claim most likely to be wrong, because the mechanisms that break it — a
shared style, a `seeds.global` change, an engine constant — produce no error and no visible difference in
the frames you happen to open. Numbers are the only way to distinguish "nothing changed" from "nothing I
looked at changed". The observed failure is a seeds change that restyled the noise in every shot, found by a
viewer rather than by the author.

**In your own work this looks like:** you changed a shared file and reasoned that it could not matter. Audit
question: *which times did I re-render, and did I compare them or look at them?* Looking is not comparing;
`--gold` is comparing.

## 19. The code-versus-doc authority rule

**What it is.** Levels 1–4 (SPEC, CONTRACTS, schemas, WORKFLOW/QA/EXTENDING) are **normative**: if code
disagrees, the code is wrong. Levels 5–7 (`project.json`, generated artifacts, code) are factual records of a
particular project. Level 8 (README, AGENTS, ARCHITECTURE, ENVIRONMENT, BRIEF, STORYBOARD, notes) is
**descriptive**: if a prose doc disagrees with code, fix the **doc** in the same change.

**Why.** Every reference project suffered unmanaged doc/code drift; one legislated "when doc and code
disagree, the code wins", which makes its docs unverifiable — every statement provisional, none reliable.
Fixing the direction by document *level* keeps both properties: the constitution stays enforceable, and the
descriptive docs stay true because they are maintained when they drift.

**In your own work this looks like:** you found a disagreement and picked the side that was easier to change.
Audit question: *which authority level is each of these two things at?* Fix the lower one. If you cannot tell
which level applies, stop and ask.

## The shortest version

> Nothing may be a guess: not a time, not an argument name, not a threshold, not a colour, not the claim
> that a frame looks right.

When two principles appear to conflict, the conflict usually means a fact is missing. Get the fact — re-read
the spec section, run the gate, open the frame — rather than choosing a principle to obey. If the conflict is
real, it is an ADR or a recorded deviation, not a silent judgement call at 2 a.m.

Procedural form: [01-stages.md](./01-stages.md). Multi-agent constraints:
[03-parallel-work.md](./03-parallel-work.md).
