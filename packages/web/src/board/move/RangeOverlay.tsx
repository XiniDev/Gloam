import type { RangeField } from "@gloam/shared/movement";
import { rangeLimit } from "@gloam/shared/movement";
import type { TokenView } from "@gloam/shared/state";
import { useEffect, useMemo, useState } from "react";
import {
  Color,
  DataTexture,
  LinearFilter,
  PlaneGeometry,
  RGFormat,
  ShaderMaterial,
  UnsignedByteType,
} from "three";
import { useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { C, col } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { again } from "../frames.ts";
import { rangeInputs } from "./drag.ts";
import { lastMs, requestRange } from "./rangeHost.ts";

/** Colour-blind palette (SPEC §27.2 --path-ok), as the move preview's. */
const CB_OK = "#56b4e9";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * The reachable region, soft, fading toward its limit, and the limit itself as a bright line (SPEC §16.6). The texture
 * holds each cell's cost (R, as a share of the field's reach; unreachable cells take their reachable neighbours' so the
 * interpolation never invents a limit along a wall) and whether it's reachable (G).
 */
const FRAG = /* glsl */ `
uniform sampler2D uField; uniform float uMax; uniform float uBudget; uniform float uOpacity;
uniform vec3 uFill; uniform vec3 uLine;
varying vec2 vUv;
void main() {
  vec2 s = texture2D(uField, vec2(vUv.x, 1.0 - vUv.y)).rg;
  float d = s.r * uMax;
  float reach = smoothstep(0.35, 0.65, s.g);
  float inside = reach * (1.0 - smoothstep(uBudget - 0.05, uBudget + 0.05, d));
  float fill = inside * mix(0.26, 0.08, clamp(d / max(uBudget, 1e-3), 0.0, 1.0));
  float w = max(fwidth(d), 1e-4);
  float line = reach * (1.0 - smoothstep(0.75 * w, 1.75 * w, abs(d - uBudget)));
  float a = max(fill, 0.95 * line) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uFill, uLine, line), a);
  #include <colorspace_fragment>
}`;

/** The field as a texture: cost in R (0–1 of `max`), reachable in G. */
function fieldTexture(f: RangeField, max: number): DataTexture {
  const { cols, rows, cost } = f;
  const data = new Uint8Array(cols * rows * 2);
  const enc = (c: number) => Math.round(Math.min(1, c / max) * 255);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const v = cost[k] as number;
      if (Number.isFinite(v)) {
        data[2 * k] = enc(v);
        data[2 * k + 1] = 255;
        continue;
      }
      // Unreachable: its nearest reachable neighbour's cost (no false limit where the two blend), not reachable.
      let best = Number.POSITIVE_INFINITY;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const n = cost[rr * cols + cc] as number;
          if (n < best) best = n;
        }
      data[2 * k] = Number.isFinite(best) ? enc(best) : 255;
      data[2 * k + 1] = 0;
    }
  const t = new DataTexture(data, cols, rows, RGFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** The token the overlay is for: the one selected, when the viewer may move it. */
function useRangeToken(): TokenView | null {
  const on = useUi((s) => s.rangeOverlay);
  const selection = useUi((s) => s.selection);
  const tokens = useBoard((d) => d.tokens);
  const me = useTable((s) => s.me);
  if (!on || selection.length !== 1) return null;
  const t = tokens.get(selection[0] as string);
  if (!t || !t.own) return null;
  const dm = me?.role === "dm" || me?.role === "admin";
  return dm || t.ownerIds.includes(me?.userId ?? "") ? t : null;
}

/** Diagnostics for the test hook: the last field drawn. */
let shown: { tokenId: string; field: RangeField; ms: number } | null = null;

/**
 * The movement range overlay (SPEC §8.6, §16.6; AC-MOV-10): for the selected token the viewer controls, with G, the
 * floor it can reach around walls and through difficult terrain — within its movement left in combat, one move at
 * its speed outside it — soft, with a bright line at the limit. A visual aid; a move's cost is always its path's.
 */
export function RangeOverlay() {
  const token = useRangeToken();
  const colorBlind = useSettings((s) => s.colorBlind);
  const walls = useEntities((s) => boardData(s).walls);
  const zones = useEntities((s) => boardData(s).zones);
  const [field, setField] = useState<RangeField | null>(null);
  const tokensKey = useBoard((d) =>
    [...d.tokens.values()].map((t) => `${t.id}:${t.pos.x.toFixed(2)},${t.pos.y.toFixed(2)}`).join("|"),
  );
  // Recomputed when the token moves or its budget changes, the walls or zones change, or other creatures move.
  const key = token
    ? `${token.id}|${token.pos.x}|${token.pos.y}|${token.own?.budgetFt}|${token.own?.usedFt}|${token.prone}|${token.sizeFt}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what the field depends on
  useEffect(() => {
    if (!token) {
      setField(null);
      return;
    }
    const inputs = rangeInputs(token);
    if (!inputs) return;
    let live = true;
    void requestRange(inputs.world, token.pos, {
      rc: inputs.rc,
      crawl: inputs.crawl,
      budget: Math.max(0, inputs.budget),
    })
      .then((f) => {
        if (!live || !f) return;
        shown = { tokenId: token.id, field: f, ms: lastMs };
        setField(f);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, walls, zones, tokensKey]);
  useEffect(() => {
    if (!token) shown = null;
  }, [token]);

  const max = field ? field.budget + 5 : 1;
  const texture = useMemo(() => (field ? fieldTexture(field, max) : null), [field, max]);
  useEffect(() => () => disposeLater(texture), [texture]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        uniforms: {
          uField: { value: null },
          uMax: { value: 1 },
          uBudget: { value: 0 },
          uOpacity: { value: 1 },
          uFill: { value: new Color() },
          uLine: { value: col(C.bone100) },
        },
      }),
    [],
  );
  useEffect(() => () => disposeLater(material), [material]);
  const u = material.uniforms as Record<string, { value: unknown }>;
  (u.uField as { value: unknown }).value = texture;
  (u.uMax as { value: number }).value = max;
  (u.uBudget as { value: number }).value = field?.budget ?? 0;
  ((u.uFill as { value: Color }).value as Color).copy(col(colorBlind ? CB_OK : C.verdigris400));
  const geometry = useMemo(
    () => (field ? new PlaneGeometry(field.cols * field.h, field.rows * field.h) : null),
    [field],
  );
  useEffect(() => () => disposeLater(geometry), [geometry]);
  // The board draws on demand: once the overlay has mounted or changed (a new field, off, its colours), a frame.
  const shownKey = token && field ? `${token.id}|${field.x0}|${field.y0}|${field.budget}|${colorBlind}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a frame whenever what's drawn changed
  useEffect(() => {
    again();
  }, [shownKey, texture]);

  useEffect(
    () =>
      provideTestHook("rangeOverlay", () => {
        if (!shown) return null;
        const f = shown.field;
        return {
          tokenId: shown.tokenId,
          budget: f.budget,
          h: f.h,
          ms: shown.ms,
          limit: rangeLimit(f).map((p) => ({ x: p.x, y: p.y })),
        };
      }),
    [],
  );
  useEffect(
    () =>
      provideTestHook("rangeCostAt", (x: number, y: number) => {
        if (!shown) return null;
        const f = shown.field;
        const c = Math.floor((x - f.x0) / f.h);
        const r = Math.floor((y - f.y0) / f.h);
        if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return null;
        const v = f.cost[r * f.cols + c] as number;
        return Number.isFinite(v) ? v : null;
      }),
    [],
  );

  if (!token || !field || !geometry || !texture) return null;
  return (
    <mesh
      geometry={geometry}
      material={material}
      rotation-x={-Math.PI / 2}
      position={[
        field.x0 + (field.cols * field.h) / 2,
        token.elevation + 0.04,
        field.y0 + (field.rows * field.h) / 2,
      ]}
      renderOrder={2}
      raycast={() => null}
      userData={{ part: "rangeOverlay" }}
    />
  );
}
