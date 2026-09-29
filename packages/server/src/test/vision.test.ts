import { inflateSync } from "node:zlib";
import type { Room } from "@colyseus/sdk";
import { type P, pathLength } from "@gloam/shared/geometry";
import { Table, type TableState } from "@gloam/shared/state";
import { Raster, rleDecode } from "@gloam/shared/vision";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moveDurationMs } from "../engine/commands/move.ts";
import type { TableRoom } from "../rooms/TableRoom.ts";
import {
  EXPLORED_FLUSH_MS,
  type FogSnapshot,
  type MoveSeen,
  type VisionService,
} from "../vision/visionService.ts";
import {
  Agent,
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
  payload: Record<string, unknown>;
}
interface Player {
  room: TableRoomClient;
  id: string;
  msgs: Msg[];
  socket: ReturnType<typeof socketsSince>[number];
}
interface ViewAs {
  tokens: string[];
  sensed: { id: string; x: number; y: number }[];
  viewers: string[];
  fog: FogSnapshot | null;
}

/** The cells of a snapshot's explored memory. */
function explored(s: FogSnapshot | null): Raster {
  if (!s?.explored) throw new Error("no explored memory");
  return new Raster(s.x0, s.y0, s.cell, s.w, s.h, rleDecode(s.explored, s.w * s.h));
}
function layer(s: FogSnapshot | null, name: string): Raster {
  const l = s?.layers.find((x) => x.layer === name);
  if (!s || !l) throw new Error(`no layer ${name}`);
  return new Raster(s.x0, s.y0, s.cell, s.w, s.h, rleDecode(l.runs, s.w * s.h));
}

/**
 * The server vision service (SPEC §15.5, §15.6, §15.8): what each player's client receives in a dark hall with a door,
 * two players (Anna's elf with darkvision, Bob's human without) and a goblin.
 */
describe("P4 — vision, light and fog on the server (VIS)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  const dmMsgs: Msg[] = [];
  let anna: Player;
  let bob: Player;
  let sceneId = "";
  let elf = "";
  let human = "";
  let goblin = "";
  let door = "";

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const sees = (p: Player, id: string) => Boolean(p.room.state.tokens?.get?.(id));
  let lastMove = 0;
  const move = async (r: TableRoomClient, tokenId: string, points: P[]) => {
    const wait = lastMove + 220 - Date.now();
    if (wait > 0) await sleep(wait);
    lastMove = Date.now();
    return rq(r, "move.commit", { tokenId, points });
  };
  /** `door.toggle` at the protocol's pace (5/s); `lastDoor` is when it was actually sent. */
  let lastDoor = 0;
  const toggleDoor = async (action: "open" | "close") => {
    const wait = lastDoor + 220 - Date.now();
    if (wait > 0) await sleep(wait);
    lastDoor = Date.now();
    return rq(dm, "door.toggle", { wallId: door, action });
  };

  async function admit(name: string): Promise<Player> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const mark = socketCount();
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) =>
      msgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    return { room: r, id: p.userId, msgs, socket: socketsSince(mark).at(-1) as Player["socket"] };
  }

  beforeAll(async () => {
    recordFrames(true);
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) =>
      dmMsgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    anna = await admit("Anna");
    bob = await admit("Bob");
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Dark hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
        fogMode: "dynamic",
        ambient: "dark",
      })
    ).sceneId;
    // A room 0..40 × 0..40 with a 6-ft door in its east wall (y 17..23); a corridor beyond, to x = 60.
    const ids = (
      await rq<{ wallIds: string[] }>(dm, "wall.create", {
        sceneId,
        walls: [
          { a: { x: 0, y: 0 }, b: { x: 40, y: 0 }, kind: "wall" },
          { a: { x: 0, y: 40 }, b: { x: 40, y: 40 }, kind: "wall" },
          { a: { x: 0, y: 0 }, b: { x: 0, y: 40 }, kind: "wall" },
          { a: { x: 40, y: 0 }, b: { x: 40, y: 17 }, kind: "wall" },
          { a: { x: 40, y: 17 }, b: { x: 40, y: 23 }, kind: "door" },
          { a: { x: 40, y: 23 }, b: { x: 40, y: 40 }, kind: "wall" },
        ],
      })
    ).wallIds;
    door = ids[4] as string;
    elf = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Anna's Elf",
        pos: { x: 5, y: 15 },
        disposition: "party",
        ownerIds: [anna.id],
        stats: { hp: 20, hpMax: 20, ac: 14, senses: { darkvision: 60 } },
      })
    ).tokenId;
    human = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Bob's Human",
        pos: { x: 5, y: 25 },
        disposition: "party",
        ownerIds: [bob.id],
      })
    ).tokenId;
    goblin = (
      await rq<{ tokenId: string }>(dm, "token.create", { sceneId, name: "Goblin G7", pos: { x: 30, y: 20 } })
    ).tokenId;
    await rq(dm, "scene.activate", { sceneId });
    await waitFor(() => sees(anna, elf) && sees(bob, human));
    await sleep(200);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-VIS-05: in the dark room Anna's elf (darkvision) sees the goblin; Bob's human doesn't — his state and raw frames never hold it", async () => {
    expect(sees(anna, goblin)).toBe(true);
    expect(sees(bob, goblin)).toBe(false);
    expect(sees(bob, elf)).toBe(false); // Bob can't see Anna's elf in the dark either
    expect(bob.socket.received("Goblin G7")).toBe(false);
    expect(bob.socket.received(goblin)).toBe(false);
    // The DM holds everything.
    expect(Boolean(dm.state.tokens.get(goblin))).toBe(true);
  });

  it("AC-VIS-15 (server): Blinded, a creature gives no sight (blindsight still works); Unconscious, no perception at all", async () => {
    expect(sees(anna, goblin)).toBe(true);
    await rq(dm, "status.change", { tokenId: elf, add: [{ id: "blinded" }] });
    await waitFor(() => !sees(anna, goblin));
    // Blindsight 30 ft reaches the goblin (about 25 ft off) without eyes.
    await rq(dm, "token.update", { tokenId: elf, stats: { senses: { darkvision: 60, blindsight: 30 } } });
    await waitFor(() => sees(anna, goblin));
    // Unconscious: nothing at all, blindsight or not.
    await rq(dm, "status.change", { tokenId: elf, add: [{ id: "unconscious" }] });
    await waitFor(() => !sees(anna, goblin));
    await rq(dm, "status.change", { tokenId: elf, remove: ["blinded", "unconscious"] });
    await rq(dm, "token.update", { tokenId: elf, stats: { senses: { darkvision: 60, blindsight: 0 } } });
    await waitFor(() => sees(anna, goblin));
  });

  it("AC-VIS-03 (server): a torch Bob lights shows him the goblin 25 ft off; only its owners and the DM douse it", async () => {
    const mark = bob.socket.frames.length;
    const { lightId } = await rq<{ lightId: string }>(bob.room, "light.carry", {
      tokenId: human,
      preset: "torch",
    });
    await waitFor(() => sees(bob, goblin));
    const l = room().model.get("light", lightId as string);
    expect([l?.bright, l?.dim, l?.animation, l?.tokenId]).toEqual([20, 20, "torch", human]);
    await expect(rq(anna.room, "light.toggle", { lightId, enabled: false })).rejects.toThrow(/FORBIDDEN/);
    // Nor its owner while the DM has locked the token: its light is one of its controls, like moving it.
    await rq(dm, "token.update", { tokenId: human, locked: true });
    await expect(rq(bob.room, "light.toggle", { lightId, enabled: false })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(bob.room, "light.carry", { tokenId: human, preset: "candle" })).rejects.toThrow(
      /FORBIDDEN/,
    );
    // …not even by undoing his last step (lighting it) around the lock.
    await expect(rq(bob.room, "history.undo", {})).rejects.toThrow(/FORBIDDEN/);
    expect(room().model.get("light", lightId as string)?.enabled).toBe(true);
    await rq(dm, "token.update", { tokenId: human, locked: false });
    await rq(bob.room, "light.toggle", { lightId, enabled: false });
    await waitFor(() => !sees(bob, goblin));
    expect(bob.socket.receivedSince(mark, "Goblin G7")).toBe(true); // (he did see it by torchlight)
    // A light round a corner: Anna sees the glow of Bob's torch, which is carried by a token she can't see.
    await rq(bob.room, "light.toggle", { lightId, enabled: true });
    await waitFor(() => anna.room.state.lights?.get?.(lightId as string));
    await rq(bob.room, "light.carry", { tokenId: human, preset: null });
    await waitFor(() => !sees(bob, goblin));
  });

  it("AC-VIS-11 / AC-WAL-03 (vision): a goblin leaving Anna's sight is seen only to where it vanished, never at its destination; a door shuts it out within 200 ms", async () => {
    await toggleDoor("open");
    await sleep(150);
    // Out through the door and round the corner, behind the east wall.
    const before = anna.msgs.length;
    await move(dm, goblin, [
      { x: 30, y: 20 },
      { x: 45, y: 20 },
      { x: 55, y: 32 },
    ]);
    await waitFor(() => !sees(anna, goblin));
    const seen = anna.msgs.slice(before).find((m) => m.type === "token.moved")
      ?.payload as unknown as MoveSeen;
    expect(seen).toBeDefined();
    expect(seen.disappear).toBe(true);
    expect(seen.appear).toBe(false);
    const last = seen.path.at(-1) as P;
    expect(Math.hypot(last.x - 55, last.y - 32)).toBeGreaterThan(2);
    expect(seen.path[0]).toEqual({ x: 30, y: 20 });
    // Bob saw none of it: no move, no goblin.
    expect(bob.msgs.some((m) => m.type === "token.moved" && m.payload.id === goblin)).toBe(false);
    // Back into view: it appears partway, with its looks for her to draw it.
    const back = anna.msgs.length;
    await move(dm, goblin, [
      { x: 55, y: 32 },
      { x: 45, y: 20 },
    ]);
    await waitFor(() => sees(anna, goblin));
    const again = anna.msgs.slice(back).find((m) => m.type === "token.moved")?.payload as unknown as MoveSeen;
    expect(again.appear).toBe(true);
    expect(Math.hypot((again.path[0] as P).x - 55, (again.path[0] as P).y - 32)).toBeGreaterThan(2);
    // Timed by what she sees alone: no delay or pace that tells how far it came unseen.
    expect(again.delayMs).toBe(0);
    expect(again.durationMs).toBe(moveDurationMs(pathLength(again.path)));
    // Standing in the doorway's line of sight; shutting the door hides it, opening shows it again — fast.
    await toggleDoor("close");
    await waitFor(() => !sees(anna, goblin), 3000, 5);
    expect(Date.now() - lastDoor).toBeLessThan(200);
    await toggleDoor("open");
    await waitFor(() => sees(anna, goblin), 3000, 5);
    expect(Date.now() - lastDoor).toBeLessThan(200);
    await move(dm, goblin, [
      { x: 45, y: 20 },
      { x: 30, y: 20 },
    ]);
    await waitFor(() => room().model.get("token", goblin)?.pos.x === 30);
  });

  it("AC-VIS-11 (previews): a drag's preview reaches a player only as far as they'd see the token go, without its cost; a route longer than four crossings of the scene is refused, and clipping the longest one is quick", async () => {
    const previews = (p: Player, from: number) =>
      p.msgs
        .slice(from)
        .filter((m) => m.type === "move.preview" && m.payload.tokenId === goblin)
        .map((m) => m.payload as { points: P[]; cost: number });
    // Out through the door and round the corner: Anna sees the route to where the goblin would leave her sight.
    let a0 = anna.msgs.length;
    let b0 = bob.msgs.length;
    const out = [
      { x: 30, y: 20 },
      { x: 45, y: 20 },
      { x: 55, y: 32 },
    ];
    dm.send("move.preview", { tokenId: goblin, points: out, cost: 31 });
    await waitFor(() => previews(anna, a0).length === 1);
    const cut = previews(anna, a0)[0] as { points: P[]; cost: number };
    const end = cut.points.at(-1) as P;
    expect(Math.hypot(end.x - 55, end.y - 32)).toBeGreaterThan(2);
    expect(cut.points[0]).toEqual({ x: 30, y: 20 });
    expect(cut.cost).toBe(0);
    // Within her sight: the whole route, with its cost.
    await sleep(120);
    a0 = anna.msgs.length;
    dm.send("move.preview", { tokenId: goblin, points: [out[0], { x: 22, y: 26 }], cost: 10 });
    await waitFor(() => previews(anna, a0).length === 1);
    expect(previews(anna, a0)[0]).toMatchObject({ points: [out[0], { x: 22, y: 26 }], cost: 10 });
    // Bob, who doesn't see the goblin, gets none of it.
    await sleep(150);
    expect(previews(bob, b0)).toEqual([]);
    b0 = bob.msgs.length;
    // Longer than four crossings of the 60 × 40 scene (4 × 72 ft): refused, even for the DM.
    const zigzag = [{ x: 30, y: 20 }];
    for (let i = 0; i < 5; i++) zigzag.push(i % 2 ? { x: 1, y: 1 } : { x: 59, y: 39 });
    await expect(move(dm, goblin, zigzag)).rejects.toThrow(/too long/);
    // Just inside the limit, the per-foot clipping for a player stays quick.
    const legal = [{ x: 30, y: 20 }];
    for (let i = 0; legal.length < 40 && pathLength(legal) < 280; i++)
      legal.push(i % 2 ? { x: 2, y: 20 } : { x: 38, y: 20 });
    const vision = (room() as unknown as { vision: VisionService }).vision;
    const t0 = performance.now();
    vision.clipMove(bob.id, goblin, legal, 2000);
    vision.clipMove(anna.id, goblin, legal, 2000);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("AC-SEC-07 / §13.4 (glows): a torch round the corner reaches a player as their own stand-in — another id each time, no carrier, to the foot, no height — and a DM-hidden carrier's light not at all", async () => {
    type LightState = { id: string; x: number; y: number; elevation: number; link?: { tokenId: string } };
    const lightsOf = (p: Player) => [...((p.room.state.lights?.values?.() ?? []) as Iterable<LightState>)];
    const mark = anna.socket.frames.length;
    // A goblin with a torch in the corridor, north of the doorway: out of Anna's sight, its light into it.
    const lurker = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Torch Goblin",
        pos: { x: 58, y: 5 },
      })
    ).tokenId;
    const { lightId } = await rq<{ lightId: string }>(dm, "light.carry", {
      tokenId: lurker,
      preset: "torch",
    });
    const glow = async () => {
      await waitFor(() => lightsOf(anna).some((l) => l.id !== lightId && !l.link?.tokenId && l.x === 58));
      return lightsOf(anna).find((l) => l.x === 58 && l.y === 5) as LightState;
    };
    const g1 = await glow();
    expect(sees(anna, lurker)).toBe(false);
    expect(g1.id).not.toBe(lightId);
    expect(g1.elevation).toBe(0); // no height: the circle it lights on the table
    expect(lightsOf(anna).some((l) => l.id === lightId)).toBe(false);
    for (const needle of [lightId as string, lurker, "Torch Goblin"])
      expect(anna.socket.receivedSince(mark, needle)).toBe(false);
    // Into her sight: the light itself, with its carrier; the stand-in goes.
    await move(dm, lurker, [
      { x: 58, y: 5 },
      { x: 52, y: 21 },
    ]);
    await waitFor(() => sees(anna, lurker) && lightsOf(anna).some((l) => l.id === lightId));
    await waitFor(() => !lightsOf(anna).some((l) => l.id === g1.id));
    expect(lightsOf(anna).find((l) => l.id === lightId)?.link?.tokenId).toBe(lurker);
    // Out again: a new stand-in, not the old one — nothing ties it to the light she saw carried.
    await move(dm, lurker, [
      { x: 52, y: 21 },
      { x: 58, y: 5 },
    ]);
    const g2 = await glow();
    expect(g2.id).not.toBe(g1.id);
    expect(g2.id).not.toBe(lightId);
    await waitFor(() => !lightsOf(anna).some((l) => l.id === lightId));
    // Hidden by the DM: its light is the DM's too — no glow for anyone.
    await rq(dm, "token.update", { tokenId: lurker, hidden: true });
    await waitFor(() => !lightsOf(anna).some((l) => l.x === 58 && l.y === 5));
    await rq(dm, "token.delete", { tokenIds: [lurker] });
  });

  it("AC-VIS-09 (server): tremorsense gives a sensed marker — an opaque id and a position to 1 ft, nothing else — for grounded creatures only", async () => {
    const mark = bob.socket.frames.length;
    await rq(dm, "token.update", { tokenId: human, stats: { senses: { tremorsense: 60 } } });
    // Both creatures on the ground within 60 ft that he can't see: the goblin and Anna's elf.
    await waitFor(() => (bob.room.state.sensed?.size ?? 0) === 2);
    const marks = [...bob.room.state.sensed.values()].map((m) => [m.pos.x, m.pos.y]);
    expect(marks.sort()).toEqual([
      [30, 20],
      [5, 15],
    ]);
    for (const m of bob.room.state.sensed.values()) {
      expect(m.id).not.toContain(goblin);
      expect(m.id).not.toContain(elf);
    }
    expect(sees(bob, goblin)).toBe(false);
    for (const needle of ["Goblin G7", goblin, "Anna's Elf", elf])
      expect(bob.socket.receivedSince(mark, needle)).toBe(false);
    // Anna, who sees it, holds no marker; the DM none either.
    expect(anna.room.state.sensed?.size ?? 0).toBe(0);
    expect(dm.state.sensed?.size ?? 0).toBe(0);
    // Off the ground: nothing to feel.
    await rq(dm, "token.elevation", { tokenId: goblin, elevation: 10 });
    await waitFor(() => (bob.room.state.sensed?.size ?? 0) === 1);
    await rq(dm, "token.elevation", { tokenId: goblin, elevation: 0 });
    await waitFor(() => (bob.room.state.sensed?.size ?? 0) === 2);
    await rq(dm, "token.update", { tokenId: human, stats: { senses: { tremorsense: 0 } } });
    await waitFor(() => (bob.room.state.sensed?.size ?? 0) === 0);
  });

  it("AC-VIS-13 (server): vision sharing is off by default; the DM shares a token's vision with a player, or turns on party vision", async () => {
    expect(sees(bob, goblin)).toBe(false);
    await rq(dm, "token.update", { tokenId: elf, shareVisionWith: [bob.id] });
    await waitFor(() => sees(bob, goblin) && sees(bob, elf));
    await rq(dm, "token.update", { tokenId: elf, shareVisionWith: [] });
    await waitFor(() => !sees(bob, goblin));
    await rq(dm, "campaign.update", { settings: { partyVision: true } });
    await waitFor(() => sees(bob, goblin));
    await rq(dm, "campaign.update", { settings: { partyVision: false } });
    await waitFor(() => !sees(bob, goblin));
  });

  it("AC-SCN-07 (server): ambient light and fog mode apply to every client at once", async () => {
    let t0 = Date.now();
    await rq(dm, "scene.update", { sceneId, ambientLevel: "bright" });
    await waitFor(() => sees(bob, goblin));
    expect(Date.now() - t0).toBeLessThan(500);
    await rq(dm, "scene.update", { sceneId, ambientLevel: "dark" });
    await waitFor(() => !sees(bob, goblin));
    t0 = Date.now();
    await rq(dm, "scene.update", { sceneId, fogMode: "off" });
    await waitFor(() => sees(bob, goblin));
    expect(Date.now() - t0).toBeLessThan(500);
    await rq(dm, "scene.update", { sceneId, fogMode: "dynamic" });
    await waitFor(() => !sees(bob, goblin));
  });

  it("AC-VIS-10 (server): View as returns what a player holds, and changes nothing for anyone", async () => {
    const tokensBefore = [...bob.room.state.tokens.keys()].sort();
    const v = await rq<ViewAs>(dm, "vision.viewAs", { userId: bob.id });
    expect(v.tokens.sort()).toEqual(tokensBefore);
    expect(v.tokens).not.toContain(goblin);
    expect(v.viewers).toEqual([human]);
    const a = await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id });
    expect(a.tokens).toContain(goblin);
    expect(Boolean(dm.state.tokens.get(goblin))).toBe(true);
    await sleep(100);
    expect([...bob.room.state.tokens.keys()].sort()).toEqual(tokensBefore);
    await expect(rq(bob.room, "vision.viewAs", { userId: anna.id })).rejects.toThrow(/FORBIDDEN/);
  });

  it("AC-VIS-01 (server): painted fog — reveal and hide for everyone or one player, reveal room, players get only their layers; undo puts it back", async () => {
    await rq(dm, "scene.update", { sceneId, fogMode: "painted" });
    await waitFor(() => !sees(anna, goblin));
    expect(sees(anna, elf)).toBe(true); // her own token always
    const annaMsgs = anna.msgs.length;
    const bobMsgs = bob.msgs.length;
    await rq(dm, "fog.paint", {
      sceneId,
      mode: "reveal",
      target: "all",
      shape: { kind: "rect", x: 25, y: 15, w: 10, h: 10 },
    });
    await waitFor(() => sees(anna, goblin) && sees(bob, goblin));
    expect(
      anna.msgs.slice(annaMsgs).some((m) => m.type === "fog.patch" && m.payload.layer === "reveal:all"),
    ).toBe(true);
    await rq(dm, "fog.paint", { sceneId, mode: "hide", target: "all", shape: { kind: "all" } });
    await waitFor(() => !sees(anna, goblin) && !sees(bob, goblin));
    // For Bob only: Anna gets neither the goblin nor Bob's layer.
    await rq(dm, "fog.paint", {
      sceneId,
      mode: "reveal",
      target: bob.id,
      shape: {
        kind: "brush",
        points: [
          { x: 28, y: 20 },
          { x: 32, y: 20 },
        ],
        radius: 4,
      },
    });
    await waitFor(() => sees(bob, goblin));
    await sleep(100);
    expect(sees(anna, goblin)).toBe(false);
    expect(
      anna.msgs.slice(annaMsgs).some((m) => m.type === "fog.patch" && m.payload.layer === `reveal:${bob.id}`),
    ).toBe(false);
    expect(
      bob.msgs.slice(bobMsgs).some((m) => m.type === "fog.patch" && m.payload.layer === `reveal:${bob.id}`),
    ).toBe(true);
    // Reveal room: the walled hall under the point, not the corridor beyond its (shut) door.
    await toggleDoor("close");
    await rq(dm, "fog.paint", {
      sceneId,
      mode: "reveal",
      target: "all",
      shape: { kind: "room", x: 20, y: 30 },
    });
    const snap = await rq<FogSnapshot>(anna.room, "fog.snapshot", {});
    const all = layer(snap, "reveal:all");
    expect([all.at(1, 1), all.at(39, 39), all.at(20, 20)]).toEqual([1, 1, 1]);
    expect([all.at(45, 20), all.at(55, 5)]).toEqual([0, 0]);
    // Anna's snapshot holds no one else's layer.
    expect(snap.layers.map((l) => l.layer).sort()).toEqual(["reveal:all", `reveal:${anna.id}`]);
    await waitFor(() => sees(anna, goblin));
    // Undo (the DM's last command: the room) hides it from Anna again.
    await rq(dm, "history.undo", {});
    await waitFor(() => !sees(anna, goblin));
    expect(layer(await rq<FogSnapshot>(anna.room, "fog.snapshot", {}), "reveal:all").at(20, 20)).toBe(0);
    await rq(dm, "scene.update", { sceneId, fogMode: "dynamic" });
    await toggleDoor("open");
    await waitFor(() => sees(anna, goblin));
  });

  it("AC-VIS-14 (server): explored memory is kept per player and scene across a restart; the DM resets it for one player or everyone", async () => {
    // Bob lights a torch for a moment so he explores a little too.
    await rq(bob.room, "light.carry", { tokenId: human, preset: "torch" });
    await waitFor(() => sees(bob, goblin));
    await rq(bob.room, "light.carry", { tokenId: human, preset: null });
    const a0 = explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog);
    expect([a0.at(5, 15), a0.at(35, 35), a0.at(50, 20)]).toEqual([1, 1, 1]); // through the open door
    expect(a0.at(55, 5)).toBe(0); // round the corner
    // The player's own snapshot says the same.
    expect(explored(await rq<FogSnapshot>(anna.room, "fog.snapshot", {})).data).toEqual(a0.data);
    // Close the table and restart the server on the same data.
    await admin.post("/api/admin/table/close");
    await t.stop({ keepData: true });
    t = await startTestServer({ dataDir: t.dataDir });
    const admin2 = new Agent(t.url);
    for (const [k, v] of admin.cookies) admin2.cookies.set(k, v);
    admin = admin2;
    await openTable(admin, "local");
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const a1 = explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog);
    expect(a1.data).toEqual(a0.data);
    const b1 = explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: bob.id })).fog);
    expect(b1.at(5, 25)).toBe(1);
    // Reset Anna's with the door shut: the corridor she saw through it is forgotten; the hall she stands in is in
    // sight, so it's explored again at once. Bob's stays. Then everyone's (Bob, in the dark, keeps nothing).
    await rq(dm, "door.toggle", { wallId: door, action: "close" });
    await rq(dm, "fog.resetExplored", { sceneId, userId: anna.id });
    const a2 = explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog);
    expect([a2.at(50, 20), a2.at(20, 20)]).toEqual([0, 1]);
    expect(explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: bob.id })).fog).at(5, 25)).toBe(1);
    await rq(dm, "fog.resetExplored", { sceneId });
    expect(explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: bob.id })).fog).any()).toBe(false);
    expect(explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog).at(50, 20)).toBe(0);
    // And that is kept too.
    await admin.post("/api/admin/table/close");
    await t.stop({ keepData: true });
    t = await startTestServer({ dataDir: t.dataDir });
    const admin3 = new Agent(t.url);
    for (const [k, v] of admin.cookies) admin3.cookies.set(k, v);
    admin = admin3;
    await openTable(admin, "local");
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    expect(explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: bob.id })).fog).any()).toBe(false);
    expect(explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog).at(50, 20)).toBe(0);
  });

  it("AC-PER-02 (explored memory): what a player sees is on disk within 5 s with nothing closed or flushed — a crash loses at most the last 5 s", async () => {
    // Straight from the database, as a restarted server would read it after a SIGKILL.
    const onDisk = () => {
      const row = t.server.ctx.sqlite
        .prepare(
          "SELECT origin_x AS x0, origin_y AS y0, cell_ft AS cell, w, h, data FROM fog_masks WHERE scene_id = ? AND layer = ?",
        )
        .get(sceneId, `explored:${anna.id}`) as
        | { x0: number; y0: number; cell: number; w: number; h: number; data: Buffer }
        | undefined;
      return row
        ? new Raster(row.x0, row.y0, row.cell, row.w, row.h, new Uint8Array(inflateSync(row.data)))
        : null;
    };
    expect(onDisk()?.at(50, 20) ?? 0).toBe(0);
    // The door opens: Anna sees down the corridor again.
    await toggleDoor("open");
    const t0 = Date.now();
    while (explored((await rq<ViewAs>(dm, "vision.viewAs", { userId: anna.id })).fog).at(50, 20) !== 1) {
      if (Date.now() - t0 > 3000) throw new Error("Anna never saw the corridor");
      await sleep(20);
    }
    const seenAt = Date.now();
    await waitFor(() => onDisk()?.at(50, 20) === 1, EXPLORED_FLUSH_MS + 2000);
    // (The AC's 5 s, not the constant's: raising the interval fails here.)
    expect(Date.now() - seenAt).toBeLessThanOrEqual(5000 + 250);
  });
});
