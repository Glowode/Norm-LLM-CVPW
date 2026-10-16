/**
 * Running external processes, with the two platform hazards this framework has actually hit.
 *
 * Extracted from the CLI's copy so that `@cvpw/render` does not have to import `@cvpw/cli` — the
 * dependency direction in `docs/ARCHITECTURE.md` runs the other way, and a render package that depends on
 * the command line can no longer be used by anything else.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** `true` when the process could not be started at all, which is different from a non-zero exit. */
  spawnFailed: boolean;
  error?: string;
}

/**
 * Run a process to completion.
 *
 * Two environment variables are forced on every child, and both are load-bearing rather than tidy:
 * `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, because the reference machine's console code page is 936
 * and a Python child that prints a CJK character or a `€` dies with `UnicodeEncodeError` — a failure that
 * looks like a bug in the script and is actually a bug in how it was launched.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...options.env,
      },
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({
        code: -1,
        stdout: "",
        stderr: "",
        spawnFailed: true,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            finish({
              code: -1,
              stdout,
              stderr,
              spawnFailed: false,
              error: `timed out after ${options.timeoutMs} ms`,
            });
          }, options.timeoutMs)
        : undefined;

    // Explicit UTF-8 decoding on both streams: the default on this platform is the ANSI code page, which
    // would turn ffmpeg's output into mojibake before we ever look at it.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      if (timer) clearTimeout(timer);
      finish({ code: -1, stdout, stderr, spawnFailed: true, error: error.message });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr, spawnFailed: false });
    });
  });
}

/** The first non-empty line of a tool's `--version` output, or null. Never throws. */
export async function version(command: string, args: readonly string[] = ["--version"]): Promise<string | null> {
  const result = await run(command, args, { timeoutMs: 15_000 });
  if (result.spawnFailed) return null;
  const text = `${result.stdout}\n${result.stderr}`;
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? null;
}
