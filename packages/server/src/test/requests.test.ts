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

type TableRoomClient = Room<unknown, TableState>;
interface Msg {
  type: string;
  payload: Record<string, unknown>;
}
interface Card {
  requestId: string;
  targetId: string;
  targetName: string;
  label: string;
  formula: string;
  dc?: number;
  state: string;
  total?: number;
  success?: boolean;
  open: boolean;
}
interface Status {
  id: string;
  dc?: number;
  targets: { id: string; name: string; controllers: string[]; formula: string }[];
  responses: Record<string, { state: string; total?: number; success?: boolean }>;
  status: string;
}

describe("P6 — roll requests on the server (AC-DICE-06)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  const dmMsgs: Msg[] = [];
  const players: Record<string, { room: TableRoomClient; id: string; msgs: Msg[] }> = {};
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const cards = (who: string, requestId: string) =>
    players[who]?.msgs
      .filter((m) => m.type === "request.card" && (m.payload as unknown as Card).requestId === requestId)
      .map((m) => m.payload as unknown as Card) ?? [];
  const lastStatus = (requestId: string) =>
    dmMsgs
      .filter((m) => m.type === "request.status" && (m.payload as unknown as Status).id === requestId)
      .at(-1)?.payload as unknown as Status | undefined;

  async function admit(name: string) {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) =>
      msgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    players[name] = { room: r, id: p.userId, msgs };
  }

  let annaTok = "";
  let bobTok = "";
  let goblin = "";

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "6060" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) =>
      dmMsgs.push({ type: String(type), payload: payload as Msg["payload"] }),
    );
    await admit("Anna");
    await admit("Bob");
    const { sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Bridge",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    // Their characters: Anna's Dexterity 16 with proficient Dex saves (+3 +2 at level 1), Bob's plain.
    const { actorId: a } = await rq<{ actorId: string }>(
      players.Anna?.room as TableRoomClient,
      "actor.create",
      {
        sheet: {
          core: {
            name: "Ilse",
            classes: [{ name: "Rogue", level: 1 }],
            abilities: { str: 8, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
            saves: { dex: { proficient: true } },
            skills: { perception: { prof: "expertise" } },
          },
        },
      },
    );
    await rq(players.Bob?.room as TableRoomClient, "actor.quickCreate", { name: "Bram", hpMax: 12, ac: 14 });
    await rq(dm, "scene.activate", { sceneId });
    annaTok = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.actorId === a),
      )
    ).id;
    bobTok = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.name === "Bram"),
      )
    ).id;
    goblin = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Goblin",
        pos: { x: 50, y: 30 },
        size: "small",
        disposition: "hostile",
        stats: { hp: 7, hpMax: 7, ac: 15, saves: { dex: 2 } },
      })
    ).tokenId;
    await sleep(100);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("a hidden-DC save: each controller gets their own card with their sheet's formula; the DM watches every answer against the DC", async () => {
    const anna = players.Anna as { room: TableRoomClient; id: string; msgs: Msg[] };
    const bob = players.Bob as { room: TableRoomClient; id: string; msgs: Msg[] };
    const { requestId } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [annaTok, bobTok, goblin],
      type: "save",
      ability: "dex",
      dc: 13,
    });
    const a = (await waitFor(() => cards("Anna", requestId)[0])) as Card;
    // Her own card only, her Dexterity save from her sheet (+3 Dex, +2 proficiency), and no DC (it's hidden).
    expect(a).toMatchObject({
      targetId: annaTok,
      targetName: "Ilse",
      label: "Dexterity save",
      state: "pending",
    });
    expect(a.formula).toBe("1d20 + 5");
    expect(a).not.toHaveProperty("dc");
    expect(cards("Anna", requestId).every((c) => c.targetId === annaTok)).toBe(true);
    const b = (await waitFor(() => cards("Bob", requestId)[0])) as Card;
    expect(b.formula).toBe("1d20");
    // Nobody is asked for the goblin but the DM.
    expect(JSON.stringify(anna.msgs.concat(bob.msgs))).not.toContain(goblin);
    const s0 = (await waitFor(() => lastStatus(requestId))) as Status;
    expect(s0.dc).toBe(13);
    expect(s0.targets.find((x) => x.id === goblin)).toMatchObject({ controllers: [], formula: "1d20 + 2" });

    // Anna rolls: the server rolls her formula; the DM sees the total and success against 13; she, her total only.
    const mine = await rq<Card>(anna.room, "request.respond", { requestId, target: annaTok, action: "roll" });
    expect(mine.state).toBe("rolled");
    expect(mine.total).toBeGreaterThanOrEqual(6);
    expect(mine).not.toHaveProperty("success");
    const s1 = (await waitFor(
      () => lastStatus(requestId)?.responses[annaTok]?.state === "rolled" && lastStatus(requestId),
    )) as Status;
    expect(s1.responses[annaTok]?.success).toBe((mine.total as number) >= 13);
    // Once only; and never someone else's card.
    await expect(
      rq(anna.room, "request.respond", { requestId, target: annaTok, action: "roll" }),
    ).rejects.toThrow(/CONFLICT/);
    await expect(
      rq(anna.room, "request.respond", { requestId, target: bobTok, action: "skip" }),
    ).rejects.toThrow(/FORBIDDEN/);
    // Bob rolled his own dice: entered as a total.
    await rq(bob.room, "request.respond", { requestId, target: bobTok, action: "manual", total: 15 });
    // The DM rolls the goblin with one click, then sets Bob's result by hand.
    await rq(dm, "request.answer", { requestId, target: goblin, action: "roll" });
    await rq(dm, "request.answer", { requestId, target: bobTok, action: "set", total: 9 });
    const s2 = (await waitFor(
      () => lastStatus(requestId)?.responses[goblin]?.state === "dm" && lastStatus(requestId),
    )) as Status;
    expect(s2.responses[goblin]?.total).toBeGreaterThanOrEqual(3);
    expect(s2.responses[bobTok]).toMatchObject({ state: "dm", total: 9, success: false });
    // Players can't ask.
    await expect(
      rq(anna.room, "request.create", { targets: [bobTok], type: "save", ability: "wis" }),
    ).rejects.toThrow(/FORBIDDEN/);
    // Closed: the cards go.
    await rq(dm, "request.close", { requestId });
    await waitFor(() => cards("Anna", requestId).at(-1)?.open === false);
    await expect(
      rq(bob.room, "request.respond", { requestId, target: bobTok, action: "skip" }),
    ).rejects.toThrow(/CONFLICT/);
  });

  it("a blind check: the roller's card and dice show '?'; only the DM gets the number — and a shown DC tells the player how it went", async () => {
    const anna = players.Anna as { room: TableRoomClient; id: string; msgs: Msg[] };
    const { requestId } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [annaTok],
      type: "check",
      skill: "perception",
      dc: 15,
      visibility: "blind",
    });
    const card = (await waitFor(() => cards("Anna", requestId)[0])) as Card;
    // Perception with expertise: +2 Wis, +4.
    expect(card).toMatchObject({ label: "Perception check", formula: "1d20 + 6" });
    const mark = anna.msgs.length;
    const res = await rq<Card>(anna.room, "request.respond", { requestId, target: annaTok, action: "roll" });
    expect(res).not.toHaveProperty("total");
    const rolled = await waitFor(() => anna.msgs.slice(mark).find((m) => m.type.startsWith("roll.")));
    expect(rolled?.type).toBe("roll.masked");
    expect(JSON.stringify(rolled?.payload)).not.toContain('"total"');
    const s = (await waitFor(
      () => lastStatus(requestId)?.responses[annaTok]?.state === "rolled" && lastStatus(requestId),
    )) as Status;
    expect(typeof s.responses[annaTok]?.total).toBe("number");

    // Shown DC: the card carries it, and after rolling, whether it succeeded.
    const shown = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [annaTok],
      type: "check",
      ability: "str",
      dc: 8,
      showDc: true,
      adv: "adv",
    });
    const c2 = (await waitFor(() => cards("Anna", shown.requestId)[0])) as Card;
    expect(c2).toMatchObject({ dc: 8, label: "Strength check", formula: "1d20 - 1 adv" });
    const done = await rq<Card>(anna.room, "request.respond", {
      requestId: shown.requestId,
      target: annaTok,
      action: "roll",
    });
    expect(done.success).toBe((done.total as number) >= 8);
    // On joining again, the open cards come back.
    const open = await rq<Card[]>(anna.room, "request.list", {});
    expect(open.map((c) => c.requestId)).toEqual(expect.arrayContaining([requestId, shown.requestId]));
  });

  it("rules audit A1: a sheet's initiative counts Dex once — Ilse (Dex 16) under Fixed initiative scores 13, not 16", async () => {
    await rq(dm, "combat.start", { participants: [annaTok], method: "fixed" });
    const where = room().model.get("token", annaTok)?.sceneId as string;
    const c = await waitFor(() =>
      room()
        .model.inScene("combat", where)
        .find((x) => x.active),
    );
    const entry = dataOf(c).combatants.find((e) => e.tokenId === annaTok);
    // SRD 5.2.1 p. 184: Initiative score 10 + Dex modifier (+3).
    expect(entry?.initiative).toBe(13);
    await rq(dm, "combat.stop", {});
  });
});
