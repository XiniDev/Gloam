import type { Room } from "@colyseus/sdk";
import { effectiveTokenState } from "@gloam/shared/rules";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataOf } from "../engine/commands/combat.ts";
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

  it("A9: Sacred Flame's target gains no benefit from half cover for its Dexterity save (SRD p. 159); Lightning Bolt's does (+2)", async () => {
    await fresh();
    const dmMsgs: Msg[] = [];
    const off = dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    // The ogre stands between the Mage and Sera: half cover (its base in the way).
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 25, y: 20 });
    /** Cast at Sera; the DM sets DC 12 (the Mage has no sheet); Anna enters 11 on her save card. */
    const saveAt11 = async (spellId: string, level: number, extra: object) => {
      const mark = anna.msgs.length;
      const r = await cmd<{ castId: string }>(dm, "spell.cast", {
        casterTokenId: mage,
        spellId,
        mode: "free",
        level,
        ...extra,
      });
      const row = () =>
        room()
          .model.get("cast", r.castId)
          ?.data.targets.find((x) => x.id === sera);
      expect(row()?.cover, spellId).toBe("half");
      await cmd(dm, "cast.setDc", { castId: r.castId, dc: 12 });
      const card = await waitFor(() =>
        anna.msgs
          .slice(mark)
          .filter((m) => m.type === "request.card")
          .map((m) => m.payload as { requestId: string; targetId: string; dc?: number })
          .find((c) => c.targetId === sera),
      );
      await cmd(anna.room, "request.respond", {
        requestId: card.requestId,
        target: sera,
        action: "manual",
        total: 11,
      });
      await waitFor(() => row()?.save?.total === 11);
      const answered = row()?.save?.success;
      // Judged again when the DM moves the DC (to 13: 11 + 2 still makes it; 11 alone doesn't).
      await cmd(dm, "cast.setDc", { castId: r.castId, dc: 13 });
      const rejudged = row()?.save?.success;
      return { castId: r.castId, answered, rejudged };
    };
    const flame = await saveAt11("sacred-flame", 0, { targets: [sera] });
    expect(flame).toMatchObject({ answered: false, rejudged: false });
    // The DM's card says why the chip's cover counts for nothing here.
    type View = { id: string; save?: { ignoresCover?: boolean }; coverNote?: string };
    const viewsOf = (m: Msg): View[] =>
      m.type === "cast.view" ? [m.payload as View] : m.type === "cast.views" ? (m.payload as View[]) : [];
    const flameView = await waitFor(() =>
      dmMsgs
        .flatMap(viewsOf)
        .reverse()
        .find((v) => v.id === flame.castId && v.coverNote),
    );
    expect(flameView.save?.ignoresCover).toBe(true);
    expect(flameView.coverNote).toMatch(/Sacred Flame ignores it: nothing added to its DEX save/);
    await closeAll();
    const bolt = await saveAt11("lightning-bolt", 3, {
      placement: { origin: { x: 40, y: 20, z: 0 }, dirDeg: 90 },
    });
    expect(bolt).toMatchObject({ answered: true, rejudged: true });
    off();
    await closeAll();
    await place(ogre, { x: 30, y: 30 });
  });

  it("A11: a player's creature that's Incapacitated — or Unconscious, Stunned, dead — can't cast or attack; the DM still can (SRD 5.2.1 p. 184)", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 15, y: 20 });
    const tok = room().model.get("token", sera);
    await cmd(dm, "actor.change", {
      actorId: tok?.actorId,
      changes: [
        {
          path: ["core", "attacks"],
          after: [{ name: "Mace", attack: "1d20 + 2", damage: "1d6 [bludgeoning]", range: "5 ft" }],
        },
      ],
    });
    const flame = (r: TableRoomClient) =>
      cmd<{ castId: string }>(r, "spell.cast", {
        casterTokenId: sera,
        spellId: "sacred-flame",
        mode: "slot",
        targets: [ogre],
      });
    const swing = () => cmd(anna.room, "attack.start", { tokenId: sera, attack: 0, targets: [ogre] });
    await cmd(dm, "status.change", { tokenId: sera, add: [{ id: "unconscious" }] });
    await expect(flame(anna.room)).rejects.toThrow(/Sera is Unconscious: it can't cast a spell/);
    await expect(swing()).rejects.toThrow(/Sera is Unconscious: it can't attack/);
    await cmd(dm, "status.change", {
      tokenId: sera,
      remove: ["unconscious", "prone"],
      add: [{ id: "stunned" }],
    });
    await expect(flame(anna.room)).rejects.toThrow(/Sera is Stunned/);
    // The DM's call stands (a feature, a house rule).
    const r = await flame(dm);
    expect(room().model.get("cast", r.castId)?.status).toBe("open");
    await closeAll();
    await cmd(dm, "status.change", { tokenId: sera, remove: ["stunned"], add: [{ id: "dead" }] });
    await expect(flame(anna.room)).rejects.toThrow(/Sera is dead: it can't cast a spell/);
    await cmd(dm, "status.change", { tokenId: sera, remove: ["dead"] });
    // Able again: both go through.
    const ok = await flame(anna.room);
    expect(room().model.get("cast", ok.castId)?.status).toBe("open");
    await closeAll();
    const a = await swing();
    expect((a as { castId: string }).castId).toBeTruthy();
    await closeAll();
    await place(ogre, { x: 30, y: 30 });
  });

  it("A12 / A13: Shining Smite outlines the creature it strikes; a Petrified creature can't be Poisoned and halves untyped damage — the DM's final number still stands", async () => {
    await fresh();
    const dmMsgs: Msg[] = [];
    const off = dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    type Row = { id: string; attackHints?: { adv: string[] } };
    type View = { id: string; targets: Row[] };
    const viewsOf = (m: Msg): View[] =>
      m.type === "cast.view" ? [m.payload as View] : m.type === "cast.views" ? (m.payload as View[]) : [];
    const hintsOn = (castId: string, id: string) =>
      dmMsgs
        .flatMap(viewsOf)
        .filter((v) => v.id === castId)
        .flatMap((v) => v.targets)
        .reverse()
        .find((r) => r.id === id && r.attackHints)?.attackHints;
    const ogreTok = () => room().model.get("token", ogre);
    const hpOf = () => (ogreTok()?.stats as { hp: number } | undefined)?.hp ?? -1;
    // Struck by the Mage (next to it): light on it and outlined, for the spell's minute (SRD 5.2.1 p. 162).
    await place(ogre, { x: 45, y: 20 });
    await cmd(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "shining-smite",
      mode: "free",
      level: 2,
      targets: [ogre],
      endConcentration: true,
    });
    const fx = room()
      .model.inScene("effect", sceneId)
      .find((e) => e.attachedTokenId === ogre);
    expect(fx?.props.outline).toBe(true);
    expect(fx?.props.light?.bright).toBe(5);
    await closeAll();
    // An attack at it: advantage — "target outlined" (the effect's, not only a DM's mark).
    await place(ogre, { x: 30, y: 30 });
    const fb = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "fire-bolt",
      mode: "slot",
      targets: [ogre],
    });
    expect((await waitFor(() => hintsOn(fb.castId, ogre)))?.adv).toContain("target outlined");
    await closeAll();
    for (const e of room().model.inScene("effect", sceneId))
      await cmd(dm, "effect.remove", { effectId: e.id });
    await cmd(dm, "status.change", { tokenId: mage, concentration: null });

    // Petrified: immune to Poisoned — refused on a player's creature, left off by a spell's card.
    await cmd(dm, "status.change", { tokenId: sera, add: [{ id: "petrified" }] });
    await expect(
      cmd(anna.room, "status.change", { tokenId: sera, add: [{ id: "poisoned" }] }),
    ).rejects.toThrow(/Sera can't be poisoned — Petrified/);
    /** Ray of Sickness at the ogre, a hit (its Poisoned rides on the hit — on the card, where the hit is known). */
    const ray = async () => {
      const r = await cmd<{ castId: string }>(dm, "spell.cast", {
        casterTokenId: mage,
        spellId: "ray-of-sickness",
        mode: "free",
        level: 1,
        targets: [ogre],
      });
      await cmd(dm, "cast.roll", { castId: r.castId, what: "attack", targetId: ogre, entered: 30 });
      expect(room().model.get("cast", r.castId)?.data.targets[0]?.attack?.hit).toBe(true);
      await cmd(dm, "cast.set", { castId: r.castId, targetId: ogre, final: 0 });
      await cmd(dm, "cast.apply", { castId: r.castId });
      expect(room().model.get("cast", r.castId)?.data.targets[0]?.state).toBe("applied");
      await closeAll();
      return statusOf(ogre).status.conditions.map((c) => c.id);
    };
    expect(await ray()).toContain("poisoned");
    await cmd(dm, "status.change", { tokenId: ogre, remove: ["poisoned"], add: [{ id: "petrified" }] });
    expect(await ray()).not.toContain("poisoned");
    // Untyped damage is resisted too: 10 → 5.
    const hp0 = hpOf();
    await cmd(dm, "hp.apply", { targets: [ogre], kind: "damage", amount: 10 });
    expect(hpOf()).toBe(hp0 - 5);
    // The DM's edited number on a card is final: 8 is 8 (not halved again).
    const fb2 = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "fire-bolt",
      mode: "slot",
      targets: [ogre],
    });
    await cmd(dm, "cast.roll", { castId: fb2.castId, what: "attack", targetId: ogre, entered: 30 });
    await cmd(dm, "cast.set", { castId: fb2.castId, targetId: ogre, final: 8 });
    await cmd(dm, "cast.apply", { castId: fb2.castId });
    expect(hpOf()).toBe(hp0 - 5 - 8);
    await closeAll();
    off();
    await cmd(dm, "status.change", { tokenId: ogre, remove: ["petrified"] });
    await cmd(dm, "status.change", { tokenId: sera, remove: ["petrified"] });
    await cmd(dm, "hp.apply", { targets: [ogre], kind: "heal", amount: 40 });
  });

  it("C7: Frightened of the Mage — a check at a disadvantage while the Mage is in Sera's sight; none with a wall between (SRD 5.2.1 p. 182)", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 30, y: 34 });
    const eb = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "eyebite",
      mode: "free",
      level: 6,
      targets: [sera],
      endConcentration: true,
    });
    await cmd(dm, "cast.set", {
      castId: eb.castId,
      targetId: sera,
      saveSuccess: false,
      conditions: ["frightened"],
    });
    await cmd(dm, "cast.apply", { castId: eb.castId, targets: [sera] });
    await closeAll();
    const fear = statusOf(sera).status.conditions.find((c) => c.id === "frightened");
    expect(fear?.sourceTokenId).toBe(mage);
    /** Anna's card for a Wisdom (Perception) check on Sera: its hint. */
    const checkHint = async () => {
      await sleep(250);
      const mark = anna.msgs.length;
      const { requestId } = await cmd<{ requestId: string }>(dm, "request.create", {
        targets: [sera],
        type: "check",
        skill: "perception",
      });
      const card = await waitFor(() =>
        anna.msgs
          .slice(mark)
          .filter((m) => m.type === "request.card")
          .map((m) => m.payload as { requestId: string; hint?: { mode: string; from: string[] } })
          .find((c) => c.requestId === requestId),
      );
      return card.hint;
    };
    expect(await checkHint()).toEqual({ mode: "dis", from: ["Frightened"] });
    // A wall between them, floor to ceiling: the Mage out of her sight — no Disadvantage.
    const { wallIds } = await cmd<{ wallIds: string[] }>(dm, "wall.create", {
      sceneId,
      walls: [{ a: { x: 25, y: 0 }, b: { x: 25, y: 40 } }],
    });
    expect(await checkHint()).toBeUndefined();
    await cmd(dm, "wall.delete", { wallIds });
    await cmd(dm, "status.change", { tokenId: sera, remove: ["frightened"] });
    await cmd(dm, "status.change", { tokenId: mage, concentration: null });
  });

  it("C6: a ranged spell attack with a hostile creature within 5 ft who sees the attacker is at a Disadvantage (SRD 5.2.1 p. 15)", async () => {
    await fresh();
    const dmMsgs: Msg[] = [];
    const off = dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    type Row = { id: string; attackHints?: { dis: string[] } };
    type View = { id: string; targets: Row[] };
    const viewsOf = (m: Msg): View[] =>
      m.type === "cast.view" ? [m.payload as View] : m.type === "cast.views" ? (m.payload as View[]) : [];
    const hintsOn = (castId: string, id: string) =>
      dmMsgs
        .flatMap(viewsOf)
        .filter((v) => v.id === castId)
        .flatMap((v) => v.targets)
        .reverse()
        .find((r) => r.id === id && r.attackHints)?.attackHints;
    const bolt = async () =>
      (
        await cmd<{ castId: string }>(dm, "spell.cast", {
          casterTokenId: mage,
          spellId: "fire-bolt",
          mode: "slot",
          targets: [ogre],
        })
      ).castId;
    await place(ogre, { x: 30, y: 30 });
    // Sera (the party: hostile to the Mage) right beside it: Disadvantage, named.
    await place(sera, { x: 45, y: 20 });
    const near = await bolt();
    expect((await waitFor(() => hintsOn(near, ogre)))?.dis).toContain("Sera within 5 ft");
    await closeAll();
    // Knocked out beside it, she can't act: none.
    await cmd(dm, "status.change", { tokenId: sera, add: [{ id: "unconscious" }] });
    const out = await bolt();
    expect((await waitFor(() => hintsOn(out, ogre)))?.dis).not.toContain("Sera within 5 ft");
    await closeAll();
    await cmd(dm, "status.change", { tokenId: sera, remove: ["unconscious", "prone"] });
    // Away from it: none.
    await place(sera, { x: 10, y: 20 });
    const far = await bolt();
    expect((await waitFor(() => hintsOn(far, ogre)))?.dis ?? []).not.toContain("Sera within 5 ft");
    await closeAll();
    off();
  });

  it("Q6: Bless, Bane, Haste and Slow put their markers on — with their rules on rolls, AC and Speed — and take them off with their concentration; Haste's end leaves its target lethargic (SRD 5.2.1 pp. 112, 113, 139, 163)", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 15, y: 20 });
    const actorId = room().model.get("token", sera)?.actorId as string;
    await cmd(dm, "actor.change", {
      actorId,
      changes: [
        {
          path: ["core", "attacks"],
          after: [{ name: "Mace", attack: "1d20 + 2", damage: "1d6 [bludgeoning]", range: "5 ft" }],
        },
      ],
    });
    const marks = (id: string) => statusOf(id).status.markers.map((m) => m.id as string);
    const own = (id: string) => room().state.tokens.get(id)?.own;
    const endConcentration = async () => {
      await cmd(dm, "status.change", { tokenId: mage, remove: ["concentrating"] });
      await sleep(120);
    };
    const saveFormula = async (tokenId: string, ability: string) => {
      const { requestId } = await cmd<{ requestId: string }>(dm, "request.create", {
        targets: [tokenId],
        type: "save",
        ability,
      });
      const r = room().requests.get(requestId);
      await cmd(dm, "request.close", { requestId });
      return r?.targets[0]?.formula ?? "";
    };
    const attackAtOgre = async (dice?: number[]) => {
      const { castId } = await cmd<{ castId: string }>(anna.room, "attack.start", {
        tokenId: sera,
        attack: 0,
        targets: [ogre],
      });
      await cmd(anna.room, "cast.roll", {
        castId,
        what: "attack",
        targetId: ogre,
        ...(dice ? { dice } : {}),
      });
      const a = room().model.get("cast", castId)?.data.targets[0]?.attack;
      await cmd(dm, "cast.close", { castId });
      return a;
    };

    // Bless: Blessed on both at once (no save, no card) — +1d4 on their saves and attack rolls, not their checks.
    await cmd(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "bless",
      mode: "free",
      level: 1,
      targets: [sera, ogre],
    });
    expect(marks(sera)).toContain("blessed");
    expect(marks(ogre)).toContain("blessed");
    expect(await saveFormula(sera, "wis")).toMatch(/\+ 1d4$/);
    const blessedHit = await attackAtOgre();
    expect(blessedHit?.dice?.map((d) => d.sides)).toEqual([20, 4]);
    // Its concentration ends: Blessed off both.
    await endConcentration();
    await waitFor(() => !marks(sera).includes("blessed") && !marks(ogre).includes("blessed"));
    expect(await saveFormula(sera, "wis")).not.toMatch(/1d4/);

    // Bane: Baned on a failed Charisma save, when the card is applied — not on the one who saved.
    const bane = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "bane",
      mode: "free",
      level: 1,
      targets: [sera, ogre],
    });
    expect(marks(ogre)).not.toContain("baned");
    await cmd(dm, "cast.set", { castId: bane.castId, targetId: sera, saveSuccess: true });
    await cmd(dm, "cast.set", { castId: bane.castId, targetId: ogre, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: bane.castId });
    expect(marks(ogre)).toContain("baned");
    expect(marks(sera)).not.toContain("baned");
    expect(await saveFormula(ogre, "con")).toMatch(/- 1d4$/);
    await closeAll();
    await endConcentration();
    await waitFor(() => !marks(ogre).includes("baned"));

    // Haste on the ogre: Speed doubled, AC +2 — a 13 that hit its 12 now misses its 14; Dex saves with Advantage.
    const before = own(ogre)?.budgetFt ?? 0;
    expect(before).toBeGreaterThan(0);
    expect((await attackAtOgre([11]))?.hit).toBe(true);
    await cmd(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "haste",
      mode: "free",
      level: 3,
      targets: [ogre],
    });
    expect(marks(ogre)).toContain("hasted");
    await waitFor(() => own(ogre)?.budgetFt === before * 2);
    expect((await attackAtOgre([11]))?.hit).toBe(false);
    const dexReq = await cmd<{ requestId: string }>(dm, "request.create", {
      targets: [ogre],
      type: "save",
      ability: "dex",
    });
    expect(room().requests.get(dexReq.requestId)?.targets[0]?.hint?.from).toContain("Hasted");
    await cmd(dm, "request.close", { requestId: dexReq.requestId });
    // Ended outside a fight: Hasted off, no lethargy (no turns to count).
    await endConcentration();
    await waitFor(() => !marks(ogre).includes("hasted"));
    expect(statusOf(ogre).status.conditions.map((c) => c.id)).not.toContain("incapacitated");
    await waitFor(() => own(ogre)?.budgetFt === before);

    // In a fight: Haste ends on the Mage's turn — the ogre Incapacitated at Speed 0 until the end of its next turn.
    const combat = () =>
      room()
        .model.inScene("combat", sceneId)
        .find((c) => c.active);
    const turnOf = () => {
      const c = combat();
      return c ? dataOf(c).combatants[c.turnIndex]?.tokenId : undefined;
    };
    const toTurnOf = async (id: string) => {
      for (let i = 0; i < 8 && turnOf() !== id; i++) await cmd(dm, "combat.next", {});
      expect(turnOf()).toBe(id);
    };
    await cmd(dm, "combat.start", { participants: [mage, sera, ogre], method: "skip" });
    await cmd(dm, "combat.begin", {});
    await waitFor(() => combat() && dataOf(combat() as NonNullable<ReturnType<typeof combat>>).begun);
    await toTurnOf(mage);
    await cmd(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "haste",
      mode: "free",
      level: 3,
      targets: [ogre],
    });
    expect(marks(ogre)).toContain("hasted");
    await endConcentration();
    const lethargic = () => statusOf(ogre).status.conditions.find((c) => c.id === "incapacitated");
    await waitFor(() => lethargic());
    expect(lethargic()).toMatchObject({ speed0: true, endsWithTurnOf: ogre, source: "Haste's lethargy" });
    expect(marks(ogre)).not.toContain("hasted");
    await waitFor(() => own(ogre)?.stuck === "speed0");
    await toTurnOf(ogre);
    expect(lethargic()).toBeDefined();
    await cmd(dm, "combat.next", {});
    await waitFor(() => !lethargic());
    await waitFor(() => own(ogre)?.stuck === "");
    await cmd(dm, "combat.stop", {});

    // Slow: Slowed on a failed Wisdom save — Speed halved, AC −2 (an 11 that missed its 12 now hits its 10), Dex
    // saves −2.
    await place(ogre, { x: 30, y: 30 });
    const slow = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "slow",
      mode: "free",
      level: 3,
      placement: { origin: { x: 30, y: 30, z: 0 }, dirDeg: 0 },
    });
    expect(
      room()
        .model.get("cast", slow.castId)
        ?.data.targets.some((x) => x.id === ogre),
    ).toBe(true);
    await cmd(dm, "cast.set", { castId: slow.castId, targetId: ogre, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: slow.castId, targets: [ogre] });
    await closeAll();
    expect(marks(ogre)).toContain("slowed");
    await waitFor(() => own(ogre)?.budgetFt === Math.floor(before / 2));
    await place(ogre, { x: 15, y: 20 });
    expect((await attackAtOgre([9]))?.hit).toBe(true);
    expect(await saveFormula(ogre, "dex")).toMatch(/- 2$/);
    await endConcentration();
    await waitFor(() => !marks(ogre).includes("slowed"));
    expect((await attackAtOgre([9]))?.hit).toBe(false);
    await place(ogre, { x: 30, y: 30 });
  });

  it("C4: Heroic Inspiration on an attack — the player rolls one of its dice again before the card is applied; the new roll counts, judged anew; spent", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 15, y: 20 });
    const tok = room().model.get("token", sera);
    const actorId = tok?.actorId as string;
    await cmd(dm, "actor.change", {
      actorId,
      changes: [
        {
          path: ["core", "attacks"],
          after: [{ name: "Mace", attack: "1d20 + 2", damage: "1d6 [bludgeoning]", range: "5 ft" }],
        },
        { path: ["core", "inspiration"], after: true },
      ],
    });
    const inspired = () =>
      (room().model.get("actor", actorId)?.sheet as { core: { inspiration: boolean } } | undefined)?.core
        .inspiration;
    const { castId } = await cmd<{ castId: string }>(anna.room, "attack.start", {
      tokenId: sera,
      attack: 0,
      targets: [ogre],
    });
    const row = () =>
      room()
        .model.get("cast", castId)
        ?.data.targets.find((t) => t.id === ogre);
    // Nothing rolled yet: nothing to roll again.
    await expect(cmd(anna.room, "cast.inspire", { castId, targetId: ogre, die: 0 })).rejects.toThrow(
      /no attack roll/,
    );
    await cmd(anna.room, "cast.roll", { castId, what: "attack", targetId: ogre });
    const first = row()?.attack;
    expect(first?.rollId).toBeTruthy();
    expect(first?.dice?.[0]?.sides).toBe(20);
    // Her card (the caster's player's view) offers it: Inspiration to spend, and the d20 it would roll again.
    type View = {
      id: string;
      can: { inspire?: boolean };
      targets: { id: string; attack?: { dice?: { sides: number }[]; inspired?: boolean } }[];
    };
    const view = () =>
      anna.msgs
        .filter((m) => m.type === "cast.view" && (m.payload as View).id === castId)
        .map((m) => m.payload as View)
        .at(-1);
    await waitFor(() => view()?.targets.find((t) => t.id === ogre)?.attack?.dice);
    expect(view()?.can.inspire).toBe(true);
    expect(view()?.targets.find((t) => t.id === ogre)?.attack?.dice?.[0]?.sides).toBe(20);
    await cmd(anna.room, "cast.inspire", { castId, targetId: ogre, die: 0 });
    // Rolled again: marked so on her card, nothing more to spend there.
    await waitFor(() => view()?.targets.find((t) => t.id === ogre)?.attack?.inspired);
    expect(view()?.can.inspire).toBeUndefined();
    expect(view()?.targets.find((t) => t.id === ogre)?.attack?.dice).toBeUndefined();
    const second = row()?.attack;
    expect(second?.inspired).toBe(true);
    expect(second?.rollId).not.toBe(first?.rollId);
    // Judged anew against its AC (12): a hit is 12 or more (a 20 always, a 1 never).
    const nat = second?.natural ?? 0;
    expect(second?.hit).toBe(nat === 20 ? true : nat === 1 ? false : (second?.total ?? 0) >= 12);
    expect(inspired()).toBe(false);
    // Once: it's spent, and this roll was the second.
    await expect(cmd(anna.room, "cast.inspire", { castId, targetId: ogre, die: 0 })).rejects.toThrow(
      /no attack roll|no Heroic/,
    );
    await cmd(dm, "cast.close", { castId });
    // "Immediately after rolling it": once the DM has called the attack, or its damage is rolled, it's too late —
    // and the card no longer offers it.
    await cmd(dm, "actor.change", { actorId, changes: [{ path: ["core", "inspiration"], after: true }] });
    const late = async () => {
      await sleep(260);
      const { castId: id } = await cmd<{ castId: string }>(anna.room, "attack.start", {
        tokenId: sera,
        attack: 0,
        targets: [ogre],
      });
      await cmd(anna.room, "cast.roll", { castId: id, what: "attack", targetId: ogre });
      return id;
    };
    const called = await late();
    await cmd(dm, "cast.set", { castId: called, targetId: ogre, hit: true });
    await expect(cmd(anna.room, "cast.inspire", { castId: called, targetId: ogre, die: 0 })).rejects.toThrow(
      /DM has called/,
    );
    expect(room().model.get("cast", called)?.data.targets[0]?.attack).toMatchObject({
      hit: true,
      ruled: true,
    });
    await cmd(dm, "cast.close", { castId: called });
    const damaged = await late();
    const damagedRow = room().model.get("cast", damaged)?.data.targets[0];
    await cmd(anna.room, "cast.roll", { castId: damaged, what: "damage", targetId: damagedRow?.key });
    await expect(cmd(anna.room, "cast.inspire", { castId: damaged, targetId: ogre, die: 0 })).rejects.toThrow(
      /damage is rolled/,
    );
    // Refused both times: nothing spent.
    expect(inspired()).toBe(true);
    await cmd(dm, "cast.close", { castId: damaged });
    await closeAll();
    await place(ogre, { x: 30, y: 30 });
  });

  it("I11: a choice lands one of its group (Blindness/Deafness: Blinded); a later stage waits (Sleep: Incapacitated, not yet Unconscious); what the DM judges waits for them (Divine Word)", async () => {
    await fresh();
    await place(ogre, { x: 30, y: 30 });
    const has = (id: string) => statusOf(ogre).status.conditions.some((c) => c.id === id);
    const castAndFail = async (spellId: string, level: number, extra: object) => {
      const r = await cmd<{ castId: string }>(dm, "spell.cast", {
        casterTokenId: mage,
        spellId,
        mode: "free",
        level,
        endConcentration: true,
        ...extra,
      });
      await cmd(dm, "cast.set", { castId: r.castId, targetId: ogre, saveSuccess: false });
      await cmd(dm, "cast.apply", { castId: r.castId, targets: [ogre] });
      await closeAll();
    };
    const clear = () =>
      cmd(dm, "status.change", {
        tokenId: ogre,
        remove: ["blinded", "deafened", "incapacitated", "unconscious", "stunned", "prone"],
      });
    await castAndFail("blindness-deafness", 2, { targets: [ogre] });
    expect([has("blinded"), has("deafened")]).toEqual([true, false]);
    await clear();
    await castAndFail("sleep", 1, { placement: { origin: { x: 30, y: 30, z: 0 }, dirDeg: 0 } });
    expect([has("incapacitated"), has("unconscious")]).toEqual([true, false]);
    await clear();
    await castAndFail("divine-word", 7, { targets: [ogre] });
    expect([has("blinded"), has("deafened"), has("stunned")]).toEqual([false, false, false]);
  });

  it("m8: in combat, Color Spray's Blinded (cast on the Mage's own turn) lasts past that turn and ends at the end of the Mage's next", async () => {
    await fresh();
    await place(ogre, { x: 32, y: 20 });
    const combat = () =>
      room()
        .model.inScene("combat", sceneId)
        .find((c) => c.active);
    const turnOf = () => {
      const c = combat();
      return c ? dataOf(c).combatants[c.turnIndex]?.tokenId : undefined;
    };
    const toTurnOf = async (id: string) => {
      for (let i = 0; i < 8 && turnOf() !== id; i++) await cmd(dm, "combat.next", {});
      expect(turnOf()).toBe(id);
    };
    await cmd(dm, "combat.start", { participants: [mage, sera, ogre], method: "skip" });
    await cmd(dm, "combat.begin", {});
    await waitFor(() => combat() && dataOf(combat() as NonNullable<ReturnType<typeof combat>>).begun);
    await toTurnOf(mage);
    const cs = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "color-spray",
      mode: "free",
      level: 1,
      placement: { origin: { x: 40, y: 20, z: 0 }, dirDeg: 90 },
    });
    expect(
      room()
        .model.get("cast", cs.castId)
        ?.data.targets.some((x) => x.id === ogre),
    ).toBe(true);
    await cmd(dm, "cast.set", { castId: cs.castId, targetId: ogre, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: cs.castId, targets: [ogre] });
    await closeAll();
    const blinded = () => statusOf(ogre).status.conditions.some((c) => c.id === "blinded");
    expect(blinded()).toBe(true);
    // The Mage's turn ends: still blinded (that was the turn it was cast on).
    await cmd(dm, "combat.next", {});
    await sleep(200);
    expect(blinded()).toBe(true);
    // Round the table to the Mage again, and past it: gone at the end of the Mage's next turn.
    await toTurnOf(mage);
    expect(blinded()).toBe(true);
    await cmd(dm, "combat.next", {});
    await waitFor(() => !blinded());
    await cmd(dm, "combat.stop", {});
  });

  it("rules audit 12: Starry Wisp's hit leaves its glow on the target — outlined, no Advantage against it — until the end of the caster's next turn", async () => {
    await fresh();
    await place(ogre, { x: 30, y: 30 });
    const combat = () =>
      room()
        .model.inScene("combat", sceneId)
        .find((c) => c.active);
    const turnOf = () => {
      const c = combat();
      return c ? dataOf(c).combatants[c.turnIndex]?.tokenId : undefined;
    };
    const toTurnOf = async (id: string) => {
      for (let i = 0; i < 8 && turnOf() !== id; i++) await cmd(dm, "combat.next", {});
      expect(turnOf()).toBe(id);
    };
    await cmd(dm, "combat.start", { participants: [mage, sera, ogre], method: "skip" });
    await cmd(dm, "combat.begin", {});
    await waitFor(() => combat() && dataOf(combat() as NonNullable<ReturnType<typeof combat>>).begun);
    await toTurnOf(mage);
    const sw = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "starry-wisp",
      mode: "slot",
      targets: [ogre],
    });
    await cmd(dm, "cast.roll", { castId: sw.castId, what: "attack", targetId: ogre, entered: 30 });
    await cmd(dm, "cast.set", { castId: sw.castId, targetId: ogre, final: 3 });
    await cmd(dm, "cast.apply", { castId: sw.castId });
    await closeAll();
    const glow = () =>
      room()
        .model.inScene("effect", sceneId)
        .find((e) => e.attachedTokenId === ogre && e.name === "Starry Wisp");
    expect(glow()?.props).toMatchObject({ outline: true });
    expect(glow()?.props.advantageAgainst).toBeUndefined();
    expect(glow()?.props.light?.dim).toBe(10);
    // Its own turn ends (the one it was cast on): still glowing; round again to the Mage's next and past it: gone.
    await cmd(dm, "combat.next", {});
    await sleep(200);
    expect(glow()).toBeDefined();
    await toTurnOf(mage);
    expect(glow()).toBeDefined();
    await cmd(dm, "combat.next", {});
    await waitFor(() => !glow());
    await cmd(dm, "combat.stop", {});
  });

  it("m11: Ice Knife — the attack's card carries the Piercing on a hit; the burst, hit or miss, is a card of its own: a Dex save for the target and each creature within 5 ft, the Cold", async () => {
    await fresh();
    await place(sera, { x: 10, y: 20 });
    await place(ogre, { x: 14, y: 22 });
    const ik = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "ice-knife",
      mode: "free",
      level: 1,
      targets: [sera],
    });
    const attack = room().model.get("cast", ik.castId)?.data;
    expect(attack?.attack).toBeTruthy();
    expect(attack?.save).toBeNull();
    expect(attack?.damage?.parts.map((x) => x.type)).toEqual(["piercing"]);
    const burst = room()
      .model.all("cast")
      .find((c) => c.status === "open" && c.id !== ik.castId && c.data.spellId === "ice-knife")?.data;
    expect(burst?.save?.ability).toBe("dex");
    expect(burst?.attack).toBeNull();
    expect(burst?.damage?.parts.map((x) => x.type)).toEqual(["cold"]);
    expect(
      burst?.targets
        .filter((x) => x.state === "in")
        .map((x) => x.id)
        .sort(),
    ).toEqual([ogre, sera].sort());
    await closeAll();
    await place(ogre, { x: 30, y: 30 });
  });
});
