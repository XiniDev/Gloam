import type { Room } from "@colyseus/sdk";
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
interface Player {
  room: TableRoomClient;
  id: string;
}

/**
 * Spells in the vision engine (SPEC §8.13 Persistent effects, §15; AC-VIS-06/07/08): in a dark hall, what each player's
 * client is sent — Darkness against darkvision, a torch, truesight and blindsight; a Fog Cloud across a line of sight
 * and around a viewer inside it; an invisible goblin against See Invisibility and Faerie Fire.
 */
describe("P9 — spells in the vision engine (VIS-06/07/08)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dm: TableRoomClient;
  let anna: Player;
  let bob: Player;
  let sceneId = "";
  let elf = "";
  let human = "";
  let goblin = "";
  let cultist = "";

  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const sees = (p: Player, id: string) => Boolean(p.room.state.tokens?.get?.(id));
  const cmd = async <T = unknown>(r: TableRoomClient, type: string, payload: unknown) => {
    await sleep(230);
    return rq<T>(r, type, payload);
  };
  const place = (tokenId: string, to: { x: number; y: number }) =>
    cmd(dm, "move.commit", { tokenId, points: [room().model.get("token", tokenId)?.pos, to] });
  /** The DM casts as the cultist (free: an NPC has no slots; the DM places anywhere). */
  const dmCast = (spellId: string, level: number, at: { x: number; y: number }, extra: object = {}) =>
    cmd<{ castId: string | null; effectId: string | null }>(dm, "spell.cast", {
      casterTokenId: cultist,
      spellId,
      mode: "free",
      level,
      placement: { origin: { x: at.x, y: at.y, z: 0 } },
      ...extra,
    });

  async function admit(name: string): Promise<Player> {
    const p = await joinAsNew(t, code, name);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const r = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    return { room: r, id: p.userId };
  }

  beforeAll(async () => {
    t = await startTestServer({ env: { GLOAM_TEST_SEED: "6060" } });
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    anna = await admit("Anna");
    bob = await admit("Bob");
    sceneId = (
      await rq<{ sceneId: string }>(dm, "scene.create", {
        name: "Dark hall",
        mapKind: "procedural",
        floorStyle: "stone",
        widthFt: 80,
        heightFt: 40,
        fogMode: "dynamic",
        ambient: "dark",
      })
    ).sceneId;
    elf = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Anna's Elf",
        pos: { x: 5, y: 20 },
        disposition: "party",
        ownerIds: [anna.id],
        stats: { hp: 20, hpMax: 20, ac: 14, senses: { darkvision: 60 } },
      })
    ).tokenId;
    human = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Bob's Human",
        pos: { x: 18, y: 20 },
        disposition: "party",
        ownerIds: [bob.id],
      })
    ).tokenId;
    goblin = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Goblin",
        pos: { x: 30, y: 20 },
        stats: { hp: 7, hpMax: 7, ac: 13, saves: { dex: 2 } },
      })
    ).tokenId;
    cultist = (
      await rq<{ tokenId: string }>(dm, "token.create", {
        sceneId,
        name: "Cultist",
        pos: { x: 75, y: 35 },
        stats: { hp: 9, hpMax: 9, ac: 12 },
      })
    ).tokenId;
    await rq(dm, "scene.activate", { sceneId });
    await waitFor(() => sees(anna, elf) && sees(bob, human));
    // Bob holds a torch: 20 ft of bright light round him.
    await rq(bob.room, "light.carry", { tokenId: human, preset: "torch" });
    await waitFor(() => sees(anna, goblin) && sees(bob, goblin));
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-VIS-06: magical darkness blocks darkvision and a torch's light; truesight and blindsight within range see through it", async () => {
    const d = await dmCast("darkness", 2, { x: 30, y: 20 });
    expect(room().model.get("effect", d.effectId as string)?.props.magicalDarkness).toBe(true);
    await waitFor(() => !sees(anna, goblin) && !sees(bob, goblin));
    // Truesight 30 ft (the goblin is 25 ft off): seen through it.
    await cmd(dm, "token.update", { tokenId: elf, stats: { senses: { darkvision: 60, truesight: 30 } } });
    await waitFor(() => sees(anna, goblin));
    // Truesight 20 ft: out of its range, darkvision can't.
    await cmd(dm, "token.update", { tokenId: elf, stats: { senses: { darkvision: 60, truesight: 20 } } });
    await waitFor(() => !sees(anna, goblin));
    // Blindsight 30 ft: no eyes needed.
    await cmd(dm, "token.update", {
      tokenId: elf,
      stats: { senses: { darkvision: 60, truesight: 0, blindsight: 30 } },
    });
    await waitFor(() => sees(anna, goblin));
    await cmd(dm, "token.update", { tokenId: elf, stats: { senses: { darkvision: 60, blindsight: 0 } } });
    await waitFor(() => !sees(anna, goblin));
    // Its end: both see it again.
    await cmd(dm, "effect.remove", { effectId: d.effectId });
    await waitFor(() => sees(anna, goblin) && sees(bob, goblin));
  });

  it("AC-VIS-07: a Fog Cloud blocks sight through it and a viewer inside sees only their own space; lightly obscuring, it's a haze that blocks nothing", async () => {
    // The goblin across the hall, 50 ft from the elf (in darkvision's reach); Bob beside the elf; the fog between.
    await place(goblin, { x: 55, y: 20 });
    await place(human, { x: 5, y: 32 });
    await waitFor(() => sees(anna, goblin) && sees(anna, human));
    const f = await dmCast("fog-cloud", 1, { x: 30, y: 20 });
    await waitFor(() => !sees(anna, goblin));
    // Bob's human, 12 ft from the elf and outside the fog: still seen.
    expect(sees(anna, human)).toBe(true);
    // The elf walks into the fog: nothing past its own space (not Bob, outside it).
    await place(elf, { x: 22, y: 20 });
    await waitFor(() => !sees(anna, human));
    expect(sees(anna, elf)).toBe(true);
    await place(elf, { x: 5, y: 20 });
    await waitFor(() => sees(anna, human));
    // The DM makes it light obscurement: a haze, no longer a wall.
    await cmd(dm, "effect.update", { effectId: f.effectId, props: { obscurement: "light" } });
    await waitFor(() => sees(anna, goblin));
    await cmd(dm, "effect.remove", { effectId: f.effectId });
    await place(goblin, { x: 30, y: 20 });
    await place(human, { x: 18, y: 20 });
    await waitFor(() => sees(anna, goblin) && sees(bob, goblin));
  });

  it("AC-VIS-08: an invisible goblin is seen with See Invisibility, or once Faerie Fire outlines it", async () => {
    await cmd(dm, "status.change", { tokenId: goblin, add: [{ id: "invisible" }] });
    await waitFor(() => !sees(anna, goblin) && !sees(bob, goblin));
    // See Invisibility on the elf (the DM casts it for her): she sees it; Bob doesn't.
    const si = await cmd<{ effectId: string | null }>(dm, "spell.cast", {
      casterTokenId: elf,
      spellId: "see-invisibility",
      mode: "free",
      level: 2,
    });
    expect(room().model.get("effect", si.effectId as string)?.attachedTokenId).toBe(elf);
    await waitFor(() => sees(anna, goblin));
    expect(sees(bob, goblin)).toBe(false);
    // Faerie Fire over the goblin: it fails its save and is outlined — Bob sees it by his torch.
    const ff = await dmCast("faerie-fire", 1, { x: 30, y: 20 });
    const castId = ff.castId as string;
    await cmd(dm, "cast.set", { castId, targetId: goblin, saveSuccess: false });
    await cmd(dm, "cast.apply", { castId });
    await waitFor(() =>
      [...room().model.maps.effect.values()].some((e) => e.attachedTokenId === goblin && e.props.outline),
    );
    await waitFor(() => sees(bob, goblin));
    // Its end (the DM removes the outline): unseen again by Bob.
    const outline = [...room().model.maps.effect.values()].find(
      (e) => e.attachedTokenId === goblin && e.props.outline,
    );
    await cmd(dm, "effect.remove", { effectId: outline?.id });
    await waitFor(() => !sees(bob, goblin));
  });
});
