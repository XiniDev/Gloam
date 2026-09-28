/**
 * Dice faces (SPEC §18.4): one canvas-drawn texture per die kind, skin and face set — each face its own cell, the
 * body colour with a darker rim at the face's edges (a bevel without the geometry), the number in the display face
 * (Fraunces, outlined in ink so it reads on any reflection; 6 and 9 underlined), the d4's three corner numbers pointing to their corners, "?" for masked rolls, and
 * 00–90 on a percentile tens die. Geometry per die kind with each face's UVs in its cell.
 */

import { DATA_TEXTURE } from "@gloam/shared/constants";
import type { DiceSkin } from "@gloam/shared/dice";
import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  NoColorSpace,
  SRGBColorSpace,
  Vector3,
} from "three";
import { C } from "../board/colors.ts";
import { again } from "../board/frames.ts";
import type { Solid } from "./solids.ts";

export type FaceSet = "values" | "tens" | "masked";

const CELL = 256;
const COLS = 5;

interface FaceLayout {
  /** The face's corners in its own plane (u, v), and its centre. */
  corners: [number, number][];
  centre: [number, number];
  /** Scale: plane units → cell pixels. */
  k: number;
}

function faceBasis(s: Solid, f: number): { u: Vector3; v: Vector3; n: Vector3; o: Vector3 } {
  const face = s.faces[f] as number[];
  const n = s.normals[f] as Vector3;
  const o = new Vector3();
  for (const i of face) o.add(s.vertices[i] as Vector3);
  o.divideScalar(face.length);
  const u = new Vector3()
    .subVectors(s.vertices[face[0] as number] as Vector3, o)
    .projectOnPlane(n)
    .normalize();
  const v = new Vector3().crossVectors(n, u).normalize();
  return { u, v, n, o };
}

function layout(s: Solid, f: number): FaceLayout {
  const { u, v, o } = faceBasis(s, f);
  const corners = (s.faces[f] as number[]).map((i): [number, number] => {
    const d = new Vector3().subVectors(s.vertices[i] as Vector3, o);
    return [d.dot(u), d.dot(v)];
  });
  const r = Math.max(...corners.map(([x, y]) => Math.hypot(x, y)));
  return { corners, centre: [0, 0], k: (CELL * 0.46) / r };
}

/** The label a face shows as text. */
function faceText(s: Solid, f: number, set: FaceSet): string {
  if (set === "masked") return "?";
  const label = s.labels[f] as number;
  if (set === "tens") return label === 0 ? "00" : String(label * 10);
  return String(label);
}

/** The display face (SPEC §18.4 "numbers in Fraunces"; §27.3), as the app registers it. */
const FACE = '"Fraunces Variable", Georgia, serif';
const FACE_CHECK = '700 64px "Fraunces Variable"';

/** How an atlas is painted: a skin's colours, or a metal die's enamel mask (white metal, black numerals). */
interface Paint {
  body: string;
  number: string;
  /** Round every light numeral (it reads on any reflection); the mask counts it as enamel. Dark numerals have none. */
  outline: string | null;
  /** The darker rim at each face's edge (the colour atlas only). */
  bevel: boolean;
  /** A light inner rim just inside the edge (metal: the bevel catching the light). */
  rim: string | null;
}

const atlases = new Map<string, CanvasTexture>();

/** Draws an atlas now and again once the display face has loaded (drawn before, it would show a fallback font). */
function atlas(
  key: string,
  s: Solid,
  set: FaceSet,
  paint: Paint,
  space: typeof SRGBColorSpace | typeof NoColorSpace,
) {
  const hit = atlases.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * Math.ceil(s.faces.length / COLS);
  drawFaces(canvas, s, set, paint);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = space;
  tex.anisotropy = 4;
  atlases.set(key, tex);
  whenFaceLoaded(() => {
    drawFaces(canvas, s, set, paint);
    tex.needsUpdate = true;
  });
  return tex;
}

let waiting: (() => void)[] | null = null;
function whenFaceLoaded(fn: () => void): void {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts || fonts.check(FACE_CHECK)) return;
  if (!waiting) {
    waiting = [];
    void fonts
      .load(FACE_CHECK)
      .then(() => {
        const list = waiting ?? [];
        waiting = null;
        for (const f of list) f();
        again();
      })
      .catch(() => {
        waiting = null;
      });
  }
  waiting.push(fn);
}

/** Loads the dice's display face ahead of the first throw (with the physics, while the table is idle). */
export function preloadDiceFace(): void {
  if (typeof document !== "undefined") void document.fonts?.load(FACE_CHECK).catch(() => {});
}

/** Relative luminance of a #RRGGBB colour, 0–1. */
function luminance(hex: string): number {
  const lin = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
}

/** Light numerals get an ink outline (they'd wash out against a bright reflection); dark ones are bold enough. */
export const outlinedNumerals = (numberColor: string): boolean => luminance(numberColor) > 0.18;

/** A hex colour a share of the way to another (both #RRGGBB). */
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The face texture for a die kind, skin and face set (cached). */
export function faceAtlas(s: Solid, skin: DiceSkin, set: FaceSet): CanvasTexture {
  const metal = skin.material === "metal";
  const outline = outlinedNumerals(skin.number) ? C.ink950 : null;
  return atlas(
    `${s.kind}|${skin.body}|${skin.number}|${metal ? "m" : ""}|${set}`,
    s,
    set,
    {
      body: skin.body,
      number: skin.number,
      outline,
      bevel: true,
      rim: metal ? mix(skin.body, C.bone100, 0.55) : null,
    },
    SRGBColorSpace,
  );
}

/**
 * Where a die kind's numbers are (cached per kind and face set): white body, black numerals and their outlines, laid
 * out as its atlas — a metal die's metalness map, so its numbers read as enamel filled into the metal.
 */
export function faceMask(s: Solid, set: FaceSet, outlined: boolean): CanvasTexture {
  return atlas(
    `${s.kind}|mask|${set}|${outlined ? "o" : ""}`,
    s,
    set,
    {
      body: DATA_TEXTURE.on,
      number: DATA_TEXTURE.off,
      outline: outlined ? DATA_TEXTURE.off : null,
      bevel: false,
      rim: null,
    },
    NoColorSpace,
  );
}

const roughness = new Map<string, CanvasTexture>();
/**
 * A metal die's roughness across each face (the green channel; written per pixel): smoother at the centre and along
 * one diagonal, rougher towards the edges — a flat face mirrors a gradient of the room, a sheen, not one flat tone.
 */
export function faceRoughness(s: Solid): CanvasTexture {
  const hit = roughness.get(s.kind);
  if (hit) return hit;
  const cols = COLS;
  const rows = Math.ceil(s.faces.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = CELL * cols;
  canvas.height = CELL * rows;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  const img = g.createImageData(canvas.width, canvas.height);
  const R = CELL * 0.46;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const dx = ((x % CELL) - CELL / 2) / R;
      const dy = ((y % CELL) - CELL / 2) / R;
      const edge = Math.min(1, dx * dx + dy * dy);
      const diagonal = 0.5 + 0.5 * Math.max(-1, Math.min(1, (dx - dy) * 0.7));
      const r = 0.1 + 0.16 * diagonal + 0.14 * edge;
      const o = (y * canvas.width + x) * 4;
      img.data[o + 1] = Math.round(255 * r);
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = NoColorSpace;
  roughness.set(s.kind, tex);
  return tex;
}

function drawFaces(canvas: HTMLCanvasElement, s: Solid, set: FaceSet, paint: Paint): void {
  const n = s.faces.length;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.globalAlpha = 1;
  g.fillStyle = paint.body;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let f = 0; f < n; f++) {
    const cx = (f % COLS) * CELL + CELL / 2;
    const cy = Math.floor(f / COLS) * CELL + CELL / 2;
    const L = layout(s, f);
    const pts = L.corners.map(([x, y]) => [cx + x * L.k, cy - y * L.k] as const);
    const outlineFace = () => {
      g.beginPath();
      pts.forEach(([x, y], i) => {
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
    };
    // The bevel: the rim of the face a little darker, shading inward; on metal a light line just inside it.
    if (paint.bevel) {
      g.save();
      outlineFace();
      g.clip();
      // Ink at 5 % per stroke, five strokes narrowing: darkest at the very edge.
      g.strokeStyle = C.ink950;
      g.lineJoin = "round";
      for (let w = 26; w > 0; w -= 6) {
        g.lineWidth = w;
        g.globalAlpha = 0.05;
        g.stroke();
      }
      if (paint.rim) {
        g.globalAlpha = 0.5;
        g.strokeStyle = paint.rim;
        g.lineWidth = 16;
        g.stroke();
        g.globalAlpha = 1;
        g.strokeStyle = paint.body;
        g.lineWidth = 8;
        g.stroke();
      }
      g.restore();
    }
    g.globalAlpha = 1;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.strokeStyle = paint.outline ?? paint.number;
    g.fillStyle = paint.number;
    const numeral = (text: string, x: number, y: number, size: number) => {
      g.font = `700 ${Math.round(size)}px ${FACE}`;
      if (paint.outline) {
        g.lineWidth = Math.max(2, size * 0.14);
        g.strokeText(text, x, y);
      }
      g.fillText(text, x, y);
    };
    if (s.kind === "d4" && set !== "masked") {
      // A d4 face shows the three corner values, each near its corner, pointing to it.
      const face = s.faces[f] as number[];
      face.forEach((vi, i) => {
        const [px, py] = pts[i] as readonly [number, number];
        const dx = px - cx;
        const dy = py - cy;
        g.save();
        g.translate(cx + dx * 0.55, cy + dy * 0.55);
        g.rotate(Math.atan2(dy, dx) + Math.PI / 2);
        numeral(String(s.labels[vi]), 0, 0, CELL * 0.2);
        g.restore();
      });
    } else {
      const text = faceText(s, f, set);
      const size =
        CELL * (s.kind === "d20" ? 0.3 : s.kind === "d6" ? 0.46 : 0.36) * (text.length > 1 ? 0.85 : 1);
      numeral(text, cx, cy + size * 0.04, size);
      if (set === "values" && (text === "6" || text === "9") && s.kind !== "d6") {
        const w = g.measureText(text).width;
        const h = Math.max(3, size * 0.06);
        g.lineWidth = Math.max(2, size * 0.1);
        if (paint.outline) g.strokeRect(cx - w / 2, cy + size * 0.42, w, h);
        g.fillRect(cx - w / 2, cy + size * 0.42, w, h);
      }
    }
  }
}

const geometries = new Map<string, BufferGeometry>();

/** A die's mesh geometry: each face a fan of triangles, flat-shaded, its UVs in its atlas cell. */
export function dieGeometry(s: Solid): BufferGeometry {
  const hit = geometries.get(s.kind);
  if (hit) return hit;
  const n = s.faces.length;
  const rows = Math.ceil(n / COLS);
  const W = CELL * COLS;
  const H = CELL * rows;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  for (let f = 0; f < n; f++) {
    const face = s.faces[f] as number[];
    const L = layout(s, f);
    const cx = (f % COLS) * CELL + CELL / 2;
    const cy = Math.floor(f / COLS) * CELL + CELL / 2;
    const normal = s.normals[f] as Vector3;
    const uvOf = (i: number): [number, number] => {
      const [x, y] = L.corners[i] as [number, number];
      return [(cx + x * L.k) / W, 1 - (cy - y * L.k) / H];
    };
    for (let t = 1; t + 1 < face.length; t++) {
      for (const i of [0, t, t + 1]) {
        const p = s.vertices[face[i] as number] as Vector3;
        pos.push(p.x, p.y, p.z);
        nor.push(normal.x, normal.y, normal.z);
        const [a, b] = uvOf(i);
        uv.push(a, b);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geometries.set(s.kind, geo);
  return geo;
}
