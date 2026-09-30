import { createHash, randomBytes, randomInt } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHT_PRESETS } from "@gloam/shared";
import { AMBIENCE_PRESETS, DEFAULT_CAMPAIGN_AUDIO, TokenStatsIn } from "@gloam/shared/protocol";
import { statusFromSheet, storedSheet } from "@gloam/shared/rules";
import type {
  EffectEntity,
  LightEntity,
  SceneEntity,
  TokenEntity,
  TokenStats,
  WallEntity,
  ZoneEntity,
} from "@gloam/shared/schemas";
import { EMPTY_STATUS } from "@gloam/shared/schemas";
import sharp from "sharp";
import type { Uploader } from "../assets/service.ts";
import type { ServerContext } from "../context.ts";
import type { ActorEntity, HandoutEntity } from "../engine/codecs.ts";
import { CODECS } from "../engine/codecs.ts";
import { checkSheet } from "../engine/commands/actor.ts";
import { newId } from "../ids.ts";
import { GOBLIN_SVG, WARDEN_SVG } from "./art.ts";

type V = { x: number; y: number };

/**
 * The Lantern Crypt (SPEC §8.24; AC-DEMO-01/02): a small dungeon made entirely by code — an entrance hall, a pillared
 * crypt, a narrow corridor, a flooded chamber and a treasure room behind a secret door — on the procedural stone floor
 * with 3D walls; wall sconces (flickering torches), a brazier, a shaft of moonlight and a pocket of magical darkness;
 * four goblins and the Crypt Warden with code-drawn art, a party spawn point, two handouts, the Crypt ambience and a
 * pregenerated character. Dynamic fog. Ready to open and fight.
 */
export async function createLanternCrypt(ctx: ServerContext, by: Uploader): Promise<{ campaignId: string }> {
  const defaults = ctx.settings.get().newCampaignDefaults;
  const campaign = ctx.campaigns.create({
    name: "The Lantern Crypt",
    rulesPack: defaults.rulesPack,
    units: defaults.units,
  });
  const campaignId = campaign.id;
  try {
    const [goblinArt, wardenArt] = [
      await art(ctx, campaignId, by, GOBLIN_SVG, "Goblin"),
      await art(ctx, campaignId, by, WARDEN_SVG, "Crypt Warden"),
    ];
    const now = Date.now();
    const scene: SceneEntity = {
      id: newId("scn"),
      campaignId,
      name: "The Lantern Crypt",
      sort: 1,
      mapKind: "procedural",
      mapAssetId: null,
      calibration: {},
      floor: { style: "stone" },
      ambient: { level: "dark", tint: "#FFFFFF" },
      fogMode: "dynamic",
      fogCellFt: 1,
      bounds: { minX: 0, minY: 0, maxX: 120, maxY: 70 },
      // The party comes in at the hall's west end.
      spawn: { x: 12, y: 35 },
      music: null,
      walls3d: true,
      thumbnailAssetId: null,
      dmNotes:
        "The goblins keep watch in the crypt; one wades in the flooded chamber. The Warden wakes if the secret door opens. The riddle's answer: a shadow.",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    };
    const sceneId = scene.id;
    const walls: WallEntity[] = [];
    const wall = (a: V, b: V, kind: WallEntity["kind"] = "wall", doorState: WallEntity["doorState"] = null) =>
      walls.push({ id: newId("wal"), sceneId, a, b, kind, doorState, hidden: false });
    /** A room's four walls, with openings (from–to along a side) left open or closed by a door. */
    const room = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      gaps: { side: "n" | "s" | "w" | "e"; from: number; to: number; door?: WallEntity["kind"] }[] = [],
    ) => {
      const sides: Record<string, [V, V]> = {
        n: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
        ],
        s: [
          { x: x0, y: y1 },
          { x: x1, y: y1 },
        ],
        w: [
          { x: x0, y: y0 },
          { x: x0, y: y1 },
        ],
        e: [
          { x: x1, y: y0 },
          { x: x1, y: y1 },
        ],
      };
      for (const [side, [a, b]] of Object.entries(sides)) {
        const horizontal = side === "n" || side === "s";
        const along = (t: number): V => (horizontal ? { x: t, y: a.y } : { x: a.x, y: t });
        const start = horizontal ? a.x : a.y;
        const end = horizontal ? b.x : b.y;
        let cur = start;
        for (const g of gaps.filter((x) => x.side === side).sort((p, q) => p.from - q.from)) {
          if (g.from > cur) wall(along(cur), along(g.from));
          if (g.door) wall(along(g.from), along(g.to), g.door, g.door === "door" ? "closed" : null);
          cur = g.to;
        }
        if (cur < end) wall(along(cur), along(end));
      }
    };
    // The entrance hall; its door east into a short passage, and on into the crypt.
    room(5, 22, 35, 48, [{ side: "e", from: 32, to: 38, door: "door" }]);
    wall({ x: 35, y: 32 }, { x: 40, y: 32 });
    wall({ x: 35, y: 38 }, { x: 40, y: 38 });
    // The pillared crypt: open to the passage (west) and the corridor (east).
    room(40, 10, 75, 60, [
      { side: "w", from: 32, to: 38 },
      { side: "e", from: 33, to: 37 },
    ]);
    for (const [px, py] of [
      [50, 20],
      [64, 20],
      [50, 48],
      [64, 48],
    ] as const)
      room(px, py, px + 4, py + 4);
    // The narrow corridor to the flooded chamber.
    wall({ x: 75, y: 33 }, { x: 95, y: 33 });
    wall({ x: 75, y: 37 }, { x: 95, y: 37 });
    // The flooded chamber; the treasure room above it, behind a secret door.
    room(95, 25, 115, 62, [
      { side: "w", from: 33, to: 37 },
      { side: "n", from: 103, to: 107, door: "secret" },
    ]);
    room(95, 5, 115, 25, [{ side: "s", from: 103, to: 107 }]);

    const light = (pos: V, presetId: string, over: Partial<LightEntity> = {}): LightEntity => {
      const p = LIGHT_PRESETS.find((l) => l.id === presetId);
      return {
        id: newId("lgt"),
        sceneId,
        tokenId: null,
        pos,
        elevation: 5,
        bright: p?.bright ?? 20,
        dim: p?.dim ?? 20,
        color: p?.color ?? "#FFB35C",
        intensity: 1,
        animation: p?.animation ?? "torch",
        coneDeg: p?.coneDeg ?? null,
        directionDeg: 0,
        magical: false,
        pierceDarkness: false,
        enabled: true,
        dmOnly: false,
        preset: p?.id ?? null,
        shuttered: false,
        ...over,
      };
    };
    const lights: LightEntity[] = [
      // Wall sconces: torches on the walls, flickering.
      light({ x: 6, y: 35 }, "torch", { label: "Sconce · entrance hall" }),
      light({ x: 41, y: 14 }, "torch", { label: "Sconce · crypt, north-west" }),
      light({ x: 74, y: 14 }, "torch", { label: "Sconce · crypt, north-east" }),
      light({ x: 41, y: 56 }, "torch", { label: "Sconce · crypt, south-west" }),
      light({ x: 74, y: 56 }, "torch", { label: "Sconce · crypt, south-east" }),
      // The brazier at the crypt's heart.
      light({ x: 57.5, y: 35 }, "torch", {
        label: "Brazier",
        preset: null,
        bright: 10,
        dim: 10,
        elevation: 3,
        animation: "torch",
      }),
      // A shaft of moonlight in the flooded chamber: dim, cold, still.
      light({ x: 108, y: 44 }, "torch", {
        label: "Moon shaft",
        preset: null,
        bright: 0,
        dim: 10,
        color: "#9FB8E8",
        animation: "none",
        elevation: 30,
      }),
    ];
    const zones: ZoneEntity[] = [
      {
        id: newId("zon"),
        sceneId,
        kind: "water",
        shape: { kind: "rect", x: 96, y: 40, w: 18, h: 21 },
        label: "Black water",
        color: "#3F6E8C",
        visible: true,
        triggers: [],
        note: "Waist-deep and cold: swimming costs double.",
      },
      {
        id: newId("zon"),
        sceneId,
        kind: "difficult",
        shape: { kind: "rect", x: 41, y: 52, w: 16, h: 7 },
        label: "Rubble",
        color: "#8C7A5B",
        visible: true,
        triggers: [],
        note: "",
      },
    ];
    const darkness: EffectEntity = {
      id: newId("eff"),
      sceneId,
      name: "Darkness",
      source: { kind: "custom" },
      shape: { kind: "sphere", origin: { x: 70, y: 44, z: 0 }, radius: 5 },
      attachedTokenId: null,
      props: { magicalDarkness: true, obscurement: "heavy" },
      triggers: [],
      concentrationTokenId: null,
      expires: { never: true },
      visibility: "everyone",
      vfx: "necrotic",
      movement: null,
      createdAt: now,
    };

    /** A creature's numbers, with the defaults a token's stats take (TokenStatsIn fills the rest). */
    const stats = (o: Record<string, unknown>): TokenStats =>
      TokenStatsIn.parse({
        ...o,
        hpMax: o.hpMax ?? o.hp,
        initBonus: o.initBonus ?? o.dexMod ?? 0,
      }) as TokenStats;
    const token = (name: string, pos: V, sizeFt: number, assetId: string, s: TokenStats): TokenEntity => ({
      id: newId("tok"),
      sceneId,
      actorId: null,
      link: "unlinked",
      name,
      pos,
      elevation: 0,
      rotationDeg: 0,
      sizeFt,
      appearance: { mode: "coin", assetId, scale: 1, offsetY: 0, rotationOffsetDeg: 0 },
      ownerIds: [],
      disposition: "hostile",
      hidden: false,
      revealTo: "vision",
      hpDisplay: "bar",
      stats: s,
      status: { ...EMPTY_STATUS },
      overrides: {},
      lightId: null,
      locked: false,
      dmNote: "",
      moveMode: "walk",
      createdAt: now,
      updatedAt: now,
    });
    const goblin = () =>
      stats({ hp: 7, ac: 15, dexMod: 2, size: "small", senses: { darkvision: 60 }, speeds: { walk: 30 } });
    const tokens: TokenEntity[] = [
      token("Goblin", { x: 55, y: 28 }, 5, goblinArt, goblin()),
      token("Goblin 2", { x: 61, y: 42 }, 5, goblinArt, goblin()),
      token("Goblin 3", { x: 68, y: 30 }, 5, goblinArt, goblin()),
      token("Goblin 4", { x: 101, y: 48 }, 5, goblinArt, goblin()),
      token(
        "Crypt Warden",
        { x: 105, y: 15 },
        10,
        wardenArt,
        stats({
          hp: 45,
          ac: 16,
          dexMod: 0,
          size: "large",
          reachFt: 10,
          senses: { darkvision: 60 },
          immune: ["poison"],
          conditionImmune: ["poisoned", "exhaustion"],
        }),
      ),
    ];
    (tokens[4] as TokenEntity).dmNote = "Wakes when the secret door opens. Slams (2d8 + 3 bludgeoning).";

    // A pregenerated character for quick tests: anyone can take her.
    const mira = checkSheet({
      core: {
        name: "Mira Holloway",
        classes: [{ name: "Fighter", level: 3 }],
        abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
        hp: { max: 28, current: 28, temp: 0 },
        ac: { value: 17 },
        speeds: { walk: 30 },
        saves: { str: { proficient: true }, con: { proficient: true } },
      },
    });
    const actor: ActorEntity = {
      id: newId("act"),
      campaignId,
      kind: "character",
      ownerUserId: null,
      templateId: null,
      lockLevel: "unlocked",
      sheet: storedSheet(mira) as unknown as Record<string, unknown>,
      status: statusFromSheet(mira, EMPTY_STATUS) as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const handout = (title: string, bodyMd: string): HandoutEntity => ({
      id: newId("hnd"),
      campaignId,
      kind: "handout",
      title,
      bodyMd,
      imageAssetId: null,
      recipients: [],
      createdBy: by.userId,
      createdAt: now,
    });
    const handouts = [
      handout(
        "A torn map",
        "A scrap of vellum, its edge burned:\n\n- **The hall** where the lanterns hang\n- **The crypt** of four pillars\n- a narrow way east, to *the drowned room*\n\nBeside the drowned room, in a shaky hand: *the wall that isn't a wall*.",
      ),
      handout(
        "A riddle on the door",
        "> *The more of me there is, the less you see.*\n> *I wait in every corner; the lantern is my enemy.*\n> *Name me, and the stone will let you through.*",
      ),
    ];

    ctx.sqlite.transaction(() => {
      const put = <K extends keyof typeof CODECS>(kind: K, e: Parameters<(typeof CODECS)[K]["toRow"]>[0]) => {
        const codec = CODECS[kind];
        ctx.db
          .insert(codec.table)
          .values(codec.toRow(e as never) as never)
          .run();
      };
      put("scene", scene);
      for (const w of walls) put("wall", w);
      for (const l of lights) put("light", l);
      for (const z of zones) put("zone", z);
      put("effect", darkness);
      for (const t of tokens) put("token", t);
      put("actor", actor);
      for (const h of handouts) put("handout", h);
      ctx.campaigns.update(campaignId, {
        activeSceneId: sceneId,
        settingsJson: JSON.stringify({
          audio: {
            ...DEFAULT_CAMPAIGN_AUDIO,
            ambience: { levels: { ...AMBIENCE_PRESETS.crypt }, preset: "crypt", seed: randomInt(2 ** 31) },
          },
        }),
      });
    })();
    return { campaignId };
  } catch (err) {
    // Half a demo helps no one.
    ctx.campaigns.delete(campaignId);
    throw err;
  }
}

/** Renders a piece of code-drawn art and takes it through the upload pipeline (a token picture of the campaign). */
async function art(
  ctx: ServerContext,
  campaignId: string,
  by: Uploader,
  svg: string,
  name: string,
): Promise<string> {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const tmp = join(ctx.paths.tmp, `demo-${randomBytes(8).toString("hex")}`);
  writeFileSync(tmp, png, { mode: 0o600 });
  try {
    const r = await ctx.assets.ingest({
      tmpPath: tmp,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      purpose: "token",
      name,
      campaignId,
      uploader: by,
    });
    return r.asset.id;
  } finally {
    rmSync(tmp, { force: true });
  }
}
