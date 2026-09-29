import { areaHeight, areaPolygon, resolveArea } from "@gloam/shared/aoe";
import type { P, Seg } from "@gloam/shared/geometry";
import { effectiveTokenState } from "@gloam/shared/rules";
import type { EffectEntity, TokenEntity } from "@gloam/shared/schemas";
import type { Creature, Obscurer, Viewer, VisionLight, VisionWall } from "@gloam/shared/vision";
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

/**
 * Effects that slow movement in a scene (§8.13: Web and Spike Growth make difficult terrain; Spirit Guardians halves
 * Speed), as the movement world's cost regions — leaving out those that spare `creatureId` (its designated creatures).
 */
export function slowingEffects(model: CampaignModel, sceneId: string, creatureId?: string): EffectEntity[] {
  return model
    .inScene("effect", sceneId)
    .filter(
      (e) =>
        e.shape.kind !== "wall" &&
        (e.props.difficult === true || e.props.speedHalved === true) &&
        !(creatureId && e.props.exempt?.includes(creatureId)),
    );
}

export function effectSlow(
  model: CampaignModel,
  effects: EffectEntity[],
): { id: string; poly: P[]; difficult: boolean; halved: boolean }[] {
  return effects.flatMap((e) => {
    const fp = footprint(e, model);
    return fp
      ? [
          {
            id: e.id,
            poly: fp.poly,
            difficult: e.props.difficult === true,
            halved: e.props.speedHalved === true,
          },
        ]
      : [];
  });
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

/**
 * An effect's footprint on the table (circles as 48-gons that contain them) and its vertical extent — from the shared
 * area resolver (aoe/effects.ts), so what blocks sight is exactly what the board draws and the triggers test.
 */
function footprint(e: EffectEntity, model: CampaignModel): { poly: P[]; zMin: number; zMax: number } | null {
  const area = resolveArea(e.shape, (id) => {
    const t = model.get("token", id);
    return t ? { pos: t.pos, r: t.sizeFt / 2, z: t.elevation, height: Math.max(t.sizeFt, 2.5) } : null;
  });
  if (!area) return null;
  const poly = areaPolygon(area, 48);
  if (!poly) return null;
  const [zMin, zMax] = areaHeight(area);
  return { poly, zMin, zMax };
}

/**
 * What the effects on a creature give or do to it (§8.13, AC-VIS-08): senses (Darkvision, True Seeing), seeing the
 * Invisible (See Invisibility), an outline that keeps it from being Invisible (Faerie Fire).
 */
export function effectsOn(
  model: CampaignModel,
  t: TokenEntity,
): {
  senses: Partial<Record<"darkvision" | "blindsight" | "tremorsense" | "truesight", number>>;
  seeInvisible: boolean;
  outlined: boolean;
} {
  const out = {
    senses: {} as Partial<Record<"darkvision" | "blindsight" | "tremorsense" | "truesight", number>>,
    seeInvisible: false,
    outlined: false,
  };
  for (const e of model.inScene("effect", t.sceneId)) {
    if (e.attachedTokenId !== t.id) continue;
    if (e.props.seeInvisible) out.seeInvisible = true;
    if (e.props.outline) out.outlined = true;
    for (const [k, v] of Object.entries(e.props.senses ?? {}))
      if (typeof v === "number") {
        const key = k as keyof typeof out.senses;
        out.senses[key] = Math.max(out.senses[key] ?? 0, v);
      }
  }
  return out;
}

/** A token as a viewer: its senses and the conditions that take them away (Blinded, Unconscious). */
export function tokenViewer(model: CampaignModel, t: TokenEntity): Viewer {
  const actor = t.actorId ? model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, actor);
  const conditions = status.conditions.map((c) => c.id as string);
  // Senses a spell on it gives (the better of its own and the spell's), and See Invisibility.
  const fx = effectsOn(model, t);
  const senses = { ...stats.senses };
  for (const [k, v] of Object.entries(fx.senses)) {
    const key = k as keyof typeof senses;
    senses[key] = Math.max(senses[key], v ?? 0);
  }
  return {
    x: t.pos.x,
    y: t.pos.y,
    elevation: t.elevation,
    senses,
    seeInvisible: status.seeInvisible || fx.seeInvisible,
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
    // Faerie Fire's glow on it (an effect on the creature), as well as a DM's mark.
    outlined: status.outlined || effectsOn(model, t).outlined,
    flying: t.moveMode === "fly" || t.elevation > 0,
  };
}
