import type { Room } from "@colyseus/sdk";
import type { DmPromptView, HpFx, HpPreviewRow, RequestCard } from "@gloam/shared/protocol";
import { effectiveTokenState } from "@gloam/shared/rules";
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
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;
interface Msg {
  type: string;
  payload: unknown;
}

describe("P7 — HP, conditions and death on the server (§8.11)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let sceneId = "";
  const dmMsgs: Msg[] = [];
  const players: Record<string, { room: TableRoomClient; id: string; msgs: Msg[] }> = {};
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const state = (tokenId: string) => {
    const tk = room().model.get("token", tokenId);
    if (!tk) throw new Error(`no token ${tokenId}`);
    const a = tk.actorId ? room().model.get("actor", tk.actorId) : undefined;
    return effectiveTokenState(tk, a && tk.link === "linked" ? a : undefined);
  };
  const conditions = (id: string) => state(id).status.conditions.map((c) => c.id);
  const markers = (id: string) => state(id).status.markers.map((m) => m.id);
  /** Each prompt as the DMs last heard of it. */
  const prompts = () => {
    const m = new Map<string, DmPromptView>();
    for (const x of dmMsgs)
      if (x.type === "prompt.update") m.set((x.payload as DmPromptView).id, x.payload as DmPromptView);
    return [...m.values()];
  };
  /** The newest open prompt about a creature (older ones from earlier tests may still be open). */
  const openPromptFor = (tokenId: string) =>
    waitFor(
      () =>
        prompts()
          .filter((p) => p.tokenId === tokenId && p.status === "open")
          .sort((a, b) => b.createdAt - a.createdAt)[0],
    );
  const cardsOf = (who: string) =>
    (players[who]?.msgs ?? []).filter((m) => m.type === "request.card").map((m) => m.payload as RequestCard);

  async function admit(name: string) {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    r.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    players[name] = { room: r, id: p.userId, msgs };
  }
  // Health commands are rate-limited like any other (§13.5: a burst of 10, then 5 a second): paced as a DM would.
  const hpApply = async <T = unknown>(r: TableRoomClient, payload: unknown) => {
    await sleep(210);
    return rq<T>(r, "hp.apply", payload);
  };
  const statusChange = async (r: TableRoomClient, payload: unknown) => {
    await sleep(210);
    return rq(r, "status.change", payload);
  };
  const anna = () => players.Anna as { room: TableRoomClient; id: string; msgs: Msg[] };
  const bob = () => players.Bob as { room: TableRoomClient; id: string; msgs: Msg[] };
  let ilse = "";
  let ilseActor = "";

  /** An NPC on the board (unlinked: its own numbers). */
  async function npc(name: string, hp: number, extra: Record<string, unknown> = {}) {
    const { tokenId } = await rq<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name,
      pos: { x: 20 + Math.round(Math.random() * 30), y: 20 },
      disposition: "hostile",
      stats: { hp, hpMax: hp, ac: 12, ...extra },
    });
    return tokenId;
  }
  /** Ilse back to full HP with nothing on her. */
  async function reset() {
    await rq(dm, "actor.change", {
      actorId: ilseActor,
      changes: [
        { path: ["core", "hp"], after: { max: 20, current: 20, temp: 0 } },
        { path: ["core", "conditions"], after: [] },
        { path: ["core", "deathSaves"], after: { successes: 0, failures: 0 } },
        { path: ["core", "exhaustion"], after: 0 },
      ],
    });
    const s = state(ilse).status;
    if (s.markers.length || s.concentration || s.deathSaves)
      await statusChange(dm, {
        tokenId: ilse,
        remove: [...s.markers.map((m) => m.id), "concentrating", "deathsaves"],
      });
  }

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "7070" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    await admit("Anna");
    await admit("Bob");
    ({ sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Crypt",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    }));
    ilseActor = (
      await rq<{ actorId: string }>(anna().room, "actor.quickCreate", { name: "Ilse", hpMax: 20, ac: 14 })
    ).actorId;
    await rq(dm, "scene.activate", { sceneId });
    ilse = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.actorId === ilseActor),
      )
    ).id;
    await sleep(100);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("damage runs the SRD pipeline, typed per part; healing stops at the maximum (AC-HP-01, AC-HP-02)", async () => {
    const ogre = await npc("Fire-scarred ogre", 40, { resist: ["fire"], vuln: ["cold"] });
    // 12 slashing + 8 fire (resisted → 4) + 5 cold (vulnerable → 10) = 26.
    await hpApply(dm, {
      targets: [ogre],
      kind: "damage",
      parts: [
        { amount: 12, type: "slashing" },
        { amount: 8, type: "fire" },
        { amount: 5, type: "cold" },
      ],
    });
    expect(state(ogre).stats.hp).toBe(14);
    // A successful save halves each instance before resistance: 8 fire → 4 → 2.
    await hpApply(dm, {
      targets: [ogre],
      kind: "damage",
      parts: [{ amount: 8, type: "fire" }],
      halved: true,
    });
    expect(state(ogre).stats.hp).toBe(12);
    await hpApply(dm, { targets: [ogre], kind: "heal", amount: 100 });
    expect(state(ogre).stats.hp).toBe(40);
    // Everyone who can see it gets the feedback: the numbers by type, largest first.
    const fx = (await waitFor(() =>
      dmMsgs.find((m) => m.type === "hp.fx" && (m.payload as HpFx).tokenId === ogre),
    )) as Msg;
    expect(fx.payload).toMatchObject({
      kind: "damage",
      amount: 26,
      parts: [
        { type: "slashing", amount: 12 },
        { type: "cold", amount: 10 },
        { type: "fire", amount: 4 },
      ],
    });
  });

  it("the dialog's preview: the DM sees what it does and what follows; a player only their own creatures' numbers (§8.11, §13.4)", async () => {
    const ogre = await npc("Ogre", 30, { resist: ["fire"] });
    const rows = await rq<HpPreviewRow[]>(dm, "hp.preview", {
      targets: [ogre],
      kind: "damage",
      parts: [
        { amount: 20, type: "fire" },
        { amount: 25, type: "bludgeoning" },
      ],
    });
    expect(rows[0]).toMatchObject({
      name: "Ogre",
      before: { hp: 30, hpMax: 30, hpTemp: 0 },
      after: { hp: 0, hpTemp: 0 },
      damage: { total: 35, overflow: 5 },
      now: [],
      asked: ["npcAtZero"],
    });
    expect(rows[0]?.damage?.parts[0]).toMatchObject({
      type: "fire",
      amount: 20,
      applied: 10,
      steps: ["resisted"],
    });
    // Nothing changed.
    expect(state(ogre).stats.hp).toBe(30);
    // Bob aims at it: named, no numbers, and his damage would go to the DM.
    const his = await rq<HpPreviewRow[]>(bob().room, "hp.preview", {
      targets: [ogre],
      kind: "damage",
      amount: 5,
    });
    expect(his).toEqual([{ tokenId: ogre, name: "Ogre", hidden: true, viaDm: true }]);
    // Anna, her own character: the numbers.
    await reset();
    const hers = await rq<HpPreviewRow[]>(anna().room, "hp.preview", {
      targets: [ilse],
      kind: "heal",
      amount: 5,
    });
    expect(hers[0]).toMatchObject({ before: { hp: 20, hpMax: 20 }, after: { hp: 20 } });
    // Temporary HP on top of some: the choice, the higher first.
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 4 });
    const temp = await rq<HpPreviewRow[]>(anna().room, "hp.preview", {
      targets: [ilse],
      kind: "temp",
      amount: 7,
    });
    expect(temp[0]?.temp).toEqual({ current: 4, incoming: 7, best: 7 });
  });

  it("temporary HP don't stack: the higher by default, or keep / replace (AC-HP-03)", async () => {
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 5 });
    expect(state(ilse).stats.hpTemp).toBe(5);
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 3 });
    expect(state(ilse).stats.hpTemp).toBe(5);
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 3, tempChoice: "replace" });
    expect(state(ilse).stats.hpTemp).toBe(3);
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 8, tempChoice: "keep" });
    expect(state(ilse).stats.hpTemp).toBe(3);
    // They take damage first.
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 5 });
    expect(state(ilse).stats).toMatchObject({ hpTemp: 0, hp: 18 });
  });

  it("an NPC at 0 HP: the DM is asked Dead / Unconscious / Keep at 0, Dead preselected; nothing dies meanwhile (AC-HP-10, AC-HP-12)", async () => {
    const goblin = await npc("Goblin", 7);
    await hpApply(dm, { targets: [goblin], kind: "damage", amount: 9 });
    expect(state(goblin).stats.hp).toBe(0);
    expect(room().state.tokens.get(goblin)?.dead ?? false).toBe(false);
    const p = (await openPromptFor(goblin)) as DmPromptView;
    expect(p.title).toBe("Goblin dropped to 0 HP");
    const item = p.items.find((i) => i.key === "npcAtZero");
    expect(item?.choice).toBe("dead");
    expect(item?.choices?.map((c) => c.label)).toEqual(["Dead", "Unconscious", "Keep at 0"]);
    // The DM makes it Unconscious instead.
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: true, choices: { npcAtZero: "unconscious" } });
    expect(conditions(goblin)).toContain("unconscious");
    expect(markers(goblin)).not.toContain("dead");
    expect(prompts().find((x) => x.id === p.id)?.status).toBe("applied");
    // A second one: Dead, the default.
    const orc = await npc("Orc", 15);
    await hpApply(dm, { targets: [orc], kind: "damage", amount: 20 });
    const q = (await openPromptFor(orc)) as DmPromptView;
    await rq(dm, "prompt.resolve", { promptId: q.id, apply: true });
    expect(markers(orc)).toContain("dead");
    await waitFor(() => room().state.tokens.get(orc)?.dead === true);
    // Healing a corpse does nothing (SRD 5.2.1 p. 180 — rules audit A2): no HP, still dead.
    await hpApply(dm, { targets: [orc], kind: "heal", amount: 10 });
    expect(state(orc).stats.hp).toBe(0);
    expect(markers(orc)).toContain("dead");
    // A third: skipped — kept at 0, nothing added.
    const rat = await npc("Rat", 2);
    await hpApply(dm, { targets: [rat], kind: "damage", amount: 5 });
    const r = (await openPromptFor(rat)) as DmPromptView;
    await rq(dm, "prompt.resolve", { promptId: r.id, apply: false });
    expect(markers(rat)).toEqual([]);
    expect(prompts().find((x) => x.id === r.id)?.status).toBe("skipped");
  });

  it("rules audit A5: Unconscious put on by hand brings Prone; coming round, it stays Prone (SRD 5.2.1 p. 191)", async () => {
    const guard = await npc("Guard", 11);
    await rq(dm, "status.change", { tokenId: guard, add: [{ id: "unconscious" }] });
    expect(conditions(guard)).toEqual(expect.arrayContaining(["unconscious", "prone"]));
    await rq(dm, "status.change", { tokenId: guard, remove: ["unconscious"] });
    expect(conditions(guard)).toContain("prone");
    expect(conditions(guard)).not.toContain("unconscious");
  });

  it("a PC at 0 HP: Unconscious and Prone and death saves, once the DM confirms; damage at 0 adds failures; massive damage asks (AC-HP-09)", async () => {
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 25 });
    expect(state(ilse).stats.hp).toBe(0);
    const p = (await openPromptFor(ilse)) as DmPromptView;
    expect(p.items.map((i) => i.key)).toEqual(["down"]);
    expect(p.items[0]?.label).toBe("Unconscious and Prone; death saves start");
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: true, keep: ["down"] });
    expect(conditions(ilse)).toEqual(["unconscious", "prone"]);
    expect(markers(ilse)).toContain("deathsaves");
    expect(state(ilse).status.deathSaves).toMatchObject({ successes: 0, failures: 0 });
    // Damage at 0: one failure; a critical hit two — with the third, "Mark dead?".
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 3 });
    const f1 = (await openPromptFor(ilse)) as DmPromptView;
    expect(f1.items.map((i) => i.key)).toEqual(["deathSaveFailures"]);
    await rq(dm, "prompt.resolve", { promptId: f1.id, apply: true });
    expect(state(ilse).status.deathSaves?.failures).toBe(1);
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 3, crit: true });
    const f2 = (await openPromptFor(ilse)) as DmPromptView;
    expect(f2.items.map((i) => i.key)).toEqual(["deathSaveFailures", "dying"]);
    // The DM keeps the failures but not the death (edits before applying).
    await rq(dm, "prompt.resolve", { promptId: f2.id, apply: true, keep: ["deathSaveFailures"] });
    expect(state(ilse).status.deathSaves).toMatchObject({ failures: 3, dead: false });
    // Massive damage: remaining damage at least the HP maximum → "Instant death?".
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 45 });
    const m = (await openPromptFor(ilse)) as DmPromptView;
    expect(m.items.map((i) => i.key)).toEqual(["down", "dying"]);
    expect(m.items[1]?.label).toBe("Instant death? (massive damage)");
    await rq(dm, "prompt.resolve", { promptId: m.id, apply: true, keep: ["down", "dying"] });
    expect(markers(ilse)).toContain("dead");
    await waitFor(() => room().state.tokens.get(ilse)?.dead === true);
  });

  it("healing a creature at 0 brings it round and clears its death saves (AC-HP-02)", async () => {
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 21 });
    const p = (await openPromptFor(ilse)) as DmPromptView;
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: true });
    await hpApply(dm, { targets: [ilse], kind: "heal", amount: 4 });
    expect(state(ilse).stats.hp).toBe(4);
    const r = (await openPromptFor(ilse)) as DmPromptView;
    expect(r.items.map((i) => i.key)).toEqual(["revive"]);
    await rq(dm, "prompt.resolve", { promptId: r.id, apply: true });
    // Unconscious (from 0 HP) goes; Prone stays until she stands up.
    expect(conditions(ilse)).toEqual(["prone"]);
    expect(state(ilse).status.deathSaves).toBeUndefined();
    expect(markers(ilse)).not.toContain("deathsaves");
  });

  it("Bloodied comes and goes at half HP by itself, when the campaign has it on (AC-HP-06)", async () => {
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 10 });
    expect(markers(ilse)).toContain("bloodied");
    await hpApply(dm, { targets: [ilse], kind: "heal", amount: 1 });
    expect(markers(ilse)).not.toContain("bloodied");
    await rq(dm, "campaign.update", { houseRules: { bloodied: false } });
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 5 });
    expect(markers(ilse)).not.toContain("bloodied");
    await rq(dm, "campaign.update", { houseRules: { bloodied: true } });
  });

  it("damage to a concentrating creature asks its owner for a CON save at max(10, half); a failure ends it, undoably (AC-HP-07)", async () => {
    await reset();
    await statusChange(anna().room, { tokenId: ilse, concentration: "Bless" });
    expect(state(ilse).status.concentration?.spellName).toBe("Bless");
    const before = cardsOf("Anna").length;
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 12 });
    const card = (await waitFor(() =>
      cardsOf("Anna")
        .slice(before)
        .find((c) => c.label.startsWith("Concentration")),
    )) as RequestCard;
    expect(card).toMatchObject({ label: "Concentration · Bless", dc: 10, targetId: ilse, state: "pending" });
    expect(card.formula).toMatch(/^1d20/);
    // 24 damage (10 of it taken by temporary HP, so she stays up): DC 12.
    await hpApply(dm, { targets: [ilse], kind: "heal", amount: 20 });
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 10 });
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 24 });
    const card2 = (await waitFor(() =>
      cardsOf("Anna")
        .slice(before)
        .find((c) => c.label.startsWith("Concentration") && c.dc === 12),
    )) as RequestCard;
    // She rolls low (entered): the DM is asked to end it (Assist).
    await rq(anna().room, "request.respond", {
      requestId: card2.requestId,
      target: ilse,
      action: "manual",
      total: 5,
    });
    const p = (await waitFor(() =>
      prompts().find((x) => x.tokenId === ilse && x.status === "open" && x.title.endsWith("concentration")),
    )) as DmPromptView;
    expect(p.items.map((i) => i.key)).toEqual(["concentrationEnds"]);
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: true });
    expect(state(ilse).status.concentration).toBeUndefined();
    // Undoable: the DM's Ctrl+Z brings it back.
    await rq(dm, "history.undo", {});
    expect(state(ilse).status.concentration?.spellName).toBe("Bless");
    // Becoming Incapacitated ends it too (asked).
    await statusChange(dm, { tokenId: ilse, add: [{ id: "stunned" }] });
    const q = (await waitFor(() =>
      prompts().find(
        (x) =>
          x.tokenId === ilse && x.status === "open" && x.items.some((i) => i.key === "concentrationEnds"),
      ),
    )) as DmPromptView;
    expect(q.items[0]?.label).toBe("Concentration ends (Stunned)");
    await rq(dm, "prompt.resolve", { promptId: q.id, apply: true });
    expect(state(ilse).status.concentration).toBeUndefined();
  });

  it("conditions and markers on and off, exhaustion's level, Exhaustion 6 asks Dead? (AC-HP-04, AC-HP-05)", async () => {
    await reset();
    await statusChange(anna().room, {
      tokenId: ilse,
      add: [{ id: "poisoned", source: "Giant spider" }, { id: "blessed" }],
    });
    expect(state(ilse).status.conditions).toEqual([{ id: "poisoned", source: "Giant spider" }]);
    expect(markers(ilse)).toContain("blessed");
    await statusChange(anna().room, { tokenId: ilse, remove: ["poisoned", "blessed"] });
    expect(conditions(ilse)).toEqual([]);
    // Players don't place the DM's custom markers, or on others' creatures.
    await expect(
      statusChange(anna().room, { tokenId: ilse, add: [{ id: "custom:hexed", label: "Hexed" }] }),
    ).rejects.toThrow(/FORBIDDEN/);
    const goblin = await npc("Goblin scout", 7);
    await expect(statusChange(bob().room, { tokenId: goblin, add: [{ id: "prone" }] })).rejects.toThrow(
      /FORBIDDEN|NOT_FOUND/,
    );
    await statusChange(dm, {
      tokenId: goblin,
      add: [{ id: "custom:hexed", label: "Hexed", color: "#7A3FA0" }],
    });
    expect(state(goblin).status.markers).toEqual([{ id: "custom:hexed", label: "Hexed", color: "#7A3FA0" }]);
    // Exhaustion is a level on the character (and its sheet).
    await statusChange(dm, { tokenId: ilse, exhaustion: 3 });
    expect(state(ilse).status.exhaustion).toBe(3);
    expect(room().model.get("actor", ilseActor)?.status).toMatchObject({ exhaustion: 3 });
    await statusChange(dm, { tokenId: ilse, exhaustion: 6 });
    const p = (await openPromptFor(ilse)) as DmPromptView;
    expect(p.items[0]?.label).toBe("Dead? (Exhaustion 6)");
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: false });
  });

  it("a player's damage to another creature waits on the DM, who may edit it; to their own, it applies (house rule, AC-HP-12)", async () => {
    const goblin = await npc("Goblin archer", 10);
    // Bob can see it (it's on the board, not hidden).
    const r = await hpApply<{ applied: number; sent: number }>(bob().room, {
      targets: [goblin],
      kind: "damage",
      parts: [{ amount: 6, type: "piercing" }],
      label: "Shortbow",
    });
    expect(r).toEqual({ applied: 0, sent: 1 });
    expect(state(goblin).stats.hp).toBe(10);
    const p = (await waitFor(() =>
      prompts().find((x) => x.tokenId === goblin && x.kind === "playerDamage"),
    )) as DmPromptView;
    expect(p.damage).toMatchObject({
      byName: "Bob",
      parts: [{ amount: 6, type: "piercing" }],
      label: "Shortbow",
    });
    // The DM makes it 4.
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: true, total: 4, keep: [] });
    expect(state(goblin).stats.hp).toBe(6);
    await waitFor(() => bob().msgs.find((m) => m.type === "prompt.decided"));
    // A token Bob can't see is not there for him.
    const hidden = await npc("Lurker", 10);
    await rq(dm, "token.update", { tokenId: hidden, hidden: true });
    await sleep(50);
    await expect(hpApply(bob().room, { targets: [hidden], kind: "damage", amount: 3 })).rejects.toThrow(
      /NOT_FOUND/,
    );
    // Anna heals her own character: straight on.
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 6 });
    await hpApply(anna().room, { targets: [ilse], kind: "heal", amount: 4 });
    expect(state(ilse).stats.hp).toBe(18);
    // "Direct": a player's damage to others applies at once.
    await rq(dm, "campaign.update", { houseRules: { playerDamage: "direct" } });
    await hpApply(bob().room, { targets: [goblin], kind: "damage", amount: 2 });
    expect(state(goblin).stats.hp).toBe(4);
    await rq(dm, "campaign.update", { houseRules: { playerDamage: "viaDm" } });
  });

  it("the DM decides in the preview: no prompt for what they've already chosen (AC-HP-12)", async () => {
    const bandit = await npc("Bandit", 11);
    const n = prompts().length;
    await hpApply(dm, {
      targets: [bandit],
      kind: "damage",
      amount: 15,
      decide: { [bandit]: { keep: ["npcAtZero"], choices: { npcAtZero: "unconscious" } } },
    });
    expect(conditions(bandit)).toContain("unconscious");
    await sleep(100);
    expect(prompts().filter((p) => p.tokenId === bandit)).toHaveLength(0);
    expect(prompts().length).toBe(n);
  });

  it("Auto: what follows applies at once (a death is still the DM's call); Manual: none of it", async () => {
    await rq(dm, "campaign.update", { houseRules: { automation: "auto" } });
    const zombie = await npc("Zombie", 8);
    await hpApply(dm, { targets: [zombie], kind: "damage", amount: 10 });
    expect(markers(zombie)).toContain("dead");
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 22 });
    expect(conditions(ilse)).toEqual(["unconscious", "prone"]);
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 45 });
    const p = (await openPromptFor(ilse)) as DmPromptView;
    expect(p.items.map((i) => i.key)).toEqual(["dying"]);
    await rq(dm, "prompt.resolve", { promptId: p.id, apply: false });
    await rq(dm, "campaign.update", { houseRules: { automation: "manual" } });
    await reset();
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 22 });
    expect(conditions(ilse)).toEqual([]);
    await sleep(100);
    expect(prompts().filter((x) => x.tokenId === ilse && x.status === "open")).toHaveLength(0);
    await rq(dm, "campaign.update", { houseRules: { automation: "assist" } });
  });

  it("undoing the damage closes the prompt it raised", async () => {
    const kobold = await npc("Kobold", 5);
    await hpApply(dm, { targets: [kobold], kind: "damage", amount: 6 });
    const p = (await openPromptFor(kobold)) as DmPromptView;
    await rq(dm, "history.undo", {});
    expect(state(kobold).stats.hp).toBe(5);
    await waitFor(() => prompts().find((x) => x.id === p.id)?.status === "skipped");
    await expect(rq(dm, "prompt.resolve", { promptId: p.id, apply: true })).rejects.toThrow(/CONFLICT/);
  });

  it("rolls: a condition's advantage or disadvantage comes on the card, applied unless the roller sets it aside; Exhaustion takes 2 × its level off D20 Tests (AC-DICE-11, AC-HP-05)", async () => {
    await reset();
    await statusChange(dm, { tokenId: ilse, add: [{ id: "poisoned" }] });
    const n = cardsOf("Anna").length;
    const { requestId } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [ilse],
      type: "check",
      skill: "perception",
    });
    const card = (await waitFor(() =>
      cardsOf("Anna")
        .slice(n)
        .find((c) => c.requestId === requestId),
    )) as RequestCard;
    expect(card.hint).toEqual({ mode: "dis", from: ["Poisoned"] });
    // Rolled as hinted: the formula carries the disadvantage.
    const rolls = () =>
      anna()
        .msgs.filter((m) => m.type === "roll.result")
        .map((m) => m.payload as { formula: string });
    const before = rolls().length;
    await rq(anna().room, "request.respond", { requestId, target: ilse, action: "roll" });
    expect((await waitFor(() => rolls()[before]))?.formula).toMatch(/ dis$/);
    // Set aside: a plain roll.
    const { requestId: r2 } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [ilse],
      type: "check",
      skill: "perception",
    });
    await waitFor(() => cardsOf("Anna").find((c) => c.requestId === r2));
    await rq(anna().room, "request.respond", {
      requestId: r2,
      target: ilse,
      action: "roll",
      ignoreHints: true,
    });
    expect((await waitFor(() => rolls()[before + 1]))?.formula).not.toMatch(/dis/);
    // Paralyzed: Dexterity saves fail outright (the card says so).
    await statusChange(dm, { tokenId: ilse, remove: ["poisoned"], add: [{ id: "paralyzed" }] });
    const { requestId: r3 } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [ilse],
      type: "save",
      ability: "dex",
    });
    const c3 = (await waitFor(() => cardsOf("Anna").find((c) => c.requestId === r3))) as RequestCard;
    expect(c3.autoFail).toEqual(["Paralyzed"]);
    await statusChange(dm, { tokenId: ilse, remove: ["paralyzed"] });
    // Exhaustion 2: −4 on every D20 Test, whether asked for or rolled from the sheet.
    await statusChange(dm, { tokenId: ilse, exhaustion: 2 });
    const { requestId: r4 } = await rq<{ requestId: string }>(dm, "request.create", {
      targets: [ilse],
      type: "save",
      ability: "con",
    });
    const c4 = (await waitFor(() => cardsOf("Anna").find((c) => c.requestId === r4))) as RequestCard;
    expect(c4.formula).toMatch(/ - 4$/);
    await sleep(250);
    await rq(anna().room, "dice.roll", {
      formula: "1d20 + @dex",
      label: "Dexterity check",
      context: { actorId: ilseActor },
    });
    expect((await waitFor(() => rolls().at(-1)?.formula.endsWith("- 4") && rolls().at(-1)))?.formula).toMatch(
      /^1d20 \+ @dex - 4$/,
    );
    // Damage isn't a D20 Test: untouched.
    await rq(anna().room, "dice.roll", { formula: "2d6 + 3", context: { actorId: ilseActor } });
    expect((await waitFor(() => rolls().at(-1)?.formula === "2d6 + 3" && rolls().at(-1)))?.formula).toBe(
      "2d6 + 3",
    );
    // Its speed shows 10 ft less (−5 ft a level).
    await waitFor(() => room().state.tokens.get(ilse)?.own?.budgetFt === 20);
    await statusChange(dm, { tokenId: ilse, exhaustion: 0 });
  });

  it("Dodging: its Dexterity save card comes with advantage; not once it's Grappled (Speed 0) or Incapacitated — Dodge's benefits lapse (SRD 5.2.1 p. 181; rules audit A10)", async () => {
    await reset();
    await statusChange(dm, { tokenId: ilse, add: [{ id: "dodging" }] });
    const dexCard = async (ability = "dex") => {
      await sleep(250);
      const { requestId } = await rq<{ requestId: string }>(dm, "request.create", {
        targets: [ilse],
        type: "save",
        ability,
      });
      return (await waitFor(() => cardsOf("Anna").find((c) => c.requestId === requestId))) as RequestCard;
    };
    expect((await dexCard()).hint).toEqual({ mode: "adv", from: ["Dodging"] });
    expect((await dexCard("wis")).hint).toBeUndefined();
    await statusChange(dm, { tokenId: ilse, add: [{ id: "grappled" }] });
    expect((await dexCard()).hint).toBeUndefined();
    await statusChange(dm, { tokenId: ilse, remove: ["grappled"], add: [{ id: "incapacitated" }] });
    expect((await dexCard()).hint).toBeUndefined();
    await statusChange(dm, { tokenId: ilse, remove: ["incapacitated", "dodging"] });
  });

  it("rests: a long rest as the DM kept it, one undoable step; a short rest's Hit Dice on the player's cards, one die at a time (AC-HP-13)", async () => {
    await reset();
    await rq(dm, "actor.change", {
      actorId: ilseActor,
      changes: [
        { path: ["core", "hitDice"], after: [{ die: "d8", total: 3, used: 2 }] },
        {
          path: ["core", "features"],
          after: [
            { name: "Second Wind", uses: { max: 1, used: 1, recharge: "short" } },
            { name: "Cunning Plan", uses: { max: 2, used: 2, recharge: "long" } },
          ],
        },
      ],
    });
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 12 });
    await hpApply(dm, { targets: [ilse], kind: "temp", amount: 4 });
    await statusChange(dm, { tokenId: ilse, exhaustion: 2 });
    const sheetOf = () => (room().model.get("actor", ilseActor) as { sheet: Record<string, unknown> }).sheet;
    // Long: everything but the temporary HP (the DM unticked that).
    await rq(dm, "rest.apply", {
      kind: "long",
      actors: { [ilseActor]: ["hp", "hitDice", "features", "exhaustion"] },
    });
    expect(state(ilse).stats).toMatchObject({ hp: 20, hpTemp: 4 });
    expect(state(ilse).status.exhaustion).toBe(1);
    const core = () =>
      sheetOf().core as { hitDice: { used: number }[]; features: { uses: { used: number } }[] };
    expect(core().hitDice[0]?.used).toBe(0);
    expect(core().features.map((f) => f.uses.used)).toEqual([0, 0]);
    // One step: the DM's Ctrl+Z takes it all back.
    await rq(dm, "history.undo", {});
    expect(state(ilse).stats.hp).toBe(8);
    expect(state(ilse).status.exhaustion).toBe(2);
    expect(core().hitDice[0]?.used).toBe(2);
    // Short: the short-rest uses back, and Anna's card to spend her one Hit Die left.
    const n = cardsOf("Anna").length;
    const r = await rq<{ rested: string[]; cards: string[] }>(dm, "rest.apply", {
      kind: "short",
      actors: { [ilseActor]: ["hitDiceCards", "features"] },
    });
    expect(r).toEqual({ rested: [ilseActor], cards: [ilseActor] });
    expect(core().features.map((f) => f.uses.used)).toEqual([0, 2]);
    const card = (await waitFor(() =>
      cardsOf("Anna")
        .slice(n)
        .find((c) => c.label.startsWith("Spend a Hit Die")),
    )) as RequestCard;
    expect(card).toMatchObject({ label: "Spend a Hit Die (d8, 1 left)", formula: "1d8" });
    // She rolled a 1 (and Con +0): still 1 HP back (SRD 5.2.1 p. 187).
    await rq(anna().room, "request.respond", {
      requestId: card.requestId,
      target: card.targetId,
      action: "manual",
      total: 0,
    });
    expect(state(ilse).stats.hp).toBe(9);
    expect(core().hitDice[0]?.used).toBe(3);
    // No dice left: no more cards (each card as Anna last heard of it).
    await sleep(150);
    const latest = new Map<string, RequestCard>();
    for (const c of cardsOf("Anna")) latest.set(`${c.requestId}|${c.targetId}`, c);
    expect(
      [...latest.values()].filter((c) => c.label.startsWith("Spend a Hit Die") && c.state === "pending"),
    ).toHaveLength(0);
    // At 0 HP no one rests.
    await hpApply(dm, { targets: [ilse], kind: "damage", amount: 30, decide: { [ilse]: { keep: [] } } });
    await expect(rq(dm, "rest.apply", { kind: "long", actors: { [ilseActor]: ["hp"] } })).rejects.toThrow(
      /INVALID/,
    );
    // Players don't rest the party.
    await expect(
      rq(anna().room, "rest.apply", { kind: "long", actors: { [ilseActor]: ["hp"] } }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("death saves outside combat: the DM asks, the owner rolls — a success, a 1 is two failures, a 20 is back on her feet (§8.11)", async () => {
    await reset();
    await hpApply(dm, {
      targets: [ilse],
      kind: "damage",
      amount: 25,
      decide: { [ilse]: { keep: ["down"] } },
    });
    expect(markers(ilse)).toContain("deathsaves");
    const ask = async () => {
      const n = cardsOf("Anna").length;
      await sleep(520); // (paced: the DM asks at most 2 a second)
      await rq(dm, "death.request", { targets: [ilse] });
      return (await waitFor(() =>
        cardsOf("Anna")
          .slice(n)
          .find((c) => c.label === "Death saving throw"),
      )) as RequestCard;
    };
    const c1 = await ask();
    expect(c1).toMatchObject({ dc: 10, formula: "1d20", deathSaves: { successes: 0, failures: 0 } });
    await rq(anna().room, "request.respond", {
      requestId: c1.requestId,
      target: ilse,
      action: "manual",
      total: 14,
    });
    expect(state(ilse).status.deathSaves).toMatchObject({ successes: 1, failures: 0 });
    const c2 = await ask();
    expect(c2.deathSaves).toEqual({ successes: 1, failures: 0 });
    await rq(anna().room, "request.respond", {
      requestId: c2.requestId,
      target: ilse,
      action: "manual",
      total: 1,
    });
    expect(state(ilse).status.deathSaves).toMatchObject({ successes: 1, failures: 2 });
    const c3 = await ask();
    await rq(anna().room, "request.respond", {
      requestId: c3.requestId,
      target: ilse,
      action: "manual",
      total: 20,
    });
    expect(state(ilse).stats.hp).toBe(1);
    expect(conditions(ilse)).toEqual(["prone"]);
    expect(state(ilse).status.deathSaves).toBeUndefined();
    await waitFor(() => anna().msgs.find((m) => m.type === "health.notice"));
    // No one else dying: nothing to ask.
    await expect(rq(dm, "death.request", { targets: [ilse] })).rejects.toThrow(/INVALID/);
    // Three successes: stable.
    await hpApply(dm, {
      targets: [ilse],
      kind: "damage",
      amount: 5,
      decide: { [ilse]: { keep: ["down"] } },
    });
    for (let i = 0; i < 3; i++) {
      const c = await ask();
      await rq(anna().room, "request.respond", {
        requestId: c.requestId,
        target: ilse,
        action: "manual",
        total: 12,
      });
    }
    expect(markers(ilse)).toContain("stable");
    expect(state(ilse).status.deathSaves?.stable).toBe(true);
    // Three failures: the DM is asked "Mark dead?".
    await reset();
    await hpApply(dm, {
      targets: [ilse],
      kind: "damage",
      amount: 25,
      decide: { [ilse]: { keep: ["down"] } },
    });
    for (let i = 0; i < 3; i++) {
      const c = await ask();
      await rq(anna().room, "request.respond", {
        requestId: c.requestId,
        target: ilse,
        action: "manual",
        total: 4,
      });
    }
    const p = (await openPromptFor(ilse)) as DmPromptView;
    expect(p.items[0]?.label).toBe("Mark dead? (three failed death saves)");
    expect(p.items[0]?.choices?.map((c) => c.label)).toEqual(["Dead", "Keep dying"]);
  });
});
