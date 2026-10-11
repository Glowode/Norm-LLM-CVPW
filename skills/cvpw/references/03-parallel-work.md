# 03 — Parallel work: blocks, ownership, handoffs

**Read when:** more than one agent is working on the same film, or you are the integrator.

The unit of parallelism in this framework is the **block**, not the file and not the shot. A block is a
contiguous time range with exactly one owner and a disjoint set of files. Everything in this document
follows from that definition.

---

## Why blocks, and not files

A film has one `timeline.json`. If two authors edit it, they collide, and the collision is not a merge
conflict in the git sense — it is two people deciding independently what happens at second 47. A block
partition gives each author a range nobody else touches, and makes the boundary between ranges a thing
that is *specified* rather than *negotiated at merge time*.

The prior art learned this the expensive way. One project with seventeen parallel authors had to
designate `timeline.json` as owned by the integrator alone and forbid everyone else from touching it,
because it was the single guaranteed conflict point. This framework takes the same rule and makes the
partition an artifact so the boundary conditions are written down before anyone starts.

---

## Reading `docs/BLOCKS.md`

Every block carries:

| Field | Meaning | Why it exists |
|---|---|---|
| `id` | `b01`, `b02`, … | Stable name for the range. |
| `file` | The scene module this block owns | **The only file you may edit.** |
| `from`, `to` | Time expressions for the range | Resolved against the timebase, like everything else. |
| `owner` | Who is building it | An unowned block is nobody's responsibility. |
| `cues` | Which named moments fall inside | Tells the author what the block has to land on. |
| `entry` | What is on screen at the first frame | The incoming state, in words. |
| `exit` | What is on screen at the last frame | The outgoing state, in words. |
| `handoffNext` | What the next block must do at the boundary, and which shared values it must read | The contract between two authors who will never read each other's code. |

**`entry` and `exit` are not documentation.** They are the specification of the boundary. If your block
cannot be entered in the state `entry` describes, the partition is wrong and it must be fixed before
anyone writes code — not discovered at integration.

---

## The two kinds of boundary

This is the part that is hardest to get right, and the prior art converged on exactly two classes.

### `transition` — the ranges overlap

```jsonc
{ "id": "b03", "from": "b(16,0)", "to": "b(24,0)",
  "handoffNext": "b04 overlaps 23.5-24.0 and owns drawing the wipe out of the book page" }
```

**The later block owns drawing the transition.** Always. The earlier block ends its own action and eases
out; it does not attempt to draw an exit effect. This asymmetry is what stops two authors writing two
half-transitions that fight each other.

So block `b03`'s job is: keep the picture alive to its last frame, and make sure the transition object
the two blocks share (a page, a curtain, a geometric shape) is in the position and colour `handoffNext`
says it will be. Block `b04`'s job is: at its first frame, reproduce that same object exactly, then
animate it away.

### `pixel` — the ranges do not overlap, and there is no transition

```jsonc
// handoff.json
{ "id": "b04|b05", "t": "b(24,0)", "mode": "pixel",
  "lastFrameOf": "b04", "firstFrameOf": "b05",
  "contract": { "camera": { "drift": { "amp": 5, "speed": 0.35, "seed": 3 }, "zoom": 1.0 },
                "env": "studio", "layers": ["bg", "fg"], "fx": { "shake": 0, "flash": 0 } } }
```

The last frame of `b04` and the first frame of `b05` must be *near-identical*. Both blocks import the
contract and read the values from it. **Neither may hard-code them.** The moment one side writes
`drift(5, 0.35, 3)` literally, the two can drift apart silently and the seam fails months later when
someone changes the other side.

Verify with `cvpw handoff`, which renders A (the last frame of the outgoing block), REF (the contract's
own reference implementation), and B (the first frame of the incoming block), computes the pixel
difference, and writes an `A|REF|B` strip you can look at. Grain is forced off: grain makes two frames
at different times differ across the whole screen, so a seam compared with grain on fails whatever the
film did.

`diffARef` and `diffBRef` localise the blame. If A is close to REF and B is far, the incoming block is
wrong, and you do not have to guess which author to talk to.

**Register the seam before either block is written.** A seam contract invented after the fact is a
description of whatever the two blocks happen to do, which is not a contract.

---

## File ownership

| Owned by | Files |
|---|---|
| **The integrator** | `engine/core/**`, `engine/lib/**`, `index.html`, `timeline.json`, `handoff.json`, `engine/styles/**`, `project.json`, `docs/BLOCKS.md`, `docs/INTEGRATION_NOTES.md` |
| **A block author** | `engine/scenes/<your block>.js`, plus private helpers you clearly own (`engine/scenes/<block>_*.js`) |
| **Shared by convention** | `cues/cues.json` is append-mostly; changing an existing cue's `t` is an integrator decision because it moves every cut that references it |

If you need a change in a shared file, you do **not** make it. You write a request.

---

## Writing a request to the integrator

Append to `docs/INTEGRATION_NOTES.md`. A useful request has four parts, and a request missing any of
them will come back:

```markdown
### REQUEST — b07 needs a softening control on drawPanel

- **file**: engine/lib/layout.js
- **function**: `drawPanel(g, rect, options)` — currently `options` has no blur
- **symptom**: at 118.4 the panel edge is hard against a bright background and reads as a cut
  inside the shot; I need to soften it, and `ctx.layer` blurs the whole panel, not the edge
- **suggested signature**: `options.softenPx?: number` (default 0), applied as a 2px feather on the
  panel's own mask
- **workaround while waiting**: drawing the panel 3px smaller and letting the background show
- **impact if not granted**: the shot works but the edge draws attention to itself
```

The **workaround** line is what keeps you unblocked. Never wait on a shared change with nothing on
screen; write the workaround, record the request, keep going.

---

## The per-block test timeline

Each block author gets a timeline that covers *only* their range, so a still render takes seconds rather
than minutes:

```bash
cvpw stills --times 41.9,43.5,45.0 --only b05 --overlay --out review/b05
```

`--only <block>` restricts both the stills and the gate suite to one block's range. This is how a block
author gets an honest signal without rendering the film, and it is the reason the check flags take
`--only` at all.

---

## Progress logs and takeover

Interruptions are normal. Long runs hit context limits, gateways fail, sessions end. Two rules:

1. **Write the progress log first, then polish.** An author who writes code for two hours and then a
   log has produced nothing recoverable if the run dies at hour two. The prior art's post-mortem says
   this outright: *write the delivery document and progress log first, then refine.*
2. **On takeover, read the disk before running anything.** Open the block's progress log, look at what
   files exist, run `cvpw check --only <block>`, and only then decide what remains. Re-running from
   scratch over a nearly-finished block wastes the work that survived.

Your progress log belongs at the top of your block file's documentation or in the block's own section of
`docs/PROGRESS.md`, and it records: what is done, what is not, every departure from the brief and why,
and what is uncertain.

---

## Cuts and seams are mutually exclusive

A seam is an *invisible* boundary: neither block transitions, and the picture must not change. A cut is
a *visible* boundary. The engine uses the distinction to classify jumps during QA — a jump near a
registered cut is expected, a jump anywhere else is a defect.

So: **a seam must not be listed as a hard cut.** Getting this wrong makes the QA pass report a planned
cut as an unplanned jump at the exact moment you were watching, which is a confusing way to lose an
afternoon.

---

## Concurrency

Cap at `min(16, logicalCPUs - 2)`. Beyond that, GPU contention makes every agent slower — the reference
projects observed five- to twenty-fold slowdowns when Blender and a browser rendered simultaneously. The
cap is not timidity; it is the measured throughput maximum.

Render jobs are the exception: they are GPU-bound and should be serialised, not parallelised across
agents. Run one render at a time unless you have measured that two fit.

---

## What a merge conflict actually means here

If two authors produce a conflict, the partition was wrong. The conflict is a symptom, and the fix is to
move the boundary — not to resolve the conflict by hand. A boundary moved once is cheap; a boundary
argued over every session is the thing that makes a large team slow.
