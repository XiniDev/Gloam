import type { Room } from "@colyseus/sdk";
import { applyPatch, type JsonPatchOp } from "@gloam/shared/rules";
import type { Sheet } from "@gloam/shared/schemas";
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
  payload: Record<string, unknown>;
  at: number;
}
interface ActorView {
  id: string;
  ownerUserId: string | null;
  lockLevel: string;
  sheet: Sheet;
}
interface Player {
  agent: Agent;
  room: TableRoomClient;
  id: string;
  msgs: Msg[];
  /** The sheets this client holds, kept as the messages say. */
  sheets: Map<string, ActorView>;
}

/** A request's refusal (the server's code, message and detail), or null when it went through. */
interface Refusal {
  code: string;
  message: string;
  detail?: { locked?: { path: string }[]; issues?: { path: string; message: string }[] };
}
const refusal = (p: Promise<unknown>): Promise<Refusal | null> =>
  p.then(
    () => null,
    (e: { reason?: Refusal }) => e.reason ?? null,
  );

/** A client's mirror of its sheets, from `actor.snapshot` / `actor.view` / `sheet.patch` / `actor.gone`. */
function mirror(room: TableRoomClient, msgs: Msg[], sheets: Map<string, ActorView>) {
  room.onMessage("*", (type, payload) => {
    const p = payload as Record<string, unknown>;
    msgs.push({ type: String(type), payload: p, at: Date.now() });
    if (type === "actor.snapshot") {
      sheets.clear();
      for (const a of p.actors as ActorView[]) sheets.set(a.id, a);
    } else if (type === "actor.view") {
      const a = p.actor as ActorView;
      sheets.set(a.id, a);
    } else if (type === "actor.gone") sheets.delete(p.id as string);
    else if (type === "sheet.patch") {
      const a = sheets.get(p.actorId as string);
      if (a) sheets.set(a.id, { ...a, sheet: applyPatch(a.sheet, p.patch as JsonPatchOp[]) });
    }
  });
}

describe("P6 — character sheets on the server (SHEET, SCN-06)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  const dmMsgs: Msg[] = [];
  const dmSheets = new Map<string, ActorView>();
  let anna: Player;
  let bob: Player;
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  /** An actor's stored sheet (the server's truth). */
  const sheetOf = (id: string): Sheet => {
    const a = room().model.get("actor", id);
    if (!a) throw new Error(`no actor ${id}`);
    return a.sheet as unknown as Sheet;
  };

  async function admit(name: string): Promise<Player> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    const sheets = new Map<string, ActorView>();
    mirror(r, msgs, sheets);
    return { agent: p.agent, room: r, id: p.userId, msgs, sheets };
  }

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    mirror(dm, dmMsgs, dmSheets);
    anna = await admit("Anna");
    bob = await admit("Bob");
    await sleep(150);
  });
  afterAll(async () => {
    await t?.stop();
  });

  let thorin = "";

  it("AC-SHEET-01: quick create makes a playable character in one request — and only its owner and the DM get its sheet (P4)", async () => {
    const { actorId } = await rq<{ actorId: string }>(anna.room, "actor.quickCreate", {
      name: "Thorin Emberhand",
      classLevel: "Fighter 3 / Wizard 2",
      hpMax: 44,
      ac: 18,
      speed: 25,
      darkvision: 60,
    });
    thorin = actorId;
    const s = room().model.get("actor", actorId);
    expect(s?.ownerUserId).toBe(anna.id);
    const core = sheetOf(actorId).core;
    expect(core.classes).toEqual([
      { name: "Fighter", level: 3 },
      { name: "Wizard", level: 2 },
    ]);
    expect(core.hp).toEqual({ max: 44, current: 44, temp: 0 });
    expect(core.ac.value).toBe(18);
    expect(core.speeds.walk).toBe(25);
    expect(core.senses.darkvision).toBe(60);
    await waitFor(() => anna.sheets.get(actorId) && dmSheets.get(actorId));
    expect(anna.sheets.get(actorId)?.sheet.core.name).toBe("Thorin Emberhand");
    await sleep(200);
    // Bob never receives Anna's sheet, in any message.
    expect(bob.sheets.has(actorId)).toBe(false);
    expect(JSON.stringify(bob.msgs)).not.toContain("Thorin");
    // Players make only their own characters.
    await expect(
      rq(bob.room, "actor.quickCreate", { name: "Stolen", hpMax: 5, ac: 10, ownerUserId: anna.id }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("an edit reaches the owner and the DM as a patch; a bad value is refused with its path", async () => {
    const before = dmMsgs.length;
    await rq(anna.room, "actor.change", {
      actorId: thorin,
      changes: [
        { path: ["core", "hp", "current"], after: 30 },
        { path: ["core", "abilities", "str"], after: 16 },
      ],
    });
    await waitFor(() => anna.sheets.get(thorin)?.sheet.core.hp.current === 30);
    await waitFor(() => dmSheets.get(thorin)?.sheet.core.abilities.str === 16);
    expect(dmMsgs.slice(before).some((m) => m.type === "sheet.patch")).toBe(true);
    // Out of range: the whole sheet schema checks every edit.
    const bad = await refusal(
      rq(anna.room, "actor.change", {
        actorId: thorin,
        changes: [{ path: ["core", "abilities", "str"], after: 31 }],
      }),
    );
    expect(bad).toMatchObject({ code: "INVALID" });
    expect(bad?.message).toContain("core.abilities.str");
    // Someone else's sheet.
    await expect(
      rq(bob.room, "actor.change", {
        actorId: thorin,
        changes: [{ path: ["core", "hp", "current"], after: 1 }],
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("AC-SHEET-05: Core locked lets the player change play-state only; Fully locked nothing; the DM anything", async () => {
    await rq(dm, "actor.setLock", { actorId: thorin, level: "core" });
    await waitFor(() => anna.sheets.get(thorin)?.lockLevel === "core");
    await rq(anna.room, "actor.change", {
      actorId: thorin,
      changes: [
        { path: ["core", "hp", "current"], after: 25 },
        { path: ["core", "conditions"], after: ["poisoned"] },
        { path: ["core", "currency", "gp"], after: 12 },
      ],
    });
    const refused = await refusal(
      rq(anna.room, "actor.change", {
        actorId: thorin,
        changes: [
          { path: ["core", "hp", "current"], after: 20 },
          { path: ["core", "abilities", "str"], after: 18 },
          { path: ["core", "hp", "max"], after: 50 },
        ],
      }),
    );
    expect(refused?.code).toBe("LOCKED_SHEET");
    expect((refused?.detail?.locked ?? []).map((l) => l.path).sort()).toEqual([
      "core.abilities.str",
      "core.hp.max",
    ]);
    // Nothing of a refused edit lands.
    expect(sheetOf(thorin).core.hp.current).toBe(25);
    // Conditions are status: they live on the actor's status, and read back on the sheet.
    const status = room().model.get("actor", thorin)?.status as { conditions: { id: string }[] } | undefined;
    expect(status?.conditions.map((c) => c.id)).toEqual(["poisoned"]);
    expect(sheetOf(thorin).core.conditions).toEqual([]);
    await waitFor(() => anna.sheets.get(thorin)?.sheet.core.conditions.includes("poisoned"));
    // Fully locked: not even HP.
    await rq(dm, "actor.setLock", { actorId: thorin, level: "full" });
    await expect(
      rq(anna.room, "actor.change", {
        actorId: thorin,
        changes: [{ path: ["core", "hp", "current"], after: 24 }],
      }),
    ).rejects.toThrow(/LOCKED_SHEET/);
    // The DM is never locked.
    await rq(dm, "actor.change", {
      actorId: thorin,
      changes: [{ path: ["core", "abilities", "wis"], after: 14 }],
    });
    expect(sheetOf(thorin).core.abilities.wis).toBe(14);
    await rq(dm, "actor.setLock", { actorId: thorin, level: "core" });
  });

  it("AC-SHEET-05: a proposal reaches the DM with its diff and applies only on approval; a denial carries its note", async () => {
    const mark = dmMsgs.length;
    const { proposalId } = await rq<{ proposalId: string }>(anna.room, "actor.propose", {
      actorId: thorin,
      changes: [{ path: ["core", "abilities", "str"], after: 18 }],
      note: "ASI at level 4",
    });
    const card = (await waitFor(() => dmMsgs.slice(mark).find((m) => m.type === "proposal.new")))
      ?.payload as {
      id: string;
      changes: { label: string; before: unknown; after: unknown }[];
      note: string;
    };
    expect(card.id).toBe(proposalId);
    expect(card.note).toBe("ASI at level 4");
    expect(card.changes).toEqual([
      { path: ["core", "abilities", "str"], label: "Strength score", before: 16, after: 18 },
    ]);
    // Not applied yet.
    expect(sheetOf(thorin).core.abilities.str).toBe(16);
    // Bob hears nothing of it.
    expect(bob.msgs.some((m) => m.type.startsWith("proposal"))).toBe(false);
    await rq(dm, "proposal.decide", { proposalId, approve: true, note: "" });
    await waitFor(() => anna.sheets.get(thorin)?.sheet.core.abilities.str === 18);
    await waitFor(() =>
      anna.msgs.find(
        (m) => m.type === "proposal.update" && (m.payload as { status: string }).status === "approved",
      ),
    );
    // Answered once.
    await expect(rq(dm, "proposal.decide", { proposalId, approve: false, note: "" })).rejects.toThrow(
      /CONFLICT/,
    );
    // Denied: nothing changes; the player gets the note.
    const second = await rq<{ proposalId: string }>(anna.room, "actor.propose", {
      actorId: thorin,
      changes: [{ path: ["core", "hp", "max"], after: 99 }],
      note: "",
    });
    await rq(dm, "proposal.decide", { proposalId: second.proposalId, approve: false, note: "Roll for it." });
    const denied = await waitFor(() =>
      anna.msgs.find(
        (m) =>
          m.type === "proposal.update" &&
          (m.payload as { id: string; status: string }).id === second.proposalId &&
          (m.payload as { status: string }).status !== "pending",
      ),
    );
    expect(denied?.payload).toMatchObject({ status: "denied", decisionNote: "Roll for it." });
    expect(sheetOf(thorin).core.hp.max).toBe(44);
    // The lists: the DM's has both, Anna's her own.
    expect((await rq<unknown[]>(dm, "proposal.list", {})).length).toBe(2);
    expect((await rq<unknown[]>(anna.room, "proposal.list", {})).length).toBe(2);
    expect(await rq<unknown[]>(bob.room, "proposal.list", {})).toEqual([]);
  });

  it("a lock can't be undone around: a player's undo of an edit the DM has since locked is refused", async () => {
    await rq(dm, "actor.setLock", { actorId: thorin, level: "unlocked" });
    await rq(anna.room, "actor.change", {
      actorId: thorin,
      changes: [{ path: ["core", "abilities", "dex"], after: 14 }],
    });
    await rq(dm, "actor.setLock", { actorId: thorin, level: "core" });
    await expect(rq(anna.room, "history.undo", {})).rejects.toThrow(/LOCKED_SHEET|CONFLICT/);
    expect(sheetOf(thorin).core.abilities.dex).toBe(14);
  });

  it("AC-SCN-06 / AC-SHEET-09: characters are placed round the party spawn; a linked token follows its sheet within 200 ms", async () => {
    const { sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    // Something already at the spawn point.
    const scene = room().model.get("scene", sceneId);
    const spawn = scene?.spawn as { x: number; y: number };
    await rq(dm, "token.create", {
      sceneId,
      name: "Statue",
      pos: spawn,
      size: "medium",
      disposition: "neutral",
    });
    await rq(dm, "scene.activate", { sceneId });
    // Anna is at the table: her character is placed as the scene becomes active.
    const placed = await waitFor(() =>
      room()
        .model.inScene("token", sceneId)
        .find((x) => x.actorId === thorin),
    );
    expect(placed.link).toBe("linked");
    expect(placed.ownerIds).toEqual([anna.id]);
    expect(Math.hypot(placed.pos.x - spawn.x, placed.pos.y - spawn.y)).toBeGreaterThan(0);
    expect(Math.hypot(placed.pos.x - spawn.x, placed.pos.y - spawn.y)).toBeLessThanOrEqual(10);
    // Placed once: activating again doesn't add another.
    await sleep(100);
    expect(
      room()
        .model.inScene("token", sceneId)
        .filter((x) => x.actorId === thorin).length,
    ).toBe(1);

    // Every field §8.10 lists reaches the linked token as its controller sees it, each within 200 ms of the change:
    // the play-state (HP, temp HP, conditions) as the player changes it, the rest (speeds, senses, size, light) as
    // the DM does (they're core-locked for her).
    await waitFor(() => anna.room.state.tokens?.get(placed.id)?.hp);
    const view = () => anna.room.state.tokens.get(placed.id);
    let t0 = Date.now();
    await rq(anna.room, "actor.change", {
      actorId: thorin,
      changes: [
        { path: ["core", "hp", "current"], after: 11 },
        { path: ["core", "hp", "temp"], after: 4 },
        { path: ["core", "conditions"], after: ["prone"] },
      ],
    });
    await waitFor(
      () => view()?.hp?.hp === 11 && view()?.hp?.hpTemp === 4 && view()?.conditions.includes("prone"),
      2000,
      5,
    );
    expect(Date.now() - t0, "HP, temp HP and conditions on the token (ms)").toBeLessThan(200);
    t0 = Date.now();
    await rq(dm, "actor.change", {
      actorId: thorin,
      changes: [
        { path: ["core", "speeds", "walk"], after: 35 },
        { path: ["core", "speeds", "fly"], after: 20 },
        { path: ["core", "senses", "darkvision"], after: 120 },
        { path: ["core", "size"], after: "large" },
        { path: ["core", "light"], after: "torch" },
      ],
    });
    await waitFor(
      () =>
        view()?.own?.speedWalk === 35 &&
        view()?.own?.speedFly === 20 &&
        view()?.vis?.darkvision === 120 &&
        view()?.sizeFt === 10 &&
        view()?.lightOn === true,
      2000,
      5,
    );
    expect(Date.now() - t0, "speeds, senses, size and light on the token (ms)").toBeLessThan(200);
    const tok = room().model.get("token", placed.id);
    expect(room().model.get("light", tok?.lightId as string)?.preset).toBe("torch");
    // The same character on another scene shows the same state (linked: one sheet, every token).
    const other = await rq<{ sceneId: string }>(dm, "scene.create", { name: "Road", mapKind: "blank" });
    const { tokenId } = await rq<{ tokenId: string }>(dm, "token.create", {
      sceneId: other.sceneId,
      name: "Thorin",
      actorId: thorin,
      pos: { x: 10, y: 10 },
    });
    expect(room().model.get("token", tokenId)?.link).toBe("linked");
    expect(room().model.get("token", tokenId)?.stats).toBeNull();
  });

  it("AC-TOK-13 (server): tokens from one creature keep their own HP and conditions; unlinking copies; relinking asks before overwriting", async () => {
    const sceneId = room().projector.activeSceneId;
    const { actorId: goblin } = await rq<{ actorId: string }>(dm, "actor.create", {
      kind: "npc",
      sheet: {
        core: {
          name: "Goblin",
          size: "small",
          hp: { max: 7, current: 7 },
          ac: { value: 15 },
          speeds: { walk: 30 },
        },
      },
    });
    const make = async (x: number) =>
      (
        await rq<{ tokenId: string }>(dm, "token.create", {
          sceneId,
          name: "Goblin",
          actorId: goblin,
          link: "unlinked",
          pos: { x, y: 5 },
          disposition: "hostile",
        })
      ).tokenId;
    const g1 = await make(5);
    const g2 = await make(10);
    const tok = (id: string) => room().model.get("token", id);
    // Each starts with a copy of the creature's numbers.
    expect(tok(g1)?.stats).toMatchObject({ hp: 7, hpMax: 7, ac: 15, size: "small" });
    expect(tok(g2)?.stats?.hp).toBe(7);
    // One is hurt; the other isn't. The creature's sheet changing reaches neither.
    await rq(dm, "token.update", { tokenId: g1, stats: { hp: 2 } });
    await rq(dm, "actor.change", {
      actorId: goblin,
      changes: [{ path: ["core", "conditions"], after: ["frightened"] }],
    });
    expect(tok(g1)?.stats?.hp).toBe(2);
    expect(tok(g2)?.stats?.hp).toBe(7);
    expect(tok(g1)?.status?.conditions).toEqual([]);
    expect(tok(g2)?.status?.conditions).toEqual([]);

    // Thorin's linked token: unlinking copies his current values; after that it's its own.
    const thorinTok = room()
      .model.inScene("token", sceneId)
      .find((x) => x.actorId === thorin) as { id: string };
    const hpNow = sheetOf(thorin).core.hp.current;
    await rq(dm, "token.setLink", { tokenId: thorinTok.id, link: "unlinked" });
    expect(tok(thorinTok.id)?.link).toBe("unlinked");
    expect(tok(thorinTok.id)?.stats?.hp).toBe(hpNow);
    expect(tok(thorinTok.id)?.status?.conditions.map((c) => c.id)).toEqual(["prone"]);
    await rq(dm, "actor.change", {
      actorId: thorin,
      changes: [{ path: ["core", "hp", "current"], after: 40 }],
    });
    expect(tok(thorinTok.id)?.stats?.hp).toBe(hpNow);
    // Relinking would throw away its own HP: refused until the DM says so.
    const asked = await refusal(rq(dm, "token.setLink", { tokenId: thorinTok.id, link: "linked" }));
    expect(asked?.code).toBe("CONFLICT");
    expect(asked?.message).toContain("HP");
    expect(tok(thorinTok.id)?.link).toBe("unlinked");
    await rq(dm, "token.setLink", { tokenId: thorinTok.id, link: "linked", overwrite: true });
    expect(tok(thorinTok.id)?.link).toBe("linked");
    expect(tok(thorinTok.id)?.stats).toBeNull();
    // Nothing to lose: relinking straight away needs no asking.
    await rq(dm, "token.setLink", { tokenId: thorinTok.id, link: "unlinked" });
    await rq(dm, "token.setLink", { tokenId: thorinTok.id, link: "linked" });
    expect(tok(thorinTok.id)?.link).toBe("linked");
    // Players can't.
    await expect(rq(anna.room, "token.setLink", { tokenId: thorinTok.id, link: "unlinked" })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });

  it("AC-SHEET-04: a sheet's custom blocks save as a template, and new characters start from it (values cleared)", async () => {
    await rq(dm, "actor.change", {
      actorId: thorin,
      changes: [
        {
          path: ["custom"],
          after: [
            { id: "b1", type: "counter", title: "Sanity", value: 3, max: 10, pinToToken: true },
            { id: "b2", type: "checklist", title: "Rites", items: [{ label: "Dawn", done: true }] },
            { id: "b3", type: "keyValue", title: "Contacts", entries: [{ key: "Fence", value: "Old Mags" }] },
          ],
        },
      ],
    });
    const { templateId } = await rq<{ templateId: string }>(anna.room, "template.save", {
      name: "Homebrew Arcana sheet",
      fromActorId: thorin,
    });
    const { actorId } = await rq<{ actorId: string }>(bob.room, "actor.quickCreate", {
      name: "Bram",
      hpMax: 9,
      ac: 12,
      templateId,
    });
    const custom = sheetOf(actorId).custom;
    expect(custom.map((b) => [b.type, b.title])).toEqual([
      ["counter", "Sanity"],
      ["checklist", "Rites"],
      ["keyValue", "Contacts"],
    ]);
    expect(custom[0]).toMatchObject({ value: 10, max: 10, pinToToken: true });
    expect(custom[1]).toMatchObject({ items: [{ label: "Dawn", done: false }] });
    expect(custom[2]).toMatchObject({ entries: [{ key: "Fence", value: "" }] });
    expect(custom.every((b) => !["b1", "b2", "b3"].includes(b.id))).toBe(true);
    // Only its maker or a DM deletes it.
    await expect(rq(bob.room, "template.delete", { templateId })).rejects.toThrow(/FORBIDDEN/);
    await rq(anna.room, "template.delete", { templateId });
  });

  it("AC-SCN-06: a player coming to the table finds their characters placed round the spawn, clear of every token", async () => {
    // Bob's character (made from the template while he was at the table) was placed then.
    const bram = room()
      .model.all("actor")
      .find((a) => (a.sheet as Sheet).core.name === "Bram");
    expect(bram).toBeTruthy();
    const sceneId = room().projector.activeSceneId;
    const first = await waitFor(() =>
      room()
        .model.inScene("token", sceneId)
        .find((x) => x.actorId === bram?.id),
    );
    // He leaves; the DM clears his token away; he comes back to the table: placed again.
    await bob.room.leave();
    await rq(dm, "token.delete", { tokenIds: [first.id] });
    bob.room = (await bob.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    mirror(bob.room, bob.msgs, bob.sheets);
    const again = await waitFor(() =>
      room()
        .model.inScene("token", sceneId)
        .find((x) => x.actorId === bram?.id),
    );
    const spawn = room().model.get("scene", sceneId)?.spawn as { x: number; y: number };
    expect(Math.hypot(again.pos.x - spawn.x, again.pos.y - spawn.y)).toBeLessThanOrEqual(15);
    for (const o of room().model.inScene("token", sceneId)) {
      if (o.id === again.id) continue;
      const reach = (o.sizeFt + again.sizeFt) / 2 - 1e-6;
      expect(
        Math.abs(o.pos.x - again.pos.x) < reach && Math.abs(o.pos.y - again.pos.y) < reach,
        `overlaps ${o.name}`,
      ).toBe(false);
    }
  });

  it("AC-SHEET-06: an import is checked against the whole schema with readable paths; export → import round-trips", async () => {
    const bad = await refusal(
      rq(anna.room, "actor.replace", {
        actorId: thorin,
        sheet: { core: { name: "", abilities: { str: 99 } }, extra: true },
      }),
    );
    expect(bad?.code).toBe("INVALID");
    const paths = (bad?.detail?.issues ?? []).map((i) => i.path);
    expect(paths).toContain("core.abilities.str");
    expect(paths).toContain("core.name");
    // Export is the sheet the owner holds; importing it back changes nothing. (Lock changes at the protocol's pace.)
    await sleep(1100);
    await rq(dm, "actor.setLock", { actorId: thorin, level: "unlocked" });
    const exported = JSON.parse(JSON.stringify(anna.sheets.get(thorin)?.sheet)) as Sheet;
    const before = room().model.get("actor", thorin);
    await rq(anna.room, "actor.replace", { actorId: thorin, sheet: exported });
    const after = room().model.get("actor", thorin);
    expect(after?.sheet).toEqual(before?.sheet);
    expect(after?.status).toEqual(before?.status);
  });

  it("the character JSON Schema is published at /api/v1/schemas/character.json", async () => {
    const res = await fetch(`${t.url}/api/v1/schemas/character.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/schema+json");
    const schema = (await res.json()) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["core", "custom"]));
  });
});
