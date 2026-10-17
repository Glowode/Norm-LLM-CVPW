# examples/minimal — a working project, committed

A complete cvpw project: four shots, one style, a measured-or-authored timebase, and no binary assets. It
exists so the template cannot regress silently — everything else in this repository *demonstrates* the
framework, and this is the one copy that is *checked in*, so changing `templates/project/` and never
scaffolding again is a mistake this repository can catch.

## Run it

`vendor/kernel/` is **not committed**: it is a build artifact of `packages/kernel/dist`, and the framework
regenerates it.

```bash
pnpm build                      # from the repository root, once
cd examples/minimal
cvpw link                       # vendor the kernel into this project
cvpw storyboard                 # FIRST: resolve the edit; writes timeline.json
cvpw validate                   # now every artifact exists and checks against its schema
cvpw check                      # the gate suite
cvpw stills --times 0.5,2.0,4.5,7.2
cvpw render --workers 2         # 240 frames -> render/master.mp4
```

## Why there is no audio

The audio is the user's property, so a committed example ships without it. The consequence is honest and
visible: every cue in `cues/cues.json` is `source: manual` because there is no `analysis/audio.json` to settle
against, and every time expression in `engine/timeline.js` is a `cue(...)` rather than a `b()` or `HIT(...)`.

That is exactly what the framework says to do without a timebase — a named cue resolves, a bar does not — and
it is what makes this example portable to a machine with nothing installed.

A real project swaps cues for the music:

```
"cue('grid_in')"  ->  "b(1,0)"          the downbeat of bar 1
"cue('chorus')"   ->  "HIT('chorus')"   the measured impact
"cue('settle')"   ->  "L(12)"           the start of lyric line 12
```

## What the four shots are

| Shot | Scene | At | What it is for |
|---|---|---|---|
| `s01_open` | `open` | `cue('open')` | An almost-empty frame with one pulse. The film has not started speaking, so the first beat reads as an event. |
| `s02_grid` | `grid` | `cue('grid_in')` | The beat becomes visible; the grid snaps on the cut, so the audience learns the rhythm when the picture does. |
| `s03_burst` | `burst` | `cue('chorus')` | The chorus lands. Bright for a fifth of a second, then a held halo rather than a fade. |
| `s04_hold` | `hold` | `cue('settle')` | Hold one image long enough that the ending reads as a decision. |

## The files that matter

```
project.json            the knobs: output size, fps, budgets, text whitelist
engine/timeline.js      THE EDIT — data, not code; the source of truth
engine/scenes/          four scenes, each registered by a manifest line
engine/styles/          one style, answering colours by ROLE
engine/lib/             shared helpers: colour roles, envelopes, paper texture
cues/cues.json          every moment the grid cannot name, with provenance
```

`timeline.json`, `render/`, `review/` and `qa/` are generated; they are not committed either.

**`cvpw storyboard` runs before `cvpw validate`**, and the order matters: `timeline.json` does not exist in a
fresh clone, and `validate` correctly refuses a project with no edit to validate. The error says so — "run
`cvpw storyboard` once the timebase exists" — which is the framework preferring a truthful failure to a
convenient one.
