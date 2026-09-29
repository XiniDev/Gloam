import type { Room } from "@colyseus/sdk";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableRoom } from "../rooms/TableRoom.ts";
import {
  type Agent,
  joinAsNew,
  openTable,
  rq,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;

/**
 * The demo campaign (SPEC §8.24; AC-DEMO-01/02): the Lantern Crypt, made by code — every listed element present,
 * nothing external or uploaded by anyone — and on an open table it shows what Gloam does: flickering sconces, a darkness
 * darkvision can't see into, dynamic fog, a secret door, water and rubble, a fight ready to start.
 */
describe("P12 — the Lantern Crypt (DEMO)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId = "";
  const q = <T>(sql: string, ...a: unknown[]) => t.server.ctx.sqlite.prepare(sql).all(...a) as T[];

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    const r = await admin.post("/api/admin/campaigns/demo", {});
    if (r.status !== 200) throw new Error(`demo failed: ${JSON.stringify(r.json)}`);
    campaignId = (r.json.data as { id: string }).id;
  }, 60_000);
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-DEMO-01: makes the Lantern Crypt with every listed element, from code alone", async () => {
    const [c] = q<{ name: string; active_scene_id: string; settings_json: string }>(
      "SELECT name, active_scene_id, settings_json FROM campaigns WHERE id = ?",
      campaignId,
    );
    expect(c?.name).toBe("The Lantern Crypt");
    // Selected for the table.
    expect(t.server.ctx.settings.get().selectedCampaignId).toBe(campaignId);
    const [scene] = q<{
      id: string;
      map_kind: string;
      floor_json: string;
      fog_mode: string;
      walls3d: number;
      spawn_json: string;
    }>("SELECT * FROM scenes WHERE campaign_id = ?", campaignId);
    expect(scene?.id).toBe(c?.active_scene_id);
    expect(scene?.map_kind).toBe("procedural");
    expect(JSON.parse(scene?.floor_json ?? "{}").style).toBe("stone");
    expect(scene?.fog_mode).toBe("dynamic");
    expect(scene?.walls3d).toBe(1);
    expect(JSON.parse(scene?.spawn_json ?? "null")).toEqual({ x: 12, y: 35 });
    const sceneId = scene?.id as string;
    // The rooms' walls, a door into the crypt and a secret door to the treasure room.
    const walls = q<{ kind: string }>("SELECT kind FROM walls WHERE scene_id = ?", sceneId);
    expect(walls.length).toBeGreaterThan(30);
    expect(walls.filter((w) => w.kind === "door")).toHaveLength(1);
    expect(walls.filter((w) => w.kind === "secret")).toHaveLength(1);
    // Five wall sconces (flickering torches), a brazier, a still shaft of moonlight.
    const lights = q<{
      preset: string | null;
      animation: string;
      bright: number;
      dim: number;
      color: string;
    }>("SELECT preset, animation, bright, dim, color FROM lights WHERE scene_id = ?", sceneId);
    expect(lights.filter((l) => l.preset === "torch" && l.animation === "torch")).toHaveLength(5);
    expect(lights.filter((l) => l.preset === null && l.animation === "torch")).toHaveLength(1);
    expect(lights.find((l) => l.animation === "none")).toMatchObject({ bright: 0, dim: 10 });
    // A pocket of magical darkness; water and difficult ground.
    const effects = q<{ name: string; props_json: string }>(
      "SELECT props_json FROM effects WHERE scene_id = ?",
      sceneId,
    );
    expect(effects).toHaveLength(1);
    expect(JSON.parse(effects[0]?.props_json ?? "{}").magicalDarkness).toBe(true);
    const zones = q<{ kind: string }>("SELECT kind FROM zones WHERE scene_id = ?", sceneId)
      .map((z) => z.kind)
      .sort();
    expect(zones).toEqual(["difficult", "water"]);
    // Four goblins and the Crypt Warden (large), coins with art drawn by code.
    const tokens = q<{ name: string; size_ft: number; appearance_json: string; disposition: string }>(
      "SELECT name, size_ft, appearance_json, disposition FROM tokens WHERE scene_id = ?",
      sceneId,
    );
    expect(tokens.filter((x) => x.name.startsWith("Goblin"))).toHaveLength(4);
    const warden = tokens.find((x) => x.name === "Crypt Warden");
    expect(warden?.size_ft).toBe(10);
    for (const x of tokens) {
      const ap = JSON.parse(x.appearance_json) as { mode: string; assetId?: string };
      expect(ap.mode).toBe("coin");
      expect(ap.assetId).toMatch(/^ast_/);
    }
    // Every asset is the demo's own: two pictures made here, through the upload pipeline (no network, no uploads).
    const assets = q<{ purpose: string; status: string; uploader_id: string; name: string }>(
      "SELECT purpose, status, uploader_id, name FROM assets WHERE campaign_id = ?",
      campaignId,
    );
    expect(assets.map((a) => a.name).sort()).toEqual(["Crypt Warden", "Goblin"]);
    expect(new Set(assets.map((a) => `${a.purpose}/${a.status}`))).toEqual(new Set(["token/approved"]));
    // Two handouts (drafts), the Crypt ambience, a pregenerated character.
    const handouts = q<{ title: string; recipients_json: string }>(
      "SELECT title, recipients_json FROM handouts WHERE campaign_id = ?",
      campaignId,
    );
    expect(handouts.map((h) => h.title).sort()).toEqual(["A riddle on the door", "A torn map"]);
    expect(handouts.every((h) => h.recipients_json === "[]")).toBe(true);
    expect(JSON.parse(c?.settings_json ?? "{}").audio.ambience).toMatchObject({ preset: "crypt" });
    const actors = q<{ kind: string; owner_user_id: string | null; sheet_json: string }>(
      "SELECT kind, owner_user_id, sheet_json FROM actors WHERE campaign_id = ?",
      campaignId,
    );
    expect(actors).toHaveLength(1);
    expect(actors[0]?.kind).toBe("character");
    expect(JSON.parse(actors[0]?.sheet_json ?? "{}").core.name).toBe("Mira Holloway");
  });

  it("AC-DEMO-02: on an open table — dynamic fog, a darkness darkvision can't see into, a secret door players don't see, and a fight ready to start", async () => {
    const code = (await openTable(admin, "local")).code;
    const dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const p = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const dave = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dave.onMessage("*", () => {});
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
    const sceneId = room.model.campaign.activeSceneId as string;
    expect(room.model.get("scene", sceneId)?.fogMode).toBe("dynamic");
    // Dave's scout with darkvision in the crypt, beside the darkness; a goblin inside it, another in plain dark.
    const tok = async (name: string, pos: { x: number; y: number }, extra: Record<string, unknown> = {}) =>
      (await rq<{ tokenId: string }>(dm, "token.create", { sceneId, name, pos, ...extra })).tokenId;
    const scout = await tok(
      "Scout",
      { x: 60, y: 44 },
      {
        ownerIds: [p.userId],
        disposition: "party",
        stats: { hp: 10, hpMax: 10, ac: 13, senses: { darkvision: 60 } },
      },
    );
    await sleep(250);
    const inDark = await tok("Lurker in the dark", { x: 70, y: 44 });
    await sleep(250);
    const inPlain = await tok("Lurker in the open", { x: 60, y: 30 });
    const sees = (id: string) => Boolean(dave.state.tokens?.get?.(id));
    await waitFor(() => sees(scout) && sees(inPlain), 5000);
    await sleep(300);
    expect(sees(inDark)).toBe(false);
    // The secret door: a wall to Dave (never "secret"), a door to the DM.
    const secret = room.model.all("wall").find((w) => w.kind === "secret");
    expect(secret).toBeTruthy();
    expect(JSON.stringify(dave.state.walls?.get?.(secret?.id as string) ?? {})).not.toContain("secret");
    // Ready to fight: Quick start takes the goblins and the Warden.
    await rq(dm, "combat.quickStart", {});
    const names = await waitFor(() => {
      const c = room.model.all("combat").find((x) => x.active);
      const d = c?.data as { combatants?: { name: string }[] } | undefined;
      return d?.combatants?.length ? d.combatants.map((x) => x.name) : null;
    });
    expect(names).toEqual(
      expect.arrayContaining(["Goblin", "Goblin 2", "Goblin 3", "Goblin 4", "Crypt Warden"]),
    );
  });
});
