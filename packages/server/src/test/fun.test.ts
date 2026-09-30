import type { Room } from "@colyseus/sdk";
import type { EmoteMessage, HandoutView, LogEntryView } from "@gloam/shared/protocol";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
interface Seat {
  room: TableRoomClient;
  id: string;
  msgs: Msg[];
}

/**
 * Table flavour on the server (SPEC §8.18; AC-FUN-01/03/04/05, AC-UNDO-05): emotes and phrases (their rate limit;
 * the sender's token only to those who see it), the raised hand (the DM told once per raise), handouts and secret notes
 * (exactly their recipients, kept in their lists), the campaign log (its automatic entries, manual ones, who reads
 * what, sessions) — and none of emotes, pings, hand raises, rolls or showing a handout undoable.
 */
describe("P11 — table flavour on the server (FUN)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: Seat;
  const seats: Record<string, Seat> = {};
  let sceneId = "";
  let daveToken = "";

  async function seat(
    name: string,
    decision: "admitPlayer" | "admitSpectator" = "admitPlayer",
  ): Promise<Seat> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const room = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    room.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    const s = { room, id: p.userId, msgs };
    seats[name] = s;
    return s;
  }
  const of = <T>(s: Seat, type: string) => s.msgs.filter((m) => m.type === type).map((m) => m.payload as T);

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    const room = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const msgs: Msg[] = [];
    room.onMessage("*", (type, payload) => msgs.push({ type: String(type), payload }));
    dm = { room, id: "admin", msgs };
    await seat("Dave");
    await seat("Erin");
    await seat("Watcher", "admitSpectator");
    // A dark hall: Dave's token by a wall Erin's can't see past.
    sceneId = (
      await rq<{ sceneId: string }>(dm.room, "scene.create", {
        name: "Dark hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 60,
        heightFt: 40,
        fogMode: "dynamic",
        ambient: "dark",
      })
    ).sceneId;
    await rq(dm.room, "wall.create", { sceneId, walls: [{ a: { x: 30, y: 0 }, b: { x: 30, y: 40 } }] });
    daveToken = (
      await rq<{ tokenId: string }>(dm.room, "token.create", {
        sceneId,
        name: "Dave's Fighter",
        pos: { x: 10, y: 20 },
        disposition: "party",
        ownerIds: [seats.Dave?.id],
      })
    ).tokenId;
    await rq(dm.room, "token.create", {
      sceneId,
      name: "Erin's Rogue",
      pos: { x: 50, y: 20 },
      disposition: "party",
      ownerIds: [seats.Erin?.id],
      stats: { hp: 9, hpMax: 9, ac: 13, senses: { darkvision: 60 } },
    });
    await rq(dm.room, "scene.activate", { sceneId });
    await sleep(300);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-FUN-01: an emote or phrase reaches everyone — over the sender's token only for those who see it; the rate limit applies; phrases are the quick ones or the sender's own (≤ 6, ≤ 40 characters)", async () => {
    const dave = seats.Dave as Seat;
    const erin = seats.Erin as Seat;
    const watcher = seats.Watcher as Seat;
    await rq(dave.room, "emote.send", { emote: "laugh" });
    for (const s of [dm, dave, erin, watcher]) await waitFor(() => of<EmoteMessage>(s, "emote").length === 1);
    const [toDm, toDave, toErin] = [dm, dave, erin].map(
      (s) => of<EmoteMessage>(s, "emote")[0] as EmoteMessage,
    );
    expect(toDm).toMatchObject({ userId: dave.id, name: "Dave", emote: "laugh", tokenId: daveToken });
    expect(toDave?.tokenId).toBe(daveToken);
    // Erin can't see Dave's token (dark, behind a wall): the emote comes without it — his portrait shows it.
    expect(toErin?.tokenId).toBeUndefined();
    expect(JSON.stringify(of(erin, "emote"))).not.toContain(daveToken);
    // A spectator may emote too (SPEC §6).
    await rq(watcher.room, "emote.send", { emote: "popcorn" });
    // Quick phrases; a phrase that isn't one needs saving first.
    await sleep(1600);
    await rq(dave.room, "emote.send", { phrase: "Nat 20!" });
    await expect(rq(dave.room, "emote.send", { phrase: "Stand back!" })).rejects.toThrow(/INVALID/);
    await expect(
      rq(dave.room, "profile.phrases", { phrases: ["a", "b", "c", "d", "e", "f", "g"] }),
    ).rejects.toThrow(/INVALID/);
    await expect(rq(dave.room, "profile.phrases", { phrases: ["x".repeat(41)] })).rejects.toThrow(/INVALID/);
    const saved = await rq<{ phrases: string[] }>(dave.room, "profile.phrases", { phrases: ["Stand back!"] });
    expect(saved.phrases).toEqual(["Stand back!"]);
    await sleep(1600);
    await rq(dave.room, "emote.send", { phrase: "Stand back!" });
    await waitFor(() => of<EmoteMessage>(erin, "emote").some((e) => e.phrase === "Stand back!"));
    // One every 1.5 s, bursts of three: a fourth at once is refused.
    await sleep(4600);
    for (let i = 0; i < 3; i++) await rq(erin.room, "emote.send", { emote: "clap" });
    await expect(rq(erin.room, "emote.send", { emote: "clap" })).rejects.toThrow(/RATE_LIMITED/);
  });

  it("AC-FUN-03: a raised hand shows for everyone and tells the DM once per raise; a spectator may raise one too", async () => {
    const dave = seats.Dave as Seat;
    const before = of(dm, "hand.raised").length;
    await rq(dave.room, "hand.toggle", {});
    await waitFor(() => dave.room.state.presence.get(dave.id)?.handRaised === true);
    await waitFor(() => of(dm, "hand.raised").length === before + 1);
    // Still up: nothing more for the DM; down and up again: once more.
    await sleep(1100);
    await rq(dave.room, "hand.toggle", { raised: true });
    await sleep(300);
    expect(of(dm, "hand.raised").length).toBe(before + 1);
    await sleep(800);
    await rq(dave.room, "hand.toggle", { raised: false });
    await sleep(1100);
    await rq(dave.room, "hand.toggle", { raised: true });
    await waitFor(() => of(dm, "hand.raised").length === before + 2);
    // The players are never told (only the DM hears the bell).
    expect(of(seats.Erin as Seat, "hand.raised")).toEqual([]);
    await rq((seats.Watcher as Seat).room, "hand.toggle", {});
  });

  it("AC-FUN-04: a handout reaches exactly its recipients (and stays in their lists); a secret note, one player alone; players can do neither", async () => {
    const dave = seats.Dave as Seat;
    const erin = seats.Erin as Seat;
    const { handoutId } = await rq<{ handoutId: string }>(dm.room, "handout.create", {
      title: "A torn map",
      bodyMd: "**North** of the crypt, a second stair.",
    });
    // A draft: nobody has it yet.
    expect(await rq<HandoutView[]>(dave.room, "handout.list", {})).toEqual([]);
    await rq(dm.room, "handout.show", { handoutId, to: [dave.id] });
    await waitFor(() => of<HandoutView>(dave, "handout").length === 1);
    expect(of<HandoutView>(dave, "handout")[0]).toMatchObject({ id: handoutId, title: "A torn map" });
    expect((of<HandoutView>(dave, "handout")[0] as HandoutView).recipients).toBeUndefined();
    await sleep(300);
    expect(of(erin, "handout")).toEqual([]);
    expect((await rq<HandoutView[]>(dave.room, "handout.list", {})).map((h) => h.id)).toEqual([handoutId]);
    expect(await rq<HandoutView[]>(erin.room, "handout.list", {})).toEqual([]);
    // Then to everyone: Erin gets it too.
    await sleep(500);
    await rq(dm.room, "handout.show", { handoutId, to: "all" });
    await waitFor(() => of<HandoutView>(erin, "handout").length === 1);
    // Dave has it already: it doesn't unroll for him again.
    await sleep(300);
    expect(of(dave, "handout").length).toBe(1);
    // A secret note to Erin: only Erin.
    await sleep(500);
    const { handoutId: noteId } = await rq<{ handoutId: string }>(dm.room, "note.secret", {
      userId: erin.id,
      text: "Only you notice the glyph glowing.",
    });
    await waitFor(() => of<HandoutView>(erin, "note").length === 1);
    expect(of<HandoutView>(erin, "note")[0]).toMatchObject({
      kind: "note",
      bodyMd: "Only you notice the glyph glowing.",
    });
    await sleep(300);
    expect(of(dave, "note")).toEqual([]);
    expect(JSON.stringify(dave.msgs)).not.toContain("glyph glowing");
    expect((await rq<HandoutView[]>(dave.room, "handout.list", {})).map((h) => h.id)).toEqual([handoutId]);
    expect((await rq<HandoutView[]>(erin.room, "handout.list", {})).map((h) => h.id).sort()).toEqual(
      [handoutId, noteId].sort(),
    );
    // The DM's list: both, with who has them.
    const dmList = await rq<HandoutView[]>(dm.room, "handout.list", {});
    expect(dmList.find((h) => h.id === handoutId)?.recipients).toBe("all");
    expect(dmList.find((h) => h.id === noteId)?.recipients).toEqual([erin.id]);
    // Players: none of it.
    await expect(rq(dave.room, "handout.create", { title: "Mine" })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(dave.room, "handout.show", { handoutId, to: "all" })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(dave.room, "note.secret", { userId: erin.id, text: "hi" })).rejects.toThrow(/FORBIDDEN/);
  });

  it("AC-FUN-05: the log records sessions, scene changes, deaths and stabilisations, level changes and handouts shown; takes manual entries; each person reads what's theirs; grouped by session", async () => {
    const dave = seats.Dave as Seat;
    const erin = seats.Erin as Seat;
    // A creature dies and another becomes stable on Dave's side of the wall, in the dark (Erin can't see there); a
    // third dies in front of Erin's rogue, in her darkvision.
    const { tokenId: seen } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Cave rat",
      pos: { x: 45, y: 20 },
      stats: { hp: 7, hpMax: 7, ac: 12 },
    });
    const { tokenId: goblin } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Goblin G7",
      pos: { x: 12, y: 22 },
      stats: { hp: 7, hpMax: 7, ac: 12 },
    });
    const { tokenId: guard } = await rq<{ tokenId: string }>(dm.room, "token.create", {
      sceneId,
      name: "Captain Vey",
      pos: { x: 14, y: 22 },
      stats: { hp: 20, hpMax: 20, ac: 15 },
    });
    await sleep(250);
    await rq(dm.room, "status.change", { tokenId: seen, add: [{ id: "dead" }] });
    await rq(dm.room, "status.change", { tokenId: goblin, add: [{ id: "dead" }] });
    await sleep(250);
    await rq(dm.room, "status.change", { tokenId: guard, add: [{ id: "stable" }] });
    // Dave's character goes up a level.
    const { actorId } = await rq<{ actorId: string }>(dave.room, "actor.create", {
      sheet: { core: { name: "Mira", classes: [{ name: "Fighter", level: 1 }] } },
    });
    await sleep(300);
    await rq(dave.room, "actor.change", {
      actorId,
      changes: [{ path: ["core", "classes"], after: [{ name: "Fighter", level: 2 }] }],
    });
    // Another scene.
    const { sceneId: next } = await rq<{ sceneId: string }>(dm.room, "scene.create", {
      name: "Flooded chamber",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 40,
    });
    await rq(dm.room, "scene.activate", { sceneId: next });
    // A recap from a player.
    await rq(dave.room, "log.add", { text: "We found the second stair." });
    await expect(rq((seats.Watcher as Seat).room, "log.add", { text: "hi" })).rejects.toThrow(/FORBIDDEN/);
    await waitFor(() => of<LogEntryView>(erin, "log.entry").some((e) => e.kind === "manual"));

    const erinLog = await rq<LogEntryView[]>(erin.room, "log.list", {});
    const texts = erinLog.map((e) => e.text);
    expect(texts).toContain("Session 1 began.");
    // Deaths and stabilisations: told to those who'd know (§13.4, AC-SEC-07) — Erin of the goblin she saw fall, not
    // of what happened out of her sight; the DM of all of them.
    expect(texts).toContain("Cave rat died.");
    expect(texts).not.toContain("Goblin G7 died.");
    expect(texts).not.toContain("Captain Vey is stable.");
    const dmTexts = (await rq<LogEntryView[]>(dm.room, "log.list", {})).map((e) => e.text);
    for (const x of ["Cave rat died.", "Goblin G7 died.", "Captain Vey is stable."])
      expect(dmTexts).toContain(x);
    expect(texts).toContain("Mira reached level 2.");
    expect(texts).toContain("The table moved to Flooded chamber.");
    expect(erinLog.find((e) => e.kind === "manual")).toMatchObject({
      text: "We found the second stair.",
      author: "Dave",
    });
    // Handouts shown: to everyone, everyone reads it; one shown to Dave alone, only Dave (and the DM).
    expect(texts).toContain('The DM showed the handout "A torn map".');
    const daveLog = await rq<LogEntryView[]>(dave.room, "log.list", {});
    const targeted = daveLog.find((e) => e.text === 'The DM showed the handout "A torn map" to a player.');
    expect(targeted).toBeTruthy();
    expect(texts).not.toContain('The DM showed the handout "A torn map" to a player.');
    expect(JSON.stringify(erinLog)).not.toContain("secret");
    // Grouped by session: every entry carries its session.
    expect(new Set(erinLog.map((e) => e.sessionNo))).toEqual(new Set([1]));
    // Undoing the death doesn't unwrite it: the log says what happened.
    const count = erinLog.length;
    await rq(dm.room, "history.undo", {}).catch(() => {});
    expect((await rq<LogEntryView[]>(erin.room, "log.list", {})).length).toBeGreaterThanOrEqual(count);
  });

  it("AC-UNDO-05: emotes, pings, hand raises, dice rolls, kicks and showing a handout leave nothing to undo", async () => {
    const dave = seats.Dave as Seat;
    const rows = () =>
      t.server.ctx.sqlite
        .prepare("SELECT type, undoable FROM history WHERE campaign_id = ? ORDER BY id")
        .all(campaignId) as { type: string; undoable: number }[];
    const before = rows().length;
    await sleep(1600);
    await rq(dave.room, "emote.send", { emote: "heart" });
    dave.room.send("ping.send", { x: 5, y: 5 });
    await sleep(1100);
    await rq(dave.room, "hand.toggle", { raised: false });
    await rq(dave.room, "dice.roll", { formula: "1d20", visibility: "public" });
    await sleep(300);
    // A kick (the spectator) is no change to the campaign either.
    await rq(dm.room, "table.kick", { userId: (seats.Watcher as Seat).id });
    await sleep(200);
    const added = rows().slice(before);
    // Nothing a person could undo: no entries, or entries marked not undoable.
    expect(added.filter((r) => r.undoable === 1)).toEqual([]);
    // None of them is a history entry at all; Dave's own undo passes over them to what he did before (Mira's level).
    expect(added).toEqual([]);
    const undone = await rq<{ entryId: number; summary: string }>(dave.room, "history.undo", {});
    expect(undone.summary).toBe("Undo: Edited Mira's sheet");
    const shows = t.server.ctx.sqlite
      .prepare(
        "SELECT undoable FROM history WHERE campaign_id = ? AND type IN ('handout.show', 'note.secret')",
      )
      .all(campaignId) as { undoable: number }[];
    expect(shows.length).toBeGreaterThan(0);
    expect(shows.every((r) => r.undoable === 0)).toBe(true);
  });
});
