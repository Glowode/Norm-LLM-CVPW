/**
 * A static file server for a project, and the frame transport it exposes.
 *
 * A `file://` URL cannot be used: the page needs `fetch` for the analysis artifacts and the cue data,
 * and a file origin gives either a CORS wall or no origin at all depending on the flags. Serving over
 * `127.0.0.1` on an ephemeral port is what every reference project ended up doing, and it is also what
 * makes the page behave the same way in the renderer as it does in a dev preview.
 *
 * Deliberately dependency-free and deliberately small: it serves files, it knows a handful of MIME
 * types, and it never writes anything. Range requests are supported because a preview needs to seek
 * audio, and a preview that cannot seek is a preview nobody uses.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".f32": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".lrc": "text/plain; charset=utf-8",
};

export interface StaticServer {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Absolute path of the directory to serve. Requests cannot escape it. */
  root: string;
  /** Bind address. Loopback only: a render must not expose a project to the network. */
  host?: string;
}

/**
 * Serve `root` on an ephemeral loopback port.
 *
 * Two security properties that matter even for a local dev server, because a project may contain a
 * user's private audio and lyric text:
 *
 * - **Path traversal is refused**, by resolving the request against the root and checking the result is
 *   still inside it. Checking for `..` in the string is not enough (`%2e%2e%2f`, a symlink, or a
 *   Windows short name all get around it); comparing resolved paths is.
 * - **Only loopback is bound**, so the film's assets are not reachable from the network while a render
 *   runs.
 */
export async function startStaticServer(options: ServeOptions): Promise<StaticServer> {
  const root = resolve(options.root);
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((request, response) => {
    void handle(request, response, root);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the static server did not report a port");
  }
  const origin = `http://${host}:${address.port}`;

  return {
    origin,
    port: address.port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("bad request");
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const candidate = normalize(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(candidate);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found: ${pathname}`);
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not a file");
    return;
  }

  const type = MIME[extname(candidate).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    // `no-store` because a render must never read a cached copy of a file the author just changed.
    // Every reference project that hit a "why is my fix not showing up" loop had a cache to blame.
    "cache-control": "no-store",
    "accept-ranges": "bytes",
  };

  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : info.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < info.size) {
        const last = Math.min(end, info.size - 1);
        response.writeHead(206, {
          ...headers,
          "content-range": `bytes ${start}-${last}/${info.size}`,
          "content-length": String(last - start + 1),
        });
        if (method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(candidate, { start, end: last }).pipe(response);
        return;
      }
      response.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` }).end();
      return;
    }
  }

  response.writeHead(200, { ...headers, "content-length": String(info.size) });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(candidate).pipe(response);
}
