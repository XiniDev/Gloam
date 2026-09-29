import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import * as t from "../db/schema.ts";
import { CODECS, type EntityMap } from "./codecs.ts";
import type { EntityKind } from "./ops.ts";

type CollectionKind = Exclude<EntityKind, "campaign">;
const SCENE_SCOPED = ["wall", "light", "zone", "token", "effect", "combat"] as const;
type SceneScoped = (typeof SCENE_SCOPED)[number];

/**
 * The server's in-memory copy of one campaign (whole campaign loaded; see DECISIONS). Mutated only by the
 * command bus after the SQLite transaction commits. Per-scene indexes make scene queries cheap.
 */
export class CampaignModel {
  campaign: EntityMap["campaign"];
  readonly maps: { [K in CollectionKind]: Map<string, EntityMap[K]> };
  private readonly sceneIndex: { [K in SceneScoped]: Map<string, Set<string>> };
  /** Increments on every commit; caches (vision, paths) key on it. */
  version = 0;
  /** Per scene: increments when its walls, zones or bounds change (the movement world is rebuilt then). */
  private readonly geometry = new Map<string, number>();

  constructor(campaign: EntityMap["campaign"]) {
    this.campaign = campaign;
    this.maps = {
      scene: new Map(),
      wall: new Map(),
      light: new Map(),
      zone: new Map(),
      token: new Map(),
      actor: new Map(),
      effect: new Map(),
      combat: new Map(),
      handout: new Map(),
      template: new Map(),
      content: new Map(),
      asset: new Map(),
      cast: new Map(),
    };
    this.sceneIndex = {
      wall: new Map(),
      light: new Map(),
      zone: new Map(),
      token: new Map(),
      effect: new Map(),
      combat: new Map(),
    };
  }

  static load(db: Db, campaignId: string): CampaignModel | null {
    const row = db.select().from(t.campaigns).where(eq(t.campaigns.id, campaignId)).get();
    if (!row) return null;
    const m = new CampaignModel(CODECS.campaign.fromRow(row));
    const scenes = db.select().from(t.scenes).where(eq(t.scenes.campaignId, campaignId)).all();
    for (const r of scenes) m.put("scene", CODECS.scene.fromRow(r));
    const sceneIds = scenes.map((s) => s.id);
    if (sceneIds.length > 0) {
      for (const r of db.select().from(t.walls).where(inArray(t.walls.sceneId, sceneIds)).all())
        m.put("wall", CODECS.wall.fromRow(r));
      for (const r of db.select().from(t.lights).where(inArray(t.lights.sceneId, sceneIds)).all())
        m.put("light", CODECS.light.fromRow(r));
      for (const r of db.select().from(t.zones).where(inArray(t.zones.sceneId, sceneIds)).all())
        m.put("zone", CODECS.zone.fromRow(r));
      for (const r of db.select().from(t.tokens).where(inArray(t.tokens.sceneId, sceneIds)).all())
        m.put("token", CODECS.token.fromRow(r));
      for (const r of db.select().from(t.effects).where(inArray(t.effects.sceneId, sceneIds)).all())
        m.put("effect", CODECS.effect.fromRow(r));
      for (const r of db.select().from(t.combats).where(inArray(t.combats.sceneId, sceneIds)).all())
        m.put("combat", CODECS.combat.fromRow(r));
    }
    for (const r of db.select().from(t.actors).where(eq(t.actors.campaignId, campaignId)).all())
      m.put("actor", CODECS.actor.fromRow(r));
    for (const r of db.select().from(t.handouts).where(eq(t.handouts.campaignId, campaignId)).all())
      m.put("handout", CODECS.handout.fromRow(r));
    for (const r of db
      .select()
      .from(t.sheetTemplates)
      .where(eq(t.sheetTemplates.campaignId, campaignId))
      .all())
      m.put("template", CODECS.template.fromRow(r));
    for (const r of db.select().from(t.content).where(eq(t.content.campaignId, campaignId)).all())
      m.put("content", CODECS.content.fromRow(r));
    for (const r of db.select().from(t.assets).where(eq(t.assets.campaignId, campaignId)).all())
      m.put("asset", CODECS.asset.fromRow(r));
    // Resolution cards still waiting on the DM (a finished one is history; it's read from the table when asked).
    for (const r of db
      .select()
      .from(t.casts)
      .where(and(eq(t.casts.campaignId, campaignId), eq(t.casts.status, "open")))
      .all())
      m.put("cast", CODECS.cast.fromRow(r));
    return m;
  }

  get<K extends EntityKind>(kind: K, id: string): EntityMap[K] | undefined {
    if (kind === "campaign")
      return (this.campaign.id === id ? this.campaign : undefined) as EntityMap[K] | undefined;
    return (this.maps[kind as CollectionKind] as Map<string, EntityMap[K]>).get(id);
  }

  put<K extends EntityKind>(kind: K, entity: EntityMap[K]): void {
    if (kind === "campaign") {
      this.campaign = entity as EntityMap["campaign"];
      return;
    }
    const map = this.maps[kind as CollectionKind] as Map<string, EntityMap[K]>;
    const id = (entity as { id: string }).id;
    const prev = map.get(id) as { sceneId?: string } | undefined;
    map.set(id, entity);
    if (
      kind === "wall" ||
      kind === "zone" ||
      (kind === "effect" && (shapesGround(entity) || shapesGround(prev)))
    ) {
      this.touchGeometry((entity as { sceneId: string }).sceneId);
      if (prev?.sceneId) this.touchGeometry(prev.sceneId);
      if (kind === "effect")
        this.indexCarried(entity as EntityMap["effect"], prev as EntityMap["effect"] | undefined);
    } else if (kind === "scene") this.touchGeometry(id);
    else if (kind === "token" && this.carries.has(id)) {
      // An emanation that slows the ground goes where its creature goes (Spirit Guardians).
      const moved = prev as EntityMap["token"] | undefined;
      const now = entity as EntityMap["token"];
      if (!moved || moved.pos.x !== now.pos.x || moved.pos.y !== now.pos.y || moved.sceneId !== now.sceneId) {
        this.touchGeometry(now.sceneId);
        if (moved && moved.sceneId !== now.sceneId) this.touchGeometry(moved.sceneId);
      }
    }
    if ((SCENE_SCOPED as readonly string[]).includes(kind)) {
      const idx = this.sceneIndex[kind as SceneScoped];
      const sceneId = (entity as { sceneId: string }).sceneId;
      if (prev?.sceneId && prev.sceneId !== sceneId) idx.get(prev.sceneId)?.delete(id);
      let set = idx.get(sceneId);
      if (!set) {
        set = new Set();
        idx.set(sceneId, set);
      }
      set.add(id);
    }
  }

  remove(kind: EntityKind, id: string): void {
    if (kind === "campaign") return;
    const map = this.maps[kind as CollectionKind] as Map<string, { sceneId?: string }>;
    const prev = map.get(id);
    map.delete(id);
    if ((kind === "wall" || kind === "zone" || (kind === "effect" && shapesGround(prev))) && prev?.sceneId)
      this.touchGeometry(prev.sceneId);
    if (kind === "effect" && prev) this.indexCarried(undefined, prev as EntityMap["effect"]);
    if (prev?.sceneId && (SCENE_SCOPED as readonly string[]).includes(kind)) {
      this.sceneIndex[kind as SceneScoped].get(prev.sceneId)?.delete(id);
    }
  }

  /** Tokens carrying an effect that shapes the ground (an emanation from them), with how many. */
  private readonly carries = new Map<string, number>();
  private indexCarried(now: EntityMap["effect"] | undefined, prev: EntityMap["effect"] | undefined): void {
    const src = (e: EntityMap["effect"] | undefined) =>
      e && shapesGround(e) && e.shape.kind === "emanation" ? e.shape.sourceTokenId : null;
    const a = src(prev);
    const b = src(now);
    if (a === b) return;
    if (a) {
      const n = (this.carries.get(a) ?? 1) - 1;
      if (n > 0) this.carries.set(a, n);
      else this.carries.delete(a);
    }
    if (b) this.carries.set(b, (this.carries.get(b) ?? 0) + 1);
  }

  private touchGeometry(sceneId: string): void {
    this.geometry.set(sceneId, (this.geometry.get(sceneId) ?? 0) + 1);
  }

  /**
   * Changes whenever the scene's walls, zones or bounds change, or an effect that shapes movement does (a wall, slow
   * ground, halved speed) — its creature moving included.
   */
  geometryVersion(sceneId: string): number {
    return this.geometry.get(sceneId) ?? 0;
  }

  inScene<K extends SceneScoped>(kind: K, sceneId: string): EntityMap[K][] {
    const ids = this.sceneIndex[kind].get(sceneId);
    if (!ids) return [];
    const map = this.maps[kind] as Map<string, EntityMap[K]>;
    const out: EntityMap[K][] = [];
    for (const id of ids) {
      const e = map.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  all<K extends CollectionKind>(kind: K): EntityMap[K][] {
    return [...(this.maps[kind] as Map<string, EntityMap[K]>).values()];
  }

  get activeScene(): EntityMap["scene"] | undefined {
    return this.campaign.activeSceneId ? this.maps.scene.get(this.campaign.activeSceneId) : undefined;
  }
}

/**
 * An effect that's part of a scene's movement geometry: a wall (Wall of Force, Wall of Stone…), difficult terrain
 * (Web, Spike Growth, Sleet Storm) or ground that halves Speed (Spirit Guardians).
 */
function shapesGround(e: unknown): boolean {
  const x = e as
    | { shape?: { kind?: string }; props?: { difficult?: boolean; speedHalved?: boolean } }
    | undefined;
  return x?.shape?.kind === "wall" || x?.props?.difficult === true || x?.props?.speedHalved === true;
}
