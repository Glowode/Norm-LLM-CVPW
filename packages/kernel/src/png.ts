/**
 * Procedural asset generators — pixels only, no encoder.
 *
 * ## The encoder lives in the CLI, not here
 *
 * This module produces PIXELS and nothing else, because the kernel runs in a browser and has no `zlib`, no
 * `Buffer` and no filesystem. Turning pixels into PNG bytes is the CLI's job (packages/cli/src/png.ts), which is
 * also where the determinism guarantee lives: a fixed filter type, a fixed compression level and a fixed chunk
 * order, so an asset regenerates to identical bytes and its recorded `sha256` keeps meaning something. Using a PNG
 * library would put a dependency's output in the middle of that promise.
 */


/**
 * The deterministic value noise every procedural generator uses.
 *
 * A hash of integer coordinates, not a PRNG with state: the value at (x, y, seed) is the same on any machine, in
 * any order, with no chance of a generator drifting because one caller asked for pixels in a different sequence.
 */
function noise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 4096) / 4096;
}

/** Smoothly interpolated noise, so an edge does not read as television static. */
function smoothNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = noise(ix, iy, seed);
  const b = noise(ix + 1, iy, seed);
  const c = noise(ix, iy + 1, seed);
  const d = noise(ix + 1, iy + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

export interface GeneratedAsset {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * The generators a manifest may name. Each is a pure function of its arguments, so `generator` plus its params
 * fully determine the bytes — which is what makes the recorded `sha256` meaningful.
 */
export type GeneratorName = "paper" | "flat";

export function generate(name: GeneratorName, params: Record<string, unknown>): GeneratedAsset {
  const width = Math.max(1, Math.round(Number(params["width"] ?? 512)));
  const height = Math.max(1, Math.round(Number(params["height"] ?? 512)));
  const seed = Math.round(Number(params["seed"] ?? 1));
  const base = typeof params["color"] === "string" ? (params["color"] as string) : "#140b1e";
  const rgb = [parseInt(base.slice(1, 3), 16) || 0, parseInt(base.slice(3, 5), 16) || 0, parseInt(base.slice(5, 7), 16) || 0];
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (name === "flat") {
        rgba[i] = rgb[0] as number;
        rgba[i + 1] = rgb[1] as number;
        rgba[i + 2] = rgb[2] as number;
        rgba[i + 3] = 255;
        continue;
      }
      // `paper`: two octaves of value noise around the base colour, plus a faint fibre pattern. The amount is a
      // declared parameter, so a project can make the texture as visible or as quiet as its budget allows.
      const amount = Math.max(0, Math.min(1, Number(params["amount"] ?? 0.06)));
      const scale = Number(params["scale"] ?? 4);
      const n = smoothNoise((x / width) * scale, (y / height) * scale, seed) * 0.75 +
        smoothNoise((x / width) * scale * 3, (y / height) * scale * 3, seed + 17) * 0.25;
      const shift = (n - 0.5) * 2 * amount * 255;
      rgba[i] = (rgb[0] as number) + shift;
      rgba[i + 1] = (rgb[1] as number) + shift;
      rgba[i + 2] = (rgb[2] as number) + shift;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width, height };
}
