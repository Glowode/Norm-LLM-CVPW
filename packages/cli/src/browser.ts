/**
 * Browser discovery and headless probing.
 *
 * `docs/SPEC.md` P5: discover, never hard-code. The prior-art projects that hard-coded an absolute
 * browser path are unusable on any other machine — and one of them hard-coded a path inside the
 * author's home directory, which stops working after a reinstall *on that same machine*.
 *
 * `docs/SPEC.md` P6: probe, never assume. `detectRenderer` is reported by `doctor`, and a software
 * rasteriser is a warning with a stated cost rather than a silent slowdown.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

import { run } from "./shared.js";

export interface BrowserInfo {
  name: string;
  path: string;
  /** Where the discovery came from, so `doctor` can explain a surprise. */
  source: "env" | "known-path" | "playwright-cache" | "which";
}

/** Candidates in priority order. Chromium first: it is what Playwright ships and what CI has. */
function candidatePaths(): Array<{ name: string; path: string }> {
  const home = homedir();
  const out: Array<{ name: string; path: string }> = [];

  if (platform() === "win32") {
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    out.push(
      { name: "Google Chrome", path: join(programFiles, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Google Chrome", path: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Microsoft Edge", path: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Microsoft Edge", path: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Chromium", path: join(localAppData, "Chromium", "Application", "chrome.exe") },
    );
  } else if (platform() === "darwin") {
    out.push(
      { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    );
  } else {
    out.push(
      { name: "Google Chrome", path: "/usr/bin/google-chrome" },
      { name: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
      { name: "Chromium", path: "/usr/bin/chromium" },
      { name: "Chromium", path: "/usr/bin/chromium-browser" },
      { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
      { name: "Snap Chromium", path: "/snap/bin/chromium" },
    );
  }

  // A Playwright browser download, if one exists. Checked last so a real system browser wins, since
  // the system browser is the one the operator can also open and look at.
  const playwrightRoots = [
    join(home, ".cache", "ms-playwright"),
    join(process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
  ];
  for (const root of playwrightRoots) {
    if (!existsSync(root)) continue;
    const exe =
      platform() === "win32"
        ? ["chrome-win", "chrome.exe"]
        : platform() === "darwin"
          ? ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]
          : ["chrome-linux", "chrome"];
    out.push({ name: "Playwright Chromium", path: join(root, ...exe) });
  }

  return out;
}

/**
 * Find a browser.
 *
 * `CVPW_BROWSER` wins outright; `CVPW_BROWSER_CHANNEL` names a known product; then the platform's
 * usual install locations. A missing browser is reported, not worked around: nothing in this
 * framework can render without one, and silently downloading a second copy of Chromium is a decision
 * the operator should make.
 */
export function detectBrowser(): BrowserInfo | null {
  const explicit = process.env["CVPW_BROWSER"];
  if (explicit) {
    if (existsSync(explicit)) return { name: "CVPW_BROWSER", path: explicit, source: "env" };
    return null;
  }

  const channel = process.env["CVPW_BROWSER_CHANNEL"]?.toLowerCase();
  for (const candidate of candidatePaths()) {
    if (!existsSync(candidate.path)) continue;
    if (channel && !candidate.name.toLowerCase().includes(channel)) continue;
    return { name: candidate.name, path: candidate.path, source: "known-path" };
  }
  return null;
}

export interface RendererProbe {
  ok: boolean;
  renderer: string;
  software: boolean;
  /** Why the probe could not run, when it could not. */
  error?: string;
}

const SOFTWARE_MARKERS = ["swiftshader", "warp", "llvmpipe", "softpipe", "software", "basic render", "mesa offscreen"];

/**
 * Ask the browser what it actually renders with.
 *
 * Runs a real headless instance against a data URL, so the answer is the answer for *this* machine
 * with *these* flags — not a guess from the GPU's marketing name. Reported as `software: true` for
 * SwiftShader / WARP / llvmpipe, which is roughly ten times slower than hardware and whose float
 * behaviour differs, making a render produced under it a different artefact.
 */
export async function headlessProbe(
  browser: BrowserInfo,
  options: { timeoutMs?: number } = {},
): Promise<RendererProbe> {
  const html = `<!doctype html><meta charset="utf-8"><body><script>
try {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  let name = 'no webgl';
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  }
  document.title = 'RENDERER:' + name;
} catch (e) { document.title = 'RENDERER:error ' + e.message; }
</script></body>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const r = await run(
    browser.path,
    [
      "--headless=new",
      "--disable-gpu-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--virtual-time-budget=3000",
      "--dump-dom",
      url,
    ],
    { timeoutMs: options.timeoutMs ?? 90_000 },
  );

  const dom = `${r.stdout}\n${r.stderr}`;
  const m = /RENDERER:([^\n<]*)/.exec(dom);
  if (!m) {
    return {
      ok: false,
      renderer: "probe failed",
      software: false,
      error: r.spawnFailed
        ? `could not launch the browser: ${r.error ?? "unknown"}`
        : `the browser did not report a renderer (exit ${r.code})`,
    };
  }
  const renderer = m[1]?.trim() ?? "unknown";
  const lower = renderer.toLowerCase();
  return { ok: true, renderer, software: SOFTWARE_MARKERS.some((s) => lower.includes(s)) };
}

/** GPU flags for a real render. Kept here so the probe and the renderer agree on the environment. */
export function gpuArgs(): string[] {
  const angle = process.env["CVPW_BROWSER_ANGLE"];
  const args = ["--ignore-gpu-blocklist", "--enable-gpu"];
  if (angle) {
    args.push(`--use-angle=${angle}`);
  } else if (platform() === "win32") {
    // D3D11 is what ANGLE picks on Windows anyway; naming it keeps the two machines' reports comparable.
    args.push("--use-angle=d3d11");
  } else if (platform() === "darwin") {
    args.push("--use-angle=metal");
  }
  return args;
}

/** Flags that keep a long render from being throttled by the browser's own heuristics. */
export function renderArgs(): string[] {
  return [
    ...gpuArgs(),
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
  ];
}
