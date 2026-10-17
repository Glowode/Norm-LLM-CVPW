/**
 * PNG encoding, on the Node side.
 *
 * The kernel produces pixels and cannot encode them: it runs in a browser, where there is no `zlib` and no
 * `Buffer`. This module is the other half, and it owns the determinism guarantee for generated assets — a fixed
 * filter type, a fixed compression level and a fixed chunk order, so the same pixels always produce the same
 * bytes and the `sha256` recorded in `assets/manifest.json` keeps meaning something.
 *
 * Using a PNG library here would put a dependency's output in the middle of that promise. A new version with a
 * different default compression level would change every recorded hash, and the failure would surface as
 * "`assets.manifest` says the hash is wrong" long after the upgrade, with no recorded reason.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tableCache: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (tableCache) return tableCache;
  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    built[n] = c >>> 0;
  }
  tableCache = built;
  return built;
}

function crc32(buffer: Buffer): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = ((table[(crc ^ (buffer[i] as number)) & 0xff] as number) ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode straight-alpha RGBA pixels as a PNG. The only inputs are the pixels and the size. */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: ${rgba.length} bytes is not ${width}x${height}x4`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Filter byte 0 ("None") on every row. Adaptive filtering would make the bytes depend on a heuristic the
  // standard does not pin down, which is the one thing this encoder exists to avoid.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
