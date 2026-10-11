# 03 — Cue curation

The cue registry is the small file that keeps a human's ear-correction from being overwritten by the next
analysis run, and the only permitted home for an off-grid time
([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T8). Read [`../SKILL.md`](../SKILL.md) first.

```bash
cvpw cues [--from analysis] [--json]     # settle guesses onto measured onsets; never touches a manual cue
```

---

## 1. What a cue is

```jsonc
// cues/cues.json
{ "$schema": "schemas/cues.schema.json", "schemaVersion": 1, "duration": 8.0,
  "cues": [
    { "id": "downbeat1", "t": 0.02, "source": "measured", "label": "first downbeat",   "note": "" },
    { "id": "chorus",    "t": 4.02, "source": "manual",   "label": "chorus in",        "note": "auditioned by ear" }
  ] }
```

A cue is **a name for an absolute time, with recorded provenance**. That is the whole idea. It is:

- not a beat (beats are the grid, and there are hundreds of them),
- not a section (sections are spans, `S('bridge')` resolves their start),
- not a shot (shots are the edit; a shot *starts at* a time expression, which may be a cue).

**Why one file, and why some times must live in it.** A moment that is not on the grid and not a section or
a lyric line — an actor's blink, a door slam, a breath before the last chorus, the exact frame a hand
touches a shoulder — has nowhere else to live. The alternatives are all worse:

| Alternative | What goes wrong |
|---|---|
| A literal second in the scene | `lint:absolute-time`; and when the analysis is regenerated, the literal does not move with the music ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T2). |
| A number inside the scene's args | Not a time expression, so nothing resolves it, nothing audits it, and no report shows it. |
| A comment | Not data. The next agent's re-analysis overwrites the picture and the comment is now a lie. |
| A cue | Named, resolvable (`cue('chorus')`), auditable (`source`, `note`), and protected from tool overwrites. |

**The rule that makes curation stick:**

> A tool MAY refine a cue whose `source` is `measured`, `analysis`, `audit` or `initial`.
> A tool **MUST NOT** touch a cue whose `source` is `manual`. `cvpw cues` reports it as skipped.
> ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T6)

Without this rule, the loop "re-analyze → re-settle → re-render" silently deletes every human judgement in
the project, one regeneration at a time. With it, the file accumulates value: the analysis moves, and the
hand-placed moments stay where a person put them.

---

## 2. The five sources, and when each is correct

| `source` | Meaning | Correct when | Wrong when |
|---|---|---|---|
| `measured` | A tool detected this exact event in the audio. | The cue sits on a real onset/impact/stop that `analysis/audio.json` contains. | The time was copied from a document, or nudged. |
| `analysis` | A tool derived this time indirectly — a section boundary from grouping, an interpolated moment. | It is a boundary or derived marker, not a single transient. | It is presented as a hard sync point; a section boundary that is 200 ms off is fine for a palette change and not fine for a cut on the hit. |
| `audit` | A verification step named this time. | A seam measurement, a QA check, or a review note localised the moment. | It was actually detected in the audio — use `measured`. |
| `initial` | A placeholder. A guess the storyboard needs to exist before the audio settled. | Only transiently, during Stage 2–3. | Any time the project is being shown to a human. |
| `manual` | A human listened and decided. | Always, once a person has actually made the call. | Never "to protect it from the tool" if no human looked — that is a guess wearing a lock. |

**`initial` is a debt, not a state to live in.** Stage 2's acceptance requires every cue to carry a
`source` **and** that anything still `initial` is listed for the operator
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 2). At the Stage 2 checkpoint, list them.

`label` is a short human phrase ("chorus in"), and `note` is where the argument goes. A `manual` cue with
an empty `note` is a decision nobody can review.

---

## 3. How `cvpw cues` settles guesses onto measured onsets

```bash
cvpw cues --json
cvpw cues --from analysis --json      # re-settle from the current analysis
```

Settlement means: for each cue that a tool is allowed to move, find the **nearest measured onset** within a
tolerance and move the cue onto it. The intent is that a storyboard written against an early guess ends up
on the real transient without anyone re-authoring anything.

What it does *not* do:

- It does not touch `manual` cues. It reports them as skipped, and the report is the point.
- It does not invent a cue for a moment the analysis does not contain.
- It does not move a cue arbitrarily far. **A candidate farther than the tolerance is not a match.**

The tolerance is a real question with a weak answer in the current docs: the worked analysis-pass example
in [`../../../docs/EXTENDING.md`](../../../docs/EXTENDING.md) §7 uses a 60 ms nearest-onset settlement,
and the `HIT()` time expression defaults to 60 ms while `VOX()` defaults to 80 ms — but the settlement
tolerance for `cvpw cues` itself is not stated in [`../../../docs/QA.md`](../../../docs/QA.md) or in
`project.json::budgets`. Until it is, pass it explicitly, record the value you used, and do not let a
module default quietly become policy.

**Settlement is not always right.** A cue can legitimately sit *off* every onset:

- a held breath before a phrase, which has no onset by definition;
- a visual moment that is deliberately a few frames before the sound;
- a moment in a `stop` or a gap, where the interesting event is the *absence*.

In each of those cases the honest outcome is the one from §4.

---

## 4. When no onset is near

**Do not silently keep an `initial` cue.** `initial` means "nobody has decided yet", and the same value with
`manual` means "a person decided". Those are different facts and the file must say which one is true.

The procedure:

```text
1. Is there an onset within tolerance?          → let cvpw cues settle it; source becomes `measured`.
2. Is there a stop/impact/section boundary that
   is the real event?                           → register that instead, and cite it in `note`.
3. Is the cue deliberately off every onset?     → source `manual`, note says why and how far.
4. Is the moment genuinely not in the audio?    → the storyboard is asking for something the song does
                                                  not have. Fix the storyboard, not the cue.
5. None of the above and no human available?    → keep it, mark it `manual`, write
                                                  "unverified guess, nearest onset 210 ms away"
                                                  in `note`, and list it as uncertain in the delivery
                                                  report. An honest guess is allowed; a disguised one is not.
```

Step 5 is the only acceptable guess, and it is only acceptable because it is labelled. A guess marked
`manual` with a note is a recorded decision to proceed without evidence; the same number marked `measured`
is a false statement.

---

## 5. Writing an id a human can read later

The id is the vocabulary the storyboard speaks, so it is read far more often than it is written.

**MUST** (schema): match `^[A-Za-z_][A-Za-z0-9_.-]*$` and be unique within the file.

**SHOULD** (craft):

| Practice | Example | Why |
|---|---|---|
| Name the *thing*, not the index | `chorus.in`, `door.slam`, `blink.02` | `cue12` tells a reader nothing, and indices renumber when a cue is inserted. |
| Namespace by kind | `vox.*`, `hit.*`, `sec.*`, `story.*` | A reader can see at a glance where the time came from. |
| Keep it stable forever | never rename a cue the timeline already uses | Renaming is a breaking change to every shot that references it. |
| Prefer plain identifiers | `chorus_in`, not `chorus-in` | The grammar reserves `+` and `-` for offsets, so a cue id containing `-` or `.` must be referenced as `cue('chorus-in')`, never bare — and a bare-identifier typo is hard to see. |
| Say what it is in `label` | `label: "chorus in"` | The id is for code, the label is for the person reading `docs/STORYBOARD.md`. |

**Removal is a validation event.** Removing a cue that a timeline references **MUST** fail
`cvpw validate`, naming the referencing shot ids
([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §6). That is deliberate: the alternative is a
timeline that silently stops resolving, or worse, resolves to a different moment because a new cue reused
the id.

---

## 6. Cue ids are the storyboard's vocabulary

A shot's `at` is a time expression; a cue id used bare is shorthand for `cue('<id>')`. So this:

```jsonc
{ "id": "s07_door", "scene": "slam", "at": "door.slam", "to": "chorus.in",
  "moment": "the door closes the verse and the chorus opens on the same frame", "block": "b03" }
```

means "start where the door slams, end where the chorus enters", and both of those are *named, sourced,
auditable* times. `docs/STORYBOARD.md` renders the same thing for a human.

Three consequences worth stating plainly:

1. **A cue id in a timeline is a promise that the moment matters.** If a shot references `cue('x')`, then
   `x` is part of the film's vocabulary, and deleting it must break the build (it does).
2. **Naming is a design act.** Giving a moment a name makes it reusable across shots and blocks. Ten shots
   that all start on `chorus.in` are ten shots that will still agree after a re-analysis.
3. **Ids are shared state.** `cues/cues.json` is shared across every block, so a block author who needs a
   new cue records the request in `docs/INTEGRATION_NOTES.md` rather than editing the file — unless they
   are the integrator ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) S2).

---

## 7. Curating a cue list that survives a re-analysis

The realistic loop is: analyze → curate → storyboard → re-analyze (because the tempo was an octave off) →
re-settle → re-render. Everything a human decided must survive the middle of that loop.

| Step | Command | What MUST survive |
|---|---|---|
| First pass | `cvpw analyze` | — |
| Register the moments the storyboard will need | hand-edit `cues/cues.json`, `source: "initial"` | the ids |
| Settle | `cvpw cues --json` | `manual` cues (unchanged) |
| Audition the ones that matter | a human, by ear | the decision, recorded as `manual` + `note` |
| Re-analyze for any reason | `cvpw analyze` | `cues/cues.json` in full (it is an input, not an output) |
| Re-settle | `cvpw cues --json` | `manual` cues again |
| Storyboard | `cvpw storyboard` | every `at` resolves; a failure names the shot and the near matches |

**Check the skip report.** `cvpw cues --json` lists which cues it skipped and why. Reading that list is how
you confirm the protection is actually working — a project where nothing is ever skipped has either no
manual cues or a bug.

**Re-analysis is a re-cut.** After any change to `analysis/audio.json`, re-resolve the whole timeline and
re-run the seam measurement for affected seams; and compare a block whose authored range did **not** change
against the gold frames numerically. A re-analysis must not silently restyle untouched work
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) §"After a re-cut").

---

## 8. Acceptance

- [ ] Every cue has a `source` from the closed set, and an `id` that matches the schema's pattern and is
      unique.
- [ ] No cue still reads `initial` at a checkpoint; each one was settled, promoted to `manual` with a note,
      or removed.
- [ ] Every `manual` cue has a `note` saying what moved it and on what evidence.
- [ ] `cvpw cues --json` reports the `manual` cues as skipped.
- [ ] Every cue id the timeline references exists; nothing referenced was removed without updating the
      referencing shots.
- [ ] The moments the storyboard names are cues — not literals, not comments, not scene args.
- [ ] `docs/PROGRESS.md` lists any cue you moved by hand and why.

Back to [`../SKILL.md`](../SKILL.md) for the routing table, or
[`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 3 for what happens to these names next.
