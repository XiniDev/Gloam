import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { GloamProcess } from "./server.ts";
import { expect, type Guard, knockAsNew, newPlayerContext, openTableAs } from "./test.ts";

/** sharp lives in the server package (pnpm keeps dependencies per package). */
const requireFromServer = createRequire(
  join(import.meta.dirname, "..", "..", "packages", "server", "package.json"),
);
type RawImage = { data: Buffer; info: { width: number; height: number; channels: number } };
export const sharp = requireFromServer("sharp") as (input: Buffer) => {
  removeAlpha(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<RawImage> } };
};

/** Calls a test hook in the page (SPEC §23.7) and returns its JSON result. */
export function hook<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([n, a]) => {
      const fn = window.__gloam?.[n as string] as ((...x: unknown[]) => unknown) | undefined;
      if (typeof fn !== "function") throw new Error(`no test hook ${n}`);
      return fn(...(a as unknown[]));
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** A command through the page's own table connection (same permissions and rate limits as the UI). */
export const req = <T = unknown>(page: Page, type: string, payload: unknown = {}) =>
  hook<T>(page, "request", type, payload);

export interface IntroState {
  phase: "ignite" | "board" | "hud" | "done";
  reduced: boolean;
  played: boolean;
  marks: Partial<Record<"start" | "ignite" | "board" | "hud" | "done" | "skipped", number>>;
}
export const intro = (page: Page) =>
  page.evaluate(() => {
    const f = window.__gloam?.intro as (() => IntroState) | undefined;
    return f ? JSON.parse(JSON.stringify(f())) : null;
  }) as Promise<IntroState | null>;

export async function introDone(page: Page): Promise<void> {
  await expect.poll(async () => (await intro(page))?.phase, { timeout: 20_000 }).toBe("done");
}

export interface BoardStats {
  tier: string;
  pinned: boolean;
  reason: string;
  dpr: number;
  shadows: boolean;
  postfx: { bloom: boolean; ao: boolean; smaa: boolean; composer: boolean };
  map: {
    kind: string;
    assetId?: string;
    variant?: string;
    width?: number;
    height?: number;
    worldW?: number;
    worldH?: number;
    style?: string;
  } | null;
  device: { maxTexture: number; software: boolean; renderer: string } | null;
  spec: { textureCap: number; dpr: number; shadowMap: number };
  memory: { geometries: number; textures: number };
  firstFrameAt: number | null;
  dust: number;
  frames: number;
}
export const stats = (page: Page) => hook<BoardStats>(page, "stats");

export interface CameraState {
  target: [number, number, number];
  position: [number, number, number];
  pitchDeg: number;
  azimuthDeg: number;
  distance: number;
  ortho: boolean;
  zoom: number;
  /** The camera that draws and picks is where the controls report (not a frame behind). */
  inSync: boolean;
}
export const camera = (page: Page, set?: Record<string, unknown>) => hook<CameraState>(page, "camera", set);

/** Admin: create the campaign, open the table locally and sit down at it as the DM. Returns the invite code. */
export async function adminAtTable(admin: Page): Promise<string> {
  const code = await openTableAs(admin, "Local only");
  await admin.getByRole("button", { name: "Go to the table" }).click();
  await expect(admin).toHaveURL(/\/table$/);
  await expect(admin.getByRole("heading", { name: "Test Campaign" })).toBeVisible();
  return code;
}

/** A player knocks, the DM admits them from the knock card on the table, and they arrive at the table. */
export async function admitPlayer(
  admin: Page,
  browser: Browser,
  gloam: GloamProcess,
  guardLog: Guard,
  code: string,
  name: string,
  contextOptions: {
    reducedMotion?: "reduce" | "no-preference";
    viewport?: { width: number; height: number };
  } = {},
): Promise<Page> {
  const { page, context } = await newPlayerContext(browser, gloam.url, guardLog, {
    ...(contextOptions.viewport ? { viewport: contextOptions.viewport } : {}),
  });
  if (contextOptions.reducedMotion) await page.emulateMedia({ reducedMotion: contextOptions.reducedMotion });
  void context;
  await knockAsNew(page, gloam.url, code, name);
  const card = admin.getByRole("alert").filter({ hasText: `${name} is knocking` });
  await card.getByRole("button", { name: "Admit" }).click();
  await expect(page).toHaveURL(/\/table$/);
  await introDone(page);
  return page;
}

/** Creates a scene through the DM's connection; `activate` moves everyone there. */
export async function createScene(
  dm: Page,
  payload: Record<string, unknown>,
  activate = true,
): Promise<string> {
  const { sceneId } = await req<{ sceneId: string }>(dm, "scene.create", payload);
  if (activate) await req(dm, "scene.activate", { sceneId });
  return sceneId;
}

/** Waits until the board shows this scene, with no travel transition running and nothing loading. */
export async function boardSettled(page: Page, sceneId: string): Promise<void> {
  await expect
    .poll(
      () =>
        hook<{ shown: string | null; travelling: boolean; loading: number; framed: string | null }>(
          page,
          "boardScene",
        ),
      { timeout: 20_000 },
    )
    // …and the camera has been set up for it (otherwise a camera move right after could be overwritten).
    .toMatchObject({ shown: sceneId, travelling: false, loading: 0, framed: sceneId });
}

/** Mean luminance and the share of near-white pixels of a PNG screenshot. */
export async function brightness(png: Buffer): Promise<{ mean: number; white: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let white = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const y =
      0.2126 * (data[i] as number) + 0.7152 * (data[i + 1] as number) + 0.0722 * (data[i + 2] as number);
    sum += y;
    if (y > 235) white++;
  }
  return { mean: sum / n, white: white / n };
}

/** Uploads bytes through the page's real upload path (test hook) and returns the asset. */
export async function uploadVia(
  page: Page,
  bytes: Uint8Array | Buffer,
  name: string,
  purpose: string,
): Promise<{ id: string; status: string; width?: number; height?: number; variants: { name: string }[] }> {
  return hook(page, "upload", Buffer.from(bytes).toString("base64"), name, purpose);
}

/**
 * The server's asset fixtures (one source of test images and GLBs), loaded at run time: the e2e TypeScript project
 * doesn't compile the server's sources.
 */
export interface AssetFixtures {
  image(format: "png" | "jpeg" | "webp", width: number, height: number): Promise<Buffer>;
  glb(opts?: Record<string, unknown>): Promise<Uint8Array>;
  roomGlb(): Promise<Uint8Array>;
  /** A stone guardian mini (for screenshots). */
  statueGlb(): Promise<Uint8Array>;
  /** Illustrated token art; `hue` makes distinct files of one figure. */
  portraitPng(
    kind: "knight" | "owl" | "goblin" | "mage",
    opts?: { size?: number; hue?: number },
  ): Promise<Buffer>;
  /** A drawn dungeon map, `cols` × `rows` squares of `pxPer5ft` pixels. */
  dungeonPng(opts?: { cols?: number; rows?: number; pxPer5ft?: number }): Promise<Buffer>;
}
export function assetFixtures(): Promise<AssetFixtures> {
  const path = ["..", "..", "packages", "server", "src", "test", "assetFixtures.ts"].join("/");
  return import(path) as Promise<AssetFixtures>;
}

interface SharpChain {
  resize(w: number, h: number, o: { kernel: string }): SharpChain;
  png(o?: { compressionLevel?: number }): SharpChain;
  toBuffer(): Promise<Buffer>;
}

/** A size × size PNG checkerboard of `cells` × `cells` squares in two map-like colours (compresses tiny). */
export async function checkerPng(size: number, cells: number): Promise<Buffer> {
  const S = requireFromServer("sharp") as (input: Buffer, o: unknown) => SharpChain;
  const raw = Buffer.alloc(cells * cells * 3);
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++)
      raw.set((i + j) % 2 ? [60, 120, 90] : [200, 170, 110], (j * cells + i) * 3);
  return S(raw, { raw: { width: cells, height: cells, channels: 3 }, limitInputPixels: false })
    .resize(size, size, { kernel: "nearest" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Loaded into the page before the table mounts: layout shifts, the HUD's boxes and styles at each intro phase,
 * and the background colour of what's on screen every animation frame (a white flash would show here). */
export function installRecorder() {
  type Rec = {
    shifts: number[];
    boxesStart: { i: string; x: number; y: number; w: number; h: number }[] | null;
    hud: { i: string; name: string; delay: string }[] | null;
    lightFrames: string[];
    frames: number;
    running: boolean;
  };
  const rec: Rec = {
    shifts: [],
    boxesStart: null,
    hud: null,
    lightFrames: [],
    frames: 0,
    running: true,
  };
  (window as unknown as { __rec: Rec }).__rec = rec;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
      if (!e.hadRecentInput) rec.shifts.push(e.value);
  }).observe({ type: "layout-shift", buffered: false });
  const boxes = () =>
    [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => ({
      i: el.dataset.hudOrder ?? "",
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
    }));
  new MutationObserver(() => {
    const phase = document.querySelector("[data-intro]")?.getAttribute("data-intro");
    if (phase && !rec.boxesStart && document.querySelector("[data-hud-order]")) rec.boxesStart = boxes();
    if (phase === "hud" && !rec.hud)
      rec.hud = [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => {
        const cs = getComputedStyle(el);
        return { i: el.dataset.hudOrder ?? "", name: cs.animationName, delay: cs.animationDelay };
      });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-intro"] });
  const lum = (c: string) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.5) return null; // (mostly) transparent: shows what's behind
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  };
  const tick = () => {
    if (!rec.running) return;
    rec.frames++;
    const probes: Element[] = [document.documentElement, document.body];
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.1],
      [0.9, 0.9],
      [0.25, 0.75],
    ] as const) {
      const x = innerWidth * fx;
      const y = innerHeight * fy;
      // What shows at this point: the first layer down that isn't (mostly) transparent.
      for (const el of document.elementsFromPoint(x, y)) {
        // The board's canvas: its pixels are the screencast's to check (reading them back stalls a software renderer).
        if (el.tagName === "CANVAS") break;
        const cs = getComputedStyle(el);
        // Faded out (a fading overlay) or a see-through background: look at what's below.
        if (Number(cs.opacity) < 0.5) continue;
        if (lum(cs.backgroundColor) !== null) {
          probes.push(el);
          break;
        }
      }
    }
    for (const el of probes) {
      const l = lum(getComputedStyle(el).backgroundColor);
      if (l !== null && l > 0.6) rec.lightFrames.push(`${el.tagName}.${el.className}`.slice(0, 80));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export type Rec = {
  shifts: number[];
  boxesStart: { i: string; x: number; y: number; w: number; h: number }[] | null;
  hud: { i: string; name: string; delay: string }[] | null;
  lightFrames: string[];
  frames: number;
};
export const readRec = (page: Page) => page.evaluate(() => (window as unknown as { __rec: Rec }).__rec);
export const hudBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => ({
      i: el.dataset.hudOrder ?? "",
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
    })),
  );

/**
 * Every composited frame (Chrome's screencast, small JPEGs) from now until `stop()`: none may be bright (a white
 * flash). Screenshots are too slow under software GL to catch a flash; the screencast sees each painted frame.
 */
export async function recordFrames(
  page: Page,
): Promise<{ stop(): Promise<{ mean: number; white: number }[]> }> {
  const cdp = await page.context().newCDPSession(page);
  const raw: Buffer[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
    raw.push(Buffer.from(f.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  // The screencast only sends frames the page's main thread commits; fades that run on the compositor alone (CSS
  // opacity transitions) would go unsampled. A 1-px, all-but-invisible element nudged every animation frame makes
  // each frame a commit, so what's on screen is sampled at the frame rate. It changes nothing anyone could see.
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "__screencast_clock";
    el.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0.001";
    document.body.appendChild(el);
    let odd = false;
    const tick = () => {
      if (!el.isConnected) return;
      odd = !odd;
      el.style.opacity = odd ? "0.002" : "0.001";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 240, maxHeight: 150 });
  return {
    async stop() {
      await page.evaluate(() => document.getElementById("__screencast_clock")?.remove()).catch(() => {});
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      return Promise.all(raw.map((b) => brightness(b)));
    },
  };
}
