/**
 * Paper cutout (SPEC §8.10 Character art, AC-SHEET-11): a phone photo of a drawing on paper → a clean transparent
 * sticker. Pure pixel work (runs in a worker; tested in Node): the paper's colour from the photo's border (median, in
 * Lab), a flood fill from the borders over everything within a tolerance of it (ΔE; gentle lighting gradients are
 * followed, the drawing isn't leaked into), specks under 0.5 % of the picture removed, the edge feathered by a pixel,
 * trimmed, and a white sticker outline and a soft drop shadow added.
 */

export interface CutoutOptions {
  /** How far from the paper's colour still counts as paper (CIE ΔE76). */
  tolerance: number;
  /** The sticker's white outline (px). */
  outline: number;
}

export const CUTOUT_DEFAULTS: CutoutOptions = { tolerance: 18, outline: 10 };

export interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** sRGB (0–255) → CIE Lab (D65). */
export function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** The paper's colour: the median Lab of the pixels along the photo's edges. */
export function paperColour(img: Rgba): [number, number, number] {
  const { data, width: w, height: h } = img;
  const L: number[] = [];
  const A: number[] = [];
  const Bb: number[] = [];
  const take = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    const [l, a, b] = toLab(data[o] as number, data[o + 1] as number, data[o + 2] as number);
    L.push(l);
    A.push(a);
    Bb.push(b);
  };
  const step = Math.max(1, Math.floor((w + h) / 400));
  for (let x = 0; x < w; x += step) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    take(0, y);
    take(w - 1, y);
  }
  return [median(L), median(A), median(Bb)];
}

/**
 * Which pixels are paper: a flood fill from the border. A pixel joins if it's within the tolerance of the paper's
 * colour, or — following shading across the page — close to the paper pixel next to it and not far from the paper.
 */
export function paperMask(img: Rgba, tolerance: number): Uint8Array {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = toLab(data[i * 4] as number, data[i * 4 + 1] as number, data[i * 4 + 2] as number);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  const [pl, pa, pb] = paperColour(img);
  const dPaper = (i: number) =>
    Math.hypot((lab[i * 3] as number) - pl, (lab[i * 3 + 1] as number) - pa, (lab[i * 3 + 2] as number) - pb);
  const dNext = (i: number, j: number) =>
    Math.hypot(
      (lab[i * 3] as number) - (lab[j * 3] as number),
      (lab[i * 3 + 1] as number) - (lab[j * 3 + 1] as number),
      (lab[i * 3 + 2] as number) - (lab[j * 3 + 2] as number),
    );
  const paper = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (i: number) => {
    if (!paper[i] && dPaper(i) <= tolerance) {
      paper[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++] as number;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (paper[j]) continue;
      const dp = dPaper(j);
      if (dp <= tolerance || (dNext(i, j) <= tolerance / 3 && dp <= tolerance * 2)) {
        paper[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  return paper;
}

/** Removes foreground specks smaller than `minArea` pixels (8-connected), in place; the mask is 1 for paper. */
export function removeSpecks(paper: Uint8Array, w: number, h: number, minArea: number): void {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (paper[s] || seen[s]) continue;
    comp.length = 0;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top] as number;
      comp.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
            const j = ny * w + nx;
            if (!paper[j] && !seen[j]) {
              seen[j] = 1;
              stack[top++] = j;
            }
          }
        }
    }
    if (comp.length < minArea) for (const i of comp) paper[i] = 1;
  }
}

/** Squared Euclidean distance (px²) from each pixel to the nearest foreground one (Felzenszwalb–Huttenlocher, O(n)). */
export function distanceToInk(ink: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = ink[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = 0;
      for (;;) {
        const vk = v[k] as number;
        s = ((f[q] as number) + q * q - ((f[vk] as number) + vk * vk)) / (2 * q - 2 * vk);
        if (s <= (z[k] as number)) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while ((z[k + 1] as number) < q) k++;
      const vk = v[k] as number;
      out[q] = (q - vk) * (q - vk) + (f[vk] as number);
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x] as number;
    pass(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y] as number;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x] as number;
    pass(w);
    for (let x = 0; x < w; x++) d[y * w + x] = out[x] as number;
  }
  return d;
}

/**
 * The sticker: the drawing on transparency (its edge feathered by a pixel), a white outline `outline` px wide round
 * it, a soft shadow below-right, trimmed to what shows. Paper inside the drawing (a drawn circle's middle) stays: only
 * paper reached from the edge goes.
 */
export function cutout(img: Rgba, opts: CutoutOptions = CUTOUT_DEFAULTS): Rgba {
  const { width: w, height: h, data } = img;
  const paper = paperMask(img, opts.tolerance);
  removeSpecks(paper, w, h, Math.max(4, Math.round(w * h * 0.005)));
  const ink = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    ink[i] = paper[i] ? 0 : 1;
    if (ink[i]) any = true;
  }
  const pad = opts.outline + 8;
  if (!any) return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  const dist = distanceToInk(ink, w, h);
  // Bounds of the sticker (the drawing grown by its outline), then the canvas with room for the shadow.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (ink[y * w + x]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  const ox = x0 - pad;
  const oy = y0 - pad;
  const W = x1 - x0 + 1 + 2 * pad;
  const H = y1 - y0 + 1 + 2 * pad;
  const outData = new Uint8ClampedArray(W * H * 4);
  const r = opts.outline;
  // Distance from the drawing at an output pixel (source coordinates; outside the photo, from its edge).
  const distAt = (sx: number, sy: number) => {
    const cx = Math.min(w - 1, Math.max(0, sx));
    const cy = Math.min(h - 1, Math.max(0, sy));
    const extra = Math.hypot(sx - cx, sy - cy);
    const base = Math.sqrt(dist[cy * w + cx] as number);
    return base + extra;
  };
  for (let Y = 0; Y < H; Y++)
    for (let X = 0; X < W; X++) {
      const sx = X + ox;
      const sy = Y + oy;
      const o = (Y * W + X) * 4;
      const d = distAt(sx, sy);
      // Drawing (feathered over its last pixel), then the white outline (its outer edge anti-aliased), then shadow.
      const inside = sx >= 0 && sy >= 0 && sx < w && sy < h && ink[sy * w + sx] === 1;
      if (inside) {
        const i = (sy * w + sx) * 4;
        // Feather: a pixel at the drawing's very edge (next to paper) is part-transparent over the outline's white.
        let edge = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = sx + dx;
          const ny = sy + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && !ink[ny * w + nx]) edge++;
        }
        const a = edge ? 0.6 : 1;
        const white = r > 0 ? 1 - a : 0;
        outData[o] = Math.round((data[i] as number) * a + 255 * white);
        outData[o + 1] = Math.round((data[i + 1] as number) * a + 255 * white);
        outData[o + 2] = Math.round((data[i + 2] as number) * a + 255 * white);
        outData[o + 3] = Math.round(255 * (r > 0 ? 1 : a));
        continue;
      }
      if (r > 0 && d <= r + 0.5) {
        const a = Math.min(1, r + 0.5 - d + 0.5);
        outData[o] = 255;
        outData[o + 1] = 255;
        outData[o + 2] = 255;
        outData[o + 3] = Math.round(255 * a);
        if (a >= 1) continue;
      }
      // The shadow: the sticker's shape, 3 px down and 2 right, softened over 5 px, at 35 %.
      const ds = distAt(sx - 2, sy - 3);
      const s = Math.max(0, Math.min(1, (r + 5 - ds) / 5)) * 0.35;
      if (s > 0 && outData[o + 3] === 0) outData[o + 3] = Math.round(255 * s);
      else if (s > 0) {
        // Under a part-transparent outline edge: shadow shows through.
        const a = (outData[o + 3] as number) / 255;
        const t = a + s * (1 - a);
        for (let k = 0; k < 3; k++) outData[o + k] = Math.round(((outData[o + k] as number) * a) / t);
        outData[o + 3] = Math.round(255 * t);
      }
    }
  return { data: outData, width: W, height: H };
}

/** The longest side at most `max` px (the worker downsizes a big phone photo before any of this). */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
