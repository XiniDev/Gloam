import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  camera,
  createScene,
  hook,
  intro,
  introDone,
  req,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

type P = { x: number; y: number };
type Compiled = { name: string; key: string; at: number; origin: "warm" | "draw"; materials: string[] };
type Tok = { id: string; name: string; pos: P; ownerIds?: string[]; appearance?: { mode: string } };

async function screen(p: Page, x: number, y: number) {
  const s = await hook<{ sx: number; sy: number }>(p, "project", x, y, 0);
  return { x: s.sx, y: s.sy };
}
async function dragOn(p: Page, a: P, b: P, steps = 8) {
  const s = await screen(p, a.x, a.y);
  await p.mouse.move(s.x, s.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const q = await screen(p, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await p.mouse.move(q.x, q.y);
    await p.waitForTimeout(30);
  }
  await p.mouse.up();
}
/** A scene travel done (under software GL, with two tables drawing, slower than the usual 20 s allows). */
async function settled(p: Page, sceneId: string) {
  await expect
    .poll(
      () =>
        hook<{ shown: string | null; travelling: boolean; loading: number; framed: string | null }>(
          p,
          "boardScene",
        ),
      { timeout: 90_000 },
    )
    .toMatchObject({ shown: sceneId, travelling: false, loading: 0, framed: sceneId });
}

/**
 * Programs a frame compiled since the board faded up (the intro's `board` mark): what drawing play made the GPU
 * compile. (The warm-up's own compiles after the board shows — the other tiers', in idle moments and in parallel —
 * aren't play's: the GPU bench measures that they cost no frame.)
 */
async function lateCompiles(p: Page): Promise<Compiled[]> {
  const shown = (await intro(p))?.marks.board ?? 0;
  return (await hook<Compiled[]>(p, "programs")).filter((c) => c.at > shown && c.origin === "draw");
}

/**
 * Shaders are compiled during the intro, not in play (SPEC §37, §24; AC-PERF-05): with the §37 benchmark scene at the
 * table, the DM and a player each load it (the candle covers the warm-up), then play through what a session does —
 * the camera from top-down to low, a token dragged, the ruler and its four templates, pings and the Spotlight, every
 * die, damage, healing and conditions, a door and a light, the twelve spell looks and lasting areas, emotes, combat,
 * the DM's tools, another scene and back. No shader program is compiled after the board fades up: a compile is the
 * stall (tens of ms on a GPU, far more under software GL) the AC forbids, so none at all is the proof.
 */
test.describe("P15 — shaders warmed up before the board shows (PERF-05)", () => {
  test("AC-PERF-05: no shader compiles during play — everything play draws was compiled behind the intro", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(420_000);
    // (Test builds warm up only when asked: under software GL it takes tens of seconds — see Warmup.tsx.)
    const warm = () => {
      // (Also run on about:blank, where there's no storage.)
      try {
        localStorage.setItem("gloam:warmup", "on");
      } catch {}
    };
    // (The Admin's page is already open on the console: set now, read when the board mounts.)
    await admin.evaluate(warm);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const warmed = await hook<{ phase: string; programsAfter: number; ms: number }>(admin, "warmup");
    expect(warmed.phase).toBe("done");
    console.log(`[warmup] DM: ${warmed.programsAfter} programs warmed in ${warmed.ms} ms`);
    // A table with one of everything a scene holds: an image map, a mini (a GLB model), art on a standee, coins, 3-D
    // walls with a door, a window and a secret door, a torch and a flickering lantern, dynamic fog. (The §37
    // benchmark scene is the headed bench's; under software GL here it would measure the rasteriser, not the rule.)
    const { dungeonPng, portraitPng, statueGlb } = await assetFixtures();
    const map = await uploadVia(admin, await dungeonPng({ cols: 12, rows: 8 }), "Hall.png", "map");
    const mini = await uploadVia(admin, await statueGlb(), "Guardian.glb", "mini");
    const art = await uploadVia(admin, await portraitPng("knight", { size: 128 }), "Scout.png", "token");
    const sceneId = await createScene(
      admin,
      {
        name: "Hall",
        mapKind: "image",
        mapAssetId: map.id,
        widthFt: 60,
        heightFt: 40,
        fogMode: "dynamic",
      },
      false,
    );
    await req(admin, "scene.update", { sceneId, walls3d: true, ambientLevel: "dim" });
    await req(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 30, y: 0 }, b: { x: 30, y: 15 } },
        { a: { x: 30, y: 15 }, b: { x: 30, y: 20 }, kind: "door" },
        { a: { x: 30, y: 20 }, b: { x: 30, y: 30 }, kind: "window" },
        { a: { x: 30, y: 30 }, b: { x: 30, y: 35 }, kind: "secret" },
        { a: { x: 30, y: 35 }, b: { x: 30, y: 40 } },
      ],
    });
    const token = async (payload: Record<string, unknown>) =>
      (await req<{ tokenId: string }>(admin, "token.create", { sceneId, ...payload })).tokenId;
    const scout = await token({
      name: "Scout",
      pos: { x: 12.5, y: 17.5 },
      disposition: "party",
      appearance: { mode: "standee", assetId: art.id },
      stats: { hp: 20, hpMax: 20, ac: 14, senses: { darkvision: 60 } },
    });
    const creatureIds: string[] = [];
    creatureIds.push(
      await token({
        name: "Guardian",
        pos: { x: 22.5, y: 12.5 },
        disposition: "hostile",
        appearance: { mode: "model", assetId: mini.id },
        stats: { hp: 40, hpMax: 40, ac: 16 },
      }),
    );
    for (let i = 0; i < 5; i++)
      creatureIds.push(
        await token({
          name: `Goblin ${i + 1}`,
          pos: { x: 7.5 + i * 5, y: 27.5 },
          disposition: "hostile",
          stats: { hp: 7, hpMax: 7, ac: 15 },
        }),
      );
    await req(admin, "light.create", { sceneId, pos: { x: 20, y: 20 }, preset: "torch" });
    await req(admin, "light.create", { sceneId, pos: { x: 45, y: 20 }, preset: "hooded-lantern" });
    await req(admin, "scene.activate", { sceneId });
    await boardSettled(admin, sceneId);

    // Dave joins with the scene up: his intro loads it.
    // (AC-PERF-02: the dice physics worker isn't part of the table's first load; it's fetched when the table is idle,
    // before any throw.)
    const workerAt: number[] = [];
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", {
      onPage: (p) => {
        p.on("request", (r) => {
          if (/physics\.worker/.test(r.url())) workerAt.push(Date.now());
        });
        return p.addInitScript(warm);
      },
    });
    const boardShownAt = Date.now();
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    await req(admin, "token.update", { tokenId: scout, ownerIds: [daveId] });
    await boardSettled(dave, sceneId);
    // (The DM's intro played at the empty table, before this scene existed: what the warm-up compiled then must
    // already cover a scene it had never seen.)
    for (const p of [admin, dave]) {
      const before = await lateCompiles(p);
      console.log(`[warmup] before play: ${before.length} late compiles`);
      for (const c of before) console.log(`  ${c.name} ${c.key} :: ${c.materials.join(" | ")}`);
    }

    // ── The camera: top-down (coins), low (models and standees), close ──
    const scoutAt = (await hook<Tok>(dave, "token", scout)).pos;
    for (const p of [admin, dave]) {
      await camera(p, { pitchDeg: 90, distance: 80, target: [scoutAt.x, scoutAt.y], ms: 0 });
      await p.waitForTimeout(400);
      await camera(p, { pitchDeg: 35, distance: 45, ms: 0 });
      await p.waitForTimeout(400);
      await camera(p, { pitchDeg: 55, distance: 60, ms: 0 });
      await p.waitForTimeout(300);
    }

    // ── Dave drags his token (the ribbon, the range), measures (ruler, radius, cone, line, cube), pings ──
    const a = await screen(dave, scoutAt.x, scoutAt.y);
    await dave.mouse.move(a.x, a.y);
    await dave.mouse.down();
    for (let i = 1; i <= 8; i++) {
      const q = await screen(dave, scoutAt.x + i * 0.8, scoutAt.y + i * 0.4);
      await dave.mouse.move(q.x, q.y);
      await dave.waitForTimeout(40);
    }
    await dave.mouse.up();
    await dave.waitForTimeout(600);
    await dave.keyboard.press("m");
    await dragOn(dave, scoutAt, { x: scoutAt.x + 10, y: scoutAt.y });
    for (const shape of ["Radius", "Cone", "Line", "Cube"]) {
      await dave.getByRole("radio", { name: shape }).click();
      await dragOn(dave, scoutAt, { x: scoutAt.x + 8, y: scoutAt.y + 3 });
      await dave.waitForTimeout(200);
    }
    await dave.getByRole("radio", { name: "Ruler" }).click();
    await dave.keyboard.press("Escape");
    await dave.keyboard.press("v");
    const pingAt = await screen(dave, scoutAt.x + 5, scoutAt.y + 5);
    await dave.keyboard.down("Alt");
    await dave.mouse.click(pingAt.x, pingAt.y);
    await dave.keyboard.up("Alt");
    const spotAt = await screen(admin, scoutAt.x - 5, scoutAt.y);
    await admin.keyboard.down("Alt");
    await admin.keyboard.down("Shift");
    await admin.mouse.click(spotAt.x, spotAt.y);
    await admin.keyboard.up("Shift");
    await admin.keyboard.up("Alt");
    await admin.waitForTimeout(800);

    // The physics worker came when the table was idle — before the first throw below.
    await expect.poll(() => workerAt.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const firstRollAt = Date.now();
    expect(workerAt[0]).toBeLessThan(firstRollAt);
    console.log(
      `[warmup] physics worker fetched before any throw (${(workerAt[0] as number) - boardShownAt} ms from Dave at the table)`,
    );

    // ── Every die, for both; damage, healing, temporary hit points and conditions ──
    await req(admin, "dice.roll", { formula: "1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20 + 1d100" });
    await req(dave, "dice.roll", { formula: "2d20" });
    const [c1, c2, c3] = creatureIds as [string, string, string];
    await req(admin, "hp.apply", { targets: [c1], kind: "damage", amount: 5 });
    await admin.waitForTimeout(260);
    await req(admin, "hp.apply", { targets: [c1], kind: "heal", amount: 3 });
    await admin.waitForTimeout(260);
    await req(admin, "hp.apply", { targets: [c2], kind: "temp", amount: 4 });
    await admin.waitForTimeout(260);
    await req(admin, "hp.apply", { targets: [c3], kind: "damage", amount: 500 });
    for (const [tokenId, id] of [
      [c1, "prone"],
      [c2, "poisoned"],
      [scout, "frightened"],
    ] as const) {
      await admin.waitForTimeout(260);
      await req(admin, "status.change", { tokenId, add: [{ id }] });
    }
    await admin.waitForTimeout(3000);

    // ── A door swings open; a light goes out and comes back ──
    const walls = await hook<{ id: string; kind: string }[]>(admin, "walls");
    const door = walls.find((w) => w.kind === "door")?.id as string;
    await req(admin, "door.toggle", { wallId: door, action: "open" });
    const lights = await hook<{ id: string }[]>(admin, "lights");
    await req(admin, "light.toggle", { lightId: lights[0]?.id });
    await admin.waitForTimeout(500);
    await req(admin, "light.toggle", { lightId: lights[0]?.id });
    await admin.waitForTimeout(800);

    // ── The twelve spell looks, and lasting areas (the DM casting for a creature, free) ──
    const casts: [string, number, Record<string, unknown>][] = [
      ["fireball", 3, { placement: { origin: { x: scoutAt.x + 12, y: scoutAt.y, z: 0 } } }],
      ["ray-of-frost", 0, { targets: [c2] }],
      ["lightning-bolt", 3, { placement: { origin: { x: scoutAt.x, y: scoutAt.y, z: 0 }, dirDeg: 0 } }],
      ["thunderwave", 1, { placement: { origin: { x: scoutAt.x, y: scoutAt.y, z: 0 }, dirDeg: 90 } }],
      ["acid-splash", 0, { placement: { origin: { x: scoutAt.x + 6, y: scoutAt.y + 6, z: 0 } } }],
      ["poison-spray", 0, { targets: [c2] }],
      ["chill-touch", 0, { targets: [c2] }],
      ["sacred-flame", 0, { targets: [c2] }],
      ["magic-missile", 1, { targets: [c2, c2, c2] }],
      ["vicious-mockery", 0, { targets: [c2] }],
      ["cure-wounds", 1, { targets: [c1] }],
      ["sleep", 1, { placement: { origin: { x: scoutAt.x + 8, y: scoutAt.y - 6, z: 0 } } }],
      ["moonbeam", 2, { placement: { origin: { x: scoutAt.x - 10, y: scoutAt.y, z: 0 } } }],
      ["web", 2, { placement: { origin: { x: scoutAt.x + 15, y: scoutAt.y + 10, z: 0 } } }],
      ["wall-of-fire", 4, { placement: { origin: { x: scoutAt.x - 5, y: scoutAt.y + 12, z: 0 } } }],
      ["silence", 2, { placement: { origin: { x: scoutAt.x + 20, y: scoutAt.y - 10, z: 0 } } }],
    ];
    const caster = creatureIds[4] as string;
    for (const [spellId, level, extra] of casts) {
      await admin.waitForTimeout(280);
      await req(admin, "spell.cast", { casterTokenId: caster, spellId, mode: "free", level, ...extra }).catch(
        () => {},
      );
    }
    await admin.waitForTimeout(4000);

    // ── Emotes and a raised hand; combat with its turn ring ──
    await req(dave, "emote.send", { emote: "clap" });
    await dave.keyboard.press("h");
    await req(admin, "combat.quickStart", {});
    await admin.waitForTimeout(1500);
    await req(admin, "combat.next", {}).catch(() => {});
    await admin.waitForTimeout(1500);

    // ── The DM's tools: walls, zones, lights, fog ──
    for (const key of ["w", "z", "i", "b"]) {
      await admin.keyboard.press(key);
      await admin.waitForTimeout(500);
      const from = { x: scoutAt.x + 2, y: scoutAt.y + 2 };
      await dragOn(admin, from, { x: from.x + 6, y: from.y + 4 }, 4);
      await admin.keyboard.press("Escape");
      await admin.waitForTimeout(300);
    }
    await admin.keyboard.press("v");

    // ── A tier change (as the governor or Settings makes it): it waits for its programs, then nothing compiles ──
    for (const p of [admin, dave]) {
      await hook(p, "settings", { tier: "medium" });
      await expect
        .poll(async () => (await hook<{ tier: string }>(p, "stats")).tier, { timeout: 90_000 })
        .toBe("medium");
    }
    await req(admin, "spell.cast", {
      casterTokenId: caster,
      spellId: "fireball",
      mode: "free",
      level: 3,
      placement: { origin: { x: scoutAt.x + 12, y: scoutAt.y, z: 0 } },
    });
    await req(admin, "dice.roll", { formula: "1d20 + 1d6" });
    await admin.waitForTimeout(3000);

    // ── Another scene (3-D walls, each floor style) and back ──
    for (const floorStyle of ["wood", "grass", "cavern"]) {
      const other = await createScene(admin, {
        name: `Elsewhere ${floorStyle}`,
        mapKind: "procedural",
        floorStyle,
        widthFt: 40,
        heightFt: 30,
      });
      await req(admin, "scene.update", { sceneId: other, walls3d: true });
      await req(admin, "wall.create", {
        sceneId: other,
        walls: [
          { a: { x: 10, y: 5 }, b: { x: 10, y: 25 } },
          { a: { x: 10, y: 25 }, b: { x: 30, y: 25 }, kind: "door" },
          { a: { x: 30, y: 5 }, b: { x: 30, y: 25 }, kind: "window" },
        ],
      });
      await settled(admin, other);
      await settled(dave, other);
    }
    await req(admin, "scene.activate", { sceneId });
    await settled(admin, sceneId);
    await settled(dave, sceneId);
    await admin.waitForTimeout(1000);

    const late: Record<string, Compiled[]> = {};
    for (const [who, p] of [
      ["DM", admin],
      ["Dave", dave],
    ] as const) {
      late[who] = await lateCompiles(p);
      console.log(`[warmup] ${who}: ${late[who].length} late compiles`);
      for (const c of late[who]) console.log(`  ${c.name} ${c.key} :: ${c.materials.join(" | ")}`);
      console.log(`[warmup] ${who}: ${(await hook<Compiled[]>(p, "programs")).length} programs in all`);
    }
    // (The probe tells the two apart: both kinds were seen — the table's first frame drew its own, the warm-up
    // compiled the rest.)
    for (const p of [admin, dave]) {
      const all = await hook<Compiled[]>(p, "programs");
      expect(all.some((c) => c.origin === "draw")).toBe(true);
      expect(all.some((c) => c.origin === "warm")).toBe(true);
    }
    expect(late.DM, "DM: shaders compiled during play").toEqual([]);
    expect(late.Dave, "Dave: shaders compiled during play").toEqual([]);
  });
});
