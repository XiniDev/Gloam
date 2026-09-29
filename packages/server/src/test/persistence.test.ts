import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { TableRoom } from "../rooms/TableRoom.ts";
import {
  createCampaign,
  openTable,
  rq,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

const running: TestServer[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

describe("F15 persistence (PER)", () => {
  it("AC-PER-01 every accepted command is in SQLite (row + history, one transaction) before any broadcast", async () => {
    const t = await startTestServer();
    running.push(t);
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin, "Before");
    await openTable(admin, "local");
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
    const client = await admin.colyseus().joinById(campaignId);
    client.onMessage("*", () => {});
    await waitFor(() => (client.state as { campaignName?: string }).campaignName === "Before");

    // Inspect the database at the last moment before Colyseus sends the patch.
    const seen: { name: string; historyRows: number }[] = [];
    room.beforePatchProbe = () => {
      if (room.state.campaignName !== "After") return;
      const row = t.server.ctx.sqlite.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaignId) as {
        name: string;
      };
      const hist = t.server.ctx.sqlite
        .prepare("SELECT count(*) AS c FROM history WHERE campaign_id = ? AND type = 'campaign.update'")
        .get(campaignId) as { c: number };
      seen.push({ name: row.name, historyRows: hist.c });
    };
    // The bus's own post-commit hook sees the committed rows too.
    const probe: { name: string; history: number }[] = [];
    room.bus.postCommitProbe = (info) => {
      const row = t.server.ctx.sqlite.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaignId) as {
        name: string;
      };
      const h = t.server.ctx.sqlite.prepare("SELECT id FROM history WHERE id = ?").get(info.entry?.id ?? -1);
      probe.push({ name: row.name, history: h ? 1 : 0 });
    };
    const res = await client.request("campaign.update", { name: "After", cid: "cid-abcdefgh" });
    expect(res).toEqual({ changed: 2 });
    await waitFor(() => (client.state as { campaignName?: string }).campaignName === "After");
    expect(probe).toEqual([{ name: "After", history: 1 }]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ name: "After", historyRows: 1 });

    // Same cid again (a retry after reconnect) is de-duplicated: no second history row.
    await client.request("campaign.update", { name: "Again", cid: "cid-abcdefgh" });
    const count = t.server.ctx.sqlite
      .prepare("SELECT count(*) AS c FROM history WHERE campaign_id = ? AND type = 'campaign.update'")
      .get(campaignId) as { c: number };
    expect(count.c).toBe(1);

    // If the transaction fails, nothing is applied or broadcast.
    t.server.ctx.sqlite.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END;",
    );
    await expect(client.request("campaign.update", { name: "Never" })).rejects.toBeTruthy();
    t.server.ctx.sqlite.exec("DROP TRIGGER boom");
    await sleep(150);
    expect((client.state as { campaignName?: string }).campaignName).toBe("After");
    expect(
      (
        t.server.ctx.sqlite.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaignId) as {
          name: string;
        }
      ).name,
    ).toBe("After");
    expect(room.model.campaign.name).toBe("After");
    await client.leave();
  });

  it("a change through the table never puts back a column written outside it: the session counter survives a scene change (found by the P10 crash journey)", async () => {
    const t = await startTestServer();
    running.push(t);
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin, "Counted");
    const sessionNo = () =>
      (
        t.server.ctx.sqlite.prepare("SELECT session_no AS n FROM campaigns WHERE id = ?").get(campaignId) as {
          n: number;
        }
      ).n;
    // The room is up before the table opens (the campaign is selected): the session counter is written beside it.
    await openTable(admin, "local");
    expect(sessionNo()).toBe(1);
    const client = await admin.colyseus().joinById(campaignId);
    client.onMessage("*", () => {});
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
    expect(room.model.campaign.sessionNo).toBe(1);
    // A change to the campaign's own row through the room (its name, its active scene) — the counter stays.
    // (And a column the room's copy knows nothing of, written directly: a command changing another column leaves it.)
    t.server.ctx.sqlite.prepare("UPDATE campaigns SET units = 'm' WHERE id = ?").run(campaignId);
    await rq(client, "campaign.update", { name: "Counted again" });
    await waitFor(
      () =>
        (
          t.server.ctx.sqlite.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaignId) as {
            name: string;
          }
        ).name === "Counted again",
    );
    expect(sessionNo()).toBe(1);
    expect(
      (
        t.server.ctx.sqlite.prepare("SELECT units FROM campaigns WHERE id = ?").get(campaignId) as {
          units: string;
        }
      ).units,
    ).toBe("m");
    // Close and open again: session 2, never 1 twice.
    await admin.post("/api/admin/table/close", {});
    await openTable(admin, "local");
    expect(sessionNo()).toBe(2);
  });

  it("AC-PER-03 automatic snapshots while open (24 kept), on close and on shutdown; manual named; pre-restore on restore", async () => {
    const t = await startTestServer({ config: { autoSnapshotMs: 400 } });
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin, "Snappy");
    await openTable(admin, "local");
    await waitFor(
      () => t.server.ctx.snapshots.list(campaignId).filter((s) => s.kind === "auto").length >= 2,
      5000,
      50,
    );
    // Retention: only the last 24 autos are kept.
    for (let i = 0; i < 30; i++) t.server.ctx.snapshots.write(campaignId, "auto");
    expect(t.server.ctx.snapshots.list(campaignId).filter((s) => s.kind === "auto")).toHaveLength(24);
    const files = readdirSync(join(t.dataDir, "snapshots", campaignId)).filter((f) =>
      f.endsWith("-auto.json.gz"),
    );
    expect(files).toHaveLength(24);
    // Manual, named.
    const manual = await admin.post(`/api/admin/campaigns/${campaignId}/snapshots`, {
      name: "Before the dragon",
    });
    expect(manual.status).toBe(200);
    const manualId = (manual.json.data as { id: string; name: string }).id;
    expect((manual.json.data as { name: string }).name).toBe("Before the dragon");
    // Change something, then restore: a pre-restore snapshot is taken first and the change is undone.
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
    room.bus.execute(
      "campaign.update",
      { name: "After the dragon" },
      { userId: "system", role: "admin", name: "Admin" },
    );
    const restore = await admin.post(`/api/admin/snapshots/${manualId}/restore`);
    expect(restore.status).toBe(200);
    const pre = t.server.ctx.snapshots.list(campaignId).find((s) => s.kind === "pre-restore");
    expect(pre).toBeTruthy();
    expect(t.server.ctx.campaigns.get(campaignId)?.name).toBe("Snappy");
    expect(room.model.campaign.name).toBe("Snappy");
    // Close writes a `close` snapshot; shutdown writes a `shutdown` snapshot.
    await admin.post("/api/admin/table/close");
    expect(t.server.ctx.snapshots.list(campaignId).some((s) => s.kind === "close")).toBe(true);
    await t.stop({ keepData: true });
    const names = readdirSync(join(t.dataDir, "snapshots", campaignId));
    expect(names.some((f) => f.endsWith("-shutdown.json.gz"))).toBe(true);
  });

  it("AC-PER-04 a daily online backup after 04:00 (14 kept) and Backup now while the table is open", async () => {
    const t = await startTestServer();
    running.push(t);
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin);
    await openTable(admin, "local");
    const b = t.server.ctx.backups;
    // Before 04:00: nothing. After: one per day.
    expect(await b.maybeDaily(null, new Date(2026, 8, 27, 3, 59))).toBeNull();
    expect(await b.maybeDaily(null, new Date(2026, 8, 27, 4, 1))).toBe("2026-09-27");
    expect(await b.maybeDaily("2026-09-27", new Date(2026, 8, 27, 23, 0))).toBeNull();
    // Backup now while commands keep landing.
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
    let writes = 0;
    const timer = setInterval(() => {
      room.bus.execute(
        "campaign.update",
        { name: `Live ${writes++}` },
        { userId: "system", role: "admin", name: "Admin" },
      );
    }, 5);
    const r = await admin.post("/api/admin/backups");
    clearInterval(timer);
    expect(r.status).toBe(200);
    const file = join(t.dataDir, "backups", (r.json.data as { name: string }).name);
    expect(existsSync(file)).toBe(true);
    const copy = new Database(file, { readonly: true });
    expect((copy.prepare("SELECT count(*) AS c FROM campaigns").get() as { c: number }).c).toBe(1);
    expect(copy.pragma("integrity_check", { simple: true }) as string).toBe("ok");
    copy.close();
    // Keep 14.
    for (let d = 1; d <= 20; d++) await b.backupNow("daily", new Date(2026, 8, d, 5, 0));
    expect(b.list().length).toBe(14);
  });
});
