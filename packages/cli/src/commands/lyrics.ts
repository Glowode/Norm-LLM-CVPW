/**
 * `cvpw lyrics` — lyric text and timing, kept separate on purpose.
 *
 * `docs/SPEC.md` T7 draws a line through the middle of this command: **lyric *timing* is committable, lyric
 * *text* is not** unless the project declares it licensed. They are different kinds of fact. A timing file
 * says "a line starts at 12.4 s"; a text file reproduces somebody's writing. So this command writes two
 * files and never conflates them:
 *
 * - `cues/lyrics.timing.json` — always. The engine, the subtitle track and the layout checks need it.
 * - `cues/lyrics.json` — only when `project.json::lyricsLicence` is set. Otherwise the text stays in the
 *   project's own input file and out of anything that gets committed.
 *
 * Two input formats, because those are what people actually have:
 *
 * - **LRC** (`[mm:ss.xx] line`) — timed already. Parsed, validated against the audio's duration, and written.
 * - **Plain text** — one line per lyric. Timed by spreading lines across detected vocal activity, which is
 *   a guess and is labelled `estimated`. If there is no vocal activity in the analysis, the command refuses:
 *   inventing an even spread across a song whose vocal you never detected is not timing, it is theatre.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ContractError, UsageError, projectPaths, readJson, relPath, type Envelope } from "../shared.js";

export interface LyricLine {
  i: number;
  start: number;
  end: number;
  text?: string;
  /** How the time was obtained. `lrc` is a fact from the file; `estimated` is a spread across activity. */
  source: "lrc" | "estimated" | "manual";
}

export interface LyricsOptions {
  root: string;
  /** LRC or plain-text file. Defaults to `lyrics/lyrics.*` if exactly one exists. */
  input?: string;
  /** Overwrite existing timing. Otherwise the command refuses rather than silently replacing an edit. */
  force?: boolean;
}

export interface LyricsResult {
  root: string;
  input: string;
  format: "lrc" | "plain";
  lines: number;
  timed: number;
  estimated: number;
  /** Whether lyric TEXT was written, which only happens when the project declares a licence. */
  textWritten: boolean;
  licence: string | null;
  timingPath: string;
  textPath: string | null;
  warnings: string[];
}

/** `[mm:ss.xx]` or `[mm:ss]`, possibly several on one line (LRC repeats). */
const LRC_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(source: string): Array<{ t: number; text: string }> {
  const out: Array<{ t: number; text: string }> = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(LRC_TAG)];
    if (tags.length === 0) continue;
    // Metadata tags such as [ar:], [ti:] and [offset:] do not match LRC_TAG because they are not numeric,
    // which is the point of anchoring on digits rather than on the bracket.
    const text = rawLine.replace(LRC_TAG, "").trim();
    for (const tag of tags) {
      const minutes = Number(tag[1] ?? 0);
      const seconds = Number(tag[2] ?? 0);
      const fraction = tag[3] ? Number(`0.${tag[3]}`) : 0;
      out.push({ t: minutes * 60 + seconds + fraction, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Find the one input file, or explain why it is ambiguous. */
async function findInput(root: string, explicit: string | undefined): Promise<string> {
  if (explicit) {
    const path = join(root, explicit);
    if (!existsSync(path)) throw new UsageError(`no such lyrics file: ${path}`);
    return path;
  }
  const { readdir } = await import("node:fs/promises");
  const dir = join(root, "lyrics");
  if (!existsSync(dir)) {
    throw new UsageError(
      "no lyrics/ directory and no --input given",
      "put an .lrc or .txt file at lyrics/, or pass --input <file>",
    );
  }
  const candidates = (await readdir(dir)).filter(
    (name) => /\.(lrc|txt)$/i.test(name) && !name.endsWith(".timing.json"),
  );
  if (candidates.length === 0) throw new UsageError(`no .lrc or .txt file in ${dir}`, "or pass --input <file>`");
  if (candidates.length > 1) {
    throw new UsageError(
      `more than one lyrics file in ${dir}: ${candidates.join(", ")}`,
      "pass --input to say which one, rather than letting an alphabetical accident decide",
    );
  }
  return join(dir, candidates[0] as string);
}

export async function buildLyrics(options: LyricsOptions): Promise<LyricsResult> {
  const paths = projectPaths(options.root);
  if (!existsSync(paths.projectJson)) throw new ContractError(`no project.json in ${options.root}`);

  const input = await findInput(options.root, options.input);
  const source = await readFile(input, "utf8");
  const isLrc = /\.lrc$/i.test(input) || LRC_TAG.test(source);
  // `LRC_TAG` is global; testing it advances `lastIndex`, so reset before any later use.
  LRC_TAG.lastIndex = 0;

  if (existsSync(paths.lyricsTiming) && !options.force) {
    throw new ContractError(
      `cues/lyrics.timing.json already exists\n` +
        `  pass --force to replace it. Lyric timing takes hand-correction, and replacing it silently would ` +
        `discard that work`,
    );
  }

  const project = (await readJson(paths.projectJson)) as { lyricsLicence?: string; duration?: number };
  const audio = existsSync(paths.analysisAudio)
    ? ((await readJson(paths.analysisAudio)) as {
        duration?: number;
        vocalActivity?: Array<{ start?: number; end?: number }>;
        fps?: number;
      })
    : null;
  const duration = audio?.duration ?? project.duration ?? 0;
  const warnings: string[] = [];

  let lines: LyricLine[] = [];

  if (isLrc) {
    const parsed = parseLrc(source);
    if (parsed.length === 0) {
      throw new ContractError(
        `${relPath(options.root, input)} has an .lrc extension but no [mm:ss.xx] timestamps`,
        // A mislabelled file is a common mistake and the fix is not obvious from the parser's silence.
      );
    }
    lines = parsed.map((entry, i) => ({
      i,
      start: entry.t,
      end: 0, // filled below
      ...(entry.text ? { text: entry.text } : {}),
      source: "lrc" as const,
    }));
    const beyond = lines.filter((line) => duration > 0 && line.start > duration + 0.05);
    if (beyond.length) {
      warnings.push(
        `${beyond.length} lyric line(s) start after the audio ends (${duration.toFixed(3)} s). ` +
          `Either the LRC belongs to a different recording or the audio was trimmed — check before offering ` +
          `a subtitle track that runs past the picture.`,
      );
    }
  } else {
    const raw = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Blank lines and leading metadata are not lyrics. Keeping them would put empty subtitles on screen.
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (raw.length === 0) throw new ContractError(`${relPath(options.root, input)} has no non-empty lines`);

    const activity = (audio?.vocalActivity ?? []).filter(
      (window): window is { start: number; end: number } =>
        typeof window.start === "number" && typeof window.end === "number" && window.end > window.start,
    );
    const activeTotal = activity.reduce((sum, window) => sum + (window.end - window.start), 0);
    if (activeTotal <= 0) {
      throw new ContractError(
        "there is no detected vocal activity to place plain-text lyrics against\n" +
          "  run `cvpw analyze` on audio that contains the vocal, or supply a timed .lrc instead.\n" +
          "  Spreading lines evenly across a song whose vocal was never found is not timing.",
      );
    }

    // Distribute by *duration of activity*, not by wall-clock: a line should not be assigned to a gap in
    // which nobody is singing, which is what an even spread across the whole song would do.
    const perLine = activeTotal / raw.length;
    let cursor = 0;
    lines = raw.map((text, i) => {
      let remaining = perLine;
      const start = cursor;
      while (remaining > 0 && cursor < activity.length) {
        const window = activity[cursor] as { start: number; end: number };
        const take = Math.min(remaining, window.end - window.start);
        remaining -= take;
        cursor++;
      }
      const end = remaining > 0 ? duration : Math.min(duration, (activity[Math.min(cursor, activity.length - 1)] as { start: number }).start + perLine);
      return { i, start: Number(start.toFixed(3)), end: Number(Math.max(end, start + 0.3).toFixed(3)), text, source: "estimated" as const };
    });
    warnings.push(
      `plain text has no timestamps: ${lines.length} line(s) were distributed across detected vocal activity ` +
        `and marked \`estimated\`. Treat the first run as a scaffold and correct it by hand — ` +
        `\`cvpw check --lyrics\` fails lines more than ±150 ms from a detected vocal onset.`,
    );
  }

  // Fill each line's end from the next line's start, with a floor and a cap so a long instrumental gap does
  // not leave a subtitle on screen for eight bars.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as LyricLine;
    if (line.end > line.start) continue;
    const next = lines[i + 1] as LyricLine | undefined;
    const proposed = next ? next.start : duration || line.start + 3;
    line.end = Number(Math.min(Math.max(line.start + 0.4, proposed), line.start + 6).toFixed(3));
    if (duration > 0) line.end = Math.min(line.end, duration);
  }

  const licence = typeof project.lyricsLicence === "string" && project.lyricsLicence.trim() ? project.lyricsLicence.trim() : null;
  const textWritten = licence !== null;
  if (!textWritten) {
    warnings.push(
      "lyric TEXT was not written: project.json has no `lyricsLicence`. Only cue/lyrics.timing.json was " +
        "written, because timing is a fact about the recording and the words are somebody's property " +
        "(docs/SPEC.md T7).",
    );
  }

  const timingPath = paths.lyricsTiming;
  await mkdir(dirname(timingPath), { recursive: true });
  // The schema's shape, not a convenient one: `count` is required, and the provenance fields it does not
  // declare go into `notes` — a string, so a reader gets a sentence rather than a key the validator rejects.
  const timingDoc = {
    $schema: "schemas/lyrics-timing.schema.json",
    schemaVersion: 1,
    count: lines.length,
    notes:
      `parsed from ${relPath(options.root, input)} as ${isLrc ? "LRC" : "plain text"} by ` +
      `${textWritten ? "cvpw lyrics" : "cvpw lyrics (timing only)"}` +
      (duration > 0 ? `; audio duration ${duration.toFixed(3)} s` : "") +
      (textWritten ? "" : "; lyric text omitted because project.json declares no lyricsLicence"),
    lines: lines.map((line) => ({
      i: line.i,
      start: line.start,
      end: line.end,
      source: line.source,
      // `text` is deliberately absent even when the licence allows it: a timing file must stay committable,
      // and the words live in cues/lyrics.json where a licence can be recorded beside them.
    })),
  };
  await writeFile(timingPath, `${JSON.stringify(timingDoc, null, 2)}\n`, "utf8");

  let textPath: string | null = null;
  if (textWritten) {
    textPath = join(options.root, "cues", "lyrics.json");
    await writeFile(
      textPath,
      `${JSON.stringify(
        {
          $schema: "schemas/lyrics.schema.json",
          schemaVersion: 1,
          licence,
          note: "Written because project.json::lyricsLicence is set. Removing that key is the way to stop publishing the words.",
          lines: lines.map((line) => ({ i: line.i, text: line.text ?? "" })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    root: options.root,
    input: relPath(options.root, input),
    format: isLrc ? "lrc" : "plain",
    lines: lines.length,
    timed: lines.filter((line) => line.source === "lrc").length,
    estimated: lines.filter((line) => line.source === "estimated").length,
    textWritten,
    licence,
    timingPath: relPath(options.root, timingPath),
    textPath: textPath ? relPath(options.root, textPath) : null,
    warnings,
  };
}

export function lyricsEnvelope(result: LyricsResult): Envelope {
  const summary = [
    `parsed ${result.input} as ${result.format.toUpperCase()}: ${result.lines} line(s)`,
    `  ${result.timed} timed from the file, ${result.estimated} estimated`,
    `  wrote ${result.timingPath}`,
    result.textWritten
      ? `  wrote ${result.textPath} — lyric text published under licence ${result.licence}`
      : "  lyric text NOT written: no `lyricsLicence` in project.json (docs/SPEC.md T7)",
  ];
  for (const warning of result.warnings) summary.push(`  warning: ${warning}`);
  return {
    ok: true,
    command: "lyrics",
    schemaVersion: 1,
    project: result.root,
    artifactsWritten: [join(result.root, result.timingPath), ...(result.textPath ? [join(result.root, result.textPath)] : [])],
    result,
    warnings: result.warnings.map((message) => ({ code: "lyrics", message })),
    errors: [],
    summary,
  };
}
