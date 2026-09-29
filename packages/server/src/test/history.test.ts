import type { Room } from "@colyseus/sdk";
import type { HistoryListResult, HistoryRestorePlan } from "@gloam/shared/protocol";
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

/**
 * The History panel's commands (SPEC §8.14, §14.4; AC-UNDO-03/04 server side): the list, newest first, filtered by
 * person, kind and scene; Revert (a dry run names what later changes it overrides; without force it's refused while
 * there are any); Restore to here (a dry run lists every later change; then all of them reverted, newest first). DMs
 * only; a player's request is refused.
 */
describe("P10 — the History panel's commands (UNDO-03/04 server)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let dm: TableRoomClient;
  let player: TableRoomClient;
  let sceneId = "";
  let daveId = "";
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const hp = (id: string) => (room().model.get("token", id) as { stats?: { hp: number } } | null)?.stats?.hp;

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    const code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const p = await joinAsNew(t, code, "Dave");
    daveId = p.userId;
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    player = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    player.onMessage("*", () => {});
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Crypt",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
      })
    ).sceneId;
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("lists, filters, reverts a doubled damage in one step and restores to a point, with its plan first; players can't", async () => {
    const { tokenId: g } = await rq<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name: "Goblin",
      pos: { x: 10, y: 10 },
      disposition: "hostile",
      stats: { hp: 20, hpMax: 20, ac: 12 },
    });
    // The same damage applied twice by mistake (J8).
    for (let i = 0; i < 2; i++) await rq(dm, "hp.apply", { targets: [g], kind: "damage", amount: 6 });
    await waitFor(() => hp(g) === 8);
    const list = await rq<HistoryListResult>(dm, "history.list", {});
    const damage = list.entries.filter((e) => e.type === "hp.apply");
    expect(damage).toHaveLength(2);
    expect(list.entries[0]?.id).toBeGreaterThan(list.entries.at(-1)?.id ?? 0);
    expect(list.entries[0]).toMatchObject({
      userName: expect.any(String),
      sceneName: "Crypt",
      undoable: true,
    });
    // Filtered by kind and by person.
    const onlyHp = await rq<HistoryListResult>(dm, "history.list", { family: "hp" });
    expect(onlyHp.entries.every((e) => e.type.startsWith("hp."))).toBe(true);
    const nobody = await rq<HistoryListResult>(dm, "history.list", { userId: "no-such-user" });
    expect(nobody.entries).toEqual([]);
    // Revert the duplicate: its plan overrides nothing; then one step, and the list shows it undone.
    const dup = damage[0] as (typeof damage)[number];
    const plan = await rq<HistoryRestorePlan>(dm, "history.revert", { id: dup.id, dryRun: true });
    expect(plan.conflicts).toEqual([]);
    await rq(dm, "history.revert", { id: dup.id });
    await waitFor(() => hp(g) === 14);
    const after = await rq<HistoryListResult>(dm, "history.list", { family: "hp" });
    expect(after.entries.find((e) => e.id === dup.id)?.undoneAt).not.toBeNull();
    // The first damage: a later change (the DM's heal) touched the same HP — named, refused without force.
    await rq(dm, "hp.apply", { targets: [g], kind: "heal", amount: 2 });
    await waitFor(() => hp(g) === 16);
    const first = damage[1] as (typeof damage)[number];
    const risky = await rq<HistoryRestorePlan>(dm, "history.revert", { id: first.id, dryRun: true });
    expect(risky.conflicts.map((c) => c.type)).toContain("hp.apply");
    await expect(rq(dm, "history.revert", { id: first.id })).rejects.toThrow(/CONFLICT/);
    // Restore to the token's creation: its plan lists the later changes, then all are reverted.
    const created = (await rq<HistoryListResult>(dm, "history.list", { family: "token" })).entries.find(
      (e) => e.type === "token.create",
    );
    expect(created).toBeTruthy();
    const restore = await rq<HistoryRestorePlan>(dm, "history.restore", { id: created?.id, dryRun: true });
    expect(restore.changes.length).toBeGreaterThanOrEqual(2);
    const r = await rq<{ reverted: number }>(dm, "history.restore", { id: created?.id });
    expect(r.reverted).toBe(restore.changes.length);
    await waitFor(() => hp(g) === 20);
    // Players: none of it.
    await expect(rq(player, "history.list", {})).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(player, "history.revert", { id: first.id })).rejects.toThrow(/FORBIDDEN/);
  });

  it("AC-UNDO-02: a player's undo over a later change is refused, saying who changed what; the DM may force it", async () => {
    const { tokenId: pc } = await rq<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name: "Rook",
      pos: { x: 30, y: 30 },
      disposition: "party",
      ownerIds: [daveId],
    });
    const pos = () => (room().model.get("token", pc) as { pos: { x: number; y: number } }).pos;
    await waitFor(() => room().model.get("token", pc));
    // Dave renames his token; then the DM renames it again.
    await rq(player, "token.update", { tokenId: pc, name: "Rook the Bold" });
    await rq(dm, "token.update", { tokenId: pc, name: "Rook (DM)" });
    // Dave's undo: refused, with the reason in words.
    await expect(rq(player, "history.undo", {})).rejects.toThrow(/Can't undo: .+ changed this since/);
    expect((room().model.get("token", pc) as { name: string }).name).toBe("Rook (DM)");
    // The DM's own undo over someone else's later change: forced.
    await rq(player, "token.update", { tokenId: pc, name: "Rook again" });
    await expect(rq(dm, "history.undo", {})).rejects.toThrow(/CONFLICT/);
    await rq(dm, "history.undo", { force: true });
    expect((room().model.get("token", pc) as { name: string }).name).not.toBe("Rook (DM)");
    expect(pos()).toEqual({ x: 30, y: 30 });
  });

  it("AC-UNDO-05: dice rolls, pings and raised hands are facts — no history entry, nothing to undo", async () => {
    const before = (await rq<HistoryListResult>(dm, "history.list", { limit: 100 })).entries.length;
    // A fresh player stack: whatever Dave did before is undone or refused; now only facts.
    await rq(player, "dice.roll", { formula: "1d20+3", label: "Perception" });
    await rq(dm, "dice.roll", { formula: "2d6", visibility: "dm" });
    await rq(player, "ping.send", { x: 10, y: 10 });
    await rq(player, "hand.toggle", {});
    const after = (await rq<HistoryListResult>(dm, "history.list", { limit: 100 })).entries.length;
    expect(after).toBe(before);
  });
});
