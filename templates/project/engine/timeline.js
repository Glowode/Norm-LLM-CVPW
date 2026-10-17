/**
 * Timeline data for this project.
 *
 * This file is DATA, not code: it is the edit, expressed as a list of shots whose times are *time
 * expressions* resolved against the timebase. Read it next to `docs/STORYBOARD.md`, which is the same
 * information for a human.
 *
 * **Never write a bare number here.** `"0.0s"` is legal and raises a lint warning; anything else should
 * name a moment the music actually contains — a bar, a cue, a half-beat, a lyric line. A reference the
 * timebase cannot substantiate is an *error* rather than a fallback, and that is the point: it is the
 * difference between a cut that lands and a cut that was right the day it was written.
 * Grammar: `docs/CONTRACTS.md` §3.
 *
 * ## Why this file uses cue names
 *
 * The template ships without audio, so it uses the one kind of time expression that always resolves: a
 * named cue. That makes `cvpw render` work on a fresh project with nothing installed.
 *
 * Once the project has real audio and `cvpw analyze` has run, the expressions below become much better
 * than they are now, because they can be tied to the *music* instead of to named moments:
 *
 *     "cue('grid_in')"  ->  "b(0,2)"        the third beat of bar 0
 *     "cue('chorus')"   ->  "HIT('chorus')" the measured impact that starts the chorus
 *     "cue('settle')"   ->  "L(12)"         the start of lyric line 12
 *
 * Do that replacement yourself rather than leaving it to a tool: which bar a moment belongs to is a
 * judgement about the film, and a tool that guessed it would be guessing about the one thing the whole
 * framework refuses to guess at.
 */

/** @type {Record<string, unknown>} */
export const timeline = {
  $schema: "schemas/timeline.schema.json",
  schemaVersion: 1,
  duration: 8,

  shots: [
    {
      id: "s01_open",
      scene: "open",
      block: "b01",
      at: "cue('open')",
      moment:
        "an almost-empty frame with a single pulse in it; the film has not started speaking yet, so the " +
        "first beat reads as an event because there is nothing else to look at",
      args: { pulse: 0.4, rings: 3, label: "01" },
    },
    {
      id: "s02_grid",
      scene: "grid",
      block: "b01",
      at: "cue('grid_in')",
      moment:
        "the beat becomes visible: a grid snaps onto the pulse, so the audience learns the rhythm at the " +
        "same moment the picture does",
      args: { density: 7, hue: 0.55 },
    },
    {
      id: "s03_burst",
      scene: "burst",
      block: "b02",
      at: "cue('chorus')",
      moment:
        "the chorus lands; the grid is thrown outward and the frame goes bright for a fifth of a second, " +
        "then settles into a held image rather than a fade",
      transition: { type: "flash", overlap: 0.12 },
      // An explicit end, because the next shot deliberately starts later: the burst is given room to
      // settle into its held halo. Leaving `to` out makes the renderer treat the difference as unassigned
      // time and refuse the film — correct behaviour, and an annoying way to discover a deliberate pause.
      to: "cue('burst_end')",
      args: { count: 90, hue: 0.08, word: "CHORUS" },
      post: { bloom: 0.35, chromatic: 0.45 },
    },
    {
      id: "s04_hold",
      scene: "hold",
      block: "b02",
      at: "cue('settle')",
      to: "p(1.0)",
      moment:
        "hold one image long enough that the ending reads as a decision rather than as running out of " +
        "ideas; the last thing on screen is the title and nothing else",
      args: { title: "EXAMPLE", sub: "replace me" },
      post: { vignette: 0.5 },
    },
  ],
};

export default timeline;
