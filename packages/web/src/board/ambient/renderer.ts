/**
 * The full-screen fragment-shader renderer behind `ShaderCanvas`, shared by its worker path (OffscreenCanvas) and
 * its main-thread fallback. Raw WebGL 1: context creation costs a quarter of WebGL 2's on software GL and the
 * ambient shaders are GLSL ES 1.0.
 */
export type Uniforms = Record<string, number | [number, number, number]>;

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

export interface ShaderRenderer {
  /** Draws one frame at `timeSec` into a `w × h` drawing buffer. */
  draw(timeSec: number, w: number, h: number, uniforms: Uniforms): void;
  /** Frees the GPU context (synchronous: waits behind any queued frames). */
  dispose(): void;
}

export const CONTEXT_ATTRIBUTES = (preserve: boolean): WebGLContextAttributes => ({
  antialias: false,
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: preserve,
});

export function createShaderRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  frag: string,
  preserve: boolean,
  onRestored?: () => void,
): ShaderRenderer | null {
  const gl = canvas.getContext("webgl", CONTEXT_ATTRIBUTES(preserve)) as WebGLRenderingContext | null;
  if (!gl) return null;
  // Fetched now, while the command queue is idle — getExtension is a synchronous GPU-process round trip.
  const lose = gl.getExtension("WEBGL_lose_context");
  // Everything the context holds — made again when a lost context is given back (a phone short of graphics memory, a
  // driver reset): the shader, the triangle, the uniform locations. Returns the uniform lookup, or null.
  const setup = () => {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram() as WebGLProgram;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision mediump float;\n${frag}`));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    // Uniform locations are looked up once (each lookup is a synchronous round trip).
    const locations = new Map<string, WebGLUniformLocation | null>();
    return (name: string) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(prog, name));
      return locations.get(name) ?? null;
    };
  };
  let at = setup();
  if (!at) {
    lose?.loseContext();
    return null;
  }
  let disposed = false;
  onContextRestored(canvas, () => {
    if (disposed) return;
    at = setup();
    onRestored?.();
  });
  return {
    draw(timeSec, w, h, uniforms) {
      // (Lost: nothing to draw with until it's given back.)
      if (!at || gl.isContextLost()) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform1f(at("uTime"), timeSec);
      gl.uniform2f(at("uRes"), w, h);
      for (const [k, v] of Object.entries(uniforms)) {
        const l = at(k);
        if (!l) continue;
        if (typeof v === "number") gl.uniform1f(l, v);
        else gl.uniform3f(l, v[0], v[1], v[2]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      disposed = true;
      lose?.loseContext();
    },
  };
}

/**
 * A lost WebGL context given back: `fn` runs once it's usable again. (The loss is accepted — preventDefault — or the
 * browser never gives it back.) WebGL names the events alike on a canvas element and an OffscreenCanvas; the plain
 * `contextlost`/`contextrestored` pair is listened to as well, and each loss is answered once.
 */
function onContextRestored(canvas: HTMLCanvasElement | OffscreenCanvas, fn: () => void): void {
  const target = canvas as EventTarget;
  let lost = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onBack = () => {
    if (!lost) return;
    lost = false;
    fn();
  };
  for (const t of ["webglcontextlost", "contextlost"]) target.addEventListener(t, onLost);
  for (const t of ["webglcontextrestored", "contextrestored"]) target.addEventListener(t, onBack);
}

/**
 * One GL context drawing many fragment shaders (the shared ambient worker): each shader is compiled once and kept
 * for the page's lifetime, so no screen change ever creates or destroys a context — on software GL, releasing one
 * froze every other context (the board included) for seconds.
 */
export interface MultiShaderGl {
  /** Draws `frag` into a `w × h` buffer; false when the shader didn't compile. */
  draw(frag: string, timeSec: number, w: number, h: number, uniforms: Uniforms): boolean;
  /** The context is lost: nothing draws (and nothing fails) until it's given back. */
  lost(): boolean;
}

export function createMultiShaderGl(canvas: OffscreenCanvas, onRestored?: () => void): MultiShaderGl | null {
  const gl = canvas.getContext("webgl", CONTEXT_ATTRIBUTES(false)) as WebGLRenderingContext | null;
  if (!gl) return null;
  interface Prog {
    prog: WebGLProgram;
    loc: number;
    locations: Map<string, WebGLUniformLocation | null>;
  }
  let vert = null as unknown as WebGLShader;
  let programs = new Map<string, Prog | null>();
  let current: Prog | null = null;
  // The triangle and the vertex shader — made again, and each fragment shader compiled again as it's next drawn, when
  // a lost context is given back.
  const setup = () => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    vert = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
    gl.shaderSource(vert, VERT);
    gl.compileShader(vert);
    programs = new Map();
    current = null;
  };
  setup();
  onContextRestored(canvas, () => {
    setup();
    onRestored?.();
  });
  const program = (frag: string): Prog | null => {
    if (programs.has(frag)) return programs.get(frag) ?? null;
    const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
    gl.shaderSource(fs, `precision mediump float;\n${frag}`);
    gl.compileShader(fs);
    const prog = gl.createProgram() as WebGLProgram;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
    const p = ok ? { prog, loc: gl.getAttribLocation(prog, "p"), locations: new Map() } : null;
    programs.set(frag, p);
    return p;
  };
  return {
    lost: () => gl.isContextLost(),
    draw(frag, timeSec, w, h, uniforms) {
      const p = program(frag);
      if (!p) return false;
      if (current !== p) {
        // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
        gl.useProgram(p.prog);
        gl.enableVertexAttribArray(p.loc);
        gl.vertexAttribPointer(p.loc, 2, gl.FLOAT, false, 0, 0);
        current = p;
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const at = (name: string) => {
        if (!p.locations.has(name)) p.locations.set(name, gl.getUniformLocation(p.prog, name));
        return p.locations.get(name) ?? null;
      };
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(at("uTime"), timeSec);
      gl.uniform2f(at("uRes"), w, h);
      for (const [k, v] of Object.entries(uniforms)) {
        const l = at(k);
        if (!l) continue;
        if (typeof v === "number") gl.uniform1f(l, v);
        else gl.uniform3f(l, v[0], v[1], v[2]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
  };
}

/**
 * A ≤ 30 fps animation loop over a renderer (or one still frame for reduced motion). `schedule` is the host's
 * frame callback — `requestAnimationFrame` on the page and in workers that have it, a 33 ms timer otherwise.
 */
export function runLoop(opts: {
  renderer: ShaderRenderer;
  still: boolean;
  size: () => { w: number; h: number };
  uniforms: () => Uniforms;
  schedule: (fn: (now: number) => void) => () => void;
  onFirstFrame: () => void;
}): { pause(): void; resume(): void; stop(): void } {
  const t0 = performance.now();
  let last = 0;
  let first = true;
  let cancel: (() => void) | null = null;
  let running = false;
  const frame = (now: number) => {
    cancel = opts.still || !running ? null : opts.schedule(frame);
    if (!opts.still && now - last < 33) return;
    last = now;
    const { w, h } = opts.size();
    if (w < 1 || h < 1) return;
    opts.renderer.draw(opts.still ? 12 : (now - t0) / 1000, w, h, opts.uniforms());
    if (first) {
      first = false;
      opts.onFirstFrame();
    }
  };
  const resume = () => {
    if (running) return;
    running = true;
    cancel = opts.schedule(frame);
  };
  const pause = () => {
    running = false;
    cancel?.();
    cancel = null;
  };
  resume();
  return {
    pause,
    // A size change under reduced motion needs a fresh still frame.
    resume: () => {
      if (opts.still) {
        running = true;
        cancel = opts.schedule(frame);
      } else resume();
    },
    stop: pause,
  };
}
