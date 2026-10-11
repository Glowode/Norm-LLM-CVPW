# 03 — Delivery

Getting a master out the door honestly: the checklist, the encoder probe, colour and mux, failure
behaviour, variants, the delivery report, and the licence obligations that can stop a release.

Stage 7 in [`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) is normative; this file is the working
version of it.

```bash
cvpw handoff [--list "s02|s03"] [--json]
cvpw render  [--name mv] [--workers 2] [--preview] [--only b05] [--json]
cvpw check   [--profile deliver] [--only b05] [--json]
cvpw deliver [--variants master,vertical] [--json]
```

---

## 1. The delivery checklist, in order

Order matters: each step refuses to run on an invalid input, so doing them out of order just moves the
failure later.

| # | Step | Command | Gate before moving on |
|---|---|---|---|
| 1 | Environment is known | `cvpw doctor` | Every REQUIRED item present; the real WebGL renderer reported; the encoder verdict comes from a probe (§2), not a list. |
| 2 | Every artifact validates | `cvpw validate --all` | `contract.validate` green. Never build a master on an invalid artifact. |
| 3 | Static checks clean | `cvpw lint --json` | The four static ids green, and agreeing with `cvpw check` ([`./01-gates.md`](./01-gates.md)). |
| 4 | Seams measured | `cvpw handoff --json` | Every `pixel` seam graded `ok` or `minor`; any `ALIGN` fixed or exempted with a reason. |
| 5 | Master rendered | `cvpw render --name <name> --json` | `render/report.json::errors` empty; a `codec` that actually worked; frame count correct. |
| 6 | Gates, delivery profile | `cvpw check --profile deliver --json` | Everything green, or every failure dated, justified, owned and recorded. |
| 7 | Variants rendered and re-checked independently | `cvpw render` + `cvpw check` per variant | Each variant passes the same checks on its own (§6). |
| 8 | Delivery assembled | `cvpw deliver --variants master,vertical --json` | The delivery list has sizes and durations; `publish.lyricText` and `deliver.credit` green. |
| 9 | Report written | see §7 | What was **verified**, what is **uncertain**, what was **not done**. |
| 10 | Progress log updated | `docs/PROGRESS.md` | Every deviation, every waiver, every accepted defect. |

Commit at each stage boundary ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) S4). A master that cannot be
tied to a revision cannot be re-derived, and a re-derivable master is the only kind worth shipping.

---

## 2. Encoder probing: `ffmpeg -encoders` is not evidence

`ffmpeg -encoders` reports **what the build was compiled with**, not what the driver can initialise. On the
reference machine it lists `h264_nvenc` and `hevc_nvenc`; a real encode with either exits with code
**-40**. The stderr says why: the driver exposes NVENC API 12.2 while ffmpeg 8.0.1 requires 13.0
([`../../../docs/ENVIRONMENT.md`](../../../docs/ENVIRONMENT.md) §3.1, §5.2).

That is a **driver/API-version mismatch**, not a missing GPU and not a bad ffmpeg build. Reporting "NVENC
available" there would be a lie, and the renderer would later fail — or, worse, leave a truncated file that
looks plausible.

**The probe MUST attempt a real encode and judge by exit code:**

```bash
ffmpeg -hide_banner -f lavfi -i testsrc2=size=320x240:rate=30 -frames:v 5 -c:v h264_nvenc -f null -
```

| Rule | Why |
|---|---|
| At most 5 frames, 320×240, `-f null -` | The probe must be fast and must write nothing. |
| **Any non-zero exit fails the probe** | Never look for `-40` specifically: a POSIX shell reports the same failure as `216` (exit codes truncate modulo 256). |
| Record the exit code and the first stderr line | The next reader needs the mechanism, not the verdict. |
| Delete any output written before the failure | A half-written file that looks plausible is exactly what [`../../../docs/SPEC.md`](../../../docs/SPEC.md) P6 forbids. |
| Fall back to software (`libx264`) | A working software encode beats a broken hardware one. |
| Record `codecRequested` vs `codec` in `render/report.json` | So a later reader can see that the hardware path was tried and what happened. |

`cvpw doctor` MUST NOT report an encoder as available where its probe failed. If you see a green hardware
encoder in a report on a machine where the probe would fail, that is a bug in the probe, and the film is
being encoded by something you did not choose.

**Cost of getting this wrong**: the render dies partway through, and because a partial MP4 has a valid
header, the file passes a casual `ls`. See §5.

---

## 3. Colour and geometry

Three hard rules, all cheap and all expensive to retrofit:

| Rule | Why | Where |
|---|---|---|
| **Tag BT.709 explicitly** | Untagged video is a guess: players assume, and the assumption differs between a desktop player, a browser and a phone. A film graded to look a particular way that arrives untagged can arrive looking washed out or crushed, on someone else's screen, where you cannot see it. | `project.json::output.color` is `"bt709"` ([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §2). |
| **Even width and height** | `yuv420p` chroma is subsampled 2×2; an odd dimension forces the encoder to pad or to refuse. | `output.width` and `output.height` MUST be even. `cvpw validate` enforces it. |
| **The audio offset is applied at mux time only** | `-itsoffset` / `adelay` shifts the track in the container. Editing the source file to shift it changes the analysis input, moves every measured time, and breaks `av.sync` for every future render of the project. | [`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §2, [`../../../docs/SPEC.md`](../../../docs/SPEC.md) P6. |

**MUST NOT**: fix an A/V lag by re-encoding the audio with a delay baked in, or by trimming the video. Both
"work" and both destroy the relationship between `t` and the song that the entire film is built on.

Frame rate is likewise constrained: `output.fps` MUST be one of 24, 25, 30, 50, 60
([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §2). A frame rate chosen to "make it fit" changes
every time expression's frame quantisation.

---

## 4. Preview versus master

```bash
cvpw render --preview --name mv_preview      # half resolution, fast encoder, for the review checkpoint
cvpw render --name mv                        # the master
```

| | Preview | Master |
|---|---|---|
| Purpose | Look at the film and fix it | The deliverable |
| Resolution / encoder | Reduced, fast | Full, from the resolved codec |
| Naming | MUST be clearly named as a preview (`*_preview.mp4`) | The project's name |
| Deliverable? | **MUST NOT** be delivered as a master | Yes, after the gates pass |
| Gates | Enough to make reviewing meaningful | The full delivery profile |

The preview exists because reviewing a film you have not rendered is impossible and rendering a finished
master before reviewing is wasteful. What makes it honest is the **name**: a file called
`mv_preview.mp4` cannot be mistaken for the deliverable, in a folder, in an email, or in a delivery list.
A preview that is named like a master will eventually be shipped like one.

The review loop's motion pass runs on a preview ([`./02-review-loop.md`](./02-review-loop.md) §8), so a
preview is not a lesser artifact — it is a different one, and the master is only rendered once the film has
stopped changing.

---

## 5. A failed render deletes its own output

> A renderer MUST delete its output on failure. A truncated file MUST NOT be able to masquerade as a
> finished one.

The failure this prevents is specific and common: the encoder dies partway (a full disk, a driver reset, a
killed worker), the container still has a valid header, and the resulting MP4 opens. It plays. It is short.
Nobody notices until someone watches the end.

**Never report success from the file's existence.** Before believing any output:

```bash
# 1. the renderer's own account
#    render/report.json::errors must be empty
# 2. the frame count, against duration × fps
cvpw check --frames --json
# 3. if in doubt, the container's own view
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames -of csv=p=0 render/mv.mp4
```

`render.frameCount` is `== round(duration × fps)`, not "within a frame or two". An MP4 that exists but is
short is the symptom listed in [`../../../docs/QA.md`](../../../docs/QA.md) §7, and the answer is to find
the cause, not to re-run until a longer file appears.

Related and worth checking in the same breath: **disk space**. The peak-disk rule is
`frames × measured_frame_bytes × 1.3 ≤ budgets.peakDiskGb ≤ 0.6 × free_space`, with `measured_frame_bytes`
read from `render/report.json`, never guessed ([`../../../docs/QA.md`](../../../docs/QA.md) §2.2). When the
rule fails, render `--only <block>` or lower the resolution — never let the encoder finish into a full disk.

---

## 6. Variants

```bash
cvpw render --name mv_vertical --variant vertical --json
cvpw check  --profile deliver --variant vertical --json
```

A vertical version is a **re-layout, not a crop of the master**. That distinction is the whole reason
positions in scene code MUST go through `engine/lib/layout.js` and why raw `1920`/`1080` arithmetic is a lint
error ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) C7).

| Rule | Consequence if ignored |
|---|---|
| Every variant passes the same checks **independently** | A crop inherits the master's green report and none of its guarantees. |
| `text.safeArea` is re-measured per variant | Text that cleared the subtitle band at 16:9 can collide with it at 9:16. |
| `flash.rate` is re-measured per variant | A re-layout changes which parts of the frame are large-area; a passing master does not imply a passing vertical. |
| The variant keeps the same timebase and the same `timeline.json` | A variant is a layout change, not a re-edit. If it needs different cuts, it is a different film. |

`cvpw deliver --variants master,vertical` assembles both, and the delivery list reports each file with its
size and duration. A variant that failed its own check is a variant that does not ship.

---

## 7. The delivery report

The report is the last artifact and the one a human actually reads. Three sections, all required:

```markdown
## Verified
- render.frameCount: 6240 == round(208.0 × 30), ffprobe agrees.
- av.sync: 8.3 ms (≤ 33.3 ms), measured by cross-correlating the decoded track against audio/song.wav.
- determinism.workerCount: identical hashes for --workers 1 and --workers 3 at 120 sampled times.
- determinism.gold: all 24 gold times match.
- handoff.pixel: 6 seams, worst 0.0071 (ok); grain off.
- flash.rate: max 2 per 1 s window, measured per section.
- publish.lyricText: no lyric text in the delivered artifact (project.json::lyricsText = "local-only").
- deliver.credit: credit line appears verbatim in the end card and README.md.
- Review: 3 passes; review/report.json lists 214 images; first frame after each cut, main event, and last
  frame before each end were inspected for all 41 changed shots.

## Uncertain
- lines 27 and 31 of the lyric timing are placed by ear: the vocal has no measurable onset under the
  sustained chord. Both are inside ±150 ms of the nearest candidate but the candidate is weak.
- the seamless join s07|s08 grades minor (0.014). Cause believed to be grain, not geometry; not chased.

## Not done
- vertical variant: rendered and checked for text.safeArea and flash.rate; assets.manifest not re-run
  because the variant loads the same asset set as the master.
- no 4K variant: 2 GB VRAM on the reference machine; not attempted, not measured.
```

Rules for the report:

- **Verbatim waivers.** Every entry in `qa/exemptions.json` that affected this delivery appears in the
  report, quoted, not summarised.
- **Numbers, with their source.** "av.sync 8.3 ms" is a fact; "sync looks fine" is not.
- **Uncertainty is a section, not a footnote.** An honest uncertainty is worth more than a false pass
  ([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7).
- **"Not done" is required even when it is empty** — write "nothing" explicitly, so a reader can tell the
  difference between "nothing was skipped" and "nobody said".
- **Skipped gates stay skipped.** A gate reported as `skipped` in `qa/report.json` is listed under "Not
  done" with its reason. Never quietly promote it to "Verified".

---

## 8. Licence and credit obligations

Three obligations, all of which can stop a release, all of which are checked:

| Obligation | Check id | What it means in practice |
|---|---|---|
| **The credit line appears verbatim where promised** | `deliver.credit` | `project.json::credit`, when non-empty, MUST appear verbatim in the end card **and** in `README.md`. Ask the user for the exact string; never invent one, and never "tidy" it. |
| **Lyric text is not published unless licensed** | `publish.lyricText` | With `lyricsText: "local-only"`, `cvpw deliver` MUST refuse to include lyric text in a delivered artifact. With `"licensed"`, `lyricsLicence` must name who granted it and for what. |
| **Every asset has a licence and a source** | `assets.manifest` | Every entry in `assets/manifest.json` carries `licence` and `source`, is present on disk, and is `sha256`-verified. Unknown provenance fails. |

Two more that are not gates but are the same kind of obligation:

- **The audio is the user's property.** Do not commit media by default, and do not add the song to a
  delivery bundle that was not asked for ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T7 and §8).
- **A published film's effects are frozen.** Once a master has shipped, a change to a published effect MUST
  produce a new variant, never an in-place edit — an in-place edit silently invalidates every previous
  review ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) D9).

If any of these cannot be satisfied, the correct outcome is to say so before delivery, not to deliver and
mention it afterwards. `publish.lyricText` and `deliver.credit` are both marked unwaivable in
[`../../../docs/QA.md`](../../../docs/QA.md) §2, which means there is no exemption path: the project
changes, or the file does not ship.

---

## 9. Acceptance

Stage 7's acceptance list is normative ([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7).
Restated as a final gate:

- [ ] `render.frameCount` equals `round(duration × fps)`.
- [ ] `av.sync` ≤ 1 frame, measured against the source audio.
- [ ] `determinism.gold` passes, or every mismatch has a dated exemption.
- [ ] Every `pixel` handoff grades `ok` or `minor`; every `ALIGN` is fixed or exempted with a reason.
- [ ] `flash.rate` within budget, measured per section.
- [ ] Every variant passed the same checks independently.
- [ ] The credit line appears verbatim where promised.
- [ ] `publish.lyricText` and `assets.manifest` green.
- [ ] The delivery report states what was verified, what is uncertain and what was not done.
- [ ] `docs/PROGRESS.md` names every deviation, with a reason.
- [ ] `render/report.json::errors` is empty, and the file on disk is the file the report describes.

Back to [`../SKILL.md`](../SKILL.md) for the routing table, or
[`./01-gates.md`](./01-gates.md) when a check on this list is red.
