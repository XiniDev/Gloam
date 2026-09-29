import type { Room } from "@colyseus/sdk";
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
import { type RecordingWebSocket, recordFrames, socketCount, socketsSince } from "./ws-recorder.ts";

type TableRoomClient = Room<unknown, TableState>;
interface Player {
  room: TableRoomClient;
  id: string;
  socket: RecordingWebSocket;
  msgs: { type: string; payload: unknown }[];
}

/**
 * P9's security review (SPEC §13.4, §15; AC-SEC-07): what a player's client is sent about spells and their effects when
 * a creature is hidden from them — never its position, never its id. A long hall split by a wall: Anna's elf on the
 * west side; a DM-hidden Lurker and, later, a Fog Cloud on the east.
 */
describe("P9 — spells never leak what a player can't perceive", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let anna: Player;
  let sceneId = "";
  let elf = "";
  let lurker = "";
  let cultist = "";

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(230);
    return rq<T>(r, type, payload);
  };
  const place = (tokenId: string, to: { x: number; y: number }) =>
    cmd(dm, "move.commit", { tokenId, points: [room().model.get("token", tokenId)?.pos, to] });
  const effectsOf = (p: Player) => [...(p.room.state.effects?.values?.() ?? [])];

  async function admit(name: string): Promise<Player> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const mark = socketCount();
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Player["msgs"] = [];
    r.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    const socket = socketsSince(mark).at(-1) as RecordingWebSocket;
    return { room: r, id: p.userId, socket, msgs };
  }

  beforeAll(async () => {
    recordFrames(true);
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "9090" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    anna = await admit("Anna");
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Split hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 100,
        heightFt: 40,
        fogMode: "dynamic",
        ambient: "bright",
      })
    ).sceneId;
    await rq(dm, "wall.create", {
      sceneId,
      walls: [{ a: { x: 40, y: -5 }, b: { x: 40, y: 45 }, kind: "wall" }],
    });
    const token = async (name: string, pos: { x: number; y: number }, extra: object = {}) =>
      (
        await cmd<{ tokenId: string }>(dm, "token.create", {
          sceneId,
          name,
          pos,
          stats: { hp: 20, hpMax: 20, ac: 12, saves: { wis: 0, dex: 0, con: 0 } },
          ...extra,
        })
      ).tokenId;
    elf = await token("Anna's Elf", { x: 5, y: 20 }, { disposition: "party", ownerIds: [anna.id] });
    lurker = await token("Lurker", { x: 70, y: 20 }, { hidden: true });
    cultist = await token("Cultist", { x: 20, y: 34 });
    await rq(dm, "scene.activate", { sceneId });
    await waitFor(() => anna.room.state.tokens?.get?.(elf));
  });
  afterAll(async () => {
    recordFrames(false);
    await t?.stop();
  });

  it("H1: a hidden creature's Spirit Guardians — nothing while its area is out of sight; in sight, a stand-in: where, never whose", async () => {
    const from = anna.socket.frames.length;
    const cast = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: lurker,
      spellId: "spirit-guardians",
      mode: "free",
      level: 3,
    });
    expect(cast.effectId).toBeTruthy();
    await sleep(400);
    expect(effectsOf(anna)).toEqual([]);
    // The Lurker steps up to the wall: its spirits reach round to Anna's side (15 ft + its own 2.5 from x = 48).
    await place(lurker, { x: 48.4, y: 20.3 });
    await waitFor(() => effectsOf(anna).length === 1);
    const seen = effectsOf(anna)[0] as {
      id: string;
      shapeJson: string;
      propsJson: string;
      controlJson: string;
    };
    expect(seen.id).not.toBe(cast.effectId);
    expect(JSON.parse(seen.shapeJson)).toEqual({
      kind: "emanation",
      distance: 15,
      at: { x: 48, y: 20, z: 0 },
      baseRadius: 2.5,
    });
    expect(JSON.parse(seen.propsJson).exempt).toBeUndefined();
    expect(seen.controlJson).toBe("{}");
    expect((seen as { link?: unknown }).link).toBeFalsy();
    // Back out of reach: gone again.
    await place(lurker, { x: 70, y: 20 });
    await waitFor(() => effectsOf(anna).length === 0);
    // Never its id, the effect's id, or the list of who it spares.
    for (const needle of [lurker, cast.effectId, "exempt"])
      expect(anna.socket.receivedSince(from, needle), needle).toBe(false);
    await cmd(dm, "effect.remove", { effectId: cast.effectId });
  });

  it("H1: an effect whose area is out of sight (and unexplored) isn't sent; in sight it is, linked to a caster she perceives; a DM-only one never", async () => {
    const from = anna.socket.frames.length;
    const far = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: cultist,
      spellId: "fog-cloud",
      mode: "free",
      level: 1,
      placement: { origin: { x: 75, y: 20, z: 0 } },
      endConcentration: true,
    });
    await sleep(400);
    expect(effectsOf(anna)).toEqual([]);
    expect(anna.socket.receivedSince(from, far.effectId)).toBe(false);
    const near = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: cultist,
      spellId: "fog-cloud",
      mode: "free",
      level: 1,
      placement: { origin: { x: 22, y: 6, z: 0 } },
      endConcentration: true,
    });
    await waitFor(() => anna.room.state.effects?.get?.(near.effectId));
    await waitFor(() => anna.room.state.effects?.get?.(near.effectId)?.link?.casterId === cultist);
    expect(anna.room.state.effects?.get?.(far.effectId)).toBeUndefined();
    // The DM's own: gone from her view.
    await cmd(dm, "effect.update", { effectId: near.effectId, visibility: "dm" });
    await waitFor(() => !anna.room.state.effects?.get?.(near.effectId));
    await cmd(dm, "effect.remove", { effectId: near.effectId });
  });

  it("H1: who an effect spares is on the spared creature, for its controllers — never in the effect", async () => {
    const own = await cmd<{ effectId: string }>(dm, "spell.cast", {
      casterTokenId: elf,
      spellId: "spirit-guardians",
      mode: "free",
      level: 3,
      endConcentration: true,
    });
    await waitFor(() => anna.room.state.effects?.get?.(own.effectId));
    const e = anna.room.state.effects?.get?.(own.effectId) as { propsJson: string };
    expect(JSON.parse(e.propsJson)).toMatchObject({ speedHalved: true });
    expect(JSON.parse(e.propsJson).exempt).toBeUndefined();
    await waitFor(() =>
      JSON.parse(anna.room.state.tokens?.get?.(elf)?.own?.spared || "[]").includes(own.effectId),
    );
    await cmd(dm, "effect.remove", { effectId: own.effectId });
    await waitFor(
      () => !JSON.parse(anna.room.state.tokens?.get?.(elf)?.own?.spared || "[]").includes(own.effectId),
    );
  });

  describe("H2: what a spell is cast on", () => {
    let mira = "";
    let goblin = "";
    const annaCast = (payload: object) =>
      cmd<{ castId: string | null; effectId: string | null }>(anna.room, "spell.cast", payload);
    const effect = (id: string | null) => (id ? room().model.get("effect", id) : undefined);

    beforeAll(async () => {
      const { actorId } = await cmd<{ actorId: string }>(anna.room, "actor.create", {
        ownerUserId: anna.id,
        sheet: {
          core: {
            name: "Mira",
            classes: [{ name: "Wizard", level: 5 }],
            abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
            hp: { max: 28, current: 28, temp: 0 },
            spellcasting: {
              ability: "int",
              slots: [
                { level: 1, max: 4 },
                { level: 2, max: 3 },
                { level: 3, max: 2 },
              ],
              spells: [
                { name: "Light", level: 0, prepared: true },
                { name: "Darkness", level: 2, prepared: true },
                { name: "Tiny Hut", level: 3, prepared: true },
                { name: "Spirit Guardians", level: 3, prepared: true },
              ],
            },
          },
        },
      });
      await waitFor(() =>
        room()
          .model.all("token")
          .some((x) => x.actorId === actorId),
      );
      mira = (
        room()
          .model.all("token")
          .find((x) => x.actorId === actorId) as { id: string }
      ).id;
      await place(mira, { x: 10, y: 10 });
      goblin = (
        await cmd<{ tokenId: string }>(dm, "token.create", { sceneId, name: "Goblin", pos: { x: 14, y: 10 } })
      ).tokenId;
    });

    it("Light: on a creature's gear only by the DM; a player's on her own gear or an object put down within reach; cast again, the first ends", async () => {
      // Not the goblin's torch (by id, at any distance, through walls — never), nor by naming it as a target.
      await expect(
        annaCast({
          casterTokenId: mira,
          spellId: "light",
          placement: { origin: { x: 14, y: 10, z: 0 }, dirDeg: 0, attachTo: goblin },
        }),
      ).rejects.toThrow(/carries|object/);
      await expect(annaCast({ casterTokenId: mira, spellId: "light", targets: [goblin] })).rejects.toThrow(
        /Choose what Light is cast on/,
      );
      // Her own sword: goes where she goes.
      const own = await annaCast({
        casterTokenId: mira,
        spellId: "light",
        placement: { origin: { x: 10, y: 10, z: 0 }, dirDeg: 0, attachTo: mira },
      });
      expect(effect(own.effectId)?.attachedTokenId).toBe(mira);
      // A stone put down 5 ft away: stays there. 30 ft away: out of reach.
      await expect(
        annaCast({
          casterTokenId: mira,
          spellId: "light",
          placement: { origin: { x: 40, y: 10, z: 0 }, dirDeg: 0 },
        }),
      ).rejects.toThrow(/reach/);
      const stone = await annaCast({
        casterTokenId: mira,
        spellId: "light",
        placement: { origin: { x: 10, y: 15, z: 0 }, dirDeg: 0 },
      });
      const e = effect(stone.effectId);
      expect(e?.attachedTokenId).toBeNull();
      expect(e?.shape).toEqual({ kind: "sphere", origin: { x: 10, y: 15, z: 0 }, radius: 0 });
      // Cast again, the first one ended.
      expect(effect(own.effectId)).toBeUndefined();
      await cmd(dm, "effect.remove", { effectId: stone.effectId });
    });

    it("the DM may put Light on the goblin's torch; a player's Spirit Guardians can't be put on another creature", async () => {
      const dmLight = await cmd<{ effectId: string }>(dm, "spell.cast", {
        casterTokenId: mira,
        spellId: "light",
        targets: [goblin],
      });
      expect(effect(dmLight.effectId)?.attachedTokenId).toBe(goblin);
      await cmd(dm, "effect.remove", { effectId: dmLight.effectId });
      await expect(
        annaCast({
          casterTokenId: mira,
          spellId: "spirit-guardians",
          mode: "slot",
          slot: { level: 3, kind: "slot" },
          placement: { origin: { x: 14, y: 10, z: 0 }, dirDeg: 0, attachTo: goblin },
        }),
      ).rejects.toThrow(/can't be put on a creature/);
    });

    it("Darkness on an object lies where it's put (not on the caster); Tiny Hut stays where it was cast; only the DM resizes", async () => {
      const dk = await annaCast({
        casterTokenId: mira,
        spellId: "darkness",
        mode: "slot",
        slot: { level: 2, kind: "slot" },
        placement: { origin: { x: 14, y: 14, z: 0 }, dirDeg: 0, alt: 0 },
      });
      const d = effect(dk.effectId);
      expect(d?.shape.kind).toBe("sphere");
      expect(d?.attachedTokenId).toBeNull();
      await cmd(dm, "effect.remove", { effectId: dk.effectId });
      const hut = await annaCast({
        casterTokenId: mira,
        spellId: "tiny-hut",
        mode: "ritual",
        level: 5,
        endConcentration: true,
      });
      const h = effect(hut.effectId);
      expect(h?.shape).toEqual({ kind: "sphere", origin: { x: 10, y: 10, z: 0 }, radius: 12.5 });
      // A ritual is cast at its own level (SRD p. 187), whatever level is asked.
      expect(h?.source.slot).toBe(3);
      await place(mira, { x: 20, y: 10 });
      expect(effect(hut.effectId)?.shape).toEqual(h?.shape);
      await cmd(dm, "effect.remove", { effectId: hut.effectId });
      await place(mira, { x: 10, y: 10 });
      await expect(
        annaCast({
          casterTokenId: mira,
          spellId: "darkness",
          mode: "slot",
          slot: { level: 2, kind: "slot" },
          placement: { origin: { x: 14, y: 14, z: 0 }, dirDeg: 0, size: 500 },
        }),
      ).rejects.toThrow(/size/);
    });

    it("without a slot, a player casts only what her sheet has, up to her highest slot; only on the scene in play", async () => {
      await expect(
        annaCast({ casterTokenId: mira, spellId: "wish", mode: "free", level: 9 }),
      ).rejects.toThrow(/isn't on Mira's sheet/);
      await expect(
        annaCast({
          casterTokenId: mira,
          spellId: "darkness",
          mode: "free",
          level: 6,
          placement: { origin: { x: 14, y: 14, z: 0 }, dirDeg: 0 },
        }),
      ).rejects.toThrow(/3rd level at most/);
      const other = (
        await cmd<{ sceneId: string }>(dm, "scene.create", {
          name: "Elsewhere",
          mapKind: "procedural",
          floorStyle: "stone",
          widthFt: 40,
          heightFt: 40,
        })
      ).sceneId;
      const away = (
        await cmd<{ tokenId: string }>(dm, "token.create", {
          sceneId: other,
          name: "Anna's echo",
          pos: { x: 5, y: 5 },
          ownerIds: [anna.id],
        })
      ).tokenId;
      await expect(
        annaCast({
          casterTokenId: away,
          spellId: "light",
          placement: { origin: { x: 5, y: 5, z: 0 }, dirDeg: 0, attachTo: away },
        }),
      ).rejects.toThrow(/scene in play/);
    });
  });

  describe("H3 / M2: the line a cast writes", () => {
    it("a hidden caster's cast with no card tells players nothing; a card's count is of the creatures each reader perceives", async () => {
      const dmLines: string[] = [];
      dm.onMessage("cast.line", (m: { text: string }) => dmLines.push(m.text));
      const mark = anna.msgs.length;
      const lines = () =>
        anna.msgs
          .slice(mark)
          .filter((m) => m.type === "cast.line")
          .map((m) => (m.payload as { text: string }).text);
      // The Lurker (DM-hidden) casts Darkness: no card — and no line for Anna.
      const dk = await cmd<{ castId: string | null; effectId: string }>(dm, "spell.cast", {
        casterTokenId: lurker,
        spellId: "darkness",
        mode: "free",
        level: 2,
        placement: { origin: { x: 75, y: 20, z: 0 }, dirDeg: 0 },
      });
      expect(dk.castId).toBeNull();
      await waitFor(() => dmLines.some((l) => l.startsWith("Lurker casts Darkness")));
      await sleep(300);
      expect(lines()).toEqual([]);
      await cmd(dm, "effect.remove", { effectId: dk.effectId });
      // The cultist (whom she sees) throws a Fireball that catches the Lurker too: her count leaves it out.
      await place(lurker, { x: 26, y: 26 });
      const fb = await cmd<{ castId: string }>(dm, "spell.cast", {
        casterTokenId: cultist,
        spellId: "fireball",
        mode: "free",
        level: 3,
        placement: { origin: { x: 24, y: 22, z: 0 }, dirDeg: 0 },
      });
      const card = room().model.get("cast", fb.castId);
      const all = new Set(card?.data.targets.filter((x) => x.state === "in").map((x) => x.id)).size;
      expect(card?.data.targets.some((x) => x.id === lurker)).toBe(true);
      await waitFor(() => lines().some((l) => l.startsWith("Cultist casts Fireball")));
      const hers = lines().find((l) => l.startsWith("Cultist casts Fireball")) as string;
      expect(hers).toBe(
        `Cultist casts Fireball (3rd level) — ${all - 1} ${all - 1 === 1 ? "creature" : "creatures"}`,
      );
      expect(dmLines.find((l) => l.startsWith("Cultist casts Fireball"))).toBe(
        `Cultist casts Fireball (3rd level) — ${all} creatures`,
      );
      await cmd(dm, "cast.close", { castId: fb.castId });
      await place(lurker, { x: 70, y: 20 });
    });
  });

  describe("H4: an effect's triggers, moves and strikes", () => {
    let mira = "";
    let goblin = "";
    const annaTry = <T = unknown>(type: string, payload: object) => cmd<T>(anna.room, type, payload);
    const dmCastFor = (
      casterTokenId: string,
      spellId: string,
      level: number,
      at?: { x: number; y: number },
    ) =>
      cmd<{ castId: string | null; effectId: string }>(dm, "spell.cast", {
        casterTokenId,
        spellId,
        mode: "free",
        level,
        endConcentration: true,
        ...(at ? { placement: { origin: { x: at.x, y: at.y, z: 0 }, dirDeg: 0 } } : {}),
      });
    const openCards = () =>
      room()
        .model.all("cast")
        .filter((c) => c.status === "open");
    const closeAll = async () => {
      for (const c of openCards()) await cmd(dm, "cast.close", { castId: c.id });
    };
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

    beforeAll(async () => {
      const toks = room().model.inScene("token", sceneId);
      mira = (toks.find((x) => x.name === "Mira") as { id: string }).id;
      goblin = (toks.find((x) => x.name === "Goblin") as { id: string }).id;
      await place(mira, { x: 10, y: 10 });
      await place(goblin, { x: 32, y: 6 });
      await closeAll();
    });

    it("a trigger's card: its caster's players see only the creatures they perceive — none, no card; its subtitle names only them", async () => {
      const sg = await dmCastFor(mira, "spirit-guardians", 3);
      const from = anna.socket.frames.length;
      // The Lurker (DM-hidden) walks into Mira's spirits: the DM's card; nothing of it for Anna.
      await place(lurker, { x: 36, y: 30 });
      await place(lurker, { x: 18, y: 14 });
      await waitFor(() =>
        openCards().some((c) => c.data.kind === "trigger" && c.data.targets.some((t) => t.id === lurker)),
      );
      await sleep(400);
      expect(anna.socket.receivedSince(from, "Lurker")).toBe(false);
      // The goblin walks in: her card, "Goblin entered it".
      await place(goblin, { x: 20, y: 6 });
      const views = () =>
        anna.msgs.flatMap((m) =>
          m.type === "cast.views"
            ? (m.payload as { subtitle?: string }[])
            : m.type === "cast.view"
              ? [m.payload as { subtitle?: string }]
              : [],
        );
      await waitFor(() => views().some((v) => v.subtitle === "Goblin entered it"));
      expect(anna.socket.receivedSince(from, "Lurker")).toBe(false);
      await closeAll();
      await cmd(dm, "effect.remove", { effectId: sg.effectId });
      await place(lurker, { x: 70, y: 20 });
      await place(goblin, { x: 32, y: 6 });
    });

    it("a cloud that only drifts (Cloudkill) isn't its caster's to move — the DM's", async () => {
      const ck = await dmCastFor(mira, "cloudkill", 5, { x: 25, y: 25 });
      await expect(annaTry("effect.move", { effectId: ck.effectId, to: { x: 25, y: 20 } })).rejects.toThrow(
        /FORBIDDEN/,
      );
      await cmd(dm, "effect.move", { effectId: ck.effectId, to: { x: 25, y: 20 } });
      await closeAll();
      await cmd(dm, "effect.remove", { effectId: ck.effectId });
    });

    it("in combat: Moonbeam moves 60 ft a turn however many drags, never where Mira has no clear line; Flaming Sphere doesn't roll through a wall, and stops for the turn when it rams someone", async () => {
      await cmd(dm, "combat.start", { participants: [mira, goblin, cultist], method: "skip" });
      await cmd(dm, "combat.begin", {});
      await waitFor(() => combat() && dataOf(combat() as NonNullable<ReturnType<typeof combat>>).begun);
      await toTurnOf(mira);
      const mb = await dmCastFor(mira, "moonbeam", 2, { x: 20, y: 20 });
      await closeAll();
      await expect(annaTry("effect.move", { effectId: mb.effectId, to: { x: 46, y: 20 } })).rejects.toThrow(
        /clear line/,
      );
      await annaTry("effect.move", { effectId: mb.effectId, to: { x: 35, y: 20 } });
      await annaTry("effect.move", { effectId: mb.effectId, to: { x: 5, y: 20 } });
      await closeAll();
      await expect(annaTry("effect.move", { effectId: mb.effectId, to: { x: 25, y: 20 } })).rejects.toThrow(
        /15 ft more this turn/,
      );
      // Her next turn: 60 ft again.
      await toTurnOf(goblin);
      await toTurnOf(mira);
      await annaTry("effect.move", { effectId: mb.effectId, to: { x: 25, y: 20 } });
      await closeAll();
      await cmd(dm, "effect.remove", { effectId: mb.effectId });
      // Flaming Sphere: not through the wall; into the goblin — it stops there for the turn.
      const fs = await dmCastFor(mira, "flaming-sphere", 2, { x: 36, y: 20 });
      await closeAll();
      await expect(annaTry("effect.move", { effectId: fs.effectId, to: { x: 46, y: 20 } })).rejects.toThrow(
        /wall|clear line/,
      );
      await place(goblin, { x: 36, y: 8 });
      await annaTry("effect.move", { effectId: fs.effectId, to: { x: 36, y: 2 } });
      await expect(annaTry("effect.move", { effectId: fs.effectId, to: { x: 30, y: 20 } })).rejects.toThrow(
        /stopped/,
      );
      await closeAll();
      await cmd(dm, "effect.remove", { effectId: fs.effectId });
      await place(goblin, { x: 32, y: 6 });
    });

    it("Call Lightning's bolt once a turn; striking where only an unseen creature stands tells its caller nothing", async () => {
      await toTurnOf(mira);
      const cl = await dmCastFor(mira, "call-lightning", 3, { x: 20, y: 30 });
      await closeAll();
      // Only the Lurker under the bolt (5 ft round its point): nobody Anna perceives.
      await place(lurker, { x: 30, y: 18 });
      const before = openCards().length;
      const r = await annaTry<{ castId: string | null }>("effect.act", {
        effectId: cl.effectId,
        at: { x: 30, y: 18 },
      });
      expect(r.castId).toBeNull();
      // The DM has the card (the Lurker is under the bolt).
      await waitFor(() => openCards().length > before);
      expect(openCards().some((c) => c.data.targets.some((t) => t.id === lurker))).toBe(true);
      await expect(annaTry("effect.act", { effectId: cl.effectId, at: { x: 20, y: 30 } })).rejects.toThrow(
        /already been called this turn/,
      );
      await closeAll();
      await cmd(dm, "effect.remove", { effectId: cl.effectId });
      await place(lurker, { x: 70, y: 20 });
      await cmd(dm, "combat.stop", {});
    });
  });

  describe("M3 / M4 / L2 / L3, I3–I5: a card's rolls, saves and cancelling", () => {
    let mira = "";
    let goblin = "";
    const anyCard = () =>
      room()
        .model.all("cast")
        .filter((c) => c.status === "open");
    const closeAll = async () => {
      for (const c of anyCard()) await cmd(dm, "cast.close", { castId: c.id });
    };
    const annaViewOf = (castId: string) => {
      const all = anna.msgs.flatMap((m) =>
        m.type === "cast.views"
          ? (m.payload as { id: string }[])
          : m.type === "cast.view"
            ? [m.payload as { id: string }]
            : [],
      );
      return all.filter((v) => v.id === castId).at(-1) as
        | { targets: { key: string; attackHints?: { mode: string; adv: string[] } }[] }
        | undefined;
    };
    const rolls = () =>
      anna.msgs
        .filter((m) => m.type === "roll.result")
        .map((m) => m.payload as { label?: string; formula: string });

    beforeAll(async () => {
      const toks = room().model.inScene("token", sceneId);
      mira = (toks.find((x) => x.name === "Mira") as { id: string }).id;
      goblin = (toks.find((x) => x.name === "Goblin") as { id: string }).id;
      await place(mira, { x: 10, y: 10 });
      await place(goblin, { x: 24, y: 10 });
      await closeAll();
    });

    it("an attack's hints from the target (Restrained: advantage); a physical roll by its d20 (never a typed total), a 20 a critical hit; the roll's label names no creature; under \"max plus a roll\", the crit's damage is its dice plus their maximum; once rolled, the caster can't cancel", async () => {
      await cmd(dm, "status.change", { tokenId: goblin, add: [{ id: "restrained" }] });
      await cmd(dm, "campaign.update", { houseRules: { criticalDamage: "maxPlusRoll" } });
      const fb = await cmd<{ castId: string }>(anna.room, "spell.cast", {
        casterTokenId: mira,
        spellId: "fire-bolt",
        mode: "slot",
        targets: [goblin],
      });
      await waitFor(() => annaViewOf(fb.castId)?.targets[0]?.attackHints?.mode === "adv");
      expect(annaViewOf(fb.castId)?.targets[0]?.attackHints?.adv).toContain("target Restrained");
      await expect(
        cmd(anna.room, "cast.roll", { castId: fb.castId, what: "attack", targetId: goblin, entered: 25 }),
      ).rejects.toThrow(/d20 you rolled/);
      await cmd(anna.room, "cast.roll", {
        castId: fb.castId,
        what: "attack",
        targetId: goblin,
        dice: [20, 3],
        adv: "adv",
      });
      const row = room().model.get("cast", fb.castId)?.data.targets[0];
      expect(row?.attack).toMatchObject({ natural: 20, crit: true, hit: true, entered: true });
      await waitFor(() => rolls().some((r) => r.label === "Fire Bolt · attack"));
      expect(rolls().some((r) => (r.label ?? "").includes("Goblin"))).toBe(false);
      await expect(cmd(anna.room, "cast.cancel", { castId: fb.castId })).rejects.toThrow(/rolled on/);
      await cmd(anna.room, "cast.roll", { castId: fb.castId, what: "damage", targetId: goblin });
      await waitFor(() => rolls().some((r) => r.label === "Fire Bolt · damage"));
      // Mira is 5th level: Fire Bolt is 2d10 — a critical under the house rule: 2d10 + 20.
      expect(rolls().find((r) => r.label === "Fire Bolt · damage")?.formula).toMatch(/^2d10 \+ 20/);
      await cmd(dm, "campaign.update", { houseRules: { criticalDamage: "doubleDice" } });
      await cmd(dm, "status.change", { tokenId: goblin, remove: ["restrained"] });
      await closeAll();
    });

    it("a creature a player controls (a familiar) saves on its player's card, not the DM's NPC roll — and nobody's card shows a hidden DC; a row the caster doesn't perceive can't be rolled on", async () => {
      const owl = (
        await cmd<{ tokenId: string }>(dm, "token.create", {
          sceneId,
          name: "Owl",
          pos: { x: 14, y: 14 },
          ownerIds: [anna.id],
        })
      ).tokenId;
      const mark = anna.msgs.length;
      const fb = await cmd<{ castId: string }>(dm, "spell.cast", {
        casterTokenId: cultist,
        spellId: "fireball",
        mode: "free",
        level: 3,
        placement: { origin: { x: 18, y: 18, z: 0 }, dirDeg: 0 },
      });
      // Anna's card for the owl; the DM's NPC roll leaves it to her.
      await waitFor(() =>
        anna.msgs
          .slice(mark)
          .some((m) => m.type === "request.card" && JSON.stringify(m.payload).includes(owl)),
      );
      const card = anna.msgs
        .slice(mark)
        .find((m) => m.type === "request.card" && JSON.stringify(m.payload).includes(owl));
      expect((card?.payload as { dc?: number }).dc).toBeUndefined();
      await cmd(dm, "cast.npcSaves", { castId: fb.castId });
      const owlRow = room()
        .model.get("cast", fb.castId)
        ?.data.targets.find((t) => t.id === owl);
      expect(owlRow?.save?.total).toBeUndefined();
      await closeAll();
      // The DM puts the (hidden) Lurker on Anna's Fire Bolt card: she can't roll at a row she doesn't perceive.
      await place(lurker, { x: 20, y: 30 });
      const bolt = await cmd<{ castId: string }>(anna.room, "spell.cast", {
        casterTokenId: mira,
        spellId: "fire-bolt",
        mode: "slot",
        targets: [goblin],
      });
      await cmd(dm, "cast.target", { castId: bolt.castId, targetId: lurker, include: true });
      await expect(
        cmd(anna.room, "cast.roll", { castId: bolt.castId, what: "attack", targetId: lurker }),
      ).rejects.toThrow(/isn't on the card/);
      await closeAll();
      await cmd(dm, "token.delete", { tokenIds: [owl] });
      await place(lurker, { x: 70, y: 20 });
    });
  });
});
