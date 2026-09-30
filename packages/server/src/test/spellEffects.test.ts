import type { Room } from "@colyseus/sdk";
import type { P } from "@gloam/shared/geometry";
import { effectiveTokenState } from "@gloam/shared/rules";
import type { EffectEntity } from "@gloam/shared/schemas";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataOf } from "../engine/commands/combat.ts";
import { rowInstances } from "../engine/commands/spells.ts";
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

/**
 * The persistent effects §8.13 names, as the SRD 5.2.1 texts have them (AC-SPL-08): which save when the effect
 * appears and which only later, what their triggers catch (walking in, the area moving in, a turn's start or end, every
 * 5 ft), once a turn where the text says so, what moves them and how far, what drifts, what they do to movement,
 * concentration and conditions — each checked on the server, in a fight with a fixed order.
 */
describe("P9 — the named persistent effects (§8.13, AC-SPL-08)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let anna: { room: TableRoomClient; id: string };
  let sceneId = "";
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(230);
    return rq<T>(r, type, payload);
  };
  const tokenOf = (id: string) => room().model.get("token", id);
  const statusOf = (id: string) => {
    const tk = room().model.get("token", id);
    if (!tk) throw new Error(`no token ${id}`);
    const a = tk.actorId ? room().model.get("actor", tk.actorId) : undefined;
    return effectiveTokenState(tk, a && tk.link === "linked" ? a : undefined).status;
  };
  const effects = (): EffectEntity[] => [...room().model.maps.effect.values()];
  const effectOf = (id: string | null) => (id ? room().model.get("effect", id) : undefined);
  /** Open cards, oldest first: what the DM is asked to resolve. */
  const cards = () => [...room().model.maps.cast.values()].filter((c) => c.status === "open");
  const triggerCards = (effectId: string) =>
    cards().filter((c) => c.data.kind === "trigger" && c.data.trigger?.effectId === effectId);
  const whoIn = (castId: string) =>
    (room().model.get("cast", castId)?.data.targets ?? []).filter((x) => x.state === "in").map((x) => x.id);
  const place = (tokenId: string, to: P) =>
    cmd(dm, "move.commit", { tokenId, points: [tokenOf(tokenId)?.pos, to] });
  /** Closes every open card (a fresh start for the next check). */
  async function clearCards() {
    for (const c of cards()) await cmd(dm, "cast.close", { castId: c.id });
  }
  async function clearEffects() {
    for (const e of effects()) await cmd(dm, "effect.remove", { effectId: e.id });
  }
  /** A clean board for the next case: no cards open, no effects standing. */
  async function fresh() {
    await clearCards();
    await clearEffects();
  }
  const combat = () =>
    room()
      .model.inScene("combat", sceneId)
      .find((c) => c.active);
  const turnOf = () => {
    const c = combat();
    return c ? dataOf(c).combatants[c.turnIndex]?.tokenId : undefined;
  };
  async function toTurnOf(id: string) {
    for (let i = 0; i < 8 && turnOf() !== id; i++) await cmd(dm, "combat.next", {});
    expect(turnOf()).toBe(id);
  }

  let cleric = "";
  let g1 = "";
  let g2 = "";
  let ogre = "";
  async function npc(name: string, pos: P, extra: Record<string, unknown> = {}) {
    const { tokenId } = await cmd<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name,
      pos,
      disposition: "hostile",
      stats: { hp: 40, hpMax: 40, ac: 12, saves: { dex: 1, con: 1, wis: 0 }, ...extra },
    });
    return tokenId;
  }
  /** The cleric casts (Anna's creature; the DM casts for it, free — the slots aren't what's tested here). */
  const cast = (spellId: string, level: number, extra: Record<string, unknown> = {}) =>
    cmd<{ castId: string | null; effectId: string | null }>(dm, "spell.cast", {
      casterTokenId: cleric,
      spellId,
      mode: "free",
      level,
      // (A new concentration spell ends the last one: the prompt isn't what's tested here.)
      endConcentration: true,
      ...extra,
    });
  const at = (x: number, y: number) => ({ placement: { origin: { x, y, z: 0 } } });

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "7070" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const p = await joinAsNew(t, code, "Anna");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    anna = {
      room: (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient,
      id: p.userId,
    };
    ({ sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Field",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 200,
      heightFt: 120,
    }));
    await rq(dm, "scene.activate", { sceneId });
    cleric = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Sera",
        pos: { x: 20, y: 60 },
        disposition: "party",
        ownerIds: [anna.id],
        stats: { hp: 30, hpMax: 30, ac: 16 },
      })
    ).tokenId;
    g1 = await npc("Goblin", { x: 60, y: 60 });
    g2 = await npc("Goblin 2", { x: 100, y: 60 });
    ogre = await npc("Ogre", { x: 150, y: 60 }, { size: "large" });
    // The fight, in this order: Sera, Goblin, Goblin 2, Ogre.
    await cmd(dm, "combat.start", { participants: [cleric, g1, g2, ogre], method: "skip" });
    await cmd(dm, "combat.begin", {});
    await waitFor(() => combat() && dataOf(combat() as NonNullable<ReturnType<typeof combat>>).begun);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("Spirit Guardians: an emanation on its caster that spares her; no save when it appears; a creature walking in saves, once a turn even if it ends its turn there; next turn, ending it there, again; her walking up to one brings the save; Speed is halved inside", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 32, y: 60 }); // within 15 ft of Sera already
    const sg = await cast("spirit-guardians", 3);
    const e = effectOf(sg.effectId);
    expect(e?.shape.kind).toBe("emanation");
    expect(e?.props.exempt).toEqual([cleric]);
    expect(e?.props.speedHalved).toBe(true);
    // Appearing isn't entering: no card for the goblin already there (§8.13; SRD p. 164).
    expect(sg.castId).toBeNull();
    expect(triggerCards(e?.id as string)).toHaveLength(0);
    // Goblin 2's turn: it walks in — a save; it ends its turn there — no second one this turn.
    await toTurnOf(g2);
    await cmd(dm, "move.commit", {
      tokenId: g2,
      points: [tokenOf(g2)?.pos, { x: 30, y: 70 }],
    });
    await waitFor(() => triggerCards(e?.id as string).some((c) => whoIn(c.id).includes(g2)));
    expect(triggerCards(e?.id as string).filter((c) => whoIn(c.id).includes(g2))).toHaveLength(1);
    await cmd(dm, "combat.next", {}); // Goblin 2's turn ends inside
    await sleep(300);
    expect(triggerCards(e?.id as string).filter((c) => whoIn(c.id).includes(g2))).toHaveLength(1);
    await clearCards();
    // Round 2: Goblin 2 ends its turn inside — now it saves.
    await toTurnOf(g2);
    await cmd(dm, "combat.next", {});
    await waitFor(() => triggerCards(e?.id as string).some((c) => whoIn(c.id).includes(g2)));
    await clearCards();
    // Sera's turn: she walks up to the ogre; her spirits reach it — its save.
    await toTurnOf(cleric);
    await place(ogre, { x: 70, y: 60 });
    await cmd(dm, "move.commit", { tokenId: cleric, points: [tokenOf(cleric)?.pos, { x: 50, y: 60 }] });
    await waitFor(() => triggerCards(e?.id as string).some((c) => whoIn(c.id).includes(ogre)));
    await clearCards();
    await clearEffects();
    await place(cleric, { x: 20, y: 60 });
  });

  it("rules audit A4: a lasting effect reaches as its cast did — not through a wall, not a flier high over it", async () => {
    await fresh();
    await toTurnOf(cleric);
    // A solid wall between Sera and a goblin 12 ft off; another goblin beside her, 40 ft up.
    const { wallIds } = await cmd<{ wallIds: string[] }>(dm, "wall.create", {
      sceneId,
      walls: [{ a: { x: 26, y: 40 }, b: { x: 26, y: 80 } }],
    });
    await place(g1, { x: 32, y: 60 });
    await place(g2, { x: 22, y: 66 });
    await cmd(dm, "token.elevation", { tokenId: g2, elevation: 40 });
    const sg = await cast("spirit-guardians", 3);
    const id = effectOf(sg.effectId)?.id as string;
    const cardsFor = (tok: string) => triggerCards(id).filter((c) => whoIn(c.id).includes(tok));
    // Each ends its turn within 15 ft of her: neither is reached (SRD p. 177: total cover; pp. 181, 188: 3-D reach).
    await toTurnOf(g1);
    await cmd(dm, "combat.next", {});
    await cmd(dm, "combat.next", {});
    await sleep(300);
    expect(cardsFor(g1)).toHaveLength(0);
    expect(cardsFor(g2)).toHaveLength(0);
    // The wall gone and the flier down: next time round, both are.
    await cmd(dm, "wall.delete", { wallIds });
    await cmd(dm, "token.elevation", { tokenId: g2, elevation: 0 });
    await toTurnOf(g1);
    await cmd(dm, "combat.next", {});
    await waitFor(() => cardsFor(g1).length > 0);
    await cmd(dm, "combat.next", {});
    await waitFor(() => cardsFor(g2).length > 0);
    await clearCards();
    await clearEffects();
  });

  it("Moonbeam: whoever is in the beam when it appears saves; its caster moves it up to 60 ft (not 61), and moving it onto a creature brings its save", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    await place(g2, { x: 100, y: 60 });
    const mb = await cast("moonbeam", 2, at(60, 60));
    expect(mb.castId).toBeTruthy();
    expect(whoIn(mb.castId as string)).toEqual([g1]);
    await clearCards();
    const e = effectOf(mb.effectId) as EffectEntity;
    // Anna (the caster's player) moves it: 61 ft is too far; 40 ft onto Goblin 2 brings its save.
    await expect(cmd(anna.room, "effect.move", { effectId: e.id, to: { x: 121, y: 60 } })).rejects.toThrow(
      /60 ft/,
    );
    await cmd(anna.room, "effect.move", { effectId: e.id, to: { x: 100, y: 60 } });
    await waitFor(() => triggerCards(e.id).some((c) => whoIn(c.id).includes(g2)));
    await clearCards();
    await clearEffects();
  });

  it("Web: difficult ground and a haze; no save when it appears; a creature starting its turn in it saves or is Restrained", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    const web = await cast("web", 2, at(60, 60));
    expect(web.castId).toBeNull();
    const e = effectOf(web.effectId) as EffectEntity;
    expect(e.props.difficult).toBe(true);
    expect(e.props.obscurement).toBe("light");
    await toTurnOf(g1);
    const card = await waitFor(() => triggerCards(e.id).find((c) => whoIn(c.id).includes(g1)));
    expect(card.data.save?.ability).toBe("dex");
    await cmd(dm, "cast.set", { castId: card.id, targetId: g1, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: card.id });
    expect(statusOf(g1).conditions.some((c) => c.id === "restrained")).toBe(true);
    await cmd(dm, "status.change", { tokenId: g1, remove: ["restrained"] });
    await clearCards();
    await clearEffects();
  });

  it("Spike Growth: every 5 ft moved in it costs 2d4, however the feet add up across moves; no save", async () => {
    await fresh();
    await toTurnOf(cleric);
    const sp = await cast("spike-growth", 2, at(60, 30));
    expect(sp.castId).toBeNull();
    const e = effectOf(sp.effectId) as EffectEntity;
    await toTurnOf(g1);
    await place(g1, { x: 30, y: 30 });
    await clearCards();
    // 10 ft over open ground, then 10 ft into the spikes (from 40 ft off its centre to 30): 2d4 twice.
    await cmd(dm, "move.commit", {
      tokenId: g1,
      points: [
        { x: 30, y: 30 },
        { x: 50, y: 30 },
      ],
    });
    const card = await waitFor(() => triggerCards(e.id).find((c) => whoIn(c.id).includes(g1)));
    expect(card.data.damage?.parts[0]?.formula).toMatch(/^4d4/);
    expect(card.data.save).toBeNull();
    // Each 5 ft its own instance (rules audit Q5): the one roll shared between the two — a Concentration save each.
    const row = card.data.targets.find((t) => t.id === g1);
    expect(row?.times).toBe(2);
    await cmd(dm, "cast.roll", { castId: card.id, what: "damage", entered: 6 });
    const rolled = room().model.get("cast", card.id)?.data;
    const r2 = rolled?.targets.find((t) => t.id === g1);
    expect(rolled && r2 ? rowInstances(rolled, r2).map((i) => i.map((x) => x.amount)) : []).toEqual([
      [3],
      [3],
    ]);
    await clearCards();
    await clearEffects();
    await place(g1, { x: 60, y: 60 });
  });

  it("Sleet Storm: difficult and heavily obscured; a creature starting its turn in it fails its save — Prone, and its Concentration ends", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    // The goblin holds a concentration spell of its own (Fog Cloud, cast free).
    const fog = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: g1,
      spellId: "fog-cloud",
      mode: "free",
      level: 1,
      ...at(150, 20),
    });
    expect(statusOf(g1).concentration?.spellId).toBe("fog-cloud");
    const ss = await cast("sleet-storm", 3, at(60, 60));
    expect(ss.castId).toBeNull();
    const e = effectOf(ss.effectId) as EffectEntity;
    expect(e.props.difficult && e.props.obscurement === "heavy").toBe(true);
    await toTurnOf(g1);
    const card = await waitFor(() => triggerCards(e.id).find((c) => whoIn(c.id).includes(g1)));
    await cmd(dm, "cast.set", { castId: card.id, targetId: g1, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: card.id });
    expect(statusOf(g1).conditions.some((c) => c.id === "prone")).toBe(true);
    await waitFor(() => !statusOf(g1).concentration);
    await waitFor(() => !effectOf(fog.effectId));
    await cmd(dm, "status.change", { tokenId: g1, remove: ["prone"] });
    await clearCards();
    await clearEffects();
  });

  it("Stinking Cloud: a creature starting its turn in it fails — Poisoned until the end of that turn", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    const sc = await cast("stinking-cloud", 3, at(60, 60));
    expect(sc.castId).toBeNull();
    const e = effectOf(sc.effectId) as EffectEntity;
    await toTurnOf(g1);
    const card = await waitFor(() => triggerCards(e.id).find((c) => whoIn(c.id).includes(g1)));
    await cmd(dm, "cast.set", { castId: card.id, targetId: g1, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId: card.id });
    expect(statusOf(g1).conditions.some((c) => c.id === "poisoned")).toBe(true);
    await cmd(dm, "combat.next", {}); // its turn ends
    await waitFor(() => !statusOf(g1).conditions.some((c) => c.id === "poisoned"));
    await clearCards();
    await clearEffects();
  });

  it("Cloudkill: whoever is in it when it appears saves; at the start of each of its caster's turns it drifts 10 ft away from her", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    const ck = await cast("cloudkill", 5, at(60, 60));
    expect(whoIn(ck.castId as string)).toContain(g1);
    await clearCards();
    const e = effectOf(ck.effectId) as EffectEntity;
    expect(e.props.obscurement).toBe("heavy");
    const before = e.shape.kind === "sphere" ? { ...e.shape.origin } : null;
    // Round the order to Sera's next turn: 10 ft further from her (she stands at x = 20, so +x).
    await cmd(dm, "combat.next", {});
    await toTurnOf(cleric);
    await waitFor(() => {
      const now = effectOf(e.id)?.shape;
      return now?.kind === "sphere" && before && Math.abs(now.origin.x - (before.x + 10)) < 0.01;
    });
    await clearCards();
    await clearEffects();
  });

  it("Wall of Fire: a creature in the wall when it appears saves; ending a turn within 10 ft of its burning side burns, on the other side doesn't", async () => {
    await fresh();
    await toTurnOf(cleric);
    // A wall north-south along x = 80, drawn from south to north: its burning side is its left — west (x < 80).
    await place(g1, { x: 80, y: 60 });
    await place(g2, { x: 86, y: 60 }); // 6 ft east: the cool side
    await place(ogre, { x: 150, y: 60 });
    const wf = await cast("wall-of-fire", 4, {
      placement: {
        origin: { x: 80, y: 90, z: 0 },
        points: [
          { x: 80, y: 90 },
          { x: 80, y: 30 },
        ],
      },
    });
    expect(whoIn(wf.castId as string)).toEqual([g1]);
    await clearCards();
    const e = effectOf(wf.effectId) as EffectEntity;
    expect(e.shape.kind === "wall" && e.shape.opaque).toBe(true);
    // Goblin steps 6 ft west (the burning side) and ends its turn: it burns. Goblin 2 ends its turn east: nothing.
    await toTurnOf(g1);
    await place(g1, { x: 74, y: 60 });
    await cmd(dm, "combat.next", {});
    await waitFor(() => triggerCards(e.id).some((c) => whoIn(c.id).includes(g1)));
    await cmd(dm, "combat.next", {}); // Goblin 2's turn ends
    await sleep(300);
    expect(triggerCards(e.id).some((c) => whoIn(c.id).includes(g2))).toBe(false);
    await clearCards();
    await clearEffects();
  });

  it("Flaming Sphere: a 5-ft sphere where it's put (not round its caster); no save when it appears; ending a turn within 5 ft of it burns, walking up to it doesn't; its caster rolls it up to 30 ft and it stops at the first creature it runs into, which saves", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    await place(g2, { x: 100, y: 60 });
    const fs = await cast("flaming-sphere", 2, at(45, 40));
    expect(fs.castId).toBeNull();
    const e = effectOf(fs.effectId) as EffectEntity;
    expect(e.shape.kind).not.toBe("emanation");
    expect(e.props.light?.bright).toBe(20);
    // Goblin walks to 4 ft from the sphere's edge: nothing yet; it ends its turn there: it burns.
    await toTurnOf(g1);
    await place(g1, { x: 45, y: 49 });
    await sleep(300);
    expect(triggerCards(e.id)).toHaveLength(0);
    await cmd(dm, "combat.next", {});
    await waitFor(() => triggerCards(e.id).some((c) => whoIn(c.id).includes(g1)));
    await clearCards();
    // Sera's turn: Anna rolls it 31 ft (refused), then toward Goblin 2 standing in its way — it stops at it.
    await place(g1, { x: 60, y: 90 });
    await place(g2, { x: 60, y: 40 });
    await toTurnOf(cleric);
    await expect(cmd(anna.room, "effect.move", { effectId: e.id, to: { x: 76, y: 40 } })).rejects.toThrow(
      /30 ft/,
    );
    await cmd(anna.room, "effect.move", { effectId: e.id, to: { x: 70, y: 40 } });
    await waitFor(() => triggerCards(e.id).some((c) => whoIn(c.id).includes(g2)));
    const now = effectAt(effectOf(e.id) as EffectEntity);
    expect(now && now.x < 60).toBe(true);
    await clearCards();
    await clearEffects();
  });

  it("Call Lightning: the cloud over its caster; the bolt takes only those within 5 ft of its point; called again at a point under the cloud (not outside it)", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 50, y: 60 });
    await place(g2, { x: 58, y: 60 });
    const cl = await cast("call-lightning", 3, at(50, 60));
    expect(whoIn(cl.castId as string)).toEqual([g1]);
    await clearCards();
    const e = effectOf(cl.effectId) as EffectEntity;
    expect(e.shape.kind === "cylinder" && e.shape.radius === 60).toBe(true);
    // Its centre is over Sera.
    expect(effectAt(e)).toMatchObject({ x: 20, y: 60 });
    const again = await cmd<{ castId: string }>(anna.room, "effect.act", {
      effectId: e.id,
      at: { x: 58, y: 60 },
    });
    expect(whoIn(again.castId)).toEqual([g2]);
    await expect(cmd(anna.room, "effect.act", { effectId: e.id, at: { x: 150, y: 60 } })).rejects.toThrow(
      /isn.t under/,
    );
    await clearCards();
    await clearEffects();
  });

  it("Silence: those inside are Deafened while there, and no one inside casts a spell with a Verbal component", async () => {
    await fresh();
    await toTurnOf(cleric);
    const si = await cast("silence", 2, at(20, 60));
    expect(effectOf(si.effectId)?.props.silence).toBe(true);
    await waitFor(() => room().state.tokens.get(cleric)?.conditions.includes("deafened"));
    await expect(
      cmd(anna.room, "spell.cast", { casterTokenId: cleric, spellId: "sacred-flame", targets: [g1] }),
    ).rejects.toThrow(/Silence/);
    await clearEffects();
    await waitFor(() => !room().state.tokens.get(cleric)?.conditions.includes("deafened"));
  });

  it("Daylight dispels a Darkness of 3rd level or lower that it overlaps; Light cast on a creature's torch goes where it goes", async () => {
    await fresh();
    await toTurnOf(cleric);
    const dk = await cast("darkness", 2, at(100, 60));
    expect(effectOf(dk.effectId)?.props.magicalDarkness).toBe(true);
    const dl = await cast("daylight", 3, at(110, 60));
    await waitFor(() => !effectOf(dk.effectId));
    expect(effectOf(dl.effectId)?.props.light?.bright).toBe(60);
    await clearEffects();
    // Light on Goblin (on the torch it carries): the light's centre moves with it.
    const li = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: cleric,
      spellId: "light",
      targets: [g1],
    });
    const e = effectOf(li.effectId) as EffectEntity;
    expect(e.attachedTokenId).toBe(g1);
    await place(g1, { x: 64, y: 70 });
    expect(effectAt(effectOf(e.id) as EffectEntity)).toBeNull(); // follows its creature, not a point
    await clearEffects();
  });

  it("Fog Cloud: a heavily obscured sphere, 20 ft more a slot; it ends with its caster's concentration", async () => {
    await fresh();
    await toTurnOf(cleric);
    const fc = await cast("fog-cloud", 2, at(100, 60));
    const e = effectOf(fc.effectId) as EffectEntity;
    expect(e.props.obscurement).toBe("heavy");
    expect(e.shape.kind === "sphere" && e.shape.radius).toBe(40);
    expect(statusOf(cleric).concentration?.spellId).toBe("fog-cloud");
    // Her Concentration ends (the DM ends it — as when she's Incapacitated and the DM confirms): the fog goes.
    await cmd(dm, "status.change", { tokenId: cleric, concentration: null });
    await waitFor(() => !effectOf(e.id));
  });

  it("Faerie Fire: a Dex save when it appears; those who fail are outlined in light, and it goes with them", async () => {
    await fresh();
    await toTurnOf(cleric);
    await place(g1, { x: 60, y: 60 });
    await place(g2, { x: 62, y: 66 });
    const ff = await cast("faerie-fire", 1, at(62, 62));
    const castId = ff.castId as string;
    expect(whoIn(castId).sort()).toEqual([g1, g2].sort());
    await cmd(dm, "cast.set", { castId, targetId: g1, saveSuccess: false });
    await cmd(dm, "cast.set", { castId, targetId: g2, saveSuccess: true });
    await cmd(dm, "cast.apply", { castId });
    const on = effects().filter((x) => x.props.outline);
    expect(on.map((x) => x.attachedTokenId)).toEqual([g1]);
    expect(on[0]?.props.light?.dim).toBe(10);
    await clearCards();
    await clearEffects();
  });

  it("durations: an effect cast in a fight lasts its rounds from its caster's turn — Flaming Sphere's minute (10 rounds) ends at the start of her 11th turn, her Concentration with it", async () => {
    await fresh();
    await toTurnOf(cleric);
    const round0 = combat()?.round ?? 0;
    const fs = await cast("flaming-sphere", 2, at(150, 20));
    const e = effectOf(fs.effectId) as EffectEntity;
    expect(e.expires).toEqual({ round: round0 + 10, turnOf: cleric, when: "start" });
    // Ten more rounds of turns: at the start of her turn in round +10 it's gone.
    for (let r = 0; r < 10; r++) {
      await cmd(dm, "combat.next", {});
      await toTurnOf(cleric);
      if (r < 9) expect(effectOf(e.id), `round ${r + 1}`).toBeTruthy();
    }
    await waitFor(() => !effectOf(e.id));
    await waitFor(() => !statusOf(cleric).concentration);
  }, 60_000);
});

/** Where an effect stands, if it stands at a point (not on a creature). */
function effectAt(e: EffectEntity): P | null {
  const s = e.shape;
  if (s.kind === "emanation") return null;
  if (s.kind === "wall") return s.points[0] ?? null;
  return { x: s.origin.x, y: s.origin.y };
}
