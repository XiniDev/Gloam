import type { Room } from "@colyseus/sdk";
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
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;
type P = { x: number; y: number };

/**
 * The Walls tool's commands (SPEC §8.7 Editor tools, §13.5; AC-WAL-02 server side): a batch `wall.update` moves a
 * joint shared by several walls — or changes many walls' kind — as one atomic, undoable edit; `wall.split` puts a
 * joint in a wall; `wall.join` makes two walls meeting at an end one. DMs only.
 */
describe("P3 — the Walls tool's commands (WAL-02 server)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let dm: TableRoomClient;
  let player: TableRoomClient;
  let sceneId = "";

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const wall = (id: string) => room().model.get("wall", id);
  const count = () => [...room().model.inScene("wall", sceneId)].length;
  const create = async (walls: { a: P; b: P; kind?: string; hidden?: boolean }[]) =>
    (await rq<{ wallIds: string[] }>(dm, "wall.create", { sceneId, walls })).wallIds;

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    const code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const p = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    player = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    player.onMessage("*", () => {});
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Walls",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
      })
    ).sceneId;
    await rq(dm, "scene.activate", { sceneId });
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("a batch update moves a joint shared by three walls at once, and undoes as one step", async () => {
    const joint = { x: 20, y: 20 };
    const ids = await create([
      { a: { x: 10, y: 20 }, b: joint },
      { a: joint, b: { x: 30, y: 20 } },
      { a: joint, b: { x: 20, y: 30 } },
    ]);
    const [w1, w2, w3] = ids as [string, string, string];
    const moved = { x: 22.5, y: 18 };
    await rq(dm, "wall.update", {
      walls: [
        { wallId: w1, b: moved },
        { wallId: w2, a: moved },
        { wallId: w3, a: moved },
      ],
    });
    expect([wall(w1)?.b, wall(w2)?.a, wall(w3)?.a]).toEqual([moved, moved, moved]);
    // Players see the new joint.
    await waitFor(() => (player.state.walls.get(w2)?.ax === 22.5 ? true : undefined));
    await rq(dm, "history.undo", {});
    expect([wall(w1)?.b, wall(w2)?.a, wall(w3)?.a]).toEqual([joint, joint, joint]);
    await rq(dm, "history.redo", {});
    expect(wall(w3)?.a).toEqual(moved);
  });

  it("a bulk kind change turns walls into doors (shut) and back (no door state), in one edit", async () => {
    const ids = await create([
      { a: { x: 0, y: 5 }, b: { x: 5, y: 5 } },
      { a: { x: 5, y: 5 }, b: { x: 10, y: 5 } },
    ]);
    await rq(dm, "wall.update", { walls: ids.map((wallId) => ({ wallId, kind: "door" })) });
    for (const id of ids) expect([wall(id)?.kind, wall(id)?.doorState]).toEqual(["door", "closed"]);
    await rq(dm, "wall.update", { walls: ids.map((wallId) => ({ wallId, kind: "window", hidden: true })) });
    for (const id of ids)
      expect([wall(id)?.kind, wall(id)?.doorState, wall(id)?.hidden]).toEqual(["window", null, true]);
    await rq(dm, "history.undo", {});
    for (const id of ids) expect([wall(id)?.kind, wall(id)?.hidden]).toEqual(["door", false]);
  });

  it("an edit that collapses a wall to a point removes it (undo restores it); one edit never names a wall twice", async () => {
    const [id] = (await create([{ a: { x: 40, y: 0 }, b: { x: 40, y: 5 } }])) as [string];
    const before = count();
    await rq(dm, "wall.update", { walls: [{ wallId: id, b: { x: 40.004, y: 0 } }] });
    expect(wall(id)).toBeUndefined();
    expect(count()).toBe(before - 1);
    await rq(dm, "history.undo", {});
    expect(wall(id)?.b).toEqual({ x: 40, y: 5 });
    await expect(
      rq(dm, "wall.update", {
        walls: [
          { wallId: id, a: { x: 41, y: 0 } },
          { wallId: id, b: { x: 41, y: 9 } },
        ],
      }),
    ).rejects.toThrow(/twice/);
    // The single form still works.
    await rq(dm, "wall.update", { wallId: id, kind: "curtain" });
    expect(wall(id)?.kind).toBe("curtain");
  });

  it("wall.split makes a joint on the wall (both halves keep its kind); wall.join makes them one again", async () => {
    const [id] = (await create([
      { a: { x: 0, y: 30 }, b: { x: 10, y: 30 }, kind: "window", hidden: true },
    ])) as [string];
    const before = count();
    // A point a little off the wall splits at its foot on the wall.
    const { wallIds } = await rq<{ wallIds: [string, string] }>(dm, "wall.split", {
      wallId: id,
      at: { x: 4, y: 30.4 },
    });
    const [left, right] = wallIds;
    expect(left).toBe(id);
    expect(count()).toBe(before + 1);
    expect([wall(left)?.a, wall(left)?.b]).toEqual([
      { x: 0, y: 30 },
      { x: 4, y: 30 },
    ]);
    expect([wall(right)?.a, wall(right)?.b, wall(right)?.kind, wall(right)?.hidden]).toEqual([
      { x: 4, y: 30 },
      { x: 10, y: 30 },
      "window",
      true,
    ]);
    // Too close to an end, or off the wall: refused.
    await expect(rq(dm, "wall.split", { wallId: left, at: { x: 0.1, y: 30 } })).rejects.toThrow(/INVALID/);
    await expect(rq(dm, "wall.split", { wallId: left, at: { x: 2, y: 33 } })).rejects.toThrow(
      /isn't on the wall/,
    );
    // Join (in either order of ends) — one wall from far end to far end.
    const { wallId } = await rq<{ wallId: string }>(dm, "wall.join", { wallIds: [right, left] });
    expect(wallId).toBe(right);
    expect(wall(left)).toBeUndefined();
    expect([wall(right)?.a, wall(right)?.b]).toEqual([
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ]);
    expect(count()).toBe(before);
    await rq(dm, "history.undo", {});
    expect(count()).toBe(before + 1);
    // Walls that don't meet can't be joined.
    const [far] = (await create([{ a: { x: 50, y: 30 }, b: { x: 55, y: 30 } }])) as [string];
    await expect(rq(dm, "wall.join", { wallIds: [far, left] })).rejects.toThrow(/don't meet/);
  });

  it("players can't edit walls", async () => {
    const [id] = (await create([{ a: { x: 0, y: 38 }, b: { x: 5, y: 38 } }])) as [string];
    await expect(rq(player, "wall.update", { wallId: id, kind: "door" })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(player, "wall.split", { wallId: id, at: { x: 2, y: 38 } })).rejects.toThrow(/FORBIDDEN/);
    await expect(
      rq(player, "wall.create", { sceneId, walls: [{ a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
