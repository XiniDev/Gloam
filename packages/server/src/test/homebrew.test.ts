import type { Room } from "@colyseus/sdk";
import type { Spell } from "@gloam/shared/schemas";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSrdPack } from "../content/packs.ts";
import type { HomebrewEntry, ImportReport } from "../engine/commands/content.ts";
import type { TableRoom } from "../rooms/TableRoom.ts";
import {
  type Agent,
  createCampaign,
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
interface Msg {
  type: string;
  payload: unknown;
}

const SRD = loadSrdPack().spells;
const fireball = SRD.find((s) => s.id === "fireball") as Spell;
/** A copy of an SRD spell as someone would start a homebrew one from it (§8.13 "Poison Ball" from Fireball). */
const from = (s: Spell, id: string, name: string, patch: Partial<Spell> = {}): Record<string, unknown> => {
  const { provenance: _p, ...rest } = s as Spell & { provenance?: unknown };
  return { ...rest, id, name, source: { pack: "homebrew" }, ...patch };
};

/**
 * Homebrew spells and imports on the server (SPEC §8.13 Homebrew builder, Import; AC-SPL-10/11): the published schema,
 * the DM's spell in use at once, a player's proposed for the DM's approval (seen only by its author and the DM till
 * then), an SRD id never shadowed, formulas checked; `POST /api/v1/content/spells:import` — a dry run's report, then
 * skip / overwrite / rename — and only a DM may.
 */
describe("P9 — homebrew spells and imports (AC-SPL-10/11)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  const players: Record<string, { room: TableRoomClient; agent: Agent; id: string; msgs: Msg[] }> = {};
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(230);
    return rq<T>(r, type, payload);
  };
  const latestHomebrew = (msgs: Msg[]) =>
    [...msgs].reverse().find((m) => m.type === "content.spells")?.payload as HomebrewEntry[] | undefined;

  async function admit(name: string) {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    players[name] = { room: r, agent: p.agent, id: p.userId, msgs };
  }

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    await admit("Anna");
    await admit("Bo");
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("the spell schema is published (JSON Schema of the import shape)", async () => {
    const r = await admin.get("/api/v1/schemas/spell.json");
    expect(r.status).toBe(200);
    const s = r.json as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    expect(s.type).toBe("object");
    for (const k of ["id", "name", "level", "school", "range", "duration", "components"])
      expect(Object.keys(s.properties ?? {})).toContain(k);
  });

  it("the DM's homebrew spell is in use at once, for everyone; an SRD id is refused; a bad formula is refused with where", async () => {
    const poison = from(fireball, "poison-ball", "Poison Ball", {
      damage: [{ ...(fireball.damage?.[0] as NonNullable<Spell["damage"]>[number]), type: "poison" }],
      vfx: "poison",
    });
    const r = await cmd<{ id: string; status: string }>(dm, "content.spell.save", { spell: poison });
    expect(r.status).toBe("active");
    await waitFor(() => latestHomebrew(players.Anna?.msgs ?? [])?.some((h) => h.spell.id === "poison-ball"));
    await expect(
      cmd(dm, "content.spell.save", { spell: from(fireball, "fireball", "My Fireball") }),
    ).rejects.toThrow(/SRD spell's id/);
    const bad = from(fireball, "bad-ball", "Bad Ball", {
      damage: [{ ...(fireball.damage?.[0] as NonNullable<Spell["damage"]>[number]), formula: "8d6 +" }],
    });
    await expect(cmd(dm, "content.spell.save", { spell: bad })).rejects.toThrow(/damage\[0\]\.formula/);
    // It casts like any other (the DM's free cast of it for a token of theirs).
    const sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Yard",
        mapKind: "procedural",
        floorStyle: "grass",
        widthFt: 60,
        heightFt: 40,
      })
    ).sceneId;
    await rq(dm, "scene.activate", { sceneId });
    const { tokenId } = await cmd<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name: "Hag",
      pos: { x: 10, y: 10 },
      stats: { hp: 20, hpMax: 20, ac: 12 },
    });
    const cast = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: tokenId,
      spellId: "poison-ball",
      mode: "free",
      level: 3,
      placement: { origin: { x: 40, y: 20, z: 0 } },
    });
    expect(room().model.get("cast", cast.castId)?.data.damage?.parts[0]?.type).toBe("poison");
  });

  it("a player's spell is a proposal — theirs and the DM's to see, not another player's — until the DM approves it", async () => {
    const anna = players.Anna as (typeof players)[string];
    const bo = players.Bo as (typeof players)[string];
    const frost = from(fireball, "frost-ball", "Frost Ball", {
      damage: [{ ...(fireball.damage?.[0] as NonNullable<Spell["damage"]>[number]), type: "cold" }],
      vfx: "cold",
    });
    const r = await cmd<{ id: string; status: string }>(anna.room, "content.spell.save", { spell: frost });
    expect(r.status).toBe("proposed");
    await waitFor(() =>
      latestHomebrew(anna.msgs)?.some((h) => h.spell.id === "frost-ball" && h.status === "proposed"),
    );
    await sleep(300);
    expect(latestHomebrew(bo.msgs)?.some((h) => h.spell.id === "frost-ball")).toBe(false);
    // A player can't approve, nor cast it yet.
    await expect(cmd(anna.room, "content.spell.decide", { id: r.id, approve: true })).rejects.toThrow(
      /FORBIDDEN/,
    );
    await cmd(dm, "content.spell.decide", { id: r.id, approve: true });
    await waitFor(() =>
      latestHomebrew(bo.msgs)?.some((h) => h.spell.id === "frost-ball" && h.status === "active"),
    );
  });

  it("REST import: a dry run reports valid, invalid (with why) and clashes, changing nothing; then rename, overwrite and skip; only a DM may", async () => {
    const batch = [
      from(fireball, "ember-storm", "Ember Storm"),
      { ...from(fireball, "broken", "Broken"), level: 12 },
      from(fireball, "fireball", "Fireball (ours)"),
      from(fireball, "poison-ball", "Poison Ball Mk II"),
    ];
    const count = () =>
      room()
        .model.all("content")
        .filter((c) => c.type === "spell").length;
    const before = count();
    const dry = await admin.post("/api/v1/content/spells:import", {
      campaignId,
      spells: batch,
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    const d = (dry.json as { data: ImportReport }).data;
    expect(d.dryRun).toBe(true);
    expect(d.total).toBe(4);
    expect(d.valid).toBe(3);
    expect(d.invalid.map((x) => x.index)).toEqual([1]);
    expect(d.invalid[0]?.errors.join(" ")).toMatch(/level/);
    expect(d.conflicts.map((x) => [x.id, x.with])).toEqual([
      ["fireball", "srd"],
      ["poison-ball", "homebrew"],
    ]);
    expect(count()).toBe(before);
    // Rename: the SRD clash and the homebrew one both get the next free id.
    const renamed = (
      (
        await admin.post("/api/v1/content/spells:import", {
          campaignId,
          spells: batch,
          dryRun: false,
          strategy: "rename",
        })
      ).json as { data: ImportReport }
    ).data;
    expect(renamed.imported.sort()).toEqual(["ember-storm", "fireball-2", "poison-ball-2"].sort());
    expect(renamed.renamed).toEqual([
      { from: "fireball", to: "fireball-2" },
      { from: "poison-ball", to: "poison-ball-2" },
    ]);
    expect(count()).toBe(before + 3);
    // Overwrite: the homebrew clash replaced in place; the SRD one never — renamed instead.
    const over = (
      (
        await admin.post("/api/v1/content/spells:import", {
          campaignId,
          spells: [from(fireball, "poison-ball", "Poison Ball Mk III"), from(fireball, "fireball", "Fb")],
          dryRun: false,
          strategy: "overwrite",
        })
      ).json as { data: ImportReport }
    ).data;
    expect(over.overwritten).toEqual(["poison-ball"]);
    expect(over.renamed).toEqual([{ from: "fireball", to: "fireball-3" }]);
    expect(
      room()
        .model.all("content")
        .find((c) => c.slug === "poison-ball")?.name,
    ).toBe("Poison Ball Mk III");
    // Skip: nothing new.
    const skip = (
      (
        await admin.post("/api/v1/content/spells:import", {
          campaignId,
          spells: [from(fireball, "ember-storm", "Again")],
          dryRun: false,
          strategy: "skip",
        })
      ).json as { data: ImportReport }
    ).data;
    expect(skip.skipped).toEqual(["ember-storm"]);
    // A player may not.
    const no = await (players.Anna as (typeof players)[string]).agent.post("/api/v1/content/spells:import", {
      campaignId,
      spells: batch,
      dryRun: true,
    });
    expect(no.status).toBe(403);
  });
});
