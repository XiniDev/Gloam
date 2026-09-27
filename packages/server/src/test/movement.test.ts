import type { Room } from "@colyseus/sdk";
import type { P } from "@gloam/shared/geometry";
import { buildMoveWorld, clearanceRadius, pathCost, route } from "@gloam/shared/movement";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Agent,
  createCampaign,
  joinAsNew,
  openTable,
  rq,
  setupAdmin,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;
interface Msg {
  type: string;
  payload: Record<string, unknown>;
}
interface MoveResult {
  points: P[];
  cost: number;
  bumped: boolean;
  unseen: boolean;
  durationMs: number;
}

/**
 * Server movement (SPEC §8.6, §16.5; AC-MOV-08, AC-MOV-13 server side): `move.commit` validates a controller's path
 * against the true obstacles and moves the token; everyone who can see it animates the committed path;
 * `move.preview` relays drags to the other viewers.
 */
describe("P3 — movement on the server (MOV)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let dm: TableRoomClient;
  const players: { room: TableRoomClient; id: string; msgs: Msg[] }[] = [];
  const dmMsgs: Msg[] = [];
  let sceneId = "";
  let rogue = "";
  const walls: Record<string, string> = {};

  async function admit(code: string, name: string) {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const room = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    room.onMessage("*", (type, payload) =>
      msgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    return { room, id: p.userId, msgs };
  }
  /** `move.commit` at the protocol's pace (5/s per user; §13.5). */
  let lastMove = 0;
  const commit = async <T = MoveResult>(room: TableRoomClient, payload: unknown): Promise<T> => {
    const wait = lastMove + 210 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastMove = Date.now();
    return rq<T>(room, "move.commit", payload);
  };
  /** `door.toggle` at the protocol's pace (5/s per user), so no answer below is a rate limit's. */
  let lastDoor = 0;
  const door = async <T = { doorState: string }>(room: TableRoomClient, payload: unknown): Promise<T> => {
    const wait = lastDoor + 210 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastDoor = Date.now();
    return rq<T>(room, "door.toggle", payload);
  };
  const tokenPos = () => t.server.ctx.rooms.tables.get(campaignId)?.model.get("token", rogue)?.pos as P;
  const dave = () => players[0] as (typeof players)[number];
  const eve = () => players[1] as (typeof players)[number];

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    const code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) =>
      dmMsgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    players.push(await admit(code, "Dave"), await admit(code, "Eve"));
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Crypt",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 100,
        heightFt: 100,
      })
    ).sceneId;
    await rq(dm, "scene.activate", { sceneId });
    rogue = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Dave's Rogue",
        pos: { x: 20, y: 50 },
        disposition: "party",
        ownerIds: [dave().id],
      })
    ).tokenId;
    // A visible wall across x = 50 (gap at the north end), a hidden wall across x = 30 near y = 30…40, and a door.
    const ids = (
      await rq<{ wallIds: string[] }>(dm, "wall.create", {
        sceneId,
        walls: [
          { a: { x: 50, y: 20 }, b: { x: 50, y: 100 }, kind: "wall" },
          { a: { x: 30, y: 25 }, b: { x: 30, y: 45 }, kind: "wall", hidden: true },
          { a: { x: 70, y: 0 }, b: { x: 70, y: 45 }, kind: "wall" },
          { a: { x: 70, y: 45 }, b: { x: 70, y: 55 }, kind: "door" },
          { a: { x: 70, y: 55 }, b: { x: 70, y: 100 }, kind: "wall" },
        ],
      })
    ).wallIds;
    const [long, hidden, north, door, south] = ids as [string, string, string, string, string];
    Object.assign(walls, { long, hidden, north, door, south });
    await waitFor(() => dave().room.state.tokens?.get?.(rogue) && dave().room.state.walls?.size === 5);
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** The world as Dave's browser knows it: the walls in his view (a hidden wall comes only as a sight occluder). */
  const daveWorld = () =>
    buildMoveWorld({
      walls: [...(dave().room.state.walls?.values?.() ?? [])].map((w) => ({
        id: w.id,
        a: { x: w.ax, y: w.ay },
        b: { x: w.bx, y: w.by },
        kind: w.kind,
        doorState: (w.door || null) as never,
      })),
      zones: [],
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    });
  const rc = clearanceRadius(5);

  it("AC-MOV-08: a routed move around the walls the player knows is accepted as previewed, and every viewer animates it", async () => {
    // The hidden wall reaches him only as an anonymous sight occluder, which doesn't block movement.
    const kinds = [...dave().room.state.walls.values()].map((w) => w.kind).sort();
    expect(kinds).toEqual(["door", "occluder", "wall", "wall", "wall"]);
    const preview = route(daveWorld(), tokenPos(), { x: 40, y: 60 }, [], { rc }) as {
      points: P[];
      cost: number;
    };
    const r = await commit(dave().room, { tokenId: rogue, points: preview.points });
    expect(r.bumped).toBe(false);
    expect(Math.abs(r.cost - preview.cost)).toBeLessThanOrEqual(0.05);
    expect(tokenPos()).toEqual({ x: 40, y: 60 });
    // 30 ft/s, at least 250 ms, at most 2 s.
    expect(r.durationMs).toBe(Math.round(Math.min(2000, Math.max(250, (r.cost / 30) * 1000))));
    for (const msgs of [dmMsgs, dave().msgs, eve().msgs]) {
      const m = await waitFor(() => msgs.find((x) => x.type === "token.moved" && x.payload.id === rogue));
      expect(m.payload.path).toEqual(r.points);
      expect(m.payload.durationMs).toBe(r.durationMs);
    }
  });

  it("AC-MOV-08: a path through a wall the player couldn't see stops at the contact point with the 'unseen' toast", async () => {
    // Back to the start (DM), then straight west→east through the hidden wall at x = 30.
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 20, y: 35 }] });
    dave().msgs.length = 0;
    const r = await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 20, y: 35 },
        { x: 40, y: 35 },
      ],
    });
    expect(r.bumped).toBe(true);
    expect(r.unseen).toBe(true);
    // Stopped where its clearance circle touches the wall (within the server's 0.01-ft graze tolerance).
    expect(tokenPos().x).toBeCloseTo(30 - rc + 0.01, 6);
    const toast = await waitFor(() => dave().msgs.find((m) => m.type === "toast"));
    expect(toast.payload.message).toBe("You bump into something unseen.");
    expect(eve().msgs.find((m) => m.type === "toast")).toBeUndefined();
  });

  it("AC-MOV-08 / AC-MOV-14: a freehand line through a wall the player can see is truncated too — without the toast", async () => {
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 40, y: 60 }] });
    dave().msgs.length = 0;
    const r = await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 40, y: 60 },
        { x: 60, y: 60 },
      ],
    });
    expect(r.bumped).toBe(true);
    expect(r.unseen).toBe(false);
    expect(tokenPos().x).toBeCloseTo(50 - rc + 0.01, 6);
    await new Promise((res) => setTimeout(res, 150));
    expect(dave().msgs.find((m) => m.type === "toast")).toBeUndefined();
  });

  it("the DM moves ignore blocking (SPEC §8.6 DM moves)", async () => {
    const from = tokenPos();
    const r = await commit(dm, { tokenId: rogue, points: [from, { x: 60, y: 30 }] });
    expect(r.bumped).toBe(false);
    expect(tokenPos()).toEqual({ x: 60, y: 30 });
  });

  it("doors: shut they block like walls, open they don't — and the server's world follows the change at once", async () => {
    // From (60, 50) east through the door at x = 70.
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 60, y: 50 }] });
    const through = {
      tokenId: rogue,
      points: [
        { x: 60, y: 50 },
        { x: 80, y: 50 },
      ],
    };
    const shut = await commit(dave().room, through);
    expect(shut.bumped).toBe(true);
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 60, y: 50 }] });
    await rq(dm, "wall.update", { wallId: walls.door, doorState: "open" });
    const open = await commit(dave().room, through);
    expect(open.bumped).toBe(false);
    expect(tokenPos()).toEqual({ x: 80, y: 50 });
    await rq(dm, "wall.update", { wallId: walls.door, doorState: "closed" });
  });

  it("difficult terrain doubles the part of the path inside it, priced by the server (AC-MOV-03 server)", async () => {
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 80, y: 10 }] });
    await rq(dm, "zone.create", {
      sceneId,
      kind: "difficult",
      shape: { kind: "rect", x: 85, y: 0, w: 10, h: 20 },
      label: "Rubble",
    });
    const world = buildMoveWorld({
      walls: [],
      zones: [{ id: "z", kind: "difficult", shape: { kind: "rect", x: 85, y: 0, w: 10, h: 20 } }],
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    });
    const expected = pathCost(
      world,
      [
        { x: 80, y: 10 },
        { x: 99, y: 10 },
      ],
      {},
    ).cost;
    expect(expected).toBeCloseTo(29, 9);
    const r = await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 80, y: 10 },
        { x: 99, y: 10 },
      ],
    });
    expect(r.cost).toBeCloseTo(expected, 6);
  });

  it("only a token's controllers move it; a locked token or locked movement refuses players; bad paths are rejected", async () => {
    const here = tokenPos();
    const step = { tokenId: rogue, points: [here, { x: here.x - 5, y: here.y }] };
    await expect(commit(eve().room, step)).rejects.toThrow(/FORBIDDEN/);
    await rq(dm, "token.update", { tokenId: rogue, locked: true });
    await expect(commit(dave().room, step)).rejects.toThrow(/MOVEMENT_LOCKED/);
    await rq(dm, "token.update", { tokenId: rogue, locked: false });
    // Not from where the token stands; out of the scene; mismatched elevations.
    await expect(
      commit(dave().room, { tokenId: rogue, points: [{ x: here.x - 3, y: here.y }, here] }),
    ).rejects.toThrow(/INVALID .*start/);
    await expect(
      commit(dave().room, { tokenId: rogue, points: [here, { x: 120, y: here.y }] }),
    ).rejects.toThrow(/INVALID .*leaves the scene/);
    await expect(
      commit(dave().room, {
        tokenId: rogue,
        points: [here, { x: here.x - 5, y: here.y }],
        elevations: [0],
      }),
    ).rejects.toThrow(/INVALID/);
    // Oversized paths never reach the planner.
    const many = Array.from({ length: 300 }, (_, i) => ({ x: here.x, y: here.y + (i % 2) * 0.1 }));
    await expect(commit(dave().room, { tokenId: rogue, points: many })).rejects.toThrow(/INVALID/);
  });

  it("Ctrl/Cmd+Z undoes the player's last move (the token returns)", async () => {
    const before = tokenPos();
    await commit(dave().room, {
      tokenId: rogue,
      points: [before, { x: before.x - 5, y: before.y }],
    });
    expect(tokenPos().x).toBeCloseTo(before.x - 5, 9);
    await rq(dave().room, "history.undo", {});
    expect(tokenPos()).toEqual(before);
  });

  it("AC-MOV-13 (server): drags are relayed to everyone else who can see the token, never to those who can't", async () => {
    dmMsgs.length = 0;
    eve().msgs.length = 0;
    dave().msgs.length = 0;
    const here = tokenPos();
    dave().room.send("move.preview", {
      tokenId: rogue,
      points: [here, { x: here.x - 8, y: here.y }],
      cost: 8,
    });
    const got = await waitFor(() => dmMsgs.find((m) => m.type === "move.preview"));
    expect(got.payload).toMatchObject({ tokenId: rogue, cost: 8, by: dave().id });
    await waitFor(() => eve().msgs.find((m) => m.type === "move.preview"));
    expect(dave().msgs.find((m) => m.type === "move.preview")).toBeUndefined();
    // Eve can't preview someone else's token.
    eve().room.send("move.preview", { tokenId: rogue, points: [], cost: 0 });
    // A token hidden by the DM: its moves reach DMs only.
    await rq(dm, "token.update", { tokenId: rogue, hidden: true });
    dmMsgs.length = 0;
    eve().msgs.length = 0;
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 15, y: 15 }] });
    await waitFor(() => dmMsgs.find((m) => m.type === "token.moved"));
    await new Promise((res) => setTimeout(res, 150));
    expect(eve().msgs.find((m) => m.type === "token.moved" || m.type === "move.preview")).toBeUndefined();
    await rq(dm, "token.update", { tokenId: rogue, hidden: false });
  });

  it("AC-WAL-03: players open and close unlocked doors within 5 ft of their token; locked doors refuse them; DMs work any door", async () => {
    // Dave's rogue far from the door at x = 70, y 45..55.
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 40, y: 50 }] });
    await expect(door(dave().room, { wallId: walls.door })).rejects.toThrow(/FORBIDDEN .*within 5 ft/);
    // Base edge within 5 ft: centre 2.5 + 5 = 7.5 ft from the door line.
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 62.6, y: 50 }] });
    expect(await door(dave().room, { wallId: walls.door })).toEqual({ doorState: "open" });
    expect(await door(dave().room, { wallId: walls.door, action: "close" })).toEqual({
      doorState: "closed",
    });
    // Players can't lock; the DM can, from anywhere; then players are refused with "It's locked".
    await expect(door(dave().room, { wallId: walls.door, action: "lock" })).rejects.toThrow(/FORBIDDEN .*DM/);
    expect(await door(dm, { wallId: walls.door, action: "lock" })).toEqual({
      doorState: "locked",
    });
    await expect(door(dave().room, { wallId: walls.door })).rejects.toThrow(/BLOCKED .*locked/);
    expect(await door(dm, { wallId: walls.door, action: "unlock" })).toEqual({
      doorState: "closed",
    });
    // Eve has no token near the door.
    await expect(door(eve().room, { wallId: walls.door })).rejects.toThrow(/FORBIDDEN/);
    // A plain wall isn't a door.
    await expect(door(dave().room, { wallId: walls.north })).rejects.toThrow(/isn't a door/);
  });

  it("AC-WAL-04: a secret door is a wall in players' state — same kind, no door state — and answers like one", async () => {
    const [secret] = (
      await rq<{ wallIds: string[] }>(dm, "wall.create", {
        sceneId,
        walls: [{ a: { x: 62, y: 60 }, b: { x: 62, y: 70 }, kind: "secret" }],
      })
    ).wallIds as [string];
    const plain = await waitFor(() => dave().room.state.walls.get(walls.north as string));
    const seen = await waitFor(() => dave().room.state.walls.get(secret));
    expect(seen.kind).toBe(plain.kind);
    expect(seen.door).toBe(plain.door);
    expect(seen.dmKind).toBe(plain.dmKind);
    // The DM sees what it is.
    const dmSeen = await waitFor(() => dm.state.walls.get(secret));
    expect(dmSeen.dmKind || dmSeen.kind).toBe("secret");
    // Trying it gets a wall's answer, word for word.
    const asWall = await door(dave().room, { wallId: walls.north }).catch((e: Error) => e.message);
    const asSecret = await door(dave().room, { wallId: secret }).catch((e: Error) => e.message);
    expect(asWall).toMatch(/isn't a door/);
    expect(asSecret).toBe(asWall);
    // The DM can open it (and it then lets bodies through on the server) — which reveals it: the gap is real, so
    // players' state says "open door", and a player may answer it as a door.
    expect(await door(dm, { wallId: secret })).toEqual({ doorState: "open" });
    await waitFor(() => (dave().room.state.walls.get(secret)?.door === "open" ? true : undefined));
    expect(dave().room.state.walls.get(secret)?.kind).toBe("door");
    expect(dave().room.state.walls.get(secret)?.dmKind).toBe(plain.dmKind);
    const asOpen = await door(dave().room, { wallId: secret }).catch((e: Error) => e.message);
    expect(asOpen).toMatch(/within 5 ft/); // a door's answer now: Dave's rogue is too far away to shut it
    // Shut again, it is a wall again, to the letter.
    expect(await door(dm, { wallId: secret, action: "close" })).toEqual({ doorState: "closed" });
    await waitFor(() => (dave().room.state.walls.get(secret)?.kind === plain.kind ? true : undefined));
    const again = dave().room.state.walls.get(secret);
    expect([again?.kind, again?.door, again?.dmKind, again?.dmDoor]).toEqual([
      plain.kind,
      plain.door,
      plain.dmKind,
      plain.dmDoor,
    ]);
  });

  it("AC-WAL-05: zones — impassable blocks like a wall, water doubles for non-swimmers, invisible zones stay out of players' state", async () => {
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 10, y: 80 }] });
    const pit = (
      await rq<{ zoneId: string }>(dm, "zone.create", {
        sceneId,
        kind: "impassable",
        shape: { kind: "circle", x: 20, y: 80, r: 4 },
        label: "Pit",
        visible: false,
      })
    ).zoneId;
    const through = await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 10, y: 80 },
        { x: 30, y: 80 },
      ],
    });
    expect(through.bumped).toBe(true);
    // Hidden from players, so: the unseen toast.
    expect(through.unseen).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    expect(dave().room.state.zones?.get?.(pit)).toBeUndefined();
    expect(dm.state.zones.get(pit)).toBeDefined();
    await rq(dm, "zone.update", { zoneId: pit, visible: true });
    await waitFor(() => dave().room.state.zones?.get?.(pit));
    await rq(dm, "zone.delete", { zoneIds: [pit] });
    await waitFor(() => !dave().room.state.zones?.get?.(pit));
    // Water: double cost without a swim speed.
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 10, y: 90 }] });
    await rq(dm, "zone.create", {
      sceneId,
      kind: "water",
      shape: { kind: "rect", x: 12, y: 85, w: 10, h: 10 },
    });
    const wade = await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 10, y: 90 },
        { x: 24, y: 90 },
      ],
    });
    expect(wade.cost).toBeCloseTo(14 + 10, 6);
    // Zone payloads are validated: a two-point polygon is refused.
    await expect(
      rq(dm, "zone.create", {
        sceneId,
        kind: "difficult",
        shape: {
          kind: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).rejects.toThrow(/INVALID/);
  });

  it("AC-WAL-05: walking into a hazard prompts the DM (never the player) with the trigger's save and damage", async () => {
    await commit(dm, { tokenId: rogue, points: [tokenPos(), { x: 80, y: 80 }] });
    await rq(dm, "zone.create", {
      sceneId,
      kind: "hazard",
      label: "Burning floor",
      shape: { kind: "rect", x: 84, y: 76, w: 8, h: 8 },
      triggers: [
        {
          when: "enter",
          label: "Flames lick at you",
          save: { ability: "dex", dc: 12, onSuccess: "half" },
          damage: { formula: "1d4", type: "fire" },
        },
      ],
    });
    dmMsgs.length = 0;
    dave().msgs.length = 0;
    // Passing beside it: no prompt.
    await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 80, y: 80 },
        { x: 80, y: 95 },
      ],
    });
    await new Promise((res) => setTimeout(res, 150));
    expect(dmMsgs.find((m) => m.type === "hazard.prompt")).toBeUndefined();
    // Into it.
    await commit(dave().room, {
      tokenId: rogue,
      points: [
        { x: 80, y: 95 },
        { x: 88, y: 80 },
      ],
    });
    const prompt = await waitFor(() => dmMsgs.find((m) => m.type === "hazard.prompt"));
    expect(prompt.payload).toMatchObject({
      tokenId: rogue,
      tokenName: "Dave's Rogue",
      prompts: [
        {
          zoneLabel: "Burning floor",
          when: "enter",
          label: "Flames lick at you",
          save: { ability: "dex", dc: 12, onSuccess: "half" },
          damage: { formula: "1d4", type: "fire" },
        },
      ],
    });
    expect(dave().msgs.find((m) => m.type === "hazard.prompt")).toBeUndefined();
  });
});
