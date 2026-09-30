import type { Room } from "@colyseus/sdk";
import type { RollRecord } from "@gloam/shared/dice";
import type { ActingAsView, HistoryListResult, LogEntryView } from "@gloam/shared/protocol";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { recordFrames, socketCount, socketsSince } from "./ws-recorder.ts";

type TableRoomClient = Room<unknown, TableState>;
interface Msg {
  type: string;
  payload: unknown;
}
interface Seat {
  room: TableRoomClient;
  id: string;
  msgs: Msg[];
  socket: ReturnType<typeof socketsSince>[number];
}

/**
 * The DM control panel on the server (SPEC §8.19): DM notes — a scene's and a token's — reach the DMs and never a
 * player's socket (AC-DMP-05); Act as — a DM takes a character's controls, and what they do is recorded as "DM as
 * <character>" in the history, the rolls and the log, the character's player told (AC-DMP-03).
 */
describe("P12 — the DM control panel on the server (DMP)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: Seat;
  let dave: Seat;
  let sceneId = "";
  const of = <T>(s: Seat, type: string) => s.msgs.filter((m) => m.type === type).map((m) => m.payload as T);

  async function join(agent: Agent): Promise<Seat> {
    const mark = socketCount();
    const room = (await agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    room.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    return { room, id: "", msgs, socket: socketsSince(mark).at(-1) as Seat["socket"] };
  }

  beforeAll(async () => {
    recordFrames(true);
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = { ...(await join(admin)), id: "admin" };
    const p = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    dave = { ...(await join(p.agent)), id: p.userId };
    sceneId = (
      await rq<{ sceneId: string }>(dm.room, "scene.create", {
        name: "Crypt hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
        fogMode: "off",
        ambient: "bright",
      })
    ).sceneId;
    await rq(dm.room, "scene.activate", { sceneId });
    await waitFor(() => dave.room.state.scene?.id === sceneId);
  }, 60_000);
  afterAll(async () => {
    recordFrames(false);
    await t?.stop();
  });

  it("AC-DMP-05: DM notes — a scene's and a token's — reach the DMs and never a player's socket", async () => {
    // A goblin every player sees, with the DM's note on it; the scene's own notes.
    const { tokenId } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Goblin Zq",
      pos: { x: 20, y: 20 },
      stats: { hp: 7, hpMax: 7, ac: 15 },
    });
    await waitFor(() => dave.room.state.tokens?.get(tokenId));
    await rq(dm.room, "token.update", { tokenId, dmNote: "carries the Kx8 key" });
    await rq(dm.room, "scene.update", { sceneId, dmNotes: "the Wq3 trap is armed" });
    // The DMs: the token's note in its DM view, the scene's by asking — and pushed as it changes.
    await waitFor(() => dm.room.state.tokens.get(tokenId)?.dm?.secretNote === "carries the Kx8 key");
    expect(await rq<{ notes: string }>(dm.room, "scene.notes", { sceneId })).toEqual({
      sceneId,
      notes: "the Wq3 trap is armed",
    });
    await waitFor(() =>
      of<{ sceneId: string; notes: string }>(dm, "scene.notes").some(
        (n) => n.notes === "the Wq3 trap is armed",
      ),
    );
    // An undo is a change like any other: the DMs' copy follows it.
    await rq(dm.room, "history.undo", {});
    await waitFor(() => of<{ notes: string }>(dm, "scene.notes").at(-1)?.notes === "");
    await rq(dm.room, "history.redo", {});
    await waitFor(() => of<{ notes: string }>(dm, "scene.notes").at(-1)?.notes === "the Wq3 trap is armed");
    // A player: the goblin, but not its note; the scene, but not its notes — in state, in messages, in raw frames.
    await sleep(300);
    expect(dave.room.state.tokens.get(tokenId)?.name).toBe("Goblin Zq");
    expect(dave.room.state.tokens.get(tokenId)?.dm?.secretNote).toBeUndefined();
    await expect(rq(dave.room, "scene.notes", { sceneId })).rejects.toThrow(/FORBIDDEN/);
    for (const needle of ["Kx8", "Wq3"]) {
      expect(dave.socket.received(needle), needle).toBe(false);
      expect(JSON.stringify(dave.msgs), needle).not.toContain(needle);
    }
    expect(dm.socket.received("Kx8")).toBe(true);
    expect(dm.socket.received("Wq3")).toBe(true);
  });

  it('AC-DMP-03: Act as — the DM takes Dave\'s character; its commands, rolls and log entries read "DM as <character>", and Dave is told', async () => {
    const { actorId } = await rq<{ actorId: string }>(dave.room, "actor.create", {
      sheet: {
        core: {
          name: "Thorin",
          hp: { max: 12, current: 12 },
          ac: { value: 16 },
          speeds: { walk: 30 },
          abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
        },
      },
    });
    const { tokenId } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Thorin",
      pos: { x: 10, y: 10 },
      actorId,
      ownerIds: [dave.id],
      disposition: "party",
    });
    // Only a DM may act as someone, and only as a character.
    await expect(rq(dave.room, "act.as", { actorId })).rejects.toThrow(/FORBIDDEN/);
    const view = await rq<ActingAsView>(dm.room, "act.as", { actorId });
    expect(view).toMatchObject({ actorId, name: "Thorin" });
    // Dave hears that the DM has his character's controls.
    await waitFor(() =>
      of<ActingAsView>(dave, "act.as").some((v) => v.actorId === actorId && v.name === "Thorin"),
    );

    // A command while acting: its history entry records it.
    await rq(dm.room, "hp.apply", { targets: [tokenId], kind: "damage", amount: 3 });
    const list = await rq<HistoryListResult>(dm.room, "history.list", {});
    const hit = list.entries.find((e) => e.type === "hp.apply");
    expect(hit?.actingAs).toBe("Thorin");
    // A roll while acting: the character's, by its sheet (`@` answers from Thorin's), public to Dave, "DM as Thorin".
    const before = of<RollRecord>(dave, "roll.result").length;
    await rq(dm.room, "dice.roll", { formula: "1d20 + @str", visibility: "public" });
    const roll = await waitFor(() => of<RollRecord>(dave, "roll.result").slice(before)[0]);
    expect(roll).toMatchObject({ name: "Thorin", actingAs: "Thorin" });
    expect(roll.terms.find((x) => x.kind === "ref")).toMatchObject({ ref: "@str", value: 3 });
    // A log entry while acting.
    const entry = await rq<LogEntryView>(dm.room, "log.add", { text: "Thorin guards the door." });
    expect(entry.author).toMatch(/ as Thorin$/);

    // Let go: the next change is the DM's own again, and Dave hears that too.
    await rq(dm.room, "act.as", { actorId: null });
    await waitFor(() => of<ActingAsView>(dave, "act.as").at(-1)?.actorId === null);
    await rq(dm.room, "hp.apply", { targets: [tokenId], kind: "heal", amount: 3 });
    const after = await rq<HistoryListResult>(dm.room, "history.list", {});
    expect(after.entries.find((e) => e.type === "hp.apply" && e.id !== hit?.id)?.actingAs).toBeNull();
    const own = of<RollRecord>(dave, "roll.result").length;
    await rq(dm.room, "dice.roll", { formula: "1d20", visibility: "public" });
    const dmRoll = await waitFor(() => of<RollRecord>(dave, "roll.result").slice(own)[0]);
    expect(dmRoll.actingAs).toBeUndefined();
  });

  it("AC-DMP-02 (server): every per-token override takes effect — speed, free and locked movement, conditions' speed, reveal, HP display — and Exploration movement limits a move to its speed", async () => {
    const room = () =>
      t.server.ctx.rooms.tables.get(campaignId) as unknown as {
        model: { get: (k: string, id: string) => { pos: { x: number; y: number } } | undefined };
      };
    const pos = (id: string) => room().model.get("token", id)?.pos as { x: number; y: number };
    // (Paced: a player's moves are rate-limited.)
    const move = async (tokenId: string, dx: number) => {
      await sleep(400);
      const from = pos(tokenId);
      return rq(dave.room, "move.commit", { tokenId, points: [from, { x: from.x + dx, y: from.y }] });
    };
    const { tokenId: hero } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Wren",
      pos: { x: 7.5, y: 32.5 },
      ownerIds: [dave.id],
      disposition: "party",
      stats: { hp: 10, hpMax: 10, ac: 13, speeds: { walk: 30 } },
    });
    await waitFor(() => dave.room.state.tokens?.get(hero));
    // Exploration movement "Limited to speed per move" (§19.6): 35 ft in one move is refused at Speed 30…
    await rq(dm.room, "campaign.update", {
      houseRules: { explorationMovement: "limited", overlongMoves: "reject" },
    });
    await expect(move(hero, 35)).rejects.toThrow(/OVER_BUDGET/);
    // …a speed override of 40 lets it; free movement lifts the limit altogether.
    await rq(dm.room, "token.update", { tokenId: hero, overrides: { speedOverride: 40 } });
    await move(hero, 35);
    await rq(dm.room, "token.update", {
      tokenId: hero,
      overrides: { speedOverride: null, freeMovement: true },
    });
    await move(hero, -35);
    await rq(dm.room, "token.update", { tokenId: hero, overrides: { freeMovement: false } });
    await expect(move(hero, 35)).rejects.toThrow(/OVER_BUDGET/);
    await rq(dm.room, "campaign.update", {
      houseRules: { explorationMovement: "free", overlongMoves: "clamp" },
    });
    // Locked movement: its player can't move it.
    await rq(dm.room, "token.update", { tokenId: hero, overrides: { lockMovement: true } });
    await expect(move(hero, 5)).rejects.toThrow(/MOVEMENT_LOCKED/);
    await rq(dm.room, "token.update", { tokenId: hero, overrides: { lockMovement: false } });
    await move(hero, 5);
    // Grappled (Speed 0) refuses a move — unless conditions' speed is ignored.
    await rq(dm.room, "status.change", { tokenId: hero, add: [{ id: "grappled" }] });
    await expect(move(hero, 5)).rejects.toThrow(/SPEED_ZERO/);
    await rq(dm.room, "token.update", { tokenId: hero, overrides: { ignoreConditionSpeed: true } });
    await move(hero, 5);
    await rq(dm.room, "status.change", { tokenId: hero, remove: ["grappled"] });

    // Reveal and HP display: a goblin in a dark scene Dave's character can't see.
    await rq(dm.room, "scene.update", { sceneId, fogMode: "dynamic", ambientLevel: "dark" });
    const { tokenId: gob } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Lurking Goblin",
      pos: { x: 52.5, y: 7.5 },
      stats: { hp: 7, hpMax: 7, ac: 15 },
    });
    await sleep(300);
    expect(dave.room.state.tokens.get(gob)).toBeUndefined();
    await rq(dm.room, "token.update", { tokenId: gob, revealTo: "all" });
    await waitFor(() => dave.room.state.tokens.get(gob));
    // Shown, but its HP only as a bar — until the DM shows it exact.
    expect(dave.room.state.tokens.get(gob)?.hp).toBeUndefined();
    await rq(dm.room, "token.update", { tokenId: gob, hpDisplay: "exact" });
    await waitFor(() => dave.room.state.tokens.get(gob)?.hp?.hp === 7);
    await rq(dm.room, "token.update", { tokenId: gob, revealTo: [dave.id] });
    await sleep(200);
    expect(dave.room.state.tokens.get(gob)).toBeTruthy();
    await rq(dm.room, "token.update", { tokenId: gob, revealTo: "vision" });
    await waitFor(() => dave.room.state.tokens.get(gob) === undefined);
    await rq(dm.room, "scene.update", { sceneId, fogMode: "off", ambientLevel: "bright" });
  });
});
