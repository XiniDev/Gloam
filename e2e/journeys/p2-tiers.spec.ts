import type { Page } from "@playwright/test";
import {
  adminAtTable,
  boardSettled,
  checkerPng,
  createScene,
  hook,
  introDone,
  stats,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/** Settings → Graphics → a tier (or Auto). */
async function pinTier(page: Page, label: "Auto" | "Ultra" | "High" | "Medium" | "Low"): Promise<void> {
  const settings = page.getByRole("dialog", { name: "Settings" });
  if (!(await settings.isVisible())) await page.getByRole("button", { name: "Settings" }).click();
  await settings
    .getByRole("radiogroup", { name: "Graphics quality" })
    .getByRole("radio", { name: label })
    .click();
}

test.describe("P2 — performance tiers and big maps (BRD-03, BRD-06)", () => {
  // A 2× display, so "caps DPR" is visible (at 1× every tier would render at 1).
  test.use({ deviceScaleFactor: 2, viewport: { width: 960, height: 600 } });

  test("AC-BRD-03: auto-selected from the device, adapts at runtime, can be pinned; Low has no shadows, bloom or AO and DPR 1", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Tier hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);

    // Auto: software GL (SwiftShader) → Low, from the device profile.
    let s = await stats(admin);
    expect(s.device?.software).toBe(true);
    expect(s).toMatchObject({ tier: "low", pinned: false, reason: "device profile" });
    // Low: no shadow maps, no bloom, no ambient occlusion, no composer at all, DPR capped at 1 on a 2× display.
    expect(s.shadows).toBe(false);
    expect(s.postfx).toMatchObject({ bloom: false, ao: false, composer: false });
    expect(s.dpr).toBe(1);
    expect(s.dust).toBe(0);

    // Runtime adaptation (§8.4): 10 s comfortably above target steps up; 3 s below steps down.
    await hook(admin, "forceFrameMs", 5);
    await expect
      .poll(async () => (await stats(admin)).tier, { timeout: 25_000, intervals: [500] })
      .toBe("medium");
    expect((await stats(admin)).reason).toBe("comfortably above target for 10 s");
    const tUp = Date.now();
    await hook(admin, "forceFrameMs", 40);
    await expect
      .poll(async () => (await stats(admin)).tier, { timeout: 15_000, intervals: [250] })
      .toBe("low");
    expect((await stats(admin)).reason).toBe("below target for 3 s");
    expect(Date.now() - tUp).toBeGreaterThanOrEqual(2900);

    // Pinned by the user: High stays High however slow the frames; its features switch on.
    await pinTier(admin, "High");
    await expect.poll(async () => (await stats(admin)).tier).toBe("high");
    s = await stats(admin);
    expect(s).toMatchObject({ pinned: true, reason: "pinned in settings", shadows: true });
    expect(s.postfx).toMatchObject({ bloom: true, ao: false, composer: true, smaa: true });
    expect(s.dpr).toBe(1.75);
    expect(s.dust).toBe(110);
    await expect(admin.getByTestId("tier-readout")).toContainText("Pinned to High");
    await hook(admin, "forceFrameMs", 200);
    await admin.waitForTimeout(4500);
    expect((await stats(admin)).tier).toBe("high");
    await hook(admin, "forceFrameMs", null);
    // Ultra adds ambient occlusion and the full pixel ratio.
    await pinTier(admin, "Ultra");
    await expect.poll(async () => (await stats(admin)).tier).toBe("ultra");
    s = await stats(admin);
    expect(s.postfx).toMatchObject({ bloom: true, ao: true, composer: true });
    expect(s.dpr).toBe(2);
    expect(s.dust).toBe(160);
    // Back to Auto: the device profile decides again, and the pin is remembered on this device only.
    await pinTier(admin, "Auto");
    await expect.poll(async () => (await stats(admin)).tier).toBe("low");
    expect((await stats(admin)).pinned).toBe(false);
    await expect(admin.getByTestId("tier-readout")).toContainText("now Low");
    await pinTier(admin, "Medium");
    await admin.reload();
    await introDone(admin);
    await expect.poll(async () => (await stats(admin)).tier).toBe("medium");
    expect((await stats(admin)).pinned).toBe(true);
  });

  test("AC-BRD-06: a 16 384 × 16 384 map is accepted and shown with the largest variant the device and tier allow", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const png = await checkerPng(16384, 4);
    // Through the DM's New scene wizard, like a real upload.
    await admin.getByRole("button", { name: "DM panel" }).click();
    await admin.getByRole("tab", { name: "Scenes" }).click();
    await admin.getByRole("button", { name: "New scene" }).first().click();
    const wizard = admin.getByRole("dialog", { name: "New scene" });
    await wizard.getByRole("button", { name: /Upload a map image/ }).click();
    await admin
      .getByRole("dialog", { name: "Upload a map image" })
      .locator('input[type="file"]')
      .setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: png });
    const calibrate = admin.getByRole("dialog", { name: "Calibrate the map" });
    await expect(calibrate).toBeVisible({ timeout: 60_000 });
    await calibrate.getByRole("button", { name: "Next" }).click();
    const name = admin.getByRole("dialog", { name: "Name the scene" });
    await name.getByLabel("Scene name").fill("The Great Vault");
    await name.getByRole("button", { name: "Create scene" }).click();
    await expect(admin.getByTestId("prep-banner")).toContainText("The Great Vault");

    // The largest variant not exceeding min(MAX_TEXTURE_SIZE, the tier's cap) — Low first, then Ultra.
    const variants = [8192, 4096, 1024, 256];
    const expected = (maxTexture: number, cap: number) =>
      variants.find((v) => v <= Math.min(maxTexture, cap));
    for (const pin of ["Low", "Ultra"] as const) {
      await pinTier(admin, pin);
      await admin.keyboard.press("Escape");
      await expect.poll(async () => (await stats(admin)).tier).toBe(pin.toLowerCase());
      const st = await stats(admin);
      const want = expected(st.device?.maxTexture ?? 4096, st.spec.textureCap);
      await expect
        .poll(async () => (await stats(admin)).map, { timeout: 30_000 })
        .toMatchObject({ kind: "image", variant: `w${want}`, width: want, height: want });
      // Loaded and on the table: the texture is held by the map, and the plane is the full map in feet.
      await expect
        .poll(async () =>
          (
            await hook<{ resources: { textures: { key: string; refs: number }[] } }>(admin, "stats")
          ).resources.textures.some((t) => t.key.endsWith(`/w${want}`) && t.refs > 0),
        )
        .toBe(true);
      const map = (await stats(admin)).map;
      expect(map?.worldW).toBeCloseTo((16384 * 5) / 70, 3);
      test.info().annotations.push({
        type: "variant",
        description: `${pin}: MAX_TEXTURE_SIZE ${st.device?.maxTexture}, cap ${st.spec.textureCap} → w${want}`,
      });
    }
    await admin.screenshot({ path: "artifacts/screens/p2-huge-map.png" });
  });
});
