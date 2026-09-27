import type { Room } from "@colyseus/sdk";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableRoom } from "../rooms/TableRoom.ts";
import {
  type Agent,
  createCampaign,
  joinAsNew,
  openTable,
  setupAdmin,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";
import { recordFrames, socketCount, socketsSince } from "./ws-recorder.ts";

type TableRoomClient = Room<unknown, TableState>;

describe("P2 — scenes, tokens and per-client views (SCN/TOK)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let player: TableRoomClient;
  let playerSocket: ReturnType<typeof socketsSince>[number];
  let playerId: string;
  const prepPatches: unknown[] = [];

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cmd = <T = unknown>(r: TableRoomClient, type: string, payload: unknown) =>
    r.request(type, payload) as Promise<T>;

  beforeAll(async () => {
    recordFrames(true);
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) => {
      if (type === "prep.patch") prepPatches.push(payload);
    });
    const p = await joinAsNew(t, code, "Dave");
    playerId = p.userId;
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const mark = socketCount();
    player = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    player.onMessage("*", () => {});
    playerSocket = socketsSince(mark).at(-1) as ReturnType<typeof socketsSince>[number];
  });
  afterAll(async () => {
    await t?.stop();
  });

  let sceneA = "";
  let sceneB = "";
  let tokA = "";

  it("scene.create / token.create: blank and procedural scenes, Quick-Unit-style tokens with arbitrary values (AC-TOK-09 server)", async () => {
    sceneA = (await cmd<{ sceneId: string }>(dm, "scene.create", { name: "Crossroads", mapKind: "blank" }))
      .sceneId;
    sceneB = (
      await cmd<{ sceneId: string }>(dm, "scene.create", {
        name: "Lantern Crypt",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
      })
    ).sceneId;
    tokA = (
      await cmd<{ tokenId: string }>(dm, "token.create", {
        sceneId: sceneA,
        name: "Goblin Scout",
        pos: { x: 20, y: 15 },
        size: "small",
        disposition: "hostile",
        hpDisplay: "bar",
        stats: {
          hp: 7,
          hpMax: 9,
          ac: 15,
          speeds: { walk: 30, climb: 20 },
          senses: { darkvision: 60 },
          resist: ["poison"],
        },
      })
    ).tokenId;
    const m = room().model;
    const tok = m.get("token", tokA);
    expect(tok?.stats).toMatchObject({ hp: 7, hpMax: 9, ac: 15, size: "small" });
    expect(tok?.stats?.speeds).toMatchObject({ walk: 30, climb: 20, fly: 0 });
    expect(tok?.stats?.senses.darkvision).toBe(60);
    expect(tok?.sizeFt).toBe(5); // Small → 5-ft base (AC-TOK-02)
    expect(tok?.link).toBe("unlinked");
    // No scene is active yet: nobody has any token in their state.
    expect(player.state.scene.id).toBe("");
  });

  it("AC-SCN-02 activating a scene moves every player within 2 s, and players receive only its entities", async () => {
    await cmd(dm, "token.create", { sceneId: sceneB, name: "Crypt Orc", pos: { x: 10, y: 10 } });
    const t0 = Date.now();
    await cmd(dm, "scene.activate", { sceneId: sceneA });
    await waitFor(() => player.state.scene.id === sceneA && player.state.tokens?.size === 1);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(player.state.scene.name).toBe("Crossroads");
    const seqA = player.state.scene.seq;
    expect([...player.state.tokens.values()].map((x) => x.name)).toEqual(["Goblin Scout"]);

    const t1 = Date.now();
    await cmd(dm, "scene.activate", { sceneId: sceneB });
    await waitFor(() => player.state.scene.id === sceneB && player.state.tokens?.size === 1);
    expect(Date.now() - t1).toBeLessThan(2000);
    expect([...player.state.tokens.values()].map((x) => x.name)).toEqual(["Crypt Orc"]);
    expect(player.state.scene.seq).toBeGreaterThan(seqA);
    expect(JSON.parse(player.state.scene.floorJson)).toMatchObject({ style: "stone" });
    // The DM sees the same live scene.
    await waitFor(() => dm.state.scene.id === sceneB);
  });

  it("AC-PER-03 (activation clause): activating a scene writes a `scene` snapshot", async () => {
    const snaps = t.server.ctx.snapshots.list(campaignId);
    expect(snaps.filter((s) => s.kind === "scene").length).toBeGreaterThanOrEqual(2);
  });

  it("AC-SCN-03 the DM edits a non-active scene while players stay; players receive none of its data (network inspection)", async () => {
    const snap = (await cmd<{ scene: { id: string }; tokens: { name: string }[] }>(dm, "prep.open", {
      sceneId: sceneA,
    }))!;
    expect(snap.scene.id).toBe(sceneA);
    expect(snap.tokens.map((x) => x.name)).toEqual(["Goblin Scout"]);
    const before = playerSocket.frames.length;
    const secret = await cmd<{ tokenId: string }>(dm, "token.create", {
      sceneId: sceneA,
      name: "Zzprep Wight",
      pos: { x: 30, y: 30 },
      appearance: { mode: "coin", scale: 1, offsetY: 0, rotationOffsetDeg: 0 },
    });
    await cmd(dm, "scene.update", { sceneId: sceneA, name: "Vault of Qx7", dmNotes: "the wight waits" });
    await waitFor(
      () =>
        prepPatches.some((p) => JSON.stringify(p).includes("Zzprep Wight")) &&
        prepPatches.some((p) => JSON.stringify(p).includes("Vault of Qx7")),
    );
    // Players stay on the live scene, and nothing about the prep scene reached their socket.
    await new Promise((r) => setTimeout(r, 150));
    expect(player.state.scene.id).toBe(sceneB);
    // Never-seen names: nowhere in the socket's history. Ids: nothing since the scene went into prep.
    for (const needle of ["Zzprep", "Qx7", "wight waits"])
      expect(playerSocket.received(needle), needle).toBe(false);
    for (const needle of [sceneA, secret.tokenId, tokA])
      expect(playerSocket.receivedSince(before, needle), needle).toBe(false);
    expect(playerSocket.frames.length - before).toBeLessThanOrEqual(1); // at most an unrelated heartbeat/patch
    await cmd(dm, "prep.close", {});
  });

  let lurker = "";
  it("AC-TOK-08 DM-hidden tokens: DMs get them (flagged); players never receive them — state and raw frames", async () => {
    lurker = (
      await cmd<{ tokenId: string }>(dm, "token.create", {
        sceneId: sceneB,
        name: "Hidden Lurker Q9",
        pos: { x: 25, y: 20 },
        hidden: true,
      })
    ).tokenId;
    await waitFor(() => dm.state.tokens?.get(lurker));
    expect(dm.state.tokens.get(lurker)?.dm.dmHidden).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(player.state.tokens.get(lurker)).toBeUndefined();
    expect(playerSocket.received("Hidden Lurker Q9")).toBe(false);
    expect(playerSocket.received(lurker)).toBe(false);
    // Reveal → players get it; hide again → it leaves their state.
    await cmd(dm, "token.update", { tokenId: lurker, hidden: false });
    await waitFor(() => player.state.tokens.get(lurker));
    expect(player.state.tokens.get(lurker)?.dm?.dmHidden).toBeUndefined();
    await cmd(dm, "token.update", { tokenId: lurker, hidden: true });
    await waitFor(() => !player.state.tokens.get(lurker));
  });

  it("per-client tags: owners and Exact display get HP numbers, others only the bar; revoking a tag clears the field", async () => {
    const mine = (
      await cmd<{ tokenId: string }>(dm, "token.create", {
        sceneId: sceneB,
        name: "Dave's Fighter",
        pos: { x: 5, y: 5 },
        disposition: "party",
        ownerIds: [playerId],
        stats: { hp: 30, hpMax: 44, ac: 18, isPC: true },
      })
    ).tokenId;
    const orc = [...room().model.inScene("token", sceneB)].find((x) => x.name === "Crypt Orc")?.id as string;
    await cmd(dm, "token.update", { tokenId: orc, hpDisplay: "bar", stats: { hp: 6, hpMax: 15, ac: 13 } });
    await waitFor(
      () => player.state.tokens.get(mine) && player.state.tokens.get(orc)?.hpFrac === Math.fround(6 / 15),
    );
    const pm = player.state.tokens.get(mine);
    expect(pm?.hp.hp).toBe(30);
    expect(pm?.own.ac).toBe(18); // TAG_OWNER on the player's own token
    expect(pm?.ringColor).toBe("#E6B450"); // Dave's amber (AC-TOK-02)
    const po = player.state.tokens.get(orc);
    expect(po?.hp?.hp).toBeUndefined(); // Bar: fraction only
    expect(po?.own?.ac).toBeUndefined(); // AC never reaches non-controllers
    expect(po?.hpBand).toBe(2);
    // Exact → numbers for everyone; back to Bar → the numbers are gone from the player's copy.
    await cmd(dm, "token.update", { tokenId: orc, hpDisplay: "exact" });
    await waitFor(() => player.state.tokens.get(orc)?.hp?.hp === 6);
    await cmd(dm, "token.update", { tokenId: orc, hpDisplay: "bar" });
    await waitFor(() => player.state.tokens.get(orc)?.hpDisplay === "bar");
    await new Promise((r) => setTimeout(r, 100));
    expect(player.state.tokens.get(orc)?.hp?.hp).toBeUndefined();
    // Descriptor: band only, no fraction.
    await cmd(dm, "token.update", { tokenId: orc, hpDisplay: "descriptor" });
    await waitFor(() => player.state.tokens.get(orc)?.hpDisplay === "descriptor");
    expect(player.state.tokens.get(orc)?.hpFrac).toBe(-1);
    expect(player.state.tokens.get(orc)?.hpBand).toBe(2);
  });

  it("token.update permissions: owners may rename and restyle their token, nothing else; partial appearance keeps other fields", async () => {
    const mine = [...room().model.inScene("token", sceneB)].find((x) => x.name === "Dave's Fighter")
      ?.id as string;
    await cmd(dm, "token.update", { tokenId: mine, appearance: { scale: 1.4, offsetY: 0.5 } });
    await cmd(player, "token.update", { tokenId: mine, name: "Thorin", appearance: { mode: "coin" } });
    const tok = room().model.get("token", mine);
    expect(tok?.name).toBe("Thorin");
    expect(tok?.appearance).toMatchObject({ mode: "coin", scale: 1.4, offsetY: 0.5 });
    await expect(cmd(player, "token.update", { tokenId: mine, hidden: true })).rejects.toMatchObject({
      name: "rejected",
    });
    await expect(cmd(player, "token.update", { tokenId: mine, stats: { hp: 999 } })).rejects.toBeTruthy();
    await expect(
      cmd(player, "token.create", { sceneId: sceneB, name: "x", pos: { x: 0, y: 0 } }),
    ).rejects.toBeTruthy();
    const orc = [...room().model.inScene("token", sceneB)].find((x) => x.name === "Crypt Orc")?.id as string;
    await expect(cmd(player, "token.update", { tokenId: orc, name: "mine now" })).rejects.toBeTruthy();
  });

  it("token.duplicate / token.place / token.delete (undoable)", async () => {
    const orc = [...room().model.inScene("token", sceneB)].find((x) => x.name === "Crypt Orc")?.id as string;
    const dup = await cmd<{ tokenIds: string[] }>(dm, "token.duplicate", { tokenIds: [orc] });
    expect(dup.tokenIds).toHaveLength(1);
    const copyId = dup.tokenIds[0] as string;
    const copy = room().model.get("token", copyId);
    expect(copy?.stats?.hp).toBe(6); // own copy of the stats
    await cmd(dm, "token.place", { tokenId: copyId, pos: { x: 40, y: 12 } });
    await waitFor(() => player.state.tokens.get(copyId)?.pos.x === 40);
    await cmd(dm, "token.delete", { tokenIds: [copyId] });
    await waitFor(() => !player.state.tokens.get(copyId));
    await cmd(dm, "history.undo", {});
    await waitFor(() => player.state.tokens.get(copyId)?.pos.x === 40);
  });

  it("walls reach players sanitised: secret doors read as walls, hidden sight-blockers as anonymous occluders, hidden windows not at all", async () => {
    const r = room();
    const wall = (id: string, kind: string, hidden: boolean, doorState: string | null = null) => ({
      k: "create" as const,
      e: "wall" as const,
      id,
      value: { id, sceneId: sceneB, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, kind, doorState, hidden },
    });
    const ops = [
      wall("wal_secretDoor01", "secret", false, "closed"),
      wall("wal_hiddenWall01", "wall", true),
      wall("wal_hiddenWind01", "window", true),
      wall("wal_plainDoor001", "door", false, "open"),
    ];
    r.bus.commit(
      "test.walls",
      ops as never,
      "walls",
      false,
      { userId: "system", role: "admin", name: "test" },
      sceneB,
    );
    (r as unknown as { onCommitted(i: unknown): void }).onCommitted({
      entry: null,
      ops,
      actor: {},
      type: "test",
    });
    await waitFor(() => player.state.walls?.size === 3 && dm.state.walls?.size === 4);
    const pw = player.state.walls;
    expect(pw.get("wal_secretDoor01")).toMatchObject({ kind: "wall", door: "" });
    expect(pw.get("wal_secretDoor01")?.dmKind).toBeUndefined();
    expect(pw.get("wal_hiddenWall01")).toMatchObject({ kind: "occluder", door: "" });
    expect(pw.get("wal_hiddenWind01")).toBeUndefined();
    expect(pw.get("wal_plainDoor001")).toMatchObject({ kind: "door", door: "open" });
    expect(dm.state.walls.get("wal_secretDoor01")).toMatchObject({ dmKind: "secret", dmHidden: false });
  });

  it("AC-SCN-04 server: Generate walls arrives in 500-wall batches sharing an undoGroup and undoes/redoes as one step", async () => {
    const r = room();
    const before = [...r.model.inScene("wall", sceneB)].length;
    const walls = (n: number, row: number) =>
      Array.from({ length: n }, (_, i) => ({ a: { x: i, y: row }, b: { x: i + 0.8, y: row } }));
    // The batch limit (§13.5) holds per message.
    await expect(cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(501, 90) })).rejects.toThrow();
    const group = "gen_walls_0001";
    for (const [n, row] of [
      [500, 100],
      [500, 101],
      [200, 102],
    ] as const)
      await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(n, row), undoGroup: group });
    expect([...r.model.inScene("wall", sceneB)].length).toBe(before + 1200);
    await waitFor(() => player.state.walls?.size === 3 + 1200);
    await cmd(dm, "history.undo", {});
    expect([...r.model.inScene("wall", sceneB)].length).toBe(before);
    await waitFor(() => player.state.walls?.size === 3);
    await cmd(dm, "history.redo", {});
    expect([...r.model.inScene("wall", sceneB)].length).toBe(before + 1200);
    await cmd(dm, "history.undo", {});
    expect([...r.model.inScene("wall", sceneB)].length).toBe(before);

    // Without a group (or with a different command in between) each command is its own step.
    await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(2, 110) });
    await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(3, 111), undoGroup: "gen_walls_0002" });
    await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(4, 112), undoGroup: "gen_walls_0002" });
    await cmd(dm, "scene.update", { sceneId: sceneB, name: "Crypt (walls)" });
    await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(5, 113), undoGroup: "gen_walls_0002" });
    const count = () => [...r.model.inScene("wall", sceneB)].length;
    expect(count()).toBe(before + 14);
    await cmd(dm, "history.undo", {});
    expect(count()).toBe(before + 9); // the 5 after the rename
    await cmd(dm, "history.undo", {}); // the rename
    await cmd(dm, "history.undo", {});
    expect(count()).toBe(before + 2); // 3 + 4 together
    await cmd(dm, "history.undo", {});
    expect(count()).toBe(before);
    // A grouped step is checked as a whole: when someone else changed part of it, a player's undo is refused and
    // nothing of the step is undone (no half-applied group).
    const mine = [...r.model.inScene("token", sceneB)].find((x) => x.name === "Thorin")?.id as string;
    await cmd(player, "token.update", {
      tokenId: mine,
      appearance: { scale: 1.1 },
      undoGroup: "look_group_01",
    });
    await cmd(player, "token.update", { tokenId: mine, name: "Thorin II", undoGroup: "look_group_01" });
    await cmd(dm, "token.update", { tokenId: mine, name: "Thorin the DM's" });
    await expect(cmd(player, "history.undo", {})).rejects.toBeTruthy();
    expect(r.model.get("token", mine)).toMatchObject({ name: "Thorin the DM's" });
    expect(r.model.get("token", mine)?.appearance.scale).toBe(1.1);

    // A malformed group is ignored (not an error), like a malformed cid.
    await cmd(dm, "wall.create", { sceneId: sceneB, walls: walls(1, 114), undoGroup: "x" });
    await cmd(dm, "history.undo", {});
    expect(count()).toBe(before);
  });
});
