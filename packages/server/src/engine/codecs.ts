import {
  type CampaignEntity,
  DEFAULT_SPEEDS,
  type EffectEntity,
  type LightEntity,
  parseCampaignSettings,
  parseHouseRules,
  type SceneEntity,
  type TokenEntity,
  type WallEntity,
  type ZoneEntity,
} from "@gloam/shared/schemas";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as t from "../db/schema.ts";
import type { EntityKind } from "./ops.ts";

/** Actors are sheets plus status (conditions etc. for linked tokens). The sheet shape arrives in Phase 6. */
export interface ActorEntity {
  id: string;
  campaignId: string;
  kind: "character" | "npc";
  ownerUserId: string | null;
  templateId: string | null;
  lockLevel: "unlocked" | "core" | "full";
  sheet: Record<string, unknown>;
  status: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CombatEntity {
  id: string;
  sceneId: string;
  active: boolean;
  round: number;
  turnIndex: number;
  data: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
}

export interface HandoutEntity {
  id: string;
  campaignId: string;
  kind: "handout" | "note";
  title: string;
  bodyMd: string;
  imageAssetId: string | null;
  recipients: string[] | "all";
  createdBy: string;
  createdAt: number;
}

export interface TemplateEntity {
  id: string;
  campaignId: string;
  name: string;
  blocks: unknown[];
  createdBy: string;
  createdAt: number;
}

export interface ContentEntity {
  id: string;
  campaignId: string | null;
  pack: string;
  type: "spell" | "monster" | "item";
  slug: string;
  name: string;
  data: Record<string, unknown>;
  status: "active" | "proposed" | "rejected";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** A campaign's reference to a stored file (the Library item). Files themselves live in asset_files (§21). */
export interface AssetEntity {
  id: string;
  campaignId: string;
  fileId: string;
  name: string;
  purpose: string;
  tags: string[];
  uploaderId: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  deletedAt: number | null;
  /** Minis: display overrides that persist per asset (AC-TOK-03). */
  overrides: { scale?: number; rotationYDeg?: number; offsetY?: number };
}

export interface EntityMap {
  campaign: CampaignEntity;
  scene: SceneEntity;
  wall: WallEntity;
  light: LightEntity;
  zone: ZoneEntity;
  token: TokenEntity;
  actor: ActorEntity;
  effect: EffectEntity;
  combat: CombatEntity;
  handout: HandoutEntity;
  template: TemplateEntity;
  content: ContentEntity;
  asset: AssetEntity;
}

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const p = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export interface Codec<K extends EntityKind> {
  table: SQLiteTable;
  toRow(e: EntityMap[K]): Row;
  fromRow(r: Row): EntityMap[K];
}

/** Entity ↔ row mapping per kind; JSON columns carry the nested documents. */
export const CODECS: { [K in EntityKind]: Codec<K> } = {
  campaign: {
    table: t.campaigns,
    toRow: (e) => ({
      id: e.id,
      name: e.name,
      coverAssetId: e.coverAssetId,
      rulesPack: e.rulesPack,
      units: e.units,
      houseRulesJson: j(e.houseRules),
      settingsJson: j(e.settings),
      activeSceneId: e.activeSceneId,
      sessionNo: e.sessionNo,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      archivedAt: e.archivedAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      name: r.name as string,
      coverAssetId: (r.coverAssetId as string | null) ?? null,
      rulesPack: r.rulesPack as string,
      units: r.units as "ft" | "m",
      houseRules: parseHouseRules(r.houseRulesJson as string),
      settings: parseCampaignSettings(r.settingsJson as string),
      activeSceneId: (r.activeSceneId as string | null) ?? null,
      sessionNo: r.sessionNo as number,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      archivedAt: (r.archivedAt as number | null) ?? null,
    }),
  },
  scene: {
    table: t.scenes,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      name: e.name,
      sort: e.sort,
      mapKind: e.mapKind,
      mapAssetId: e.mapAssetId,
      calibrationJson: j(e.calibration),
      floorJson: j(e.floor),
      ambientJson: j(e.ambient),
      fogMode: e.fogMode,
      fogCellFt: e.fogCellFt,
      boundsJson: j(e.bounds),
      spawnJson: j(e.spawn),
      musicJson: e.music ? j(e.music) : null,
      walls3d: e.walls3d,
      thumbnailAssetId: e.thumbnailAssetId,
      dataJson: j({ dmNotes: e.dmNotes }),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      archivedAt: e.archivedAt,
      deletedAt: e.deletedAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: r.campaignId as string,
      name: r.name as string,
      sort: r.sort as number,
      mapKind: r.mapKind as SceneEntity["mapKind"],
      mapAssetId: (r.mapAssetId as string | null) ?? null,
      calibration: p(r.calibrationJson, {}),
      floor: p(r.floorJson, { style: "stone" }),
      ambient: p(r.ambientJson, { level: "bright", tint: "#FFFFFF" }),
      fogMode: r.fogMode as SceneEntity["fogMode"],
      fogCellFt: r.fogCellFt as number,
      bounds: p(r.boundsJson, { minX: 0, minY: 0, maxX: 100, maxY: 100 }),
      spawn: p(r.spawnJson, { x: 0, y: 0 }),
      music: p(r.musicJson, null),
      walls3d: Boolean(r.walls3d),
      thumbnailAssetId: (r.thumbnailAssetId as string | null) ?? null,
      dmNotes: p<{ dmNotes?: string }>(r.dataJson, {}).dmNotes ?? "",
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      archivedAt: (r.archivedAt as number | null) ?? null,
      deletedAt: (r.deletedAt as number | null) ?? null,
    }),
  },
  wall: {
    table: t.walls,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      ax: e.a.x,
      ay: e.a.y,
      bx: e.b.x,
      by: e.b.y,
      kind: e.kind,
      doorState: e.doorState,
      hidden: e.hidden,
      createdAt: 0,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      sceneId: r.sceneId as string,
      a: { x: r.ax as number, y: r.ay as number },
      b: { x: r.bx as number, y: r.by as number },
      kind: r.kind as WallEntity["kind"],
      doorState: (r.doorState as WallEntity["doorState"]) ?? null,
      hidden: Boolean(r.hidden),
    }),
  },
  light: {
    table: t.lights,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      tokenId: e.tokenId,
      x: e.pos.x,
      y: e.pos.y,
      elevation: e.elevation,
      bright: e.bright,
      dim: e.dim,
      color: e.color,
      intensity: e.intensity,
      animation: e.animation,
      coneDeg: e.coneDeg,
      directionDeg: e.directionDeg,
      magical: e.magical,
      pierceDarkness: e.pierceDarkness,
      enabled: e.enabled,
      dmOnly: e.dmOnly,
      preset: e.preset,
      dataJson: j({ shuttered: e.shuttered ?? false }),
    }),
    fromRow: (r) => ({
      id: r.id as string,
      sceneId: r.sceneId as string,
      tokenId: (r.tokenId as string | null) ?? null,
      pos: { x: r.x as number, y: r.y as number },
      elevation: r.elevation as number,
      bright: r.bright as number,
      dim: r.dim as number,
      color: r.color as string,
      intensity: r.intensity as number,
      animation: r.animation as LightEntity["animation"],
      coneDeg: (r.coneDeg as number | null) ?? null,
      directionDeg: r.directionDeg as number,
      magical: Boolean(r.magical),
      pierceDarkness: Boolean(r.pierceDarkness),
      enabled: Boolean(r.enabled),
      dmOnly: Boolean(r.dmOnly),
      preset: (r.preset as string | null) ?? null,
      shuttered: p<{ shuttered?: boolean }>(r.dataJson, {}).shuttered ?? false,
    }),
  },
  zone: {
    table: t.zones,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      kind: e.kind,
      shapeJson: j(e.shape),
      label: e.label,
      color: e.color,
      visible: e.visible,
      triggersJson: j(e.triggers),
      note: e.note,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      sceneId: r.sceneId as string,
      kind: r.kind as ZoneEntity["kind"],
      shape: p(r.shapeJson, { kind: "polygon", points: [] }),
      label: r.label as string,
      color: r.color as string,
      visible: Boolean(r.visible),
      triggers: p(r.triggersJson, []),
      note: r.note as string,
    }),
  },
  token: {
    table: t.tokens,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      actorId: e.actorId,
      link: e.link,
      name: e.name,
      x: e.pos.x,
      y: e.pos.y,
      elevation: e.elevation,
      rotation: e.rotationDeg,
      sizeFt: e.sizeFt,
      appearanceJson: j(e.appearance),
      ownerIdsJson: j(e.ownerIds),
      disposition: e.disposition,
      hidden: e.hidden,
      revealJson: j(e.revealTo),
      hpDisplay: e.hpDisplay,
      statsJson: e.stats ? j(e.stats) : null,
      statusJson: e.status ? j(e.status) : null,
      overridesJson: j(e.overrides),
      lightId: e.lightId,
      locked: e.locked,
      dataJson: j({ dmNote: e.dmNote, moveMode: e.moveMode }),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }),
    fromRow: (r) => {
      const data = p<{ dmNote?: string; moveMode?: TokenEntity["moveMode"] }>(r.dataJson, {});
      const stats = p<TokenEntity["stats"]>(r.statsJson, null);
      if (stats && !stats.speeds) stats.speeds = { ...DEFAULT_SPEEDS };
      return {
        id: r.id as string,
        sceneId: r.sceneId as string,
        actorId: (r.actorId as string | null) ?? null,
        link: r.link as TokenEntity["link"],
        name: r.name as string,
        pos: { x: r.x as number, y: r.y as number },
        elevation: r.elevation as number,
        rotationDeg: r.rotation as number,
        sizeFt: r.sizeFt as number,
        appearance: p(r.appearanceJson, { mode: "auto", scale: 1, offsetY: 0, rotationOffsetDeg: 0 }),
        ownerIds: p(r.ownerIdsJson, []),
        disposition: r.disposition as TokenEntity["disposition"],
        hidden: Boolean(r.hidden),
        revealTo: p(r.revealJson, "vision"),
        hpDisplay: r.hpDisplay as TokenEntity["hpDisplay"],
        stats,
        status: p(r.statusJson, null),
        overrides: p(r.overridesJson, {}),
        lightId: (r.lightId as string | null) ?? null,
        locked: Boolean(r.locked),
        dmNote: data.dmNote ?? "",
        moveMode: data.moveMode ?? "walk",
        createdAt: r.createdAt as number,
        updatedAt: r.updatedAt as number,
      };
    },
  },
  actor: {
    table: t.actors,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      kind: e.kind,
      ownerUserId: e.ownerUserId,
      templateId: e.templateId,
      lockLevel: e.lockLevel,
      sheetJson: j(e.sheet),
      statusJson: j(e.status),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      deletedAt: e.deletedAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: r.campaignId as string,
      kind: r.kind as ActorEntity["kind"],
      ownerUserId: (r.ownerUserId as string | null) ?? null,
      templateId: (r.templateId as string | null) ?? null,
      lockLevel: r.lockLevel as ActorEntity["lockLevel"],
      sheet: p(r.sheetJson, {}),
      status: p(r.statusJson, {}),
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      deletedAt: (r.deletedAt as number | null) ?? null,
    }),
  },
  effect: {
    table: t.effects,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      sourceJson: j(e.source),
      shapeJson: j(e.shape),
      propsJson: j(e.props),
      triggersJson: j(e.triggers),
      attachedTokenId: e.attachedTokenId,
      concentrationTokenId: e.concentrationTokenId,
      expiresJson: j(e.expires),
      visibility: e.visibility,
      vfx: e.vfx,
      dataJson: j({ name: e.name, movement: e.movement }),
      createdAt: e.createdAt,
    }),
    fromRow: (r) => {
      const data = p<{ name?: string; movement?: EffectEntity["movement"] }>(r.dataJson, {});
      return {
        id: r.id as string,
        sceneId: r.sceneId as string,
        name: data.name ?? "Effect",
        source: p(r.sourceJson, { kind: "custom" }),
        shape: p(r.shapeJson, { kind: "sphere", origin: { x: 0, y: 0, z: 0 }, radius: 5 }),
        attachedTokenId: (r.attachedTokenId as string | null) ?? null,
        props: p(r.propsJson, {}),
        triggers: p(r.triggersJson, []),
        concentrationTokenId: (r.concentrationTokenId as string | null) ?? null,
        expires: p(r.expiresJson, { never: true }),
        visibility: r.visibility as EffectEntity["visibility"],
        vfx: r.vfx as EffectEntity["vfx"],
        movement: data.movement ?? null,
        createdAt: r.createdAt as number,
      };
    },
  },
  combat: {
    table: t.combats,
    toRow: (e) => ({
      id: e.id,
      sceneId: e.sceneId,
      active: e.active,
      round: e.round,
      turnIndex: e.turnIndex,
      dataJson: j(e.data),
      startedAt: e.startedAt,
      endedAt: e.endedAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      sceneId: r.sceneId as string,
      active: Boolean(r.active),
      round: r.round as number,
      turnIndex: r.turnIndex as number,
      data: p(r.dataJson, {}),
      startedAt: r.startedAt as number,
      endedAt: (r.endedAt as number | null) ?? null,
    }),
  },
  handout: {
    table: t.handouts,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      kind: e.kind,
      title: e.title,
      bodyMd: e.bodyMd,
      imageAssetId: e.imageAssetId,
      recipientsJson: j(e.recipients),
      createdBy: e.createdBy,
      createdAt: e.createdAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: r.campaignId as string,
      kind: r.kind as HandoutEntity["kind"],
      title: r.title as string,
      bodyMd: r.bodyMd as string,
      imageAssetId: (r.imageAssetId as string | null) ?? null,
      recipients: p(r.recipientsJson, []),
      createdBy: r.createdBy as string,
      createdAt: r.createdAt as number,
    }),
  },
  template: {
    table: t.sheetTemplates,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      name: e.name,
      blocksJson: j(e.blocks),
      createdBy: e.createdBy,
      createdAt: e.createdAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: r.campaignId as string,
      name: r.name as string,
      blocks: p(r.blocksJson, []),
      createdBy: r.createdBy as string,
      createdAt: r.createdAt as number,
    }),
  },
  content: {
    table: t.content,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      pack: e.pack,
      type: e.type,
      slug: e.slug,
      name: e.name,
      dataJson: j(e.data),
      status: e.status,
      createdBy: e.createdBy,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: (r.campaignId as string | null) ?? null,
      pack: r.pack as string,
      type: r.type as ContentEntity["type"],
      slug: r.slug as string,
      name: r.name as string,
      data: p(r.dataJson, {}),
      status: r.status as ContentEntity["status"],
      createdBy: r.createdBy as string,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
    }),
  },
  asset: {
    table: t.assets,
    toRow: (e) => ({
      id: e.id,
      campaignId: e.campaignId,
      fileId: e.fileId,
      name: e.name,
      purpose: e.purpose,
      tagsJson: j(e.tags),
      uploaderId: e.uploaderId,
      status: e.status,
      createdAt: e.createdAt,
      reviewedBy: e.reviewedBy,
      reviewedAt: e.reviewedAt,
      deletedAt: e.deletedAt,
      overridesJson: j(e.overrides),
    }),
    fromRow: (r) => ({
      id: r.id as string,
      campaignId: r.campaignId as string,
      fileId: r.fileId as string,
      name: r.name as string,
      purpose: r.purpose as string,
      tags: p(r.tagsJson, [] as string[]),
      uploaderId: r.uploaderId as string,
      status: r.status as AssetEntity["status"],
      createdAt: r.createdAt as number,
      reviewedBy: (r.reviewedBy as string | null) ?? null,
      reviewedAt: (r.reviewedAt as number | null) ?? null,
      deletedAt: (r.deletedAt as number | null) ?? null,
      overrides: p(r.overridesJson, {}),
    }),
  },
};
