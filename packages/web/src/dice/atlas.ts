/**
 * Dice faces (SPEC §18.4): one canvas-drawn texture per die kind, skin and face set — each face its own cell, the
 * body colour with a darker rim at the face's edges (a bevel without the geometry), the number in the display face
 * (Fraunces, 6 and 9 underlined), the d4's three corner numbers pointing to their corners, "?" for masked rolls, and
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

const atlases = new Map<string, CanvasTexture>();

/** The face texture for a die kind, skin and face set (cached). */
export function faceAtlas(s: Solid, skin: DiceSkin, set: FaceSet): CanvasTexture {
  const key = `${s.kind}|${skin.body}|${skin.number}|${set}`;
  const hit = atlases.get(key);
  if (hit) return hit;
  const tex = new CanvasTexture(drawFaces(s, set, skin.body, skin.number, true));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  atlases.set(key, tex);
  return tex;
}

/**
 * Where a die kind's numbers are (cached per kind and face set): white body, black numerals, laid out as its atlas —
 * a metal die's metalness map, so its numbers read as enamel filled into the metal.
 */
export function faceMask(s: Solid, set: FaceSet): CanvasTexture {
  const key = `${s.kind}|mask|${set}`;
  const hit = atlases.get(key);
  if (hit) return hit;
  const tex = new CanvasTexture(drawFaces(s, set, DATA_TEXTURE.on, DATA_TEXTURE.off, false));
  tex.colorSpace = NoColorSpace;
  tex.anisotropy = 4;
  atlases.set(key, tex);
  return tex;
}

function drawFaces(s: Solid, set: FaceSet, body: string, number: string, bevel: boolean): HTMLCanvasElement {
  const n = s.faces.length;
  const rows = Math.ceil(n / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * rows;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = body;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let f = 0; f < n; f++) {
    const cx = (f % COLS) * CELL + CELL / 2;
    const cy = Math.floor(f / COLS) * CELL + CELL / 2;
    const L = layout(s, f);
    const pts = L.corners.map(([x, y]) => [cx + x * L.k, cy - y * L.k] as const);
    // The bevel: the rim of the face a little darker, shading inward.
    if (bevel) {
      g.save();
      g.beginPath();
      pts.forEach(([x, y], i) => {
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.clip();
      // Ink at 5 % per stroke, five strokes narrowing: darkest at the very edge.
      g.strokeStyle = C.ink950;
      g.lineJoin = "round";
      for (let w = 26; w > 0; w -= 6) {
        g.lineWidth = w;
        g.globalAlpha = 0.05;
        g.stroke();
      }
      g.restore();
    }
    g.fillStyle = number;
    g.textAlign = "center";
    g.textBaseline = "middle";
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
        g.font = `700 ${Math.round(CELL * 0.2)}px Fraunces, Georgia, serif`;
        g.fillText(String(s.labels[vi]), 0, 0);
        g.restore();
      });
    } else {
      const text = faceText(s, f, set);
      const size =
        CELL * (s.kind === "d20" ? 0.3 : s.kind === "d6" ? 0.46 : 0.36) * (text.length > 1 ? 0.85 : 1);
      g.font = `700 ${Math.round(size)}px Fraunces, Georgia, serif`;
      g.fillText(text, cx, cy + size * 0.04);
      if (set === "values" && (text === "6" || text === "9") && s.kind !== "d6") {
        const w = g.measureText(text).width;
        g.fillRect(cx - w / 2, cy + size * 0.42, w, Math.max(3, size * 0.06));
      }
    }
  }
  return canvas;
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
