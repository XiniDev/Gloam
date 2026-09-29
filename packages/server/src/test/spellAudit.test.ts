import type { Room } from "@colyseus/sdk";
import { effectiveTokenState } from "@gloam/shared/rules";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * P9's rules audit (SRD 5.2.1), the fixes on the resolution card: each attack, ray or dart is damage of its own (death
 * saves, Concentration saves, p. 17, p. 146, p. 179); a condition that incapacitates ends Concentration; the conditions
 * an effect's trigger lands end with its spell (Web's Restrained); Thunder does nothing inside Silence (p. 162); a
 * Silence the DM hides isn't shown on anyone's token nor named when a Verbal spell fails in it.
 */
describe("P9 — the rules audit's fixes on the card", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let anna: { room: TableRoomClient; id: string; msgs: Msg[] };
  let sceneId = "";
  let sera = "";
  let mage = "";
  let ogre = "";

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(230);
    return rq<T>(r, type, payload);
  };
  const statusOf = (id: string) => {
    const tok = room().model.get("token", id);
    if (!tok) throw new Error("no token");
    const a = tok.actorId ? room().model.get("actor", tok.actorId) : undefined;
    return effectiveTokenState(tok, a ?? undefined);
  };
  const closeAll = async () => {
    for (const c of room()
      .model.all("cast")
      .filter((x) => x.status === "open"))
      await cmd(dm, "cast.close", { castId: c.id });
  };
  const place = (tokenId: string, to: { x: number; y: number }) =>
    cmd(dm, "move.commit", { tokenId, points: [room().model.get("token", tokenId)?.pos, to] });
  /** Sera at full HP with nothing on her. */
  async function fresh() {
    await closeAll();
    for (const e of room().model.inScene("effect", sceneId))
      await cmd(dm, "effect.remove", { effectId: e.id });
    const tok = room().model.get("token", sera);
    await cmd(dm, "actor.change", {
      actorId: tok?.actorId,
      changes: [
        { path: ["core", "hp"], after: { max: 20, current: 20, temp: 0 } },
        { path: ["core", "conditions"], after: [] },
        { path: ["core", "deathSaves"], after: { successes: 0, failures: 0 } },
      ],
    });
    const s = statusOf(sera).status;
    if (s.markers.length || s.concentration)
      await cmd(dm, "status.change", {
        tokenId: sera,
        remove: [...s.markers.map((m) => m.id), "concentrating", "deathsaves"],
      });
  }

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "4242" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const p = await joinAsNew(t, code, "Anna");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    anna = { room: r, id: p.userId, msgs };
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Audit hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
      })
    ).sceneId;
    await rq(dm, "scene.activate", { sceneId });
    // Consequences as the "auto" automation has them: the non-decisions applied at once (death-save failures).
    await rq(dm, "campaign.update", { houseRules: { automation: "auto" } });
    const { actorId } = await cmd<{ actorId: string }>(anna.room, "actor.create", {
      ownerUserId: anna.id,
      sheet: {
        core: {
          name: "Sera",
          classes: [{ name: "Cleric", level: 5 }],
          abilities: { str: 10, dex: 10, con: 12, int: 10, wis: 16, cha: 10 },
          hp: { max: 20, current: 20, temp: 0 },
        },
      },
    });
    await waitFor(() =>
      room()
        .model.all("token")
        .some((x) => x.actorId === actorId),
    );
    sera = (
      room()
        .model.all("token")
        .find((x) => x.actorId === actorId) as { id: string }
    ).id;
    await place(sera, { x: 10, y: 20 });
    const npc = async (name: string, pos: { x: number; y: number }, extra: object = {}) =>
      (
        await cmd<{ tokenId: string }>(dm, "token.create", {
          sceneId,
          name,
          pos,
          disposition: "hostile",
          stats: { hp: 40, hpMax: 40, ac: 12, saves: { wis: 0, con: 0, dex: 0 }, ...extra },
        })
      ).tokenId;
    mage = await npc("Mage", { x: 40, y: 20 });
    ogre = await npc("Ogre", { x: 30, y: 30 });
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("B1: Magic Missile's three darts at a PC at 0 HP are three instances — three death-save failures, not one", async () => {
    await fresh();
    await cmd(dm, "hp.apply", { targets: [sera], kind: "damage", amount: 25 });
    await waitFor(() => statusOf(sera).status.deathSaves !== undefined);
    expect(statusOf(sera).status.deathSaves?.failures ?? 0).toBe(0);
    const mm = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "magic-missile",
      mode: "free",
      level: 1,
      targets: [sera, sera, sera],
    });
    const row = room().model.get("cast", mm.castId)?.data.targets[0];
    expect(row?.times).toBe(3);
    await cmd(dm, "cast.roll", { castId: mm.castId, what: "damage", targetId: row?.key, entered: 9 });
    await cmd(dm, "cast.apply", { castId: mm.castId });
    await waitFor(() => (statusOf(sera).status.deathSaves?.failures ?? 0) >= 3);
    expect(statusOf(sera).status.deathSaves?.failures).toBe(3);
  });

  it("B1: three darts at a concentrating PC are three Concentration saves", async () => {
    await fresh();
    await cmd(dm, "status.change", { tokenId: sera, concentration: "Bless" });
    const mark = anna.msgs.length;
    const mm = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "magic-missile",
      mode: "free",
      level: 1,
      targets: [sera, sera, sera],
    });
    const row = room().model.get("cast", mm.castId)?.data.targets[0];
    await cmd(dm, "cast.roll", { castId: mm.castId, what: "damage", targetId: row?.key, entered: 9 });
    await cmd(dm, "cast.apply", { castId: mm.castId });
    const conc = () =>
      anna.msgs
        .slice(mark)
        .filter((m) => m.type === "request.card" && JSON.stringify(m.payload).includes("Concentration"));
    await waitFor(() => conc().length >= 3);
    await sleep(300);
    expect(conc().length).toBe(3);
  });

  it("I2: Hold Person on a concentrating creature ends its Concentration (Paralyzed incapacitates)", async () => {
    await fresh();
    await cmd(dm, "status.change", { tokenId: sera, concentration: "Bless" });
    const hp = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "hold-person",
      mode: "free",
      level: 2,
      targets: [sera],
    });
    await cmd(dm, "cast.set", { castId: hp.castId, targetId: sera, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: hp.castId });
    await waitFor(() => statusOf(sera).status.conditions.some((c) => c.id === "paralyzed"));
    expect(statusOf(sera).status.concentration).toBeFalsy();
  });

  it("I1: Web's Restrained (from its trigger's card) ends with the web", async () => {
    await fresh();
    await place(ogre, { x: 48, y: 30 });
    const web = await cmd<{ castId: string | null; effectId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "web",
      mode: "free",
      level: 2,
      placement: { origin: { x: 20, y: 30, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    const castOfWeb = room().model.get("effect", web.effectId)?.source.castId;
    await closeAll();
    // The ogre walks in: the trigger's card; a failed save — Restrained.
    await place(ogre, { x: 20, y: 30 });
    await waitFor(() =>
      room()
        .model.all("cast")
        .some(
          (c) =>
            c.status === "open" && c.data.kind === "trigger" && c.data.targets.some((x) => x.id === ogre),
        ),
    );
    const card = room()
      .model.all("cast")
      .find((c) => c.status === "open" && c.data.kind === "trigger") as { id: string };
    await cmd(dm, "cast.set", { castId: card.id, targetId: ogre, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: card.id });
    const restrained = () => statusOf(ogre).status.conditions.find((c) => c.id === "restrained");
    await waitFor(() => restrained());
    expect(restrained()?.castId).toBe(castOfWeb);
    // The web goes (its caster's concentration ends): so does the Restrained it landed.
    await cmd(dm, "status.change", { tokenId: mage, concentration: null });
    await waitFor(() => !restrained());
    await place(ogre, { x: 30, y: 30 });
  });

  it("I6 / L5: Thunder does nothing inside Silence; a Silence the DM hides puts no Deafened on the tokens everyone sees, and isn't named", async () => {
    await fresh();
    const sil = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "silence",
      mode: "free",
      level: 2,
      placement: { origin: { x: 30, y: 30, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    await closeAll();
    // Shatter (thunder) at the ogre, inside it: the DM's card computes 0.
    const sh = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "shatter",
      mode: "free",
      level: 2,
      placement: { origin: { x: 30, y: 30, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    await cmd(dm, "cast.set", { castId: sh.castId, targetId: ogre, saveSuccess: false });
    await cmd(dm, "cast.roll", { castId: sh.castId, what: "damage", entered: 14 });
    const before = statusOf(ogre).stats.hp;
    await cmd(dm, "cast.apply", { castId: sh.castId, targets: [ogre] });
    await sleep(300);
    expect(statusOf(ogre).stats.hp).toBe(before);
    await closeAll();
    // Hidden: the ogre's public conditions lose Deafened; Sera, stepping in, is refused without its name.
    await waitFor(() => room().state.tokens.get(ogre)?.conditions.includes("deafened"));
    await cmd(dm, "effect.update", { effectId: sil.effectId, visibility: "dm" });
    await waitFor(() => !room().state.tokens.get(ogre)?.conditions.includes("deafened"));
    await place(sera, { x: 30, y: 26 });
    await expect(
      cmd(anna.room, "spell.cast", {
        casterTokenId: sera,
        spellId: "sacred-flame",
        mode: "slot",
        targets: [ogre],
      }),
    ).rejects.toThrow(/can't make a sound here/);
    await cmd(dm, "effect.remove", { effectId: sil.effectId });
    await place(sera, { x: 10, y: 20 });
  });

  it("I10: light and darkness both ways — a Light cast into a Darkness goes; a Darkness cast into a Daylight goes; a Light carried into a Darkness goes", async () => {
    await fresh();
    const effect = (id: string | null) => (id ? room().model.get("effect", id) : undefined);
    const dark = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "darkness",
      mode: "free",
      level: 2,
      placement: { origin: { x: 45, y: 10, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    expect(effect(dark.effectId)).toBeTruthy();
    // A Light on a stone put down inside it: dispelled as it comes.
    const lit = await cmd<{ effectId: string | null }>(dm, "spell.cast", {
      casterTokenId: ogre,
      spellId: "light",
      placement: { origin: { x: 45, y: 12, z: 0 }, dirDeg: 0 },
    });
    expect(lit.effectId).toBeNull();
    await cmd(dm, "effect.remove", { effectId: dark.effectId });
    // A Daylight standing: a Darkness cast into it goes (3rd level or lower).
    const day = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "daylight",
      mode: "free",
      level: 3,
      placement: { origin: { x: 45, y: 10, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    const dk2 = await cmd<{ effectId: string | null }>(dm, "spell.cast", {
      casterTokenId: ogre,
      spellId: "darkness",
      mode: "free",
      level: 2,
      placement: { origin: { x: 50, y: 20, z: 0 }, dirDeg: 0 },
      endConcentration: true,
    });
    expect(dk2.effectId).toBeNull();
    expect(effect(day.effectId)).toBeTruthy();
    await cmd(dm, "effect.remove", { effectId: day.effectId });
    // Carried: in a long hall (a Light reaches 40 ft, so they start well apart), a lamp-bearer walks toward a
    // Darkness — once its light reaches the dark, the Light goes.
    const hall = (
      await cmd<{ sceneId: string }>(dm, "scene.create", {
        name: "Long hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 140,
        heightFt: 40,
      })
    ).sceneId;
    await cmd(dm, "scene.activate", { sceneId: hall });
    const tok = async (name: string, pos: { x: number; y: number }) =>
      (await cmd<{ tokenId: string }>(dm, "token.create", { sceneId: hall, name, pos })).tokenId;
    const bearer = await tok("Lamp-bearer", { x: 5, y: 20 });
    const shade = await tok("Shade", { x: 130, y: 20 });
    const lamp = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: bearer,
      spellId: "light",
      placement: { origin: { x: 5, y: 20, z: 0 }, dirDeg: 0, attachTo: bearer },
    });
    const gloom = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: shade,
      spellId: "darkness",
      mode: "free",
      level: 2,
      placement: { origin: { x: 120, y: 20, z: 0 }, dirDeg: 0 },
    });
    expect(effect(lamp.effectId)).toBeTruthy();
    await cmd(dm, "move.commit", {
      tokenId: bearer,
      points: [
        { x: 5, y: 20 },
        { x: 70, y: 20 },
      ],
    });
    await waitFor(() => !effect(lamp.effectId));
    expect(effect(gloom.effectId)).toBeTruthy();
    await cmd(dm, "scene.activate", { sceneId });
  });

  it("m7 / m13: a save not rolled when the DM applies counts as failed for its conditions too; an attack counts the target's cover (half: +2)", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 30, y: 30 });
    const hp = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "hold-person",
      mode: "free",
      level: 2,
      targets: [ogre],
      endConcentration: true,
    });
    await cmd(dm, "cast.apply", { castId: hp.castId });
    await waitFor(() => statusOf(ogre).status.conditions.some((c) => c.id === "paralyzed"));
    await cmd(dm, "status.change", { tokenId: ogre, remove: ["paralyzed"] });
    // The ogre stands between the Mage and Sera: half cover. Sera's AC is 10: an 11 misses her (it needs 12).
    await place(ogre, { x: 25, y: 20 });
    const fb = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "fire-bolt",
      mode: "slot",
      targets: [sera],
    });
    const row = room().model.get("cast", fb.castId)?.data.targets[0];
    expect(row?.cover).toBe("half");
    expect(statusOf(sera).stats.ac).toBe(10);
    await cmd(dm, "cast.roll", { castId: fb.castId, what: "attack", targetId: sera, entered: 11 });
    expect(room().model.get("cast", fb.castId)?.data.targets[0]?.attack?.hit).toBe(false);
    await closeAll();
    await place(ogre, { x: 30, y: 30 });
  });
});
