import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 960, height: 600 };

interface TokenState {
  modes: { at: number; mode: string; coin: number; standee: number } | null;
  hp: { frac: number; temp: number; ghost: number; at: number; ghostStart: number } | null;
  parts: Record<string, { diameter?: number; visible: boolean; bounds?: { min: number[]; max: number[] } }>;
  ring: string | null;
  opacity: number | null;
  position: number[];
}
const tokenState = (p: Page, id: string) => hook<TokenState | null>(p, "tokenState", id);
const tokenView = (p: Page, id: string) => hook<Record<string, unknown> | null>(p, "token", id);

async function makeToken(dm: Page, sceneId: string, extra: Record<string, unknown>): Promise<string> {
  const { tokenId } = await req<{ tokenId: string }>(dm, "token.create", {
    sceneId,
    pos: { x: 20, y: 15 },
    ...extra,
  });
  return tokenId;
}

/** Screen point over a token (its base, a little above the table). */
async function screenOf(p: Page, id: string): Promise<{ x: number; y: number }> {
  await expect.poll(() => tokenState(p, id)).not.toBeNull();
  const t = (await tokenView(p, id)) as { pos: { x: number; y: number } };
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}

async function openRadial(p: Page, id: string): Promise<string[] | null> {
  const at = await screenOf(p, id);
  await p.mouse.click(at.x, at.y, { button: "right" });
  // The menu's container has no size of its own (its slices are placed around the pointer): wait on the slices.
  const items = p.getByRole("menu").getByRole("menuitem");
  try {
    await items.first().waitFor({ state: "visible", timeout: 2500 });
  } catch {
    return null;
  }
  return items.allInnerTexts();
}
const labels = (items: string[] | null) =>
  items?.map((t) => t.replace(/\d+$/, "").replace(/\s+/g, " ").trim()) ?? null;

async function closeRadial(p: Page): Promise<void> {
  await p.keyboard.press("Escape");
  await expect(p.getByRole("menu")).toHaveCount(0);
}

test.describe("P2 — tokens (TOK)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-TOK-09: the Quick Unit dialog creates a sheetless unit with arbitrary values in one submit", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Workshop",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const before = await hook<string[]>(admin, "visibleTokenIds");
    await admin.getByRole("button", { name: "Quick unit" }).click();
    const dlg = admin.getByRole("dialog", { name: "Quick unit" });
    await dlg.getByLabel("Name").fill("Clockwork Sentinel");
    await dlg.getByLabel("Disposition").selectOption("neutral");
    await dlg.getByLabel("Size").selectOption("huge");
    await dlg.getByLabel("HP", { exact: true }).fill("123");
    await dlg.getByLabel("Max HP").fill("150");
    await dlg.getByLabel("AC", { exact: true }).fill("17");
    await dlg.getByLabel("Walk").fill("25");
    await dlg.getByLabel("Fly").fill("60");
    await dlg.getByRole("switch", { name: "Hovers" }).click();
    await dlg.getByLabel("Darkvision").fill("120");
    await dlg.getByLabel("Tremorsense").fill("30");
    await dlg.getByRole("button", { name: "Place unit" }).click();
    await expect(dlg).toBeHidden();
    await expect
      .poll(async () => (await hook<string[]>(admin, "visibleTokenIds")).length)
      .toBe(before.length + 1);
    const id = (await hook<string[]>(admin, "visibleTokenIds")).find((x) => !before.includes(x)) as string;
    const t = (await tokenView(admin, id)) as Record<string, unknown> & {
      hp: Record<string, number>;
      own: Record<string, number>;
      vis: Record<string, number>;
    };
    expect(t).toMatchObject({
      name: "Clockwork Sentinel",
      kind: "unit",
      size: "huge",
      sizeFt: 15,
      disposition: "neutral",
    });
    expect(t.hp).toMatchObject({ hp: 123, hpMax: 150 });
    expect(t.own).toMatchObject({ ac: 17, speedWalk: 25, speedFly: 60 });
    expect(t.vis).toMatchObject({ darkvision: 120, tremorsense: 30 });
    // Its own copy of the stats (unlinked, no sheet): selected and on the board where the view was centred.
    expect(t.actorId).toBe("");
    expect(await hook<string[]>(admin, "visibleTokenIds")).toContain(id);
  });

  test("AC-TOK-06 / AC-TOK-08: the radial menu offers only what the viewer may do; DM-hidden tokens are faint with an eye-slash for DMs and absent for players", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Guard post",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    const hero = await makeToken(admin, sceneId, {
      name: "Hero",
      pos: { x: 15, y: 20 },
      disposition: "party",
      ownerIds: [daveId],
    });
    const goblin = await makeToken(admin, sceneId, { name: "Goblin", pos: { x: 30, y: 20 } });
    const lurker = await makeToken(admin, sceneId, { name: "Lurker", pos: { x: 45, y: 20 }, hidden: true });
    await boardSettled(dave, sceneId);
    for (const p of [admin, dave]) await camera(p, { pitchDeg: 90, distance: 70, target: [30, 20], ms: 0 });

    // Hidden: the DM sees it at 40 % with the eye-slash badge; the player never receives it.
    await expect.poll(async () => (await tokenState(admin, lurker))?.opacity).toBeCloseTo(0.4, 5);
    expect((await tokenState(admin, lurker))?.parts.hiddenBadge?.visible).toBe(true);
    expect((await tokenState(admin, goblin))?.parts.hiddenBadge).toBeUndefined();
    expect((await tokenState(admin, goblin))?.opacity).toBe(1);
    expect((await hook<string[]>(dave, "visibleTokenIds")).sort()).toEqual([goblin, hero].sort());
    expect(await tokenView(dave, lurker)).toBeNull();

    // The DM: everything this phase offers.
    // (Light arrived with P4 — SPEC §8.8; the other phases add theirs.)
    expect(labels(await openRadial(admin, goblin))).toEqual([
      "Elevation",
      "Facing",
      "Look",
      "Light",
      "Hide",
      "Lock",
      "Duplicate",
      "Delete",
    ]);
    await closeRadial(admin);
    expect(labels(await openRadial(admin, lurker))).toContain("Reveal");
    await closeRadial(admin);
    // The owner: only their own token's controls.
    expect(labels(await openRadial(dave, hero))).toEqual(["Elevation", "Facing", "Look", "Light"]);
    // Number keys pick a slice; the Elevation ring raises the token 5 ft.
    await dave.keyboard.press("1");
    await expect(dave.getByRole("menuitem", { name: "Up 5 ft" })).toBeVisible();
    await dave.keyboard.press("1");
    await expect
      .poll(async () => ((await tokenView(admin, hero)) as { elevation: number }).elevation)
      .toBe(5);
    await expect(dave.getByRole("menu")).toHaveCount(0);
    // Someone else's token: no menu at all.
    expect(await openRadial(dave, goblin)).toBeNull();
    // Locked by the DM: the owner keeps only Look.
    await req(admin, "token.update", { tokenId: hero, locked: true });
    await expect.poll(async () => ((await tokenView(dave, hero)) as { locked: boolean }).locked).toBe(true);
    expect(labels(await openRadial(dave, hero))).toEqual(["Look"]);
    await closeRadial(dave);

    // Long-press (touch) opens it too.
    const at = await screenOf(dave, hero);
    await dave.evaluate(async ({ x, y }) => {
      const c = document.querySelector("[data-testid=board] canvas") as HTMLCanvasElement;
      const ev = (type: string) =>
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        });
      c.dispatchEvent(ev("pointerdown"));
      await new Promise((r) => setTimeout(r, 650));
      c.dispatchEvent(ev("pointerup"));
    }, at);
    await expect(
      dave.getByRole("menu", { name: "Actions for Hero" }).getByRole("menuitem").first(),
    ).toBeVisible();
  });

  test("AC-TOK-01 / AC-TOK-02 / AC-TOK-11: model, standee, coin and auto modes switch at once and persist; bases follow size; rings show owner or disposition colours; auto crossfades at 70°", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const { portraitPng, statueGlb } = await assetFixtures();
    const art = await uploadVia(admin, await portraitPng("knight"), "knight.png", "token");
    const mini = await uploadVia(admin, await statueGlb(), "statue.glb", "mini");
    const sceneId = await createScene(admin, {
      name: "Gallery",
      mapKind: "procedural",
      floorStyle: "parchment",
      widthFt: 80,
      heightFt: 50,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const me = (await hook<{ userId: string; color: string }>(dave, "me")) as {
      userId: string;
      color: string;
    };

    const knight = await makeToken(admin, sceneId, {
      name: "Knight",
      pos: { x: 20, y: 20 },
      appearance: { mode: "auto", assetId: art.id },
    });
    const statue = await makeToken(admin, sceneId, {
      name: "Statue",
      pos: { x: 40, y: 20 },
      appearance: { mode: "model", assetId: mini.id },
    });
    await camera(admin, { pitchDeg: 90, distance: 90, target: [40, 25], ms: 0 });

    // AC-TOK-01: switching through the radial menu's Look ring is immediate…
    const pick = async (id: string, label: string) => {
      await openRadial(admin, id);
      await admin.getByRole("menuitem", { name: "Look" }).click();
      await admin.getByRole("menuitem", { name: label }).click();
    };
    const shows = async (id: string) => {
      const s = await tokenState(admin, id);
      if (!s) return [];
      return Object.entries(s.parts)
        .filter(([k, v]) => ["coin", "standee", "mini"].includes(k) && v.visible)
        .map(([k]) => k)
        .sort();
    };
    await expect.poll(() => shows(statue), { timeout: 20_000 }).toEqual(["mini"]);
    await pick(knight, "Coin");
    await expect.poll(() => shows(knight), { timeout: 2000 }).toEqual(["coin"]);
    await pick(knight, "Standee");
    await expect.poll(() => shows(knight), { timeout: 2000 }).toEqual(["standee"]);
    await pick(statue, "Coin");
    await expect.poll(() => shows(statue), { timeout: 2000 }).toEqual(["coin"]);
    await pick(statue, "3D model");
    await expect.poll(() => shows(statue), { timeout: 2000 }).toEqual(["mini"]);
    await pick(knight, "Auto");
    // …and persisted: after a reload the tokens come back as they were left.
    await admin.reload();
    await introDone(admin);
    await boardSettled(admin, sceneId);
    await camera(admin, { pitchDeg: 90, distance: 90, target: [40, 25], ms: 0 });
    expect(((await tokenView(admin, knight)) as { mode: string }).mode).toBe("auto");
    await expect.poll(() => shows(statue), { timeout: 20_000 }).toEqual(["mini"]);

    // AC-TOK-11: auto is a coin above 70° pitch and a standee below, crossfading over 200 ms.
    await camera(admin, { pitchDeg: 69, ms: 0 });
    await expect.poll(() => shows(knight)).toEqual(["standee"]);
    await camera(admin, { pitchDeg: 71, ms: 0 });
    await expect.poll(() => shows(knight)).toEqual(["coin"]);
    // The fade itself, from the frames the board rendered: coin weight rises linearly at 1 / 200 ms.
    await camera(admin, { pitchDeg: 60, ms: 0 });
    await expect.poll(async () => (await tokenState(admin, knight))?.modes?.coin).toBe(0);
    await admin.evaluate((id) => {
      const w = window as unknown as {
        __cf: { at: number; coin: number }[];
        __gloam: Record<string, (...a: unknown[]) => unknown>;
      };
      w.__cf = [];
      let last = 0;
      const tick = () => {
        const s = (w.__gloam.tokenState as (x: string) => unknown)(id) as {
          modes: { at: number; coin: number };
        };
        if (s.modes.at !== last) {
          last = s.modes.at;
          w.__cf.push({ at: s.modes.at, coin: s.modes.coin });
        }
        if (s.modes.coin < 1 || w.__cf.length < 2) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (w.__gloam.camera as (x: unknown) => unknown)({ pitchDeg: 80, ms: 0 });
    }, knight);
    await admin.waitForFunction(() => {
      const cf = (window as unknown as { __cf: { coin: number }[] }).__cf;
      return cf.length > 0 && (cf[cf.length - 1] as { coin: number }).coin >= 1;
    });
    const cf = await admin.evaluate(
      () => (window as unknown as { __cf: { at: number; coin: number }[] }).__cf,
    );
    const mid = cf.filter((s) => s.coin > 0 && s.coin < 1);
    const rates = mid
      .slice(1)
      .map(
        (s, i) =>
          (s.coin - (mid[i] as { coin: number }).coin) / ((s.at - (mid[i] as { at: number }).at) / 1000),
      );
    test.info().annotations.push({
      type: "crossfade",
      description: `coin weights ${cf.map((s) => s.coin.toFixed(2)).join(" → ")}; rates ${rates.map((r) => r.toFixed(2)).join(", ")} /s`,
    });
    for (const r of rates) expect(r).toBeCloseTo(5, 0); // 1 per 200 ms
    expect(cf.length).toBeGreaterThanOrEqual(2);

    // AC-TOK-02: bases are the creature's space; custom sizes too.
    const sizes = { tiny: 2.5, small: 5, medium: 5, large: 10, huge: 15, gargantuan: 20 } as const;
    const ids: Record<string, string> = {};
    let x = 8;
    for (const [size] of Object.entries(sizes)) {
      ids[size] = await makeToken(admin, sceneId, { name: size, size, pos: { x, y: 40 } });
      x += 12;
    }
    ids.custom = await makeToken(admin, sceneId, {
      name: "Swarm",
      size: "large",
      sizeFt: 7.5,
      pos: { x: 70, y: 8 },
    });
    const diameter = async (id: string) => {
      const s = await tokenState(admin, id);
      return s?.parts.base?.diameter ?? s?.parts.coin?.diameter;
    };
    for (const [size, ft] of Object.entries(sizes))
      await expect.poll(() => diameter(ids[size] as string)).toBe(ft);
    await expect.poll(() => diameter(ids.custom as string)).toBe(7.5);
    // Rings: disposition colours for NPCs, the owner's player colour for party tokens.
    const { DISPOSITION_COLORS } = await import("../../packages/shared/src/constants.ts");
    const hostile = await makeToken(admin, sceneId, {
      name: "Brute",
      disposition: "hostile",
      pos: { x: 10, y: 10 },
    });
    const neutral = await makeToken(admin, sceneId, {
      name: "Merchant",
      disposition: "neutral",
      pos: { x: 20, y: 10 },
    });
    const friendly = await makeToken(admin, sceneId, {
      name: "Ally",
      disposition: "friendly",
      pos: { x: 30, y: 10 },
    });
    const party = await makeToken(admin, sceneId, {
      name: "Dave's Ranger",
      disposition: "party",
      ownerIds: [me.userId],
      pos: { x: 40, y: 10 },
    });
    const ring = async (id: string) => (await tokenState(admin, id))?.ring?.toLowerCase();
    await expect.poll(() => ring(hostile)).toBe(DISPOSITION_COLORS.hostile.toLowerCase());
    await expect.poll(() => ring(neutral)).toBe(DISPOSITION_COLORS.neutral.toLowerCase());
    await expect.poll(() => ring(friendly)).toBe(DISPOSITION_COLORS.friendly.toLowerCase());
    await expect.poll(() => ring(party)).toBe(me.color.toLowerCase());
    await admin.screenshot({ path: "artifacts/screens/p2-tokens-sizes-rings.png" });
  });

  test("AC-TOK-03 / AC-TOK-10: GLB minis are grounded, centred and scaled to their size with persistent overrides; twenty minis share one geometry set", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const { glb } = await assetFixtures();
    // A 2-unit-tall model floating from y −1 to 1, off-centre: the pipeline and the client must normalise it.
    const mini = await uploadVia(admin, await glb({ height: 2, baseY: -1 }), "golem.glb", "mini");
    const sceneId = await createScene(admin, {
      name: "Forge",
      mapKind: "procedural",
      floorStyle: "cavern",
      widthFt: 80,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);
    const golem = await makeToken(admin, sceneId, {
      name: "Golem",
      size: "medium",
      pos: { x: 20, y: 20 },
      appearance: { mode: "model", assetId: mini.id },
    });
    const bounds = async (id: string) => (await tokenState(admin, id))?.parts.mini?.bounds;
    await expect.poll(() => bounds(golem), { timeout: 20_000 }).toBeTruthy();
    const b0 = (await bounds(golem)) as { min: number[]; max: number[] };
    // Medium stands 5.5 ft tall, on its base (BASE_H), centred on the token.
    const BASE_H = b0.min[1] as number;
    expect(BASE_H).toBeGreaterThan(0);
    expect(BASE_H).toBeLessThan(0.5);
    expect((b0.max[1] as number) - (b0.min[1] as number)).toBeCloseTo(5.5, 1);
    expect(((b0.min[0] as number) + (b0.max[0] as number)) / 2).toBeCloseTo(20, 1);
    expect(((b0.min[2] as number) + (b0.max[2] as number)) / 2).toBeCloseTo(20, 1);
    // Per-asset overrides (scale, vertical offset) apply to every token using it, and persist.
    await req(admin, "asset.update", { assetId: mini.id, overrides: { scale: 1.5, offsetY: 0.5 } });
    await expect
      .poll(async () => {
        const b = await bounds(golem);
        return b ? +((b.max[1] as number) - (b.min[1] as number)).toFixed(1) : null;
      })
      .toBeCloseTo(8.3, 0);
    await admin.reload();
    await introDone(admin);
    await boardSettled(admin, sceneId);
    await expect.poll(() => bounds(golem), { timeout: 20_000 }).toBeTruthy();
    const b1 = (await bounds(golem)) as { min: number[]; max: number[] };
    expect((b1.max[1] as number) - (b1.min[1] as number)).toBeCloseTo(8.25, 1);
    expect(b1.min[1] as number).toBeCloseTo(BASE_H + 0.5, 1);

    // AC-TOK-10: twenty tokens with the same GLB share its geometry and materials. The renderer's geometry count
    // grows by the same amount for 19 more minis as for 19 more plain coins (their overlays are identical), so the
    // minis add no geometry of their own — one set for all twenty.
    type MiniStats = { instances: number; geometries: number; materials: number; rendererGeometries: number };
    const one = await hook<MiniStats>(admin, "miniStats");
    const settle = async () => {
      await admin.waitForTimeout(600);
      return (await hook<MiniStats>(admin, "miniStats")).rendererGeometries;
    };
    const g0 = await settle();
    for (let i = 0; i < 19; i++)
      await makeToken(admin, sceneId, {
        name: `Coin ${i + 2}`,
        pos: { x: 6 + (i % 10) * 7, y: 50 },
        appearance: { mode: "coin" },
      });
    await expect.poll(async () => (await hook<string[]>(admin, "visibleTokenIds")).length).toBe(20);
    const g1 = await settle();
    for (let i = 0; i < 19; i++)
      await makeToken(admin, sceneId, {
        name: `Golem ${i + 2}`,
        pos: { x: 6 + (i % 10) * 7, y: 30 + Math.floor(i / 10) * 10 },
        appearance: { mode: "model", assetId: mini.id },
      });
    await expect
      .poll(async () => (await hook<MiniStats>(admin, "miniStats")).instances, { timeout: 20_000 })
      .toBe(20);
    const g2 = await settle();
    const twenty = await hook<MiniStats>(admin, "miniStats");
    test.info().annotations.push({
      type: "minis",
      description: `1 mini ${JSON.stringify(one)}; 20 minis ${JSON.stringify(twenty)}; +19 coins +${g1 - g0} geometries, +19 minis +${g2 - g1}`,
    });
    expect(twenty.geometries).toBe(one.geometries);
    expect(twenty.materials).toBe(one.materials);
    expect(Math.abs(g2 - g1 - (g1 - g0))).toBeLessThanOrEqual(3);
  });

  test("AC-TOK-05: damage leaves a ghost that holds 400 ms and drains over 600 ms; temp HP is its own segment; a tick marks 50 %", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Arena",
      mapKind: "procedural",
      floorStyle: "sand",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const ogre = await makeToken(admin, sceneId, {
      name: "Ogre",
      size: "large",
      hpDisplay: "exact",
      stats: { hp: 20, hpMax: 20, hpTemp: 5, ac: 11 },
    });
    await expect.poll(async () => (await tokenState(admin, ogre))?.hp?.temp).toBeCloseTo(0.25, 5);

    // The drain, from the frames the board rendered (each frame's ghost value and the drain's start time).
    await admin.evaluate((id) => {
      const w = window as unknown as {
        __hp: { at: number; ghost: number; frac: number; start: number }[];
        __gloam: Record<string, (...a: unknown[]) => unknown>;
      };
      w.__hp = [];
      let last = 0;
      const tick = () => {
        const s = (
          (w.__gloam.tokenState as (x: string) => unknown)(id) as {
            hp: { at: number; ghost: number; frac: number; ghostStart: number };
          }
        ).hp;
        if (s.at !== last) {
          last = s.at;
          w.__hp.push({ at: s.at, ghost: s.ghost, frac: s.frac, start: s.ghostStart });
        }
        if (w.__hp.length < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, ogre);
    await req(admin, "token.update", { tokenId: ogre, stats: { hp: 8, hpTemp: 0 } });
    await admin.waitForFunction(() => {
      const hp = (window as unknown as { __hp: { ghost: number; frac: number; start: number }[] }).__hp;
      const l = hp[hp.length - 1];
      return !!l && Math.abs(l.ghost - 0.4) < 1e-6 && hp.some((s) => s.start > 0);
    });
    const hp = await admin.evaluate(
      () =>
        (window as unknown as { __hp: { at: number; ghost: number; frac: number; start: number }[] }).__hp,
    );
    const start = (hp.find((s) => s.start > 0) as { start: number }).start;
    const after = hp.filter((s) => s.at >= start && s.frac < 0.5);
    for (const s of after) {
      const t = s.at - start;
      const expected = t < 400 ? 1 : t < 1000 ? 1 + (0.4 - 1) * ((t - 400) / 600) : 0.4;
      expect(s.ghost, `ghost at ${Math.round(t)} ms`).toBeCloseTo(expected, 2);
    }
    const inHold = after.filter((s) => s.at - start < 400).length;
    const inDrain = after.filter((s) => s.at - start >= 400 && s.at - start < 1000).length;
    test.info().annotations.push({
      type: "ghost",
      description: `${inHold} frames in the hold, ${inDrain} in the drain`,
    });
    expect(inHold + inDrain).toBeGreaterThanOrEqual(2);

    // The bar itself, rendered by the real shader: fill, then temp HP as its own segment, then the ghost; a tick at 50 %.
    const { BOARD_COLORS } = await import("../../packages/shared/src/constants.ts");
    const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    const near = (a: number[], b: number[], tol = 6) =>
      a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);
    const W = 400;
    // 16 / 20 HP + 5 temp: spans 21 → fill to 76 %, temp to 100 %.
    let px = await hook<number[][]>(admin, "renderHpBar", { frac: 0.8, temp: 0.25, ghost: 0.8 }, W);
    expect(near(px[Math.round(W * 0.3)] as number[], hex(BOARD_COLORS.verdigris400))).toBe(true);
    expect(near(px[Math.round(W * 0.88)] as number[], hex(BOARD_COLORS.ice300))).toBe(true);
    // The 50 % tick (of max HP, so at 0.5 / 1.05 of the bar): darker than the fill either side.
    const tickX = Math.round((W * 0.5) / 1.05);
    const lum = (c: number[]) =>
      0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
    expect(lum(px[tickX] as number[])).toBeLessThan(lum(px[tickX - 8] as number[]) * 0.6);
    expect(lum(px[tickX] as number[])).toBeLessThan(lum(px[tickX + 8] as number[]) * 0.6);
    // 8 / 20 HP with the ghost still at 16: brass fill to 40 %, the ghost to 80 %, then empty.
    px = await hook<number[][]>(admin, "renderHpBar", { frac: 0.4, temp: 0, ghost: 0.8 }, W);
    expect(near(px[Math.round(W * 0.2)] as number[], hex(BOARD_COLORS.brass400))).toBe(true);
    expect(near(px[Math.round(W * 0.65)] as number[], hex(BOARD_COLORS.hpGhost))).toBe(true);
    expect(near(px[Math.round(W * 0.9)] as number[], hex(BOARD_COLORS.ink900))).toBe(true);
  });

  test("overlay layout (§8.5): every plate sits just above its own token at any pitch and pose, shown plates never overlap, and settled fades stay settled", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const { portraitPng, statueGlb } = await assetFixtures();
    const art = await uploadVia(admin, await portraitPng("knight"), "knight.png", "token");
    const mini = await uploadVia(admin, await statueGlb(), "guardian.glb", "mini");
    const sceneId = await createScene(admin, {
      name: "Crowd",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 80,
      heightFt: 50,
    });
    await boardSettled(admin, sceneId);
    const hp = (n: number, max = 20) => ({ stats: { hp: n, hpMax: max, ac: 12 } });
    const tokens = [
      {
        name: "Stone Guardian",
        pos: { x: 44, y: 26 },
        size: "large",
        appearance: { mode: "model", assetId: mini.id },
        ...hp(60, 60),
      },
      {
        name: "Fallen Guardian",
        pos: { x: 62, y: 30 },
        size: "large",
        appearance: { mode: "model", assetId: mini.id },
        ...hp(0, 60),
      },
      {
        name: "Sir Aldric",
        pos: { x: 16, y: 26 },
        appearance: { mode: "auto", assetId: art.id },
        ...hp(24, 31),
      },
      {
        name: "Fallen Knight",
        pos: { x: 26, y: 34 },
        appearance: { mode: "standee", assetId: art.id },
        ...hp(0, 31),
      },
      { name: "Goblin Boss", pos: { x: 30, y: 20 }, hpDisplay: "descriptor", ...hp(12, 21) },
      // A tight pack: at a distance their plates would pile up — declutter keeps one of each overlap.
      ...[0, 1, 2, 3].map((i) => ({
        name: `Goblin ${i + 1}`,
        pos: { x: 56 + (i % 2) * 5, y: 10 + Math.floor(i / 2) * 5 },
        size: "small",
        ...hp(7, 7),
      })),
    ];
    for (const t of tokens) await req(admin, "token.create", { sceneId, ...t });

    type R = { x0: number; y0: number; x1: number; y1: number };
    type O = {
      id: string;
      clear: number;
      rect?: R;
      flips: number;
      token: R | null;
      fade?: { clear: number; target: number; a: number };
    };
    const overlays = () => hook<O[]>(admin, "overlays");
    // Settled: frames have been drawn since the view changed and the board has gone idle again, every plate is laid
    // out and done fading, and nothing moved since the last look (minis load late; a slow first frame after a big
    // view change must not pass for "nothing changed").
    let last = "";
    let since = 0;
    const frames = async () => (await hook<{ frames: number }>(admin, "stats")).frames;
    const settled = async () => {
      const o = await overlays();
      const f = await frames();
      const ready =
        f > since + 2 &&
        o.length === tokens.length &&
        o.every((x) => x.rect && x.token && x.fade && x.fade.clear === x.fade.target);
      const now = JSON.stringify([f, o.map((x) => [x.clear, x.rect, x.token])]);
      const same = now === last;
      last = now;
      return ready && same;
    };
    const overlap = (a: R, b: R) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    for (const view of [
      { pitchDeg: 90, distance: 75 },
      { pitchDeg: 55, distance: 70 },
      { pitchDeg: 30, distance: 60 },
      { pitchDeg: 55, distance: 160 },
    ]) {
      since = await frames();
      await camera(admin, { ...view, target: [40, 25], ms: 0 });
      await expect.poll(settled, { timeout: 20_000, intervals: [400] }).toBe(true);
      const all = await overlays();
      const shown = all.filter((o) => o.clear === 1);
      expect(shown.length, JSON.stringify(view)).toBeGreaterThan(0);
      for (const o of shown) {
        const plate = o.rect as R;
        const tok = o.token as R;
        const label = `${JSON.stringify(view)} ${((await tokenView(admin, o.id)) as { name: string }).name}`;
        // Just above the token's highest point: a small gap, not floating (or sinking into it).
        const gap = tok.y0 - plate.y1;
        expect(gap, label).toBeGreaterThanOrEqual(-1);
        expect(gap, label).toBeLessThanOrEqual(14);
        // And over it, not beside it: its centre within the middle 60 % of the token's width on screen (perspective
        // shifts a tall token's top away from the view's centre, and the plate follows the top).
        const cx = (plate.x0 + plate.x1) / 2;
        const w = tok.x1 - tok.x0;
        expect(cx, label).toBeGreaterThanOrEqual(tok.x0 + 0.2 * w);
        expect(cx, label).toBeLessThanOrEqual(tok.x1 - 0.2 * w);
      }
      for (const [i, a] of shown.entries())
        for (const b of shown.slice(i + 1))
          expect(overlap(a.rect as R, b.rect as R), `${JSON.stringify(view)} ${a.id} × ${b.id}`).toBe(false);
      // Settled stays settled: a burst of ordinary redraws changes no verdict and moves no fade.
      await hook(admin, "redraw", 600);
      await admin.waitForTimeout(700);
      const again = await overlays();
      for (const o of again) {
        const before = all.find((x) => x.id === o.id) as O;
        expect(o.flips, o.id).toBe(before.flips);
        expect(o.fade?.clear, o.id).toBe(o.fade?.target);
        expect(o.fade?.a, o.id).toBe(before.fade?.a);
      }
    }
  });
});
