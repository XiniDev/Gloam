import type { Room } from "@colyseus/sdk";
import type { MaskedRoll, RollRecord } from "@gloam/shared/dice";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import {
  type Agent,
  Agent as AgentCtor,
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
  at: number;
}
interface Player {
  room: TableRoomClient;
  id: string;
  msgs: Msg[];
  socket: ReturnType<typeof socketsSince>[number];
}

describe("P5 — dice on the server (DICE)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  const dmMsgs: Msg[] = [];
  let anna: Player;
  let bob: Player;

  async function admit(name: string): Promise<Player> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const mark = socketCount();
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) =>
      msgs.push({ type: String(type), payload: payload as Msg["payload"], at: Date.now() }),
    );
    return { room: r, id: p.userId, msgs, socket: socketsSince(mark).at(-1) as Player["socket"] };
  }
  const got = (msgs: Msg[], id: string) => msgs.find((m) => (m.payload as { id?: string }).id === id);
  /** A dice request at the protocol's pace (5/s per client). */
  const last = new WeakMap<object, number>();
  async function paced<T>(room: TableRoomClient, type: string, payload: unknown): Promise<T> {
    const wait = (last.get(room) ?? 0) + 220 - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(room, Date.now());
    return rq<T>(room, type, payload);
  }

  beforeAll(async () => {
    recordFrames(true);
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "20260928" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) =>
      dmMsgs.push({ type: String(type), payload: payload as Msg["payload"], at: Date.now() }),
    );
    anna = await admit("Anna");
    bob = await admit("Bob");
    await sleep(200);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-DICE-02 / AC-DICE-01 (server): the server decides every die; the client sends a formula, never a result; invalid formulas are refused with where the problem is", async () => {
    const sent = Date.now();
    const { id } = await paced<{ id: string }>(anna.room, "dice.roll", {
      formula: "4d6kh3 + 2",
      label: "Strength",
    });
    await waitFor(() => got(bob.msgs, id) && got(dmMsgs, id) && got(anna.msgs, id));
    const r = got(bob.msgs, id)?.payload as unknown as RollRecord;
    expect(r.formula).toBe("4d6kh3 + 2");
    expect(r.name).toBe("Anna");
    expect(r.label).toBe("Strength");
    const dice = r.terms.find((x) => x.kind === "dice");
    expect(dice?.kind === "dice" && dice.dice).toHaveLength(4);
    expect(dice?.kind === "dice" && dice.dice.filter((d) => d.kept)).toHaveLength(3);
    expect(r.total).toBe((dice?.kind === "dice" ? dice.subtotal : 0) + 2);
    expect(r.tumble).toHaveLength(4);
    expect(Number.isInteger(r.seed)).toBe(true);
    // No way to hand the server a result: the schema takes none.
    await expect(paced(anna.room, "dice.roll", { formula: "1d20", total: 20 })).rejects.toThrow(/INVALID/);
    // An invalid formula: refused, with the place.
    const bad = await paced(anna.room, "dice.roll", { formula: "1d20 ++ 2" }).catch(
      (e: { reason?: { code?: string; message?: string; details?: { at: number } } }) => e.reason,
    );
    expect(bad).toMatchObject({ code: "INVALID" });
    expect(String((bad as { message?: string }).message)).toMatch(/Unexpected/);
    // AC-DICE-09: the limits hold on the server too (the same engine decides).
    for (const [f, re] of [
      ["101d6", /At most 100 dice/],
      ["100d6+100d6+100d6+100d6+100d6+1d6", /At most 500 dice/],
      ["1d1001", /1 to 1000 sides/],
      [`1d20+${"1+".repeat(100)}1`, /at most 200 characters/],
    ] as const) {
      const e = await paced(anna.room, "dice.roll", { formula: f }).catch(
        (x: { reason?: { code?: string; message?: string } }) => x.reason,
      );
      expect(e, f).toMatchObject({ code: "INVALID", message: expect.stringMatching(re) });
    }
    // AC-DICE-04 (public): everyone within 300 ms of the result.
    for (const p of [bob.msgs, dmMsgs]) expect((got(p, id) as Msg).at - sent).toBeLessThan(300);
  });

  it("AC-DICE-04: Private to DM — the roller and DMs see it, other players a masked card; Self — only the roller, DMs are told; the DM's private roll is 'The DM rolls…'; blind isn't the tray's to choose", async () => {
    const priv = (
      await paced<{ id: string }>(anna.room, "dice.roll", { formula: "1d20+3", visibility: "dm" })
    ).id;
    await waitFor(() => got(bob.msgs, priv) && got(dmMsgs, priv) && got(anna.msgs, priv));
    expect(got(anna.msgs, priv)?.type).toBe("roll.result");
    expect(got(dmMsgs, priv)?.type).toBe("roll.result");
    const masked = got(bob.msgs, priv) as Msg;
    expect(masked.type).toBe("roll.masked");
    expect((masked.payload as unknown as MaskedRoll).text).toBe("Anna rolled privately");
    expect(masked.payload).not.toHaveProperty("total");
    expect(masked.payload).not.toHaveProperty("terms");
    // Nothing in Bob's raw frames carries the numbers (total or dice).
    const full = got(dmMsgs, priv)?.payload as unknown as RollRecord;
    expect(bob.socket.received(`"total":${full.total}`)).toBe(false);

    const self = (await paced<{ id: string }>(anna.room, "dice.roll", { formula: "1d8", visibility: "self" }))
      .id;
    await waitFor(() => got(anna.msgs, self) && got(dmMsgs, self));
    await sleep(150);
    expect(got(bob.msgs, self)).toBeUndefined();
    expect(got(dmMsgs, self)?.type).toBe("roll.masked");
    expect((got(dmMsgs, self)?.payload as unknown as MaskedRoll | undefined)?.text).toBe(
      "Anna rolled for themselves",
    );

    const secret = (await paced<{ id: string }>(dm, "dice.roll", { formula: "1d20", visibility: "dm" })).id;
    await waitFor(() => got(bob.msgs, secret) && got(anna.msgs, secret));
    expect((got(bob.msgs, secret)?.payload as unknown as MaskedRoll | undefined)?.text).toBe("The DM rolls…");

    await expect(paced(anna.room, "dice.roll", { formula: "1d20", visibility: "blind" })).rejects.toThrow(
      /INVALID/,
    );
    await expect(paced(dm, "dice.roll", { formula: "1d20", visibility: "self" })).rejects.toThrow(/INVALID/);
  });

  it("AC-DICE-05 (server): a physical roll entered by hand — each die, or the total — is recorded with its hand and seen by everyone like any roll", async () => {
    const { id } = await paced<{ id: string }>(bob.room, "dice.manual", { formula: "2d6+1", values: [4, 5] });
    await waitFor(() => got(anna.msgs, id) && got(dmMsgs, id));
    const r = got(anna.msgs, id)?.payload as unknown as RollRecord;
    expect(r.manual).toBe(true);
    expect(r.total).toBe(10);
    const tot = (await paced<{ id: string }>(bob.room, "dice.manual", { formula: "1d20+5", total: 23 })).id;
    await waitFor(() => got(anna.msgs, tot));
    expect((got(anna.msgs, tot)?.payload as unknown as RollRecord | undefined)?.total).toBe(23);
    await expect(paced(bob.room, "dice.manual", { formula: "2d6", values: [7, 1] })).rejects.toThrow(
      /INVALID/,
    );
    await expect(paced(bob.room, "dice.manual", { formula: "2d6", values: [3] })).rejects.toThrow(/INVALID/);
  });

  it("AC-DICE-09 (server): the limits hold on the server too", async () => {
    for (const f of ["101d6", "1d1001", "200d6+200d6+200d6", `1d20+${"1+".repeat(100)}1`])
      await expect(paced(anna.room, "dice.roll", { formula: f })).rejects.toThrow(/INVALID/);
  });

  it("@ references come from the roller's own token (a token they don't control can't be used); unknown ones are refused", async () => {
    const { tokenId } = await rq<{ tokenId: string }>(dm, "token.create", {
      sceneId: (
        await rq<{ sceneId: string }>(dm, "scene.create", {
          name: "Hall",
          mapKind: "procedural",
          floorStyle: "stone",
          widthFt: 40,
          heightFt: 40,
        })
      ).sceneId,
      name: "Anna's Rogue",
      pos: { x: 10, y: 10 },
      ownerIds: [anna.id],
      stats: { hp: 10, hpMax: 10, ac: 14, dexMod: 4, initBonus: 4, saves: { dex: 6 } },
    });
    const { id } = await paced<{ id: string }>(anna.room, "dice.roll", {
      formula: "1d20 + @dex.save",
      context: { tokenId },
    });
    await waitFor(() => got(anna.msgs, id));
    const r = got(anna.msgs, id)?.payload as unknown as RollRecord;
    expect(r.total).toBe((r.natural as number) + 6);
    await expect(
      paced(bob.room, "dice.roll", { formula: "1d20+@dex", context: { tokenId } }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      paced(anna.room, "dice.roll", { formula: "1d20+@wis", context: { tokenId } }),
    ).rejects.toThrow(/INVALID/);
  });

  it("AC-DICE-07 (server): a player's dice skin is saved, shown in everyone's presence, and on their rolls; a malformed one is refused", async () => {
    const skin = { body: "#6E1E24", number: "#E6C98B", material: "metal" };
    await rq(bob.room, "profile.diceSkin", skin);
    // Everyone's presence carries it at once (their dice show it).
    await waitFor(() => {
      const p = dm.state.presence.get(bob.id);
      return p && JSON.parse(p.diceSkin).material === "metal";
    });
    expect(JSON.parse(anna.room.state.presence.get(bob.id)?.diceSkin ?? "{}")).toEqual(skin);
    // His next roll is thrown in it, for everyone.
    const { id } = await paced<{ id: string }>(bob.room, "dice.roll", { formula: "1d20" });
    await waitFor(() => got(anna.msgs, id));
    expect((got(anna.msgs, id)?.payload as unknown as RollRecord | undefined)?.skin).toEqual(skin);
    // Kept with his profile, not just the room.
    const fresh = await paced<RollRecord[]>(anna.room, "dice.feed", {});
    expect(fresh.find((r) => r.id === id)?.skin).toEqual(skin);
    for (const bad of [
      { ...skin, body: "red" },
      { ...skin, material: "glass" },
      { ...skin, extra: 1 },
    ])
      await expect(rq(bob.room, "profile.diceSkin", bad)).rejects.toThrow(/INVALID/);
  });

  it("the feed: written before it's sent, kept across a restart, and fetched as each viewer may see it", async () => {
    const annaFeed = await rq<(RollRecord | MaskedRoll)[]>(anna.room, "dice.feed", {});
    const bobFeed = await rq<(RollRecord | MaskedRoll)[]>(bob.room, "dice.feed", {});
    const dmFeed = await rq<(RollRecord | MaskedRoll)[]>(dm, "dice.feed", {});
    // Anna 3 (one private, one self), the DM 1, Bob 2 by hand, Anna 1 with her token, Bob 1 in his new skin.
    expect(dmFeed.length).toBe(8);
    // Newest first; Bob's lacks Anna's Self roll and masks her private one.
    expect(dmFeed[0]?.at).toBeGreaterThanOrEqual(dmFeed[dmFeed.length - 1]?.at as number);
    expect(bobFeed.length).toBe(dmFeed.length - 1);
    expect(bobFeed.some((r) => "masked" in r && r.text === "Anna rolled privately")).toBe(true);
    expect(annaFeed.filter((r) => !("masked" in r)).length).toBeGreaterThan(
      bobFeed.filter((r) => !("masked" in r)).length,
    );
    // Kept: close the table, restart the server on the same data, and the DM's feed is the same.
    await admin.post("/api/admin/table/close");
    await t.stop({ keepData: true });
    t = await startTestServer({ dataDir: t.dataDir, env: { GLOAM_TEST_SEED: "20260928" } });
    const admin2 = new AgentCtor(t.url);
    for (const [k, v] of admin.cookies) admin2.cookies.set(k, v);
    admin = admin2;
    await openTable(admin, "local");
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const again = await rq<(RollRecord | MaskedRoll)[]>(dm, "dice.feed", {});
    expect(again.map((r) => r.id)).toEqual(dmFeed.map((r) => r.id));
  });

  it("AC-DICE-10: GLOAM_TEST_SEED makes results reproducible in test mode; production ignores it", async () => {
    const roll = async (s: TestServer) => {
      const a = await setupAdmin(s);
      const c = await createCampaign(a);
      await openTable(a, "local");
      const room = (await a.colyseus().joinById(c, {}, Table)) as unknown as TableRoomClient;
      const out: number[] = [];
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await paced<{ id: string }>(room, "dice.roll", { formula: "3d20" })).id);
      const feed = await rq<RollRecord[]>(room, "dice.feed", {});
      for (const id of ids) out.push((feed.find((r) => r.id === id) as RollRecord).total);
      return out;
    };
    const s1 = await startTestServer({ env: { GLOAM_TEST_SEED: "7" } });
    const a = await roll(s1);
    await s1.stop();
    const s2 = await startTestServer({ env: { GLOAM_TEST_SEED: "7" } });
    const b = await roll(s2);
    await s2.stop();
    expect(b).toEqual(a);
    expect(loadConfig({ NODE_ENV: "production", GLOAM_TEST_SEED: "7" }).testSeed).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "test", GLOAM_TEST_SEED: "7" }).testSeed).toBe(7);
  });
});
