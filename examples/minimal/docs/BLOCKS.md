# BLOCKS — who owns what

**Authored, not generated.** The storyboard table is derived from `engine/timeline.js` and can be regenerated
any time; this file cannot, because it records a *decision about people*: which range of the film one author may
touch without colliding with another.

Two blocks, cut on the chorus because that is where the film's energy changes.

| Block | Range | Duration | Shots | Owner's files |
|---|---|---|---|---|
| `b01` | 0.000 – 4.000 s | 4.00 s | `s01_open`, `s02_grid` | `engine/scenes/intro.js`, `engine/scenes/grid.js` |
| `b02` | 4.000 – 8.000 s | 4.00 s | `s03_burst`, `s04_hold` | `engine/scenes/burst.js`, `engine/scenes/outro.js` |

Both blocks are **4.00 s** because this is an eight-second example with one cut at its midpoint. A real film's
blocks are never this even, and `timeline.pacing` will say so if they are.

## Shared files — nobody's block owns these

Editing one of these is an **integration** change, not a block change. Request it, do not make it
(`docs/SPEC.md` S1–S2):

```
project.json                 the project's knobs
engine/timeline.js           the edit itself
engine/main.js               the bootstrap
engine/lib/                  colour roles, envelopes, texture
engine/scenes/manifest.js    which scenes exist
engine/styles/               the palette every scene reads by role
cues/cues.json               the moment register
handoff.json                 the seam contracts
```

A block author who needs a change here writes it into `docs/INTEGRATION_NOTES.md` and continues on their own
range. The alternative — two agents editing `project.json` in the same afternoon — is how a film acquires a
palette that no longer matches its scenes.

## The one cross-block dependency in this example

`s03_burst` (block `b02`) opens on the same ink as `s02_grid` (block `b01`) closes, and the seam between them is
declared `transition` in `handoff.json`: the later shot owns the drawing across the cut, so there is no shared
frame to match. Their `s01`→`s02` neighbour is declared `pixel` and measures **0.00152** against a 0.03
threshold, from `cvpw handoff` on this project:

```
ok    s01_open|s02_grid   frame  75  0.00152
n/a   s02_grid|s03_burst  frame 120  (transition: nothing to compare)
```

(Worth recording how that number got here: an earlier draft of this file quoted 0.00152 copied from a different
project, before this one had a `handoff.json` at all. The value turned out identical — both projects use the
same template scenes — but a number is only evidence once it was measured where it is claimed.)

What this means in practice: **`b02` may restyle its opening freely**, because the seam is a transition. `b01`
may not restyle its close without telling `b02`, because that seam is a pixel contract.

## How to work inside a block

```bash
cvpw check --only-block b01          # gate only your range
cvpw render --name b01 --from 0 --to 120
cvpw stills --times 0.5,2.0,3.9       # the frame after your last cut matters most
```

Then look at the stills, and write down what you saw in your block's progress log before moving on. An
unrecorded review is a review that has to be repeated.
