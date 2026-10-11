#!/usr/bin/env node
// `cvpw` entry point.
//
// Kept as a tiny .mjs shim so that `--help` and `doctor` produce a useful answer even when the
// TypeScript has not been built yet. An agent on a fresh checkout should never be told
// "cannot find module" when it asks the framework what it can do.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "main.js");

if (!existsSync(built)) {
  process.stderr.write(
    [
      "cvpw: not built yet.",
      "",
      "  pnpm install",
      "  pnpm -r --filter './packages/**' build      # or: pnpm build",
      "",
      `expected: ${built}`,
      "",
    ].join("\n"),
  );
  process.exit(3);
}

const { main } = await import(pathToFileURL(built).href);
process.exitCode = await main(process.argv.slice(2));
