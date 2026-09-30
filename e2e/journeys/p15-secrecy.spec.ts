import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

type Tok = {
  id: string;
  name: string;
  hp?: unknown;
  own?: unknown;
  dm?: unknown;
  pos: { x: number; y: number };
};
type Wall = { id: string; kind: string; door?: string; dmKind?: string; dmHidden?: boolean };

/** Everything a page receives over its WebSockets from the moment it opens, as text (binary frames as latin-1). */
function recordFrames(page: Page, into: string[]): void {
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) =>
      into.push(typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("latin1")),
    ),
  );
}

/**
 * What the DM keeps back never reaches a player's browser (SPEC §13.4, §15; AC-SEC-07), checked in every WebSocket
 * frame the player's page receives from the moment it opens: DM-hidden tokens; secret doors (a plain wall to them) and
 * hidden walls (only as anonymous occluders when they block sight); a carried light's and an effect's carrier while
 * it's out of sight; the DM's notes, on the scene and on a creature; an NPC's exact HP and AC; the results of their own
 * blind rolls; another player's private rolls; another scene's preparation. Each secret carries a marker no frame may
 * contain; what's numbers is checked in what the page holds (the view it was sent).
 */
test.describe("P15 — hidden information never reaches a player (SEC)", () => {
  test("AC-SEC-07: a player's WebSocket frames never carry what's hidden from them", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(300_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    // Another scene in preparation, never shown: its creature and its notes.
    const prep = await createScene(
      admin,
      { name: "Prep-Scene-QZ9", mapKind: "procedural", floorStyle: "stone", widthFt: 30, heightFt: 30 },
      false,
    );
    const { tokenId: prepToken } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId: prep,
      name: "Prep-Only-QZ9",
      pos: { x: 7.5, y: 7.5 },
    });
    await req(admin, "scene.update", { sceneId: prep, dmNotes: "PrepNote-QZ9: the ambush waits here." });

    // The scene at the table: fog on; a wall down the middle leaves the east half out of the players' sight.
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 30,
      fogMode: "dynamic",
    });
    await req(admin, "scene.update", { sceneId, dmNotes: "SceneNote-QZ9: the idol is cursed." });
    const walls = (
      await req<{ wallIds: string[] }>(admin, "wall.create", {
        sceneId,
        walls: [
          { a: { x: 30, y: 0 }, b: { x: 30, y: 12 } },
          // A secret door: to players, wall like the rest.
          { a: { x: 30, y: 12 }, b: { x: 30, y: 18 }, kind: "secret" },
          { a: { x: 30, y: 18 }, b: { x: 30, y: 30 } },
          // Hidden walls: one that doesn't block sight (never sent), one that does (sent only as an occluder).
          { a: { x: 10, y: 25 }, b: { x: 14, y: 25 }, kind: "window", hidden: true },
          { a: { x: 5, y: 2 }, b: { x: 9, y: 2 }, hidden: true },
        ],
      })
    ).wallIds;
    const [, secretDoor, , hiddenWindow, hiddenWall] = walls as [string, string, string, string, string];

    // The players: Dave, whose page is recorded from the start, and Erin.
    const daveFrames: string[] = [];
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", {
      onPage: (p) => recordFrames(p, daveFrames),
    });
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin");
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    const { tokenId: scout } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's scout",
      pos: { x: 12.5, y: 12.5 },
      ownerIds: [daveId],
      disposition: "party",
      stats: { hp: 10, hpMax: 10, ac: 14 },
    });
    // In Dave's room: a DM-hidden creature, and a guard he sees — its HP a bar, its note the DM's.
    const { tokenId: lurker } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Lurker-QZ9",
      pos: { x: 17.5, y: 7.5 },
      hidden: true,
    });
    const { tokenId: guard } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Guard",
      pos: { x: 22.5, y: 17.5 },
      hpDisplay: "bar",
      stats: { hp: 37, hpMax: 53, ac: 17 },
    });
    await req(admin, "token.update", { tokenId: guard, dmNote: "TokNote-QZ9: bribable." });
    // Beyond the wall, out of sight: a creature carrying a torch, and an effect on it.
    const { tokenId: skulker } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Skulker-QZ9",
      pos: { x: 45.5, y: 15 },
    });
    await req(admin, "light.carry", { tokenId: skulker, preset: "torch" });
    await boardSettled(dave, sceneId);
    await expect.poll(async () => (await hook<Tok[]>(dave, "tokens")).some((t) => t.id === guard)).toBe(true);

    // Rolls: a blind check the DM asks of Dave (he rolls it, the DM alone sees what); Erin's to the DM alone and to
    // herself.
    const { requestId } = await req<{ requestId: string }>(admin, "request.create", {
      targets: [scout],
      type: "custom",
      formula: "1d20",
      label: "DaveBlind-QZ9",
      visibility: "blind",
    });
    const answered = await req<{ state: string; total?: number }>(dave, "request.respond", {
      requestId,
      target: scout,
      action: "roll",
    });
    expect(answered.total, "what his blind roll came to").toBeUndefined();
    await req(erin, "dice.roll", { formula: "1d20", visibility: "dm", label: "ErinPrivate-QZ9" });
    await req(erin, "dice.roll", { formula: "1d20", visibility: "self", label: "ErinSelf-QZ9" });
    await dave.waitForTimeout(2500);

    // ── What Dave's page holds ──
    const held = await hook<Tok[]>(dave, "tokens");
    expect(held.map((t) => t.id)).not.toContain(lurker);
    expect(held.map((t) => t.id)).not.toContain(skulker);
    const g = held.find((t) => t.id === guard) as Tok;
    expect(g.hp, "the guard's exact HP").toBeUndefined();
    expect(g.own, "the guard's AC and the rest of its own numbers").toBeUndefined();
    expect(g.dm, "the DM's view of the guard").toBeUndefined();
    const heldWalls = await hook<Wall[]>(dave, "walls");
    const door = heldWalls.find((w) => w.id === secretDoor);
    expect(door?.kind ?? "wall", "the secret door is a wall to him").toBe("wall");
    expect(door?.door ?? "", "no door state on it").toBe("");
    expect(heldWalls.map((w) => w.id)).not.toContain(hiddenWindow);
    // The hidden sight-blocker: an anonymous occluder (it blocks his sight, so his client must know it's there) — no
    // door, no DM kind, nothing of what it is.
    const occluder = heldWalls.find((w) => w.id === hiddenWall);
    if (occluder) {
      expect(occluder.kind).toBe("occluder");
      expect(occluder.dmKind).toBeUndefined();
      expect(occluder.dmHidden).toBeUndefined();
      expect(occluder.door ?? "").toBe("");
    }
    // His blind roll: that he rolled, not what.
    const feed = await hook<{ label?: string; total?: number; masked?: boolean }[]>(dave, "rollFeed");
    const blind = feed.find((r) => r.label === "DaveBlind-QZ9") ?? feed.find((r) => r.masked);
    expect(blind, "his blind roll in his feed").toBeDefined();
    expect((blind as { total?: number }).total, "its total").toBeUndefined();

    // ── And not a byte of it in any frame he received ──
    const all = daveFrames.join("");
    expect(daveFrames.length).toBeGreaterThan(20);
    for (const secret of [
      "Lurker-QZ9",
      lurker,
      "Skulker-QZ9",
      skulker,
      "TokNote-QZ9",
      "SceneNote-QZ9",
      "Prep-Scene-QZ9",
      "Prep-Only-QZ9",
      prepToken,
      "PrepNote-QZ9",
      "ErinPrivate-QZ9",
      "ErinSelf-QZ9",
      hiddenWindow,
    ])
      expect(all.includes(secret), `a frame held "${secret}"`).toBe(false);
  });
});
