/**
 * `cvpw skill install` — copy a skill bundle into an agent platform.
 *
 * A skill bundle is the framework's agent-facing surface (`docs/SPEC.md` P2). It must be portable: a
 * directory with `SKILL.md`, `references/` and `scripts/` that works when copied anywhere, with no Node
 * project present. That constraint is why this command **copies rather than links by default** — a symlink
 * into the framework repository makes the skill depend on a checkout that the platform may not be able to
 * read, which is the opposite of portable.
 *
 * Each target is a different *shape*, not just a different path:
 *
 * - `claude` — `~/.claude/skills/<name>/`, one directory per skill, which is what that platform scans.
 * - `dsh` — same layout under a different root, because the two platforms agree on the convention.
 * - `generic` — a flat directory the caller names, for a platform with no convention at all. The command
 *   prints the reading order, because without one a bundle is just files.
 *
 * The command never guesses a home directory it cannot confirm. A target that does not exist is created; a
 * *parent* that looks wrong is reported rather than created, because installing skills into
 * `~/.claude/skils/` (a typo) silently produces nothing and the user concludes the skills do not work.
 */

import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ContractError, UsageError, frameworkRoot, relPath } from "../shared.js";

export type SkillTarget = "claude" | "dsh" | "generic";

export interface SkillInstallOptions {
  target: SkillTarget;
  /** For `generic`, the destination directory. Required there, ignored elsewhere. */
  dest?: string;
  /** Install only these bundles by name. Defaults to all of them. */
  only?: readonly string[];
  /** Replace an existing installation. */
  force?: boolean;
}

export interface InstalledSkill {
  name: string;
  from: string;
  to: string;
  files: number;
}

export interface SkillInstallResult {
  target: SkillTarget;
  root: string;
  installed: InstalledSkill[];
  /** What to tell a human or an agent about how to read what was installed. */
  readingOrder: string[];
}

/** Where each target keeps its bundles. */
function targetRoot(target: SkillTarget, dest: string | undefined): string {
  switch (target) {
    case "claude":
      return join(homedir(), ".claude", "skills");
    case "dsh":
      return join(homedir(), ".dsh", "skills");
    case "generic":
      if (!dest) {
        throw new UsageError(
          "--target generic needs --dest <dir>",
          "there is no convention to assume, so the destination has to be stated",
        );
      }
      return resolve(dest);
  }
}

export async function installSkills(options: SkillInstallOptions): Promise<SkillInstallResult> {
  const skillsDir = join(frameworkRoot(), "skills");
  if (!existsSync(skillsDir)) {
    throw new ContractError(
      `no skills/ directory in ${frameworkRoot()}\n` +
        `  the framework ships three bundles (cvpw, cvpw-timing, cvpw-qa); a checkout without them is incomplete`,
    );
  }

  const available = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const wanted = options.only?.length ? options.only : available;
  const unknown = wanted.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new UsageError(
      `no such skill bundle: ${unknown.join(", ")}`,
      `available: ${available.join(", ")}`,
    );
  }

  const root = targetRoot(options.target, options.dest);
  await mkdir(root, { recursive: true });

  const installed: InstalledSkill[] = [];
  for (const name of wanted) {
    const from = join(skillsDir, name);
    const to = join(root, name);

    if (existsSync(to)) {
      if (!options.force) {
        throw new ContractError(
          `${to} already exists\n` +
            `  pass --force to replace it. Replacing silently would discard whatever the platform had — ` +
            `including any local edit someone made to a bundle`,
        );
      }
      await rm(to, { recursive: true, force: true });
    }

    await cp(from, to, { recursive: true });
    installed.push({ name, from: relPath(frameworkRoot(), from), to, files: await countFiles(to) });
  }

  // A README at the root, because a platform that scanned the directory now has several bundles and no
  // statement of which to read first. This is the smallest thing that makes the set usable.
  await writeFile(
    join(root, "README.md"),
    [
      "# cvpw skills",
      "",
      "Installed by `cvpw skill install`. Read in this order:",
      "",
      "1. **cvpw** — the eight stages, the principles, checkpoint discipline, ownership rules.",
      "2. **cvpw-timing** — audio into a timebase, lyric timing, cue provenance.",
      "3. **cvpw-qa** — gates, thresholds, the review loop, the failure catalogue.",
      "",
      "If a `SKILL.md` description does not match your task, read its `references/` anyway before concluding",
      "it is irrelevant: the skill knows which of its references matter, and you do not yet.",
      "",
      "Each bundle is plain Markdown plus `scripts/` that are documented shims over `cvpw`. They work with no",
      "Node project present — a shim prints the command instead of running it.",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    target: options.target,
    root,
    installed,
    readingOrder: [
      `read ${join(root, "cvpw", "SKILL.md")} first`,
      "then the reference it names for the stage you are in, not all of them",
      "then cvpw-timing if the question is when something happens",
      "then cvpw-qa before claiming any stage is done",
    ],
  };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
    else count++;
  }
  return count;
}
