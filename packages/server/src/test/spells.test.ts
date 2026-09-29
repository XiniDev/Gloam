import type { Room } from "@colyseus/sdk";
import type { CastView } from "@gloam/shared/protocol";
import { effectiveTokenState } from "@gloam/shared/rules";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSheet } from "../engine/commands/actor.ts";
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
 * P9 on the server (SPEC §8.13, §17, §29.5): a cast spends its slot, finds who its area takes with a clear line, puts
 * one card to the DM (the caster's parts to its player, a line to everyone), rolls NPC saves with one click, applies
 * damage by the save and each creature's resistances, gives conditions on a failed save; concentration ends the old
 * spell's effects with it; cancelling or undoing gives the slot back; lasting effects trigger on turns and moves.
 */
describe("P9 — spells on the server (§8.13, §17)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let sceneId = "";
  const dmMsgs: Msg[] = [];
  const players: Record<string, { room: TableRoomClient; id: string; msgs: Msg[] }> = {};
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const anna = () => players.Anna as { room: TableRoomClient; id: string; msgs: Msg[] };
  const bo = () => players.Bo as { room: TableRoomClient; id: string; msgs: Msg[] };
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(120);
    return rq<T>(r, type, payload);
  };
  const tokenOf = (id: string) => room().model.get("token", id);
  const statusOf = (id: string) => {
    const tk = room().model.get("token", id);
    if (!tk) throw new Error(`no token ${id}`);
    const a = tk.actorId ? room().model.get("actor", tk.actorId) : undefined;
    return effectiveTokenState(tk, a && tk.link === "linked" ? a : undefined);
  };
  const castOf = (id: string) => room().model.get("cast", id);
  const lastView = (msgs: Msg[], castId: string) =>
    [...msgs]
      .reverse()
      .map((m) =>
        m.type === "cast.view"
          ? (m.payload as CastView)
          : m.type === "cast.views"
            ? (m.payload as CastView[]).find((v) => v.id === castId)
            : undefined,
      )
      .find((v) => v?.id === castId);
  const slotsOf = (actorId: string) => {
    const a = room().model.get("actor", actorId);
    if (!a) throw new Error("no actor");
    return readSheet(a).core.spellcasting;
  };

  async function admit(name: string) {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    players[name] = { room: r, id: p.userId, msgs };
  }
  async function npc(name: string, pos: { x: number; y: number }, stats: Record<string, unknown> = {}) {
    const { tokenId } = await cmd<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name,
      pos,
      disposition: "hostile",
      stats: { hp: 30, hpMax: 30, ac: 12, ...stats },
    });
    return tokenId;
  }

  let mage = "";
  let mageActor = "";
  let fighter = "";

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "9090" }, config: { consoleLog: true } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    await admit("Anna");
    await admit("Bo");
    ({ sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Vault",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 120,
      heightFt: 80,
    }));
    // Anna's wizard: Intelligence 18 at level 5 (spell save DC 15, +7 to hit), slots 4 / 3 / 2.
    mageActor = (
      await rq<{ actorId: string }>(anna().room, "actor.create", {
        sheet: {
          core: {
            name: "Mira",
            classes: [{ name: "Wizard", level: 5 }],
            abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
            hp: { max: 28, current: 28, temp: 0 },
            ac: { value: 12 },
            spellcasting: {
              ability: "int",
              slots: [
                { level: 1, max: 4 },
                { level: 2, max: 3 },
                { level: 3, max: 2 },
              ],
              spells: [
                { name: "Fireball", level: 3, prepared: true },
                { name: "Magic Missile", level: 1, prepared: true },
                { name: "Web", level: 2, prepared: true },
                { name: "Detect Magic", level: 1, prepared: true },
              ],
            },
          },
        },
      })
    ).actorId;
    const fighterActor = (
      await rq<{ actorId: string }>(bo().room, "actor.quickCreate", { name: "Tor", hpMax: 40, ac: 17 })
    ).actorId;
    await rq(dm, "scene.activate", { sceneId });
    mage = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.actorId === mageActor),
      )
    ).id;
    fighter = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.actorId === fighterActor),
      )
    ).id;
    // Where they stand: Mira at (20, 40), Tor beside her.
    await cmd(dm, "move.commit", { tokenId: mage, points: [tokenOf(mage)?.pos, { x: 20, y: 40 }] });
    await cmd(dm, "move.commit", { tokenId: fighter, points: [tokenOf(fighter)?.pos, { x: 20, y: 50 }] });
    await sleep(100);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("Fireball: its sphere takes every creature inside with a clear line from its centre, not one behind a wall or outside; the 3rd-level slot is spent; the DM's card is whole, Anna's has her parts, Bo gets a line (AC-SPL-03/04)", async () => {
    const g1 = await npc("Goblin", { x: 60, y: 40 }, { saves: { dex: 2 } });
    const g2 = await npc("Goblin 2", { x: 66, y: 44 }, { saves: { dex: 2 }, resist: ["fire"] });
    const far = await npc("Scout", { x: 100, y: 40 });
    const hid = await npc("Hidden", { x: 64, y: 28 });
    // A wall between the centre and "Hidden".
    await cmd(dm, "wall.create", {
      sceneId,
      walls: [{ a: { x: 58, y: 32 }, b: { x: 72, y: 32 }, kind: "wall" }],
    });
    const r = await cmd<{ castId: string }>(anna().room, "spell.cast", {
      casterTokenId: mage,
      spellId: "fireball",
      slot: { level: 3, kind: "slot" },
      placement: { origin: { x: 63, y: 40, z: 0 } },
    });
    expect(r.castId).toBeTruthy();
    const c = castOf(r.castId);
    const rows = c?.data.targets ?? [];
    const state = (id: string) => rows.find((x) => x.id === id)?.state;
    expect(state(g1)).toBe("in");
    expect(state(g2)).toBe("in");
    expect(rows.some((x) => x.id === far)).toBe(false);
    expect(state(hid)).toBe("blocked");
    expect(slotsOf(mageActor)?.slots.find((s) => s.level === 3)?.used).toBe(1);
    // The DM's card: every row, the DC; Anna's: hers to roll (damage), no DC until revealed; Bo: a line.
    const dmView = await waitFor(() => lastView(dmMsgs, r.castId));
    expect(dmView.targets.map((x) => x.id).sort()).toEqual([g1, g2, hid].sort());
    expect(dmView.save?.dc).toBe(15);
    const hers = await waitFor(() => lastView(anna().msgs, r.castId));
    expect(hers.save?.dc).toBeUndefined();
    expect(hers.can.roll).toBe(true);
    expect(lastView(bo().msgs, r.castId)).toBeUndefined();
    await waitFor(() =>
      bo().msgs.find(
        (m) => m.type === "cast.line" && (m.payload as { text: string }).text.includes("Fireball"),
      ),
    );
    // The DM adds the one behind the wall anyway, then takes it off again (§8.13: the DM adjusts on the card).
    await cmd(dm, "cast.target", { castId: r.castId, targetId: hid, include: true });
    expect(castOf(r.castId)?.data.targets.find((x) => x.id === hid)?.state).toBe("in");
    await cmd(dm, "cast.target", { castId: r.castId, targetId: hid, include: false });
    expect(castOf(r.castId)?.data.targets.find((x) => x.id === hid)?.state).toBe("removed");
    // A player can't.
    await expect(
      cmd(anna().room, "cast.target", { castId: r.castId, targetId: hid, include: true }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("NPC saves roll with one DM click; the damage rolls once; Apply all takes it — half on a success, halved again by resistance — and the card is done (AC-SPL-05)", async () => {
    const cast = [...room().model.maps.cast.values()].find((c) => c.data.spellId === "fireball");
    if (!cast) throw new Error("no fireball");
    const castId = cast.id;
    const [g1, g2] = cast.data.targets.filter((x) => x.state === "in").map((x) => x.id) as [string, string];
    await cmd(dm, "cast.npcSaves", { castId });
    await waitFor(() =>
      castOf(castId)
        ?.data.targets.filter((x) => x.state === "in")
        .every((x) => typeof x.save?.success === "boolean"),
    );
    // Goblin fails, Goblin 2 (resistant to fire) succeeds: all of it; half, then half again.
    await cmd(dm, "cast.set", { castId, targetId: g1, saveSuccess: false });
    await cmd(dm, "cast.set", { castId, targetId: g2, saveSuccess: true });
    await cmd(anna().room, "cast.roll", { castId, what: "damage" });
    const dmg = await waitFor(() => castOf(castId)?.data.damage?.roll?.total);
    expect(dmg).toBeGreaterThanOrEqual(8);
    expect(dmg).toBeLessThanOrEqual(48);
    const hp0 = { g1: statusOf(g1).stats.hp, g2: statusOf(g2).stats.hp };
    await cmd(dm, "cast.apply", { castId });
    await waitFor(() => castOf(castId)?.data.targets.filter((x) => x.state === "in").length === 0);
    expect(statusOf(g1).stats.hp).toBe(Math.max(0, hp0.g1 - (dmg as number)));
    expect(statusOf(g2).stats.hp).toBe(Math.max(0, hp0.g2 - Math.floor(Math.floor((dmg as number) / 2) / 2)));
    await waitFor(() => lastView(dmMsgs, castId)?.status === "done");
  });

  it("a creature with no sheet casts with no DC: the DM sets it, and the saves already rolled are judged against it — the DM's own verdict kept (critic P9 r2 B1)", async () => {
    const mage = await npc("Archmage", { x: 20, y: 60 });
    const a = await npc("Kobold", { x: 40, y: 64 }, { saves: { dex: 0 } });
    const b = await npc("Kobold 2", { x: 44, y: 60 }, { saves: { dex: 0 } });
    const r = await cmd<{ castId: string }>(dm, "spell.cast", {
      casterTokenId: mage,
      spellId: "fireball",
      mode: "free",
      level: 3,
      placement: { origin: { x: 42, y: 62, z: 0 }, dirDeg: 0 },
    });
    const card = () => castOf(r.castId);
    expect(card()?.data.dc).toBeNull();
    // Rolled with no DC: nobody can say who saved.
    await cmd(dm, "cast.npcSaves", { castId: r.castId });
    await waitFor(() =>
      card()
        ?.data.targets.filter((x) => x.state === "in")
        .every((x) => x.save?.total !== undefined),
    );
    const rowOf = (id: string) => card()?.data.targets.find((x) => x.id === id);
    expect(rowOf(a)?.save?.success ?? null).toBeNull();
    // The DM calls Kobold 2's by hand; then sets the DC between the two rolls' totals (or above both).
    await cmd(dm, "cast.set", { castId: r.castId, targetId: b, saveSuccess: true });
    const total = rowOf(a)?.save?.total as number;
    await cmd(dm, "cast.setDc", { castId: r.castId, dc: total + 1 });
    expect(card()?.data.dc).toBe(total + 1);
    expect(rowOf(a)?.save?.success).toBe(false);
    expect(rowOf(b)?.save?.success).toBe(true);
    // At the total, it saves; the DM's view shows the DC.
    await cmd(dm, "cast.setDc", { castId: r.castId, dc: total });
    expect(rowOf(a)?.save?.success).toBe(true);
    await waitFor(() => lastView(dmMsgs, r.castId)?.save?.dc === total);
    // Only a DM; and a card with no save has no DC to set.
    await expect(cmd(anna().room, "cast.setDc", { castId: r.castId, dc: 12 })).rejects.toThrow(/FORBIDDEN/);
    await cmd(dm, "cast.cancel", { castId: r.castId });
  });

  it("cancel gives the slot back; undo of a cast gives it back too; a ritual spends none (AC-SPL-06)", async () => {
    const before = slotsOf(mageActor)?.slots.find((s) => s.level === 1)?.used ?? 0;
    const goblin = await npc("Imp", { x: 30, y: 40 });
    const r = await cmd<{ castId: string }>(anna().room, "spell.cast", {
      casterTokenId: mage,
      spellId: "magic-missile",
      slot: { level: 1, kind: "slot" },
      targets: [goblin, goblin, goblin],
    });
    expect(slotsOf(mageActor)?.slots.find((s) => s.level === 1)?.used).toBe(before + 1);
    // Three darts at one creature: one row, three times.
    expect(castOf(r.castId)?.data.targets.find((x) => x.id === goblin)?.times).toBe(3);
    await cmd(dm, "cast.cancel", { castId: r.castId });
    expect(slotsOf(mageActor)?.slots.find((s) => s.level === 1)?.used).toBe(before);
    expect(castOf(r.castId)?.status).toBe("cancelled");
    // Cast again, then Anna undoes it: the slot is back and the card gone.
    const r2 = await cmd<{ castId: string }>(anna().room, "spell.cast", {
      casterTokenId: mage,
      spellId: "magic-missile",
      slot: { level: 1, kind: "slot" },
      targets: [goblin],
    });
    expect(slotsOf(mageActor)?.slots.find((s) => s.level === 1)?.used).toBe(before + 1);
    await cmd(anna().room, "history.undo", {});
    expect(slotsOf(mageActor)?.slots.find((s) => s.level === 1)?.used).toBe(before);
    expect(castOf(r2.castId)).toBeUndefined();
    // Detect Magic as a ritual: no slot at all; cast with a slot it would take one.
    const used = () => (slotsOf(mageActor)?.slots ?? []).reduce((n, x) => n + x.used, 0);
    const all = used();
    await cmd(anna().room, "spell.cast", { casterTokenId: mage, spellId: "detect-magic", mode: "ritual" });
    expect(used()).toBe(all);
    expect(statusOf(mage).status.concentration?.spellId).toBe("detect-magic");
    await cmd(anna().room, "history.undo", {});
    expect(statusOf(mage).status.concentration).toBeFalsy();
    // Not a ritual (Magic Missile): refused as one.
    await expect(
      cmd(anna().room, "spell.cast", {
        casterTokenId: mage,
        spellId: "magic-missile",
        mode: "ritual",
        targets: [goblin],
      }),
    ).rejects.toThrow(/isn't a ritual/);
  });

  it("concentration: Web's difficult ground stands on the board; a second concentration spell asks first, and ending the first takes its web with it — one undo step puts both back (AC-SPL-07)", async () => {
    const web = await cmd<{ castId: string | null; effectId: string | null }>(anna().room, "spell.cast", {
      casterTokenId: mage,
      spellId: "web",
      slot: { level: 2, kind: "slot" },
      placement: { origin: { x: 40, y: 20, z: 0 } },
    });
    expect(web.effectId).toBeTruthy();
    const eff = room().model.get("effect", web.effectId as string);
    expect(eff?.props.difficult).toBe(true);
    expect(statusOf(mage).status.concentration?.spellId).toBe("web");
    // Another concentration spell (a second Web): refused until she says to end the first.
    await expect(
      cmd(anna().room, "spell.cast", {
        casterTokenId: mage,
        spellId: "web",
        slot: { level: 2, kind: "slot" },
        placement: { origin: { x: 40, y: 60, z: 0 } },
      }),
    ).rejects.toThrow(/concentrating/);
    const web2 = await cmd<{ effectId: string | null }>(anna().room, "spell.cast", {
      casterTokenId: mage,
      spellId: "web",
      slot: { level: 2, kind: "slot" },
      placement: { origin: { x: 40, y: 60, z: 0 } },
      endConcentration: true,
    });
    // The first web goes with the concentration that held it; the new one stands.
    await waitFor(() => !room().model.get("effect", web.effectId as string));
    expect(room().model.get("effect", web2.effectId as string)).toBeTruthy();
    // Undo: the second cast and the first web's end undo together.
    await cmd(anna().room, "history.undo", {});
    await waitFor(() => room().model.get("effect", web.effectId as string));
    expect(room().model.get("effect", web2.effectId as string)).toBeUndefined();
    expect(statusOf(mage).status.concentration?.spellId).toBe("web");
  });

  it("a move through the web costs double (the movement world takes slowing effects; §8.13, AC-SPL-08)", async () => {
    const eff = [...room().model.maps.effect.values()].find((e) => e.props.difficult);
    if (!eff) throw new Error("no web");
    // Tor walks 10 ft straight through the middle of the web (a 20-ft cube at (40, 20)).
    await cmd(dm, "move.commit", { tokenId: fighter, points: [tokenOf(fighter)?.pos, { x: 30, y: 20 }] });
    const r = await cmd<{ cost: number }>(bo().room, "move.commit", {
      tokenId: fighter,
      points: [
        { x: 30, y: 20 },
        { x: 40, y: 20 },
      ],
    });
    expect(r.cost).toBeGreaterThanOrEqual(15);
  });
});
