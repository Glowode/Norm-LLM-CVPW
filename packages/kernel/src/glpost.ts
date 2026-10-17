/**
 * The WebGL2 post chain.
 *
 * ## What this is, and what it deliberately is not
 *
 * Canvas2D remains the *only* thing that draws a scene. That is a deliberate constraint, not a stage of
 * migration: a frame that is a pure function of `t` is much easier to reason about when one renderer produces it,
 * and `docs/SPEC.md` D1–D3 are the framework's load-bearing promise. What WebGL2 adds is what Canvas2D genuinely
 * cannot do well — a thresholded, multi-radius bloom — because that needs two extra render targets, separable
 * blurs, and additive compositing in linear-ish space.
 *
 * So the pipeline per frame is:
 *
 * ```
 *   Canvas2D draws the frame  →  upload as a texture  →  WebGL2 pass chain  →  draw the GL canvas back
 * ```
 *
 * Two full-frame copies at 1080p cost a few milliseconds, which is a fair price for a bloom that is real. The
 * `cvpw check --only render.postApplied` gate guards the whole arrangement: if the chain silently stops running,
 * a declared grain stops changing the picture and the gate fails.
 *
 * ## Determinism
 *
 * Nothing here reads a clock, a random source, or the previous frame. Every pass is a pure function of the
 * uploaded texture and the declared numbers. Grain stays in Canvas2D precisely because it is keyed on the frame
 * index and already deterministic; moving it here would add a way to get that wrong for no gain.
 *
 * ## When WebGL2 is unavailable
 *
 * `available` is false and `apply()` returns false. The engine then falls back to its Canvas2D bloom, which is
 * cruder but correct. A headless browser without WebGL2 must still render the film — a post chain that fails
 * closed would make the framework unrunnable on a machine that only lost its GPU.
 */

/** The values this chain can act on. Everything else stays Canvas2D's job. */
export interface GLPostParams {
  /** 0..1. Bright areas are lifted and blurred into a halo. */
  bloom?: number;
  /** 0..1. Radial RGB separation, strongest at the frame edges. */
  chromatic?: number;
  /** Multiplier on colour, 1 = unchanged. */
  saturate?: number;
  /** Additive, 0 = unchanged. */
  brightness?: number;
  /** Pivot around 0.5; 1 = unchanged. */
  contrast?: number;
}

/** True when any value this chain can act on is non-neutral. */
export function wantsGLPost(params: GLPostParams): boolean {
  return (
    (params.bloom ?? 0) > 0 ||
    (params.chromatic ?? 0) > 0 ||
    (params.saturate ?? 1) !== 1 ||
    (params.brightness ?? 0) !== 0 ||
    (params.contrast ?? 1) !== 1
  );
}

export interface GLPost {
  readonly available: boolean;
  readonly reason: string;
  /** The canvas the result is drawn into. The caller composites it back onto its own 2D canvas. */
  readonly canvas: HTMLCanvasElement | null;
  /** Post-process `source` into this chain's canvas. Returns false if it did nothing. */
  apply(source: TexImageSource, params: GLPostParams, width: number, height: number): boolean;
  /** Present for tests: read a pixel for a sanity check without a screenshot. */
  readPixel(x: number, y: number): [number, number, number, number] | null;
  dispose(): void;
}

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Bright-pass: keep only what is brighter than the threshold, scaled so the kept range spans 0..1.
 *
 * A bloom that blurs the *whole* frame just makes the picture soft. The threshold is the difference between
 * "glow" and "out of focus", so it is not a tuning knob — it is the definition of the effect.
 */
const BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec4 c = texture(uSource, vUv);
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float keep = max(0.0, luma - uThreshold) / max(0.0001, 1.0 - uThreshold);
  outColor = vec4(c.rgb * keep, 1.0);
}`;

/** Separable gaussian, one axis per pass, so the cost is O(r) rather than O(r²). */
const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uDirection;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  // Nine taps with binomial weights: enough for a soft halo, cheap enough to run at full resolution twice.
  float weights[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  vec4 sum = texture(uSource, vUv) * weights[0];
  for (int i = 1; i < 5; i++) {
    vec2 offset = uDirection * uTexel * float(i);
    sum += texture(uSource, vUv + offset) * weights[i];
    sum += texture(uSource, vUv - offset) * weights[i];
  }
  outColor = sum;
}`;

/**
 * Composite: the graded source, plus the blur at the declared strength (additive), plus optional radial
 * chromatic separation applied last so it spreads the bloom as well as the picture.
 */
const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uChromatic;
uniform float uSaturate;
uniform float uBrightness;
uniform float uContrast;
out vec4 outColor;
void main() {
  vec3 base = texture(uSource, vUv).rgb;
  vec3 glow = texture(uBloom, vUv).rgb;
  vec3 col = base + glow * uBloomStrength * 3.0;

  if (uChromatic > 0.0) {
    // Radial separation grows toward the edges, so the centre of frame stays sharp — a uniform split reads as a
    // broken channel rather than as a lens.
    vec2 centred = vUv - 0.5;
    float r = length(centred) * 2.0;
    vec2 shift = centred * uChromatic * 0.02 * r;
    col.r = texture(uSource, vUv + shift).r;
    col.b = texture(uSource, vUv - shift).b;
  }
  // Colour operators, in the order a grade is normally applied: contrast around the midpoint, then saturation
  // by luminance, then exposure. They live here rather than in Canvas2D because a shader does them in one pass.
  col = (col - 0.5) * uContrast + 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturate);
  col += uBrightness;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const pixel = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vertex || !pixel) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, pixel);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(pixel);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function texture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Create the chain. `target` is the canvas the result is composited into. */
export function createGLPost(): GLPost {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    // `preserveDrawingBuffer` is required: the result is read back with `drawImage` after the frame ends, which a
    // default drawing buffer would have discarded.
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;

  if (!gl) {
    return {
      available: false,
      canvas: null,
      reason: "no WebGL2 context; falling back to the Canvas2D bloom",
      apply: () => false,
      readPixel: () => null,
      dispose: () => undefined,
    };
  }

  const bright = link(gl, BRIGHT);
  const blur = link(gl, BLUR);
  const composite = link(gl, COMPOSITE);
  if (!bright || !blur || !composite) {
    return {
      available: false,
      canvas: null,
      reason: "a post shader failed to compile; falling back to the Canvas2D bloom",
      apply: () => false,
      readPixel: () => null,
      dispose: () => undefined,
    };
  }

  // One full-screen triangle pair. A quad is two triangles; a triangle is one, and the diagonal is invisible here.
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(composite, "aPos");
  if (aPos >= 0) {
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);

  let source: WebGLTexture | null = null;
  let brightTex: WebGLTexture | null = null;
  let blurTex: WebGLTexture | null = null;
  let size = { width: 0, height: 0 };

  const ensure = (width: number, height: number): boolean => {
    if (size.width === width && size.height === height && source && brightTex && blurTex) return true;
    if (source) gl.deleteTexture(source);
    if (brightTex) gl.deleteTexture(brightTex);
    if (blurTex) gl.deleteTexture(blurTex);
    source = texture(gl, width, height);
    brightTex = texture(gl, width, height);
    blurTex = texture(gl, width, height);
    size = { width, height };
    return Boolean(source && brightTex && blurTex);
  };

  const draw = (program: WebGLProgram): void => {
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const uniform = (program: WebGLProgram, name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);

  return {
    available: true,
    canvas,
    reason: "WebGL2 post chain active",
    apply(image: TexImageSource, params, width, height) {
      const bloom = Math.max(0, Math.min(1, params.bloom ?? 0));
      const chromatic = Math.max(0, Math.min(1, params.chromatic ?? 0));
      if (!wantsGLPost(params)) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        size = { width: 0, height: 0 };
      }
      if (!ensure(width, height) || !source || !brightTex || !blurTex) return false;

      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);

      // Upload the finished Canvas2D frame.
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      // Bright-pass into brightTex.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, brightTex, 0);
      gl.useProgram(bright);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform1i(uniform(bright, "uSource"), 0);
      gl.uniform1f(uniform(bright, "uThreshold"), 0.6);
      draw(bright);

      // Separable blur, ping-ponging between blurTex and brightTex so both radii accumulate.
      const texelX = 1 / width;
      const texelY = 1 / height;
      let read = brightTex;
      let write = blurTex;
      for (const radius of [1, 2]) {
        for (const direction of [
          [radius, 0],
          [0, radius],
        ] as const) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, write, 0);
          gl.useProgram(blur);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, read);
          gl.uniform1i(uniform(blur, "uSource"), 0);
          gl.uniform2f(uniform(blur, "uDirection"), direction[0], direction[1]);
          gl.uniform2f(uniform(blur, "uTexel"), texelX, texelY);
          draw(blur);
          const swap = read;
          read = write;
          write = swap;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);

      // Composite to the canvas.
      gl.useProgram(composite);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform1i(uniform(composite, "uSource"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, read);
      gl.uniform1i(uniform(composite, "uBloom"), 1);
      gl.uniform1f(uniform(composite, "uBloomStrength"), bloom);
      gl.uniform1f(uniform(composite, "uChromatic"), chromatic);
      gl.uniform1f(uniform(composite, "uSaturate"), params.saturate ?? 1);
      gl.uniform1f(uniform(composite, "uBrightness"), params.brightness ?? 0);
      gl.uniform1f(uniform(composite, "uContrast"), params.contrast ?? 1);
      draw(composite);
      gl.bindVertexArray(null);
      return true;
    },
    readPixel(x, y) {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
    },
    dispose() {
      if (source) gl.deleteTexture(source);
      if (brightTex) gl.deleteTexture(brightTex);
      if (blurTex) gl.deleteTexture(blurTex);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(bright);
      gl.deleteProgram(blur);
      gl.deleteProgram(composite);
    },
  };
}
