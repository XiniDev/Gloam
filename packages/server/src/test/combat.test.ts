import type { Room } from "@colyseus/sdk";
import { dist } from "@gloam/shared/geometry";
import type { CombatView, RequestCard } from "@gloam/shared/protocol";
import { effectiveTokenState } from "@gloam/shared/rules";
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
  payload: unknown;
}

describe("P8 — combat on the server (§8.12, §16.5)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let sceneId = "";
  const dmMsgs: Msg[] = [];
  const players: Record<string, { room: TableRoomClient; id: string; msgs: Msg[] }> = {};
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const combat = () =>
    room()
      .model.inScene("combat", sceneId)
      .find((c) => c.active);
  const data = () => dataOf(combat() as NonNullable<ReturnType<typeof combat>>);
  const tokenOf = (id: string) => room().model.get("token", id);
  const statusOf = (id: string) => {
    const tk = room().model.get("token", id);
    if (!tk) throw new Error(`no token ${id}`);
    const a = tk.actorId ? room().model.get("actor", tk.actorId) : undefined;
    return effectiveTokenState(tk, a && tk.link === "linked" ? a : undefined).status;
  };
  const lastView = (msgs: Msg[]) =>
    [...msgs].reverse().find((m) => m.type === "combat.view")?.payload as CombatView | undefined;
  const anna = () => players.Anna as { room: TableRoomClient; id: string; msgs: Msg[] };
  // Commands are rate-limited (§13.5): paced as a DM clicks.
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(120);
    return rq<T>(r, type, payload);
  };

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
  async function npc(name: string, pos: { x: number; y: number }, extra: Record<string, unknown> = {}) {
    const { tokenId } = await cmd<{ tokenId: string }>(dm, "token.create", {
      sceneId,
      name,
      pos,
      disposition: "hostile",
      stats: { hp: 10, hpMax: 10, ac: 12, ...extra },
    });
    return tokenId;
  }
  let hero = "";
  let heroActor = "";

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "8080" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, payload) => dmMsgs.push({ type: String(type), payload }));
    await admit("Anna");
    ({ sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Arena",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 80,
      heightFt: 60,
    }));
    heroActor = (
      await rq<{ actorId: string }>(anna().room, "actor.quickCreate", { name: "Brin", hpMax: 20, ac: 15 })
    ).actorId;
    await rq(dm, "scene.activate", { sceneId });
    hero = (
      await waitFor(() =>
        room()
          .model.inScene("token", sceneId)
          .find((x) => x.actorId === heroActor),
      )
    ).id;
    await sleep(100);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("quick start: everyone not hidden, players' cards, the NPCs rolled at once — one roll for identical ones; turns begin when all are in (AC-CMB-01/02/03/11)", async () => {
    const g1 = await npc("Goblin 1", { x: 40, y: 20 }, { dexMod: 2 });
    const g2 = await npc("Goblin 2", { x: 44, y: 20 }, { dexMod: 2 });
    const hidden = await npc("Lurker", { x: 60, y: 40 });
    await cmd(dm, "token.update", { tokenId: hidden, hidden: true });
    await cmd(dm, "combat.quickStart", {});
    const d0 = data();
    expect(d0.combatants.map((e) => e.tokenId).sort()).toEqual([hero, g1, g2].sort());
    // Identical goblins share a group and one roll; the goblins are rolled already.
    await waitFor(() => data().combatants.find((e) => e.tokenId === g1)?.initiative !== null);
    const a = data().combatants.find((e) => e.tokenId === g1);
    const b = data().combatants.find((e) => e.tokenId === g2);
    expect(a?.group).toBeDefined();
    expect(a?.group).toBe(b?.group);
    expect(a?.initiative).toBe(b?.initiative);
    expect(data().begun).toBe(false);
    // Anna's initiative card, with its formula.
    const card = await waitFor(() =>
      anna()
        .msgs.filter((m) => m.type === "request.card")
        .map((m) => m.payload as RequestCard)
        .find((c) => c.label.startsWith("Initiative") && c.targetId === hero),
    );
    expect(card.formula).toMatch(/^1d20/);
    await cmd(anna().room, "request.respond", {
      requestId: card.requestId,
      target: hero,
      action: "manual",
      total: 17,
    });
    // All in: turns begin, highest first.
    await waitFor(() => data().begun);
    expect(data().combatants.find((e) => e.tokenId === hero)?.initiative).toBe(17);
    const order = data().combatants.map((e) => e.initiative ?? -99);
    expect([...order].sort((x, y) => y - x)).toEqual(order);
    expect(combat()?.round).toBe(1);
  });

  it("the tracker: the DM sees everyone; a player the combatants they perceive, their own marked (AC-CMB-04)", async () => {
    const dmView = await waitFor(() => {
      const v = lastView(dmMsgs);
      return v?.begun ? v : undefined;
    });
    expect(dmView.entries.length).toBe(3);
    expect(dmView.activeIndex).toBeGreaterThanOrEqual(0);
    const annaView = await waitFor(() => {
      const v = lastView(anna().msgs);
      return v?.begun ? v : undefined;
    });
    const mine = annaView.entries.find((e) => e.tokenId === hero);
    expect(mine?.mine).toBe(true);
    // No "Unknown" placeholders (the count isn't revealed), and never an id for what she doesn't perceive.
    expect(annaView.entries.every((e) => !e.unknown)).toBe(true);
    expect(room().state.combat.active).toBe(true);
  });

  /** Steps the turns (as the DM) until it's this creature's. */
  async function turnOf(tokenId: string) {
    for (let i = 0; i < 12; i++) {
      const c = combat();
      if (c && data().combatants[c.turnIndex]?.tokenId === tokenId) return;
      await cmd(dm, "combat.next", {});
    }
    throw new Error(`never ${tokenId}'s turn`);
  }
  const move = (r: TableRoomClient, tokenId: string, to: { x: number; y: number }) => {
    const from = tokenOf(tokenId)?.pos as { x: number; y: number };
    return cmd<{ cost: number; points: { x: number; y: number }[] }>(r, "move.commit", {
      tokenId,
      points: [from, to],
    });
  };
  const own = (id: string) => room().state.tokens.get(id)?.own;

  it("in combat a player moves only on their creature's turn, within its budget: clamped by default, refused when the house rule says reject (AC-CMB-06, AC-MOV-04, AC-MOV-07)", async () => {
    // Not Brin's turn: refused.
    const c = combat();
    if (c && data().combatants[c.turnIndex]?.tokenId === hero) await cmd(dm, "combat.next", {});
    await expect(move(anna().room, hero, { x: 22, y: 30 })).rejects.toThrow(/turn/i);
    await turnOf(hero);
    const start = { ...(tokenOf(hero)?.pos as { x: number; y: number }) };
    // Toward the middle of the scene, whichever side Brin stands.
    const dir = start.x < 40 ? 1 : -1;
    // Its budget in its controller's view (30 ft).
    await waitFor(() => own(hero)?.budgetFt === 30);
    // 20 ft: fine; then 20 more is past the 10 left — clamped at the max reach.
    await move(anna().room, hero, { x: start.x + dir * 20, y: start.y });
    expect(data().turn?.usedFt).toBeCloseTo(20, 1);
    await waitFor(() => Math.abs((own(hero)?.usedFt ?? 0) - 20) < 0.1);
    const r = await move(anna().room, hero, { x: start.x + dir * 40, y: start.y });
    expect(r.cost).toBeCloseTo(10, 1);
    expect(tokenOf(hero)?.pos.x).toBeCloseTo(start.x + dir * 30, 1);
    // Reset: back where the turn began, the whole budget again (AC-MOV-05).
    await cmd(anna().room, "move.reset", { tokenId: hero });
    expect(tokenOf(hero)?.pos).toEqual(start);
    expect(data().turn?.usedFt).toBe(0);
    // "Overlong moves: reject": a move past the budget is refused, with why.
    await cmd(dm, "campaign.update", { houseRules: { overlongMoves: "reject" } });
    await expect(move(anna().room, hero, { x: start.x + dir * 40, y: start.y })).rejects.toThrow(
      /40 ft; 30 ft/,
    );
    await cmd(dm, "campaign.update", { houseRules: { overlongMoves: "clamp" } });
    // The DM's move ignores the budget (unless it counts as movement).
    await move(dm, hero, { x: start.x + dir * 35, y: start.y });
    expect(data().turn?.usedFt).toBe(0);
    // With "Count as movement" ticked for the creature, the DM's move spends its movement like its player's would.
    await cmd(dm, "token.update", { tokenId: hero, overrides: { countAsMovement: true } });
    await move(dm, hero, { x: start.x + dir * 25, y: start.y });
    expect(data().turn?.usedFt).toBeCloseTo(10, 1);
    await cmd(dm, "token.update", { tokenId: hero, overrides: { countAsMovement: false } });
    await cmd(dm, "move.reset", { tokenId: hero });
  });

  it("AC-MOV-06: Ctrl/Cmd+Z after a move undoes only its last segment and gives back what it cost", async () => {
    await turnOf(hero);
    const start = { ...(tokenOf(hero)?.pos as { x: number; y: number }) };
    const dir = start.x < 40 ? 1 : -1;
    // Two segments: 10 ft, then 15 more.
    await move(anna().room, hero, { x: start.x + dir * 10, y: start.y });
    await move(anna().room, hero, { x: start.x + dir * 25, y: start.y });
    expect(data().turn?.usedFt).toBeCloseTo(25, 1);
    // Undo: back to the end of the first, its 15 ft refunded — the first segment stands.
    await cmd(anna().room, "history.undo", {});
    expect(tokenOf(hero)?.pos.x).toBeCloseTo(start.x + dir * 10, 1);
    expect(data().turn?.usedFt).toBeCloseTo(10, 1);
    await waitFor(() => Math.abs((own(hero)?.usedFt ?? 0) - 10) < 0.1);
    // Again: the first one too, the whole budget back.
    await cmd(anna().room, "history.undo", {});
    expect(tokenOf(hero)?.pos).toEqual(start);
    expect(data().turn?.usedFt).toBeCloseTo(0, 1);
  });

  it("an attack from the app marks the creature's Action, once; the pips can be toggled by hand (AC-CMB-08)", async () => {
    await turnOf(hero);
    expect(data().pips[hero] ?? 0).toBe(0);
    // Brin's player attacks from the sheet: the Action is marked.
    await cmd(anna().room, "dice.roll", {
      formula: "1d20 + 5",
      purpose: "attack",
      context: { tokenId: hero },
    });
    await waitFor(() => ((data().pips[hero] ?? 0) & 1) === 1);
    // A second swing (Extra Attack) is the same Action.
    await cmd(anna().room, "dice.roll", {
      formula: "1d20 + 5",
      purpose: "attack",
      context: { tokenId: hero },
    });
    expect(data().pips[hero]).toBe(1);
    // An ordinary roll marks nothing; the Bonus Action by hand, and back.
    await cmd(anna().room, "dice.roll", { formula: "1d20 + 2", context: { tokenId: hero } });
    expect(data().pips[hero]).toBe(1);
    await cmd(anna().room, "combat.pip", { tokenId: hero, pip: "bonus", used: true });
    expect(data().pips[hero]).toBe(3);
    await cmd(anna().room, "combat.pip", { tokenId: hero, pip: "bonus", used: false });
    expect(data().pips[hero]).toBe(1);
    // Not its turn: an attack marks nothing (it's someone else's Action, or a reaction the player marks).
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    const other = data().combatants[combat()?.turnIndex ?? 0]?.tokenId as string;
    const before = data().pips[other] ?? 0;
    await cmd(anna().room, "dice.roll", {
      formula: "1d20 + 5",
      purpose: "attack",
      context: { tokenId: hero },
    });
    await sleep(150);
    expect(data().pips[other] ?? 0).toBe(before);
  });

  it("Dash adds its speed; standing up costs half; Prone crawls at double; a Speed-0 condition refuses the move with why (AC-MOV-09)", async () => {
    await turnOf(hero);
    await cmd(anna().room, "move.dash", { tokenId: hero });
    await waitFor(() => own(hero)?.budgetFt === 60);
    expect(data().pips[hero]).toBe(1); // the action, used by the Dash
    await cmd(dm, "status.change", { tokenId: hero, add: [{ id: "prone" }] });
    await cmd(anna().room, "move.stand", { tokenId: hero });
    expect(data().turn?.usedFt).toBe(15);
    expect(statusOf(hero).conditions.some((x) => x.id === "prone")).toBe(false);
    // Crawling (prone again): 5 ft of ground costs 10.
    await cmd(dm, "status.change", { tokenId: hero, add: [{ id: "prone" }] });
    const at = tokenOf(hero)?.pos as { x: number; y: number };
    const r = await move(anna().room, hero, { x: at.x, y: at.y + 5 });
    expect(r.cost).toBeCloseTo(10, 1);
    await cmd(dm, "status.change", { tokenId: hero, remove: ["prone"], add: [{ id: "grappled" }] });
    // Refused with why, in §8.6's words — and the player's view says so before they try (the action bar).
    await expect(move(anna().room, hero, { x: at.x, y: at.y + 10 })).rejects.toThrow(/can't move — Grappled/);
    await waitFor(() => own(hero)?.stuck === "grappled");
    await cmd(dm, "status.change", { tokenId: hero, remove: ["grappled"] });
    await waitFor(() => own(hero)?.stuck === "");
    await cmd(anna().room, "move.reset", { tokenId: hero });
    // Dash is an action: none while Incapacitated (SRD 5.2.1 p. 184; rules audit A11).
    await cmd(dm, "status.change", { tokenId: hero, add: [{ id: "incapacitated" }] });
    await expect(cmd(anna().room, "move.dash", { tokenId: hero })).rejects.toThrow(
      /is Incapacitated: it can't Dash/,
    );
    await cmd(dm, "status.change", { tokenId: hero, remove: ["incapacitated"] });
  });

  it("Disengage and Dodge (rules audit C3): each takes the Action; Disengaged goes as the turn ends, Dodging at the start of the next", async () => {
    const markers = () => statusOf(hero).markers.map((m) => m.id as string);
    await turnOf(hero);
    await cmd(anna().room, "move.disengage", { tokenId: hero });
    expect(data().pips[hero] ?? 0).toBe(1);
    expect(markers()).toContain("disengaged");
    await cmd(anna().room, "move.dodge", { tokenId: hero });
    expect(markers()).toEqual(expect.arrayContaining(["disengaged", "dodging"]));
    // Its turn ends: Disengaged gone, Dodging still on (until the start of its next turn).
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    await waitFor(() => !markers().includes("disengaged"));
    expect(markers()).toContain("dodging");
    // Round to its turn again: Dodging gone as it starts.
    await turnOf(hero);
    await waitFor(() => !markers().includes("dodging"));
    // Not its turn: refused (its own turn's action).
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    await expect(cmd(anna().room, "move.dodge", { tokenId: hero })).rejects.toThrow(/NOT_YOUR_TURN|turn/);
  });

  it("rules audit A3: a flight needs a fly speed and pays its 3D length, held to the budget; height in a fight is movement", async () => {
    await turnOf(hero);
    await cmd(anna().room, "move.reset", { tokenId: hero });
    const at = { ...(tokenOf(hero)?.pos as { x: number; y: number }) };
    const across = { x: at.x + 15, y: at.y };
    // No fly speed: no flight, no height by walking, no rising by the stepper.
    await expect(
      cmd(anna().room, "move.commit", {
        tokenId: hero,
        points: [at, across],
        mode: "fly",
        elevations: [0, 20],
      }),
    ).rejects.toThrow(/can't fly/);
    await expect(
      cmd(anna().room, "move.commit", {
        tokenId: hero,
        points: [at, across],
        mode: "walk",
        elevations: [0, 20],
      }),
    ).rejects.toThrow(/Only a flight/);
    await expect(cmd(anna().room, "token.elevation", { tokenId: hero, delta: 20 })).rejects.toThrow(
      /can't fly/,
    );
    // Brin gains a flying speed.
    await cmd(anna().room, "actor.change", {
      actorId: heroActor,
      changes: [{ path: ["core", "speeds", "fly"], after: 30 }],
    });
    // 15 ft across while climbing 20: 25 ft of movement (3-4-5), not 15.
    const used0 = data().turn?.usedFt ?? 0;
    await cmd(anna().room, "move.commit", {
      tokenId: hero,
      points: [at, across],
      mode: "fly",
      elevations: [0, 20],
    });
    expect((data().turn?.usedFt ?? 0) - used0).toBeCloseTo(25, 1);
    expect(tokenOf(hero)?.elevation).toBe(20);
    // Further than what's left: clamped (the default) — it stops where the budget runs out, no more spent.
    const left = (own(hero)?.budgetFt ?? 0) - (data().turn?.usedFt ?? 0);
    const from = { ...(tokenOf(hero)?.pos as { x: number; y: number }) };
    await cmd(anna().room, "move.commit", {
      tokenId: hero,
      // (Toward the arena's far side, whichever way that is: 80 ft wide.)
      points: [from, { x: from.x + (from.x < 40 ? 1 : -1) * Math.min(left + 20, 35), y: from.y }],
      mode: "fly",
      elevations: [20, 20],
    });
    expect(data().turn?.usedFt ?? 0).toBeLessThanOrEqual((own(hero)?.budgetFt ?? 0) + 0.05);
    expect(dist(tokenOf(hero)?.pos as { x: number; y: number }, from)).toBeLessThan(left + 0.5);
    // The stepper spends what it rises (none left now: refused, with why).
    await expect(cmd(anna().room, "token.elevation", { tokenId: hero, delta: 5 })).rejects.toThrow(
      /movement left/,
    );
    await cmd(anna().room, "move.reset", { tokenId: hero });
    const before = data().turn?.usedFt ?? 0;
    await cmd(anna().room, "token.elevation", { tokenId: hero, delta: 10 });
    expect((data().turn?.usedFt ?? 0) - before).toBe(10);
    // Grappled: no rising either.
    await cmd(dm, "status.change", { tokenId: hero, add: [{ id: "grappled" }] });
    await expect(cmd(anna().room, "token.elevation", { tokenId: hero, delta: 5 })).rejects.toThrow(
      /Grappled/,
    );
    await cmd(dm, "status.change", { tokenId: hero, remove: ["grappled"] });
    await cmd(anna().room, "move.reset", { tokenId: hero });
    await cmd(dm, "token.elevation", { tokenId: hero, elevation: 0 });
    await cmd(anna().room, "actor.change", {
      actorId: heroActor,
      changes: [{ path: ["core", "speeds", "fly"], after: 0 }],
    });
  });

  it("the DM's bonus movement joins the budget (never doubled by Dash) and shows as its own part; free movement lifts turn order (AC-MOV-18, AC-CMB-11)", async () => {
    await turnOf(hero);
    // "+10 ft for this turn": the server fixes its end at this round.
    await cmd(dm, "token.update", { tokenId: hero, overrides: { bonusMove: { ft: 10, until: "turn" } } });
    expect(tokenOf(hero)?.overrides.bonusMove?.untilRound).toBe(combat()?.round);
    await waitFor(() => own(hero)?.bonusMoveFt === 10);
    // This turn: 30 + 10 (a Dash, if any, doubles only the 30).
    const d = own(hero);
    expect((d?.budgetFt ?? 0) - (d?.bonusMoveFt ?? 0)).toBe(30 * (1 + (d?.dashes ?? 0)));
    // The turn ends: a "this turn" grant is gone.
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    await waitFor(() => tokenOf(hero)?.overrides.bonusMove === undefined);
    // Free movement: Brin moves out of turn.
    await cmd(dm, "combat.freeMovement", { on: true });
    const at = tokenOf(hero)?.pos as { x: number; y: number };
    await move(anna().room, hero, { x: at.x, y: at.y + 5 });
    await cmd(dm, "combat.freeMovement", { on: false });
    await expect(move(anna().room, hero, { x: at.x, y: at.y })).rejects.toThrow(/turn/i);
  });

  it('a turn\'s start: its pips cleared (the Reaction only on its own turn), "your turn" to its player, the hazards it stands in to the DM, at its end too (AC-CMB-05, AC-CMB-08, AC-WAL-05)', async () => {
    await turnOf(hero);
    // Brin's Reaction used on its turn; the next creature's turn doesn't give it back, Brin's next turn does.
    await cmd(anna().room, "combat.pip", { tokenId: hero, pip: "reaction", used: true });
    expect(data().pips[hero]).toBe(4);
    const at = tokenOf(hero)?.pos as { x: number; y: number };
    await cmd(dm, "zone.create", {
      sceneId,
      kind: "hazard",
      label: "Smouldering coals",
      shape: { kind: "rect", x: at.x - 3, y: at.y - 3, w: 6, h: 6 },
      triggers: [
        { when: "startTurn", label: "The coals burn", damage: { formula: "1d4", type: "fire" } },
        { when: "endTurn", label: "Smoke chokes you", save: { ability: "con", dc: 10, onSuccess: "none" } },
      ],
    });
    dmMsgs.length = 0;
    anna().msgs.length = 0;
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    const end = await waitFor(() =>
      dmMsgs.find(
        (m) =>
          m.type === "hazard.prompt" &&
          (m.payload as { prompts: { when: string }[] }).prompts.some((p) => p.when === "endTurn"),
      ),
    );
    expect((end.payload as { tokenId: string }).tokenId).toBe(hero);
    expect(data().pips[hero]).toBe(4);
    await turnOf(hero);
    // Its own turn again: every pip back, Anna told it's hers, the coals prompt the DM.
    expect(data().pips[hero]).toBe(0);
    await waitFor(() =>
      anna().msgs.find((m) => m.type === "combat.turn" && (m.payload as { yours: boolean }).yours),
    );
    await waitFor(() =>
      dmMsgs.find(
        (m) =>
          m.type === "hazard.prompt" &&
          (m.payload as { prompts: { when: string }[] }).prompts.some((p) => p.when === "startTurn"),
      ),
    );
    expect(anna().msgs.some((m) => m.type === "hazard.prompt")).toBe(false);
    const z = room()
      .model.inScene("zone", sceneId)
      .find((x) => x.label === "Smouldering coals");
    if (z) await cmd(dm, "zone.delete", { zoneIds: [z.id] });
  });

  it("a dying character's death saving throw comes at the start of each of its turns (AC-HP-08)", async () => {
    await turnOf(hero);
    await cmd(anna().room, "combat.endTurn", { tokenId: hero });
    await cmd(dm, "hp.apply", {
      targets: [hero],
      kind: "damage",
      amount: 25,
      decide: { [hero]: { keep: ["down"] } },
    });
    expect(statusOf(hero).deathSaves?.dead).toBe(false);
    anna().msgs.length = 0;
    await turnOf(hero);
    const card = await waitFor(() =>
      anna()
        .msgs.filter((m) => m.type === "request.card")
        .map((m) => m.payload as RequestCard)
        .find((c) => c.label === "Death saving throw" && c.targetId === hero),
    );
    expect(card.dc).toBe(10);
    await cmd(anna().room, "request.respond", {
      requestId: card.requestId,
      target: hero,
      action: "manual",
      total: 14,
    });
    await waitFor(() => statusOf(hero).deathSaves?.successes === 1);
    await cmd(dm, "hp.apply", {
      targets: [hero],
      kind: "heal",
      amount: 20,
      decide: { [hero]: { keep: ["revive"] } },
    });
  });

  it("what lasts until a round runs out as that round comes round, and the DM and its player are told (AC-CMB-09)", async () => {
    await turnOf(hero);
    const r = combat()?.round ?? 1;
    await cmd(dm, "status.change", { tokenId: hero, add: [{ id: "frightened", untilRound: r + 1 }] });
    expect(statusOf(hero).conditions.some((x) => x.id === "frightened")).toBe(true);
    anna().msgs.length = 0;
    for (let i = 0; i < 6 && statusOf(hero).conditions.some((x) => x.id === "frightened"); i++)
      await cmd(dm, "combat.next", {});
    await waitFor(() => !statusOf(hero).conditions.some((x) => x.id === "frightened"));
    expect(combat()?.round).toBe(r + 1);
    await waitFor(() => anna().msgs.find((m) => m.type === "combat.expired"));
  });

  it("the DM's controls: Previous, Set initiative (the order follows), Delay, Add, Remove, drag to reorder (AC-CMB-06)", async () => {
    const before = combat()?.turnIndex ?? 0;
    const round = combat()?.round ?? 1;
    await cmd(dm, "combat.prev", {});
    const back = combat();
    expect(back?.turnIndex === before - 1 || (before === 0 && back?.round === round - 1)).toBe(true);
    const order = () => data().combatants.map((e) => e.tokenId);
    await cmd(dm, "combat.set", { tokenId: hero, initiative: 30 });
    expect(order()[0]).toBe(hero);
    const last = order()[order().length - 1] as string;
    await cmd(dm, "combat.delay", { tokenId: hero, after: last });
    expect(order()[order().length - 1]).toBe(hero);
    const orc = await npc("Orc", { x: 30, y: 45 });
    await cmd(dm, "combat.add", { tokenIds: [orc] });
    await waitFor(() => data().combatants.find((e) => e.tokenId === orc)?.initiative !== null);
    const rev = [...order()].reverse();
    await cmd(dm, "combat.reorder", { order: rev });
    expect(order()).toEqual(rev);
    await cmd(dm, "combat.remove", { tokenId: orc });
    expect(order()).not.toContain(orc);
  });

  it("creature spaces: a player's move stops at a foe, never inside its space; the DM's ignores it (AC-MOV-16)", async () => {
    await turnOf(hero);
    const at = tokenOf(hero)?.pos as { x: number; y: number };
    const dir = at.x < 40 ? 1 : -1;
    const brute = await npc("Brute", { x: at.x + dir * 10, y: at.y });
    await turnOf(hero);
    const r = await move(anna().room, hero, { x: at.x + dir * 20, y: at.y });
    const endX = r.points[r.points.length - 1]?.x as number;
    expect(Math.abs(endX - (at.x + dir * 10))).toBeGreaterThanOrEqual(2.5);
    await cmd(anna().room, "move.reset", { tokenId: hero });
    await move(dm, hero, { x: at.x + dir * 10, y: at.y });
    expect(tokenOf(hero)?.pos.x).toBeCloseTo(at.x + dir * 10, 1);
    await cmd(dm, "move.reset", { tokenId: hero });
    await cmd(dm, "token.delete", { tokenIds: [brute] });
  });

  it("stop: back to free movement, the summary in the campaign log — rounds, who went down, what each dealt and took — and to everyone (AC-CMB-07, AC-CMB-11)", async () => {
    // Brin's turn: two goblins hit, the second dropped (10 HP each) — Brin's doing, as far as the table can tell.
    await turnOf(hero);
    const goblins = data()
      .combatants.filter((e) => e.name.startsWith("Goblin"))
      .map((e) => e.tokenId);
    expect(goblins.length).toBeGreaterThanOrEqual(2);
    const [g1, g2] = goblins as [string, string];
    // (The tally so far: earlier turns of this combat — Brin went down once.)
    const before = structuredClone(data().tally);
    const dealtBefore = before.dealt[hero] ?? 0;
    await cmd(dm, "hp.apply", { targets: [g1], kind: "damage", amount: 3 });
    const drop = () =>
      cmd(dm, "hp.apply", {
        targets: [g2],
        kind: "damage",
        amount: 20,
        decide: { [g2]: { keep: ["npcAtZero"], choices: { npcAtZero: "dead" } } },
      });
    await drop();
    expect(data().tally.taken[g1]).toBe((before.taken[g1] ?? 0) + 3);
    expect(data().tally.taken[g2]).toBe((before.taken[g2] ?? 0) + 10);
    expect(data().tally.dealt[hero]).toBe(dealtBefore + 13);
    expect(data().tally.downed).toEqual([...before.downed, g2]);
    // Undone, the hit takes its share of the tally with it.
    await cmd(dm, "history.undo", {});
    expect(data().tally.taken[g2]).toBe(before.taken[g2]);
    expect(data().tally.dealt[hero]).toBe(dealtBefore + 3);
    expect(data().tally.downed).toEqual(before.downed);
    await drop();
    // The goblin that took 3 slips out of sight before the end (the DM hides it): Anna isn't told of it (§13.4,
    // AC-SEC-07; security review M3).
    const hiddenName = data().combatants.find((e) => e.tokenId === g1)?.name as string;
    await cmd(dm, "token.update", { tokenId: g1, hidden: true });
    anna().msgs.length = 0;
    await cmd(dm, "combat.stop", {});
    expect(combat()).toBeUndefined();
    const told = (await waitFor(() => anna().msgs.find((m) => m.type === "combat.stopped")))?.payload as {
      text: string;
      downed: string[];
      tally: { name: string; dealt: number; taken: number | null }[];
    };
    expect(told.text).not.toContain(hiddenName);
    expect(told.tally.map((x) => x.name)).not.toContain(hiddenName);
    // Her own creature's figures in full; a goblin's damage taken withheld (its hit points aren't numbers to her).
    expect(told.tally.find((x) => x.name === "Brin")?.taken).toEqual(expect.any(Number));
    for (const x of told.tally.filter((x) => x.name.startsWith("Goblin"))) expect(x.taken).toBeNull();
    const log = t.server.ctx.campaigns.log(campaignId);
    const annaId = anna().id;
    const hers = log.filter(
      (e) =>
        e.kind === "combat.summary" &&
        e.visibility.startsWith("only:") &&
        e.visibility.slice(5).split(",").includes(annaId),
    );
    expect(hers.length).toBe(1);
    expect(hers[0]?.text).not.toContain(hiddenName);
    // The goblin that died in plain view: its death is told to those who saw it (Anna), not to "everyone".
    const death = log.filter((e) => e.kind === "death").at(-1);
    expect(death?.visibility).toMatch(/^only:/);
    expect(death?.visibility.slice(5).split(",")).toContain(annaId);
    // The DMs' entry has everything.
    const summary = log.find((e) => e.kind === "combat.summary" && e.visibility === "only:")?.text ?? "";
    expect(summary).toMatch(/^Combat ended after \d+ rounds?\./);
    expect(summary).toMatch(/Down: [^.]*Goblin/);
    expect(summary).toMatch(new RegExp(`Brin: dealt ${dealtBefore + 13}, took [0-9]+`));
    expect(summary).toMatch(/Goblin[^:]*: dealt 0, took 3/);
    expect(room().state.combat.active).toBe(false);
    const at = tokenOf(hero)?.pos as { x: number; y: number };
    await move(anna().room, hero, { x: at.x, y: at.y + 5 });
    const v = await waitFor(() => lastView(anna().msgs));
    expect(v.active).toBe(false);
  });

  it("stopping a combat still finding its initiative takes its players' cards back (nothing left to roll for)", async () => {
    anna().msgs.length = 0;
    await cmd(dm, "combat.quickStart", {});
    const card = await waitFor(() =>
      anna()
        .msgs.filter((m) => m.type === "request.card")
        .map((m) => m.payload as RequestCard)
        .find((c) => c.label.startsWith("Initiative") && c.open),
    );
    await cmd(dm, "combat.stop", {});
    await waitFor(() =>
      anna()
        .msgs.filter((m) => m.type === "request.card")
        .map((m) => m.payload as RequestCard)
        .find((c) => c.requestId === card.requestId && !c.open),
    );
    expect(
      t.server.ctx.sqlite.prepare("SELECT status FROM roll_requests WHERE id = ?").get(card.requestId),
    ).toEqual({
      status: "closed",
    });
    // Never begun: the log says it was called off, not that it ended after 0 rounds.
    const log = t.server.ctx.campaigns.log(campaignId);
    expect(log.filter((e) => e.kind === "combat.summary").at(-1)?.text).toMatch(
      /^Combat called off before it began\./,
    );
  });

  it("rules audit A8: the server's initiative roll for a creature with Exhaustion 2 takes its −4, as a player's card does", async () => {
    const tired = await npc("Tired orc", { x: 60, y: 40 });
    await cmd(dm, "status.change", { tokenId: tired, exhaustion: 2 });
    dmMsgs.length = 0;
    await cmd(dm, "combat.start", { participants: [tired], method: "rollAll" });
    const roll = await waitFor(() =>
      dmMsgs
        .filter((m) => m.type === "roll.result")
        .map((m) => m.payload as { formula: string; label?: string })
        .find((r) => (r.label ?? "").includes("Tired orc")),
    );
    // SRD 5.2.1 p. 181: −2 per level on every D20 Test; initiative is a Dexterity check.
    expect(roll.formula).toMatch(/- 4/);
    await cmd(dm, "combat.stop", {});
  });
});
