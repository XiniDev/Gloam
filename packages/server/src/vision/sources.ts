import { circlePolygon, type P, type Seg } from "@gloam/shared/geometry";
import { effectiveTokenState } from "@gloam/shared/rules";
import type { EffectEntity, TokenEntity } from "@gloam/shared/schemas";
import {
  type Creature,
  facingAngle,
  type Obscurer,
  type Viewer,
  type VisionLight,
  type VisionWall,
} from "@gloam/shared/vision";
import type { CampaignModel } from "../engine/model.ts";

/**
 * The vision engine's inputs from the campaign model (SPEC §15.1) — the server's truth: every wall with its real kind
 * (hidden ones included), every light (DM-only ones are dropped by the world), effects as obscurers, opaque walls and
 * lights.
 */
export function sceneWalls(model: CampaignModel, sceneId: string): VisionWall[] {
  return model.inScene("wall", sceneId).map((w) => ({ a: w.a, b: w.b, kind: w.kind, door: w.doorState }));
}

export function sceneLights(model: CampaignModel, sceneId: string): VisionLight[] {
  const out: VisionLight[] = [];
  for (const l of model.inScene("light", sceneId)) {
    const carrier = l.tokenId ? model.get("token", l.tokenId) : undefined;
    const pos = carrier ? carrier.pos : l.pos;
    out.push({
      id: l.id,
      x: pos.x,
      y: pos.y,
      // A carried light shines from its carrier (on the ground, 20 ft of torchlight is 20 ft across the floor).
      z: carrier ? carrier.elevation : l.elevation,
      bright: l.shuttered ? 0 : l.bright,
      dim: l.shuttered ? 5 : l.dim,
      coneDeg: l.coneDeg,
      directionDeg: carrier ? carrier.rotationDeg : l.directionDeg,
      magical: l.magical,
      pierceDarkness: l.pierceDarkness,
      enabled: l.enabled,
      // A DM-hidden creature's light is hidden with it: it lights nothing a player perceives (AC-TOK-08).
      dmOnly: l.dmOnly || carrier?.hidden === true,
    });
  }
  return out;
}

/**
 * A scene's wall-shaped effects as segments: those that block sight (opaque), or movement and blindsight (solid:
 * Wall of Force, Wall of Stone, Wall of Ice; SPEC §17.1 "solid walls add movement-blocking segments").
 */
export function effectWalls(
  model: CampaignModel,
  sceneId: string,
  what: "sight" | "move",
): (Seg & { id: string })[] {
  const out: (Seg & { id: string })[] = [];
  for (const e of model.inScene("effect", sceneId)) {
    const sh = e.shape;
    if (sh.kind !== "wall") continue;
    const blocks = what === "sight" ? sh.opaque || e.props.opaque === true : sh.blocksMove;
    if (!blocks) continue;
    for (let i = 0; i + 1 < sh.points.length + (sh.closed ? 1 : 0); i++)
      out.push({ a: sh.points[i] as P, b: sh.points[(i + 1) % sh.points.length] as P, id: e.id });
  }
  return out;
}

export interface EffectInputs {
  opaque: Seg[];
  /** Solid walls: they block movement and blindsight. */
  solid: Seg[];
  obscurers: Obscurer[];
  lights: VisionLight[];
}

/** Effects (F13) as vision inputs: opaque wall shapes, obscuring volumes, and lights. */
export function sceneEffects(model: CampaignModel, sceneId: string): EffectInputs {
  const out: EffectInputs = {
    opaque: effectWalls(model, sceneId, "sight"),
    solid: effectWalls(model, sceneId, "move"),
    obscurers: [],
    lights: [],
  };
  for (const e of model.inScene("effect", sceneId)) {
    const sh = e.shape;
    if (sh.kind === "wall") continue;
    const fp = footprint(e, model);
    if (!fp) continue;
    if (e.props.magicalDarkness) out.obscurers.push({ kind: "magicalDarkness", ...fp });
    else if (e.props.obscurement) out.obscurers.push({ kind: e.props.obscurement, ...fp });
    if (e.props.light) {
      const c = centre(fp.poly);
      // An emanation reaches from the edge of its source's space (SRD 5.2.1 p. 181): its light does too, measured
      // here from the centre.
      const src = sh.kind === "emanation" ? model.get("token", sh.sourceTokenId) : undefined;
      const base = src ? src.sizeFt / 2 : 0;
      out.lights.push({
        id: `fx:${e.id}`,
        x: c.x,
        y: c.y,
        z: src ? src.elevation : "origin" in sh ? sh.origin.z : 0,
        bright: e.props.light.bright > 0 ? e.props.light.bright + base : 0,
        dim: e.props.light.bright > 0 ? e.props.light.dim : e.props.light.dim + base,
        coneDeg: null,
        directionDeg: 0,
        magical: e.props.light.magical,
        pierceDarkness: e.props.light.pierceDarkness,
      });
    }
  }
  return out;
}

function centre(poly: P[]): P {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** An area's footprint on the table (circles as 48-gons) and vertical extent. */
function footprint(e: EffectEntity, model: CampaignModel): { poly: P[]; zMin: number; zMax: number } | null {
  const sh = e.shape;
  switch (sh.kind) {
    case "sphere":
      return {
        poly: circlePolygon(sh.origin, sh.radius, 48, true),
        zMin: sh.origin.z - sh.radius,
        zMax: sh.origin.z + sh.radius,
      };
    case "cylinder":
      return {
        poly: circlePolygon(sh.origin, sh.radius, 48, true),
        zMin: sh.origin.z,
        zMax: sh.origin.z + sh.height,
      };
    case "emanation": {
      const t = model.get("token", sh.sourceTokenId);
      if (!t) return null;
      return {
        poly: circlePolygon(t.pos, sh.distance + t.sizeFt / 2, 48, true),
        zMin: t.elevation - sh.distance,
        zMax: t.elevation + sh.distance + t.sizeFt,
      };
    }
    case "cube": {
      const a = facingAngle(sh.dirDeg);
      const f = { x: Math.cos(a), y: Math.sin(a) };
      const s = { x: -f.y, y: f.x };
      const back = sh.originOnFace ? 0 : -sh.size / 2;
      const pts = [
        [back, -sh.size / 2],
        [back + sh.size, -sh.size / 2],
        [back + sh.size, sh.size / 2],
        [back, sh.size / 2],
      ].map(([u, v]) => ({
        x: sh.origin.x + f.x * (u as number) + s.x * (v as number),
        y: sh.origin.y + f.y * (u as number) + s.y * (v as number),
      }));
      return { poly: pts, zMin: sh.origin.z, zMax: sh.origin.z + sh.size };
    }
    case "line": {
      const a = facingAngle(sh.dirDeg);
      const f = { x: Math.cos(a), y: Math.sin(a) };
      const s = { x: -f.y * (sh.width / 2), y: f.x * (sh.width / 2) };
      const o = sh.origin;
      const end = { x: o.x + f.x * sh.length, y: o.y + f.y * sh.length };
      return {
        poly: [
          { x: o.x + s.x, y: o.y + s.y },
          { x: end.x + s.x, y: end.y + s.y },
          { x: end.x - s.x, y: end.y - s.y },
          { x: o.x - s.x, y: o.y - s.y },
        ],
        zMin: o.z - sh.width / 2,
        zMax: o.z + sh.width / 2,
      };
    }
    case "cone": {
      const a = facingAngle(sh.dirDeg);
      const half = Math.atan(0.5);
      const pts: P[] = [{ x: sh.origin.x, y: sh.origin.y }];
      for (let k = 0; k <= 8; k++) {
        const t = a - half + (2 * half * k) / 8;
        const r = sh.length / Math.cos(t - a);
        pts.push({ x: sh.origin.x + Math.cos(t) * r, y: sh.origin.y + Math.sin(t) * r });
      }
      return { poly: pts, zMin: sh.origin.z - sh.length / 2, zMax: sh.origin.z + sh.length / 2 };
    }
    default:
      return null;
  }
}

/** A token as a viewer: its senses and the conditions that take them away (Blinded, Unconscious). */
export function tokenViewer(model: CampaignModel, t: TokenEntity): Viewer {
  const actor = t.actorId ? model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, actor);
  const conditions = status.conditions.map((c) => c.id as string);
  return {
    x: t.pos.x,
    y: t.pos.y,
    elevation: t.elevation,
    senses: stats.senses,
    seeInvisible: status.seeInvisible,
    blinded: conditions.includes("blinded"),
    unconscious: conditions.includes("unconscious"),
    flying: t.moveMode === "fly" || t.elevation > 0,
    sizeFt: t.sizeFt,
  };
}

/** A token as a creature to be perceived. */
export function tokenCreature(model: CampaignModel, t: TokenEntity): Creature {
  const actor = t.actorId ? model.get("actor", t.actorId) : undefined;
  const { status } = effectiveTokenState(t, actor);
  const conditions = status.conditions.map((c) => c.id as string);
  return {
    x: t.pos.x,
    y: t.pos.y,
    elevation: t.elevation,
    sizeFt: t.sizeFt,
    invisible: conditions.includes("invisible"),
    outlined: status.outlined,
    flying: t.moveMode === "fly" || t.elevation > 0,
  };
}
