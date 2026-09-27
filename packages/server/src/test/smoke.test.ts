import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("P1 smoke: setup → open → knock → admit → table", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("walks the happy path", async () => {
    const { code } = await openTable(admin, "local");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const watcher = await admin.colyseus().joinById("lobby");
    const knocks: unknown[] = [];
    watcher.onMessage("knock", (m) => knocks.push(m));
    watcher.onMessage("*", () => {});

    const p = await joinAsNew(t, code, "Dave", { pin: "1234" });
    await waitFor(() => knocks.length > 0);
    expect(knocks[0]).toMatchObject({ name: "Dave", identity: "new" });

    const r = await admin.post("/api/admin/table/knocks/decide", {
      sessionId: p.sessionId,
      decision: "admitPlayer",
    });
    expect(r.status).toBe(200);
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    const enter = await p.agent.post("/api/join/enter");
    expect(enter.status).toBe(200);
    const room = await p.agent.colyseus().joinById(campaignId);
    room.onMessage("*", () => {});
    await waitFor(
      () => room.state && (room.state as { campaignName?: string }).campaignName === "Test Campaign",
    );

    await room.leave();
    await p.lobby.leave();
    await watcher.leave();
  });
});
