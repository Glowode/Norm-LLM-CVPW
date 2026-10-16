/**
 * A dependency-free CDP client.
 *
 * Why hand-rolled rather than Playwright: `docs/ADRs/0004` chose a filesystem-first transport precisely
 * because it is resumable and debuggable, and the reference project that proved the approach
 * (`reference/abstract-algebra-promo`) drove Chrome over raw CDP with no dependencies at all. Playwright
 * would add ~50 MB of browser download and a version-coupling problem for a capability we need in a
 * narrow way: launch, navigate, evaluate, screenshot, close.
 *
 * The protocol surface used here is deliberately tiny — `Page.navigate`, `Runtime.evaluate`,
 * `Page.captureScreenshot` — and each one is a well-specified, stable part of CDP. Anything fancier
 * (input, tracing, Network interception) would belong in an adapter with a real client.
 *
 * What this module does NOT do: retry, reconnect, or recover. A render that loses its browser is a
 * failed render, and a half-recovered one is a worse outcome than a clean failure (`docs/SPEC.md` P6).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CdpTarget {
  id: string;
  webSocketDebuggerUrl?: string;
  type: string;
  url: string;
}

export class CdpError extends Error {
  constructor(message: string, readonly method?: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

/** One launched browser. Closing it MUST be the caller's responsibility, in a `finally`. */
export class Browser {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly profileDir: string,
    readonly port: number,
  ) {}

  /**
   * Launch a browser and connect a CDP session.
   *
   * The profile directory is created under an **ASCII-only** temp path (`docs/SPEC.md` P4): a
   * non-ASCII `--user-data-dir` breaks profile creation outright on this platform, and the failure
   * looks like a browser that will not start for no reason.
   */
  static async launch(options: {
    executable: string;
    args?: readonly string[];
    timeoutMs?: number;
    /** An ASCII-safe temp root. Defaults to the system temp directory. */
    tempRoot?: string;
  }): Promise<Browser> {
    const base = options.tempRoot ?? join(tmpdir(), "cvpw");
    // `mkdtemp` needs the parent to exist. Creating it is the caller's intent either way — and a
    // missing parent producing `ENOENT` on `mkdtemp` reads as a mysterious path error rather than as
    // "the temp root was never created".
    await mkdir(base, { recursive: true });
    // Sweep first, so a profile left by a killed run cannot collide with the one about to be created.
    await sweepStaleProfiles(base);
    const profileDir = await mkdtemp(join(base, "profile-"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-background-networking",
      "--mute-audio",
      "--hide-scrollbars",
      ...(options.args ?? []),
      "about:blank",
    ];

    const child = spawn(options.executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const portFile = join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let port: number | undefined;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const first = readDebuggingPort(portFile);
        if (first !== null) {
          port = first;
          break;
        }
      }
      if (child.exitCode !== null) {
        throw new CdpError(
          `the browser exited with code ${child.exitCode} before opening a debugging port; ` +
            `stderr: ${await drain(child)}`,
        );
      }
      await sleep(100);
    }
    if (port === undefined) {
      child.kill();
      throw new CdpError(`the browser did not open a debugging port within ${options.timeoutMs ?? 60_000} ms`);
    }

    const browser = new Browser(child, profileDir, port);
    await browser.connect();
    return browser;
  }

  private async connect(): Promise<void> {
    // Ask the browser endpoint for a page target, rather than guessing a target id. `/json/list` is the
    // documented HTTP endpoint and it is stable; constructing a `/devtools/page/<id>` URL from the
    // DevToolsActivePort's second line works only for the initial about:blank and breaks as soon as a
    // page navigates or a service worker appears.
    const targets = await this.httpJson<CdpTarget[]>(`/json/list`);
    const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
    if (!page?.webSocketDebuggerUrl) {
      throw new CdpError("the browser exposed no page target with a WebSocket URL");
    }
    await this.connectTo(page.webSocketDebuggerUrl);
  }

  /** Connect to a raw WebSocket debugger URL. Used by {@link connect} and by tests. */
  async connectTo(webSocketDebuggerUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      this.socket = socket;
      const onOpen = (): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = (event: unknown): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        const message =
          event instanceof Error ? event.message : (event as { message?: string })?.message ?? "websocket error";
        reject(new CdpError(`could not open a CDP connection: ${message}`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("message", (event: MessageEvent) => this.onMessage(String(event.data)));
      socket.addEventListener("close", () => this.onClose());
    });
  }

  private onClose(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new CdpError(`the browser connection closed while awaiting ${pending.method}`, pending.method));
    }
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return; // CDP emits the odd non-JSON frame; ignoring it is correct and cheaper than failing
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CdpError(`${pending.method}: ${message.error.message}`, pending.method));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    }
  }

  on(event: string, listener: (params: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  /** Send a CDP command. Every call has a timeout: a hung browser must fail, not hang a render. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the browser connection is closed", method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} did not answer within ${timeoutMs} ms`, method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.socket?.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value. Throws on an in-page exception. */
  async evaluate<T>(expression: string, options: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const result = await this.send<{
      result: { value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? false,
        userGesture: false,
      },
      options.timeoutMs ?? 120_000,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new CdpError(`page exception: ${detail}`, "Runtime.evaluate");
    }
    return result.result.value as T;
  }

  /**
   * Pin the viewport to an exact size before navigating.
   *
   * **Without this, capture is silently wrong.** A browser launched with no window-size argument gets a
   * default window of roughly 800x600, so a page holding a 1920x1080 canvas is laid out with CSS-pixel
   * dimensions far smaller than the canvas, and `Page.captureScreenshot` returns only the top-left corner
   * of the film. Nothing errors: the PNG is a plausible size, it opens, and it is a crop. The first render
   * through this framework produced four stills of a 756x488 corner and a black rectangle, which reads as
   * "the scene draws nothing" rather than "the viewport is the wrong shape".
   *
   * `deviceScaleFactor` is set by the caller rather than derived here, because it is the supersampling
   * decision (`dpr`), which belongs to the render request and not to the transport.
   */
  async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new CdpError(`refusing a ${width}x${height} viewport`, "Emulation.setDeviceMetricsOverride");
    }
    await this.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: Math.round(width),
        height: Math.round(height),
        deviceScaleFactor,
        mobile: false,
        // The canvas is the whole page, so the visible viewport and the layout viewport must agree —
        // otherwise a scrollbar or an inset shifts the film inside the capture.
        screenWidth: Math.round(width),
        screenHeight: Math.round(height),
      },
      15_000,
    );
  }

  /**
   * Force the page's canvas work to finish before returning.
   *
   * **This is the fix for the worst bug this framework has had, and it is not obvious.** Canvas drawing is
   * queued and returns immediately; a screenshot taken afterwards can rasterise a frame whose draw calls
   * have not all executed. Nothing errors, nothing warns, and the result depends on how much other work is
   * queued — which means it depends on how far a worker has walked and how often it has captured. Measured
   * consequences, all on the reference template:
   *
   *   - `--workers 4` produced a **different film** from `--workers 1`: 4 of 24 sampled frames differed, and
   *     the MP4 differed by 2.5 KB. That is the one thing the FrameSink ordering invariant cannot prevent.
   *   - The same `t` produced **three different images** in three sessions that differed only in where their
   *     walk began, while `engine.problems` stayed empty and the scene's own arithmetic — printed into the
   *     frame as text — was identical to nine decimal places in all three.
   *
   * A one-pixel `getImageData` read is a synchronisation point: it forces queued drawing to complete and
   * cannot itself change a pixel. Measured with it: a whole-film walk and a chunk starting at frame 180 agree
   * on every sampled frame. Without it: they disagree on all of them.
   */
  async flush(timeoutMs = 30_000): Promise<void> {
    await this.evaluate(
      `(function(){
        var c = document.getElementById("out") || document.querySelector("canvas");
        if (!c) return false;
        var g = c.getContext("2d");
        if (!g) return false;
        g.getImageData(0, 0, 1, 1);
        return true;
      })()`,
      { timeoutMs },
    );
  }

  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    await this.send("Page.enable", {}, 10_000);
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`navigation to ${url} timed out`, "Page.navigate")), timeoutMs);
      this.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.send("Page.navigate", { url }, 30_000);
    await loaded;
  }

  /** Capture the viewport as JPEG or PNG bytes. */
  async screenshot(options: { format?: "jpeg" | "png"; quality?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
    const format = options.format ?? "jpeg";
    const result = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format,
        ...(format === "jpeg" ? { quality: Math.round((options.quality ?? 0.94) * 100) } : {}),
        captureBeyondViewport: false,
        fromSurface: true,
      },
      options.timeoutMs ?? 120_000,
    );
    return Buffer.from(result.data, "base64");
  }

  /** The browser's own version string, recorded in the render report. */
  async version(): Promise<{ product: string; protocolVersion: string }> {
    return this.httpJson<{ product: string; protocolVersion: string }>("/json/version");
  }

  private async httpJson<T>(path: string): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`);
    if (!response.ok) throw new CdpError(`HTTP ${response.status} from ${path}`);
    return (await response.json()) as T;
  }

  /** Close the connection and the process, and remove the profile. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new CdpError("browser closing", pending.method));
    }
    this.pending.clear();
    try {
      await this.send("Browser.close", {}, 5_000);
    } catch {
      /* the browser may already be gone; the kill below is the backstop */
    }
    this.socket?.close();
    if (this.child.exitCode === null) {
      this.child.kill();
      // Give it a moment to die before removing its profile, which it holds open on Windows.
      await sleep(300);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
}

async function drain(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      text += chunk;
    });
    setTimeout(() => resolve(text.trim().slice(-400) || "(no stderr)"), 250);
  });
}

/**
 * Read the debugging port, tolerating the moment when the file exists but is not yet readable.
 *
 * Chromium creates `DevToolsActivePort` and *then* writes it, and on Windows the create is visible before
 * the write completes — so `existsSync` is true while `readFileSync` fails with `EBUSY`. That window is a
 * few milliseconds wide and it sits on the startup path of every worker, which makes it a rare,
 * load-dependent, unattributable failure: two workers launch at once, one reads the other's half-written
 * file, and the render dies with `EBUSY: resource busy or locked` naming a file the operator never chose.
 * Returning null so the poll loop tries again is the whole fix.
 */
function readDebuggingPort(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    const first = Number(text.split(/\r?\n/)[0]);
    return Number.isInteger(first) && first > 0 ? first : null;
  } catch {
    // Not ready yet. The caller's loop retries in 100 ms and the deadline still applies.
    return null;
  }
}

/**
 * Remove profile directories left behind by a run that was killed.
 *
 * A killed render never reaches `close()`, so its Chromium profile survives — and a surviving profile is
 * not merely wasted disk. On Windows the directory stays locked by whatever process is still shutting down,
 * so a later launch fails with an error about a temp file. Sweeping is what makes a killed render
 * recoverable by simply running the command again, which is the behaviour an interrupted operator expects.
 *
 * Best-effort by design: a profile still locked by a *live* browser stays, and that is correct — removing it
 * would break a render that is legitimately in progress.
 */
async function sweepStaleProfiles(base: string): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith("profile-")) continue;
    try {
      await rm(join(base, entry), { recursive: true, force: true, maxRetries: 2 });
      removed++;
    } catch {
      // Locked by a live browser: correct to leave alone.
    }
  }
  return removed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
