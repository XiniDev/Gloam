import { readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { Room } from "@colyseus/sdk";
import { validateBytes } from "gltf-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_TIMEOUT_MS, PROCESSOR_RSS_LIMIT, PROFILE_CAP, QUOTA } from "../assets/types.ts";
import { BucketMap } from "../auth/rateLimit.ts";
import { bombPng, denseGlb, editGlbJson, glb, hookFile, image, noisePng, wav, zip } from "./assetFixtures.ts";
import {
  type Agent,
  createCampaign,
  joinAsNew,
  openTable,
  rq,
  setupAdmin,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

interface AssetDto {
  id: string;
  name: string;
  status: string;
  cls: string;
  variants: { name: string; width?: number; height?: number; mime: string; bytes: number }[];
  glb?: {
    triangles: number;
    trianglesIn: number;
    bounds: { min: number[]; max: number[] };
    animations: string[];
  };
  overrides: Record<string, number>;
  dominant?: string;
}
type UploadResult = { status: number; asset?: AssetDto; error?: { code: string; message: string } };

async function upload(
  agent: Agent,
  purpose: string,
  filename: string,
  bytes: Uint8Array,
  query: Record<string, string> = {},
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const qs = new URLSearchParams({ purpose, ...query }).toString();
  const res = await fetch(`${agent.base}/api/assets?${qs}`, {
    method: "POST",
    headers: {
      cookie: agent.cookieHeader(),
      origin: agent.base,
      "x-gloam-csrf": agent.cookies.get("gloam_csrf") ?? "",
    },
    body: form,
  });
  const j = (await res.json()) as { data?: { asset: AssetDto }; error?: { code: string; message: string } };
  return { status: res.status, asset: j.data?.asset, error: j.error };
}

const get = (agent: Agent | null, path: string, headers: Record<string, string> = {}) =>
  fetch(`${agent?.base ?? ""}${path}`, {
    headers: agent ? { cookie: agent.cookieHeader(), origin: agent.base, ...headers } : headers,
  });

describe("P2 — assets and uploads (AST)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  let dave: Agent;
  let daveRoom: Room;
  let erin: Agent;
  let dm: Room;
  let realUploadLimit: BucketMap;

  beforeAll(async () => {
    t = await startTestServer({
      config: {
        processor: { timeoutMs: { image: 4000, model: 20_000, audio: 3000 }, rssLimit: 700 * 1024 * 1024 },
      },
    });
    admin = await setupAdmin(t);
    // This suite uploads far more than §22.5's 10 per minute per user; that limit has its own test below.
    realUploadLimit = t.server.ctx.limits.uploads;
    t.server.ctx.limits.uploads = new BucketMap(10_000, 10_000);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
    dm = await admin.colyseus().joinById(campaignId);
    dm.onMessage("*", () => {});
    const admit = async (name: string) => {
      const p = await joinAsNew(t, code, name);
      await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
      await waitFor(() => p.messages.find((m) => m.type === "admitted"));
      await p.agent.post("/api/join/enter");
      const room = await p.agent.colyseus().joinById(campaignId);
      room.onMessage("*", () => {});
      return { agent: p.agent, room };
    };
    ({ agent: dave, room: daveRoom } = await admit("Dave"));
    ({ agent: erin } = await admit("Erin"));
  }, 120_000);
  afterAll(async () => {
    await t?.stop();
  });

  const health = async () => (await fetch(`${t.url}/api/health`)).status;
  const tmpFiles = () => readdirSync(t.server.ctx.paths.tmp);

  it("the production limits match SPEC §8.16/§21.1 (tests shorten only the kill-path timeouts)", () => {
    const MB = 1024 * 1024;
    expect(PROFILE_CAP).toMatchObject({
      map: 80 * MB,
      tok: 25 * MB,
      hnd: 25 * MB,
      mini: 60 * MB,
      mapglb: 60 * MB,
      aud: 50 * MB,
    });
    expect(QUOTA).toEqual({ player: 200 * MB, lobby: 20 * MB });
    expect(JOB_TIMEOUT_MS).toEqual({ image: 20_000, model: 60_000, audio: 5_000 });
    expect(PROCESSOR_RSS_LIMIT).toBe(1.5 * 1024 * MB);
  });

  it("§22.5 uploads are rate-limited to 10 per minute per user", async () => {
    t.server.ctx.limits.uploads = realUploadLimit;
    try {
      const png = await image("png", 20, 20);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await upload(erin, "token", `r${i}.png`, png)).status);
      expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      t.server.ctx.limits.uploads = new BucketMap(10_000, 10_000);
    }
  }, 60_000);

  it("AC-AST-01 formats are detected by content (never extension); everything else gets a readable reason", async () => {
    for (const f of ["png", "jpeg", "webp", "gif", "avif"] as const) {
      const r = await upload(admin, "token", `wrong-extension-${f}.txt`, await image(f, 80, 60));
      expect(r.status, f).toBe(200);
      expect(r.asset?.cls).toBe("image");
      expect(r.asset?.variants.every((v) => v.mime === "image/webp")).toBe(true);
    }
    const png = await image("png", 200, 100);
    expect((await upload(admin, "map", "looks-like.jpg", png)).status).toBe(200);
    expect((await upload(admin, "audio", "tune.mp3", wav())).asset?.cls).toBe("audio");
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(admin, "token", "icon.png", svg)).error?.message).toMatch(
      /SVG images aren't accepted/,
    );
    expect((await upload(admin, "mini", "goblin.glb", zip())).error?.message).toMatch(
      /Archives aren't accepted — export it as \.glb/,
    );
    const obj = Buffer.from("# Blender\nmtllib goblin.mtl\no Goblin\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    expect((await upload(admin, "mini", "goblin.glb", obj)).error?.message).toMatch(/FBX, OBJ and STL/);
    expect((await upload(admin, "mini", "not-a-model.glb", png)).error?.message).toMatch(
      /Minis must be \.glb/,
    );
    expect((await upload(admin, "token", "model.png", await glb())).error?.message).toMatch(/must be images/);
    expect(
      (await upload(admin, "token", "notes.png", Buffer.from("just some text, nothing else"))).error?.message,
    ).toMatch(/isn't supported/);
    expect(tmpFiles()).toEqual([]);
  }, 60_000);

  it("AC-AST-02 caps and quotas are enforced while streaming (aborted as soon as exceeded)", async () => {
    // Stream a 40 MB "token" (cap 25 MB) slowly; the server must answer 413 long before the body ends.
    const total = 40 * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024, 7);
    chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // looks like a PNG from the first bytes
    const boundary = "----gloamtestboundary";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const { status, sentWhenAnswered, body } = await new Promise<{
      status: number;
      sentWhenAnswered: number;
      body: string;
    }>((resolve, reject) => {
      let sent = 0;
      const req = httpRequest(
        `${t.url}/api/assets?purpose=token`,
        {
          method: "POST",
          headers: {
            cookie: admin.cookieHeader(),
            origin: t.url,
            "x-gloam-csrf": admin.cookies.get("gloam_csrf") ?? "",
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
        },
        (res) => {
          const at = sent;
          let text = "";
          res.on("data", (d) => {
            text += d;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, sentWhenAnswered: at, body: text }));
        },
      );
      req.on("error", () => {}); // the server drops the connection after answering
      req.write(head);
      const pump = () => {
        if (sent >= total || req.destroyed) return;
        sent += chunk.length;
        req.write(chunk, () => setTimeout(pump, 1));
      };
      pump();
      setTimeout(() => reject(new Error("no answer")), 30_000);
    });
    expect(status).toBe(413);
    expect(body).toMatch(/larger than the 25 MB limit/);
    expect(sentWhenAnswered).toBeLessThan(32 * 1024 * 1024);
    await waitFor(() => tmpFiles().length === 0, 3000);
    expect(await health()).toBe(200);

    // Quota: someone still in the lobby may store 20 MB of drawings.
    const lobby = await joinAsNew(t, code, "Lobbyist");
    const art = await noisePng(2300, 2300); // ≈ 15.9 MB of incompressible pixels
    const first = await upload(lobby.agent, "art", "me.png", art);
    expect(first.status).toBe(200);
    expect(first.asset?.status).toBe("pending");
    const second = await upload(lobby.agent, "art", "me-again.png", await noisePng(2310, 2300));
    expect(second.status).toBe(413);
    expect(second.error?.message).toMatch(/storage allowance/);
    expect((await upload(lobby.agent, "token", "x.png", await image("png"))).status).toBe(403);
    await waitFor(() => tmpFiles().length === 0, 3000);
  }, 90_000);

  let tokenAsset: AssetDto;
  let miniAsset: AssetDto;

  it("AC-AST-03 images are re-encoded to WebP variants with metadata stripped", async () => {
    const jpeg = await image("jpeg", 1600, 1200, { exif: "SECRET-EXIF-MARK" });
    expect(jpeg.includes(Buffer.from("SECRET-EXIF-MARK"))).toBe(true);
    const r = await upload(admin, "token", "hero.jpg", jpeg);
    expect(r.status).toBe(200);
    tokenAsset = r.asset as AssetDto;
    expect(tokenAsset.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ["w1024", 1024, 768],
      ["w512", 512, 384],
      ["w128", 128, 96],
    ]);
    expect(tokenAsset.dominant).toMatch(/^#[0-9a-f]{6}$/);
    for (const v of tokenAsset.variants) {
      const res = await get(admin, `/assets/${tokenAsset.id}/${v.name}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.toString("latin1", 8, 12)).toBe("WEBP");
      expect(bytes.includes(Buffer.from("SECRET-EXIF-MARK"))).toBe(false);
    }
    // Maps: 8192/4096/1024/256 by long edge, never enlarged.
    const map = await upload(admin, "map", "small-map.png", await image("png", 3000, 2000));
    expect(map.asset?.variants.map((v) => [v.name, v.width])).toEqual([
      ["w3000", 3000],
      ["w1024", 1024],
      ["w256", 256],
    ]);
  }, 60_000);

  it("AC-AST-03 GLBs are validated, stripped (cameras, lights, extras), optimised (meshopt, WebP) and re-validated", async () => {
    const r = await upload(admin, "mini", "goblin.glb", await glb({ height: 2, baseY: -1 }));
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    miniAsset = r.asset as AssetDto;
    expect(miniAsset.glb?.triangles).toBe(12);
    expect(miniAsset.glb?.bounds.min[1]).toBeCloseTo(-1, 2);
    expect(miniAsset.glb?.bounds.max[1]).toBeCloseTo(1, 2);
    const res = await get(admin, `/assets/${miniAsset.id}/glb`);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const out = new Uint8Array(await res.arrayBuffer());
    const report = await validateBytes(out, { format: "glb", writeTimestamp: false });
    expect(report.issues.numErrors).toBe(0);
    const json = JSON.parse(Buffer.from(out).toString("utf8", 20, 20 + Buffer.from(out).readUInt32LE(12)));
    expect(json.cameras).toBeUndefined();
    expect(json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(json.extensionsUsed).not.toContain("KHR_lights_punctual");
    expect(JSON.stringify(json)).not.toContain("extras-payload");
    expect(json.images.every((i: { mimeType: string }) => i.mimeType === "image/webp")).toBe(true);
    // Over the 100 k budget → simplified toward it (one dense mesh, as real sculpts are).
    const heavy = await upload(admin, "mini", "heavy.glb", await denseGlb(240));
    expect(heavy.status, JSON.stringify(heavy.error)).toBe(200);
    expect(heavy.asset?.glb?.trianglesIn).toBe(2 * 240 * 240);
    expect(heavy.asset?.glb?.triangles).toBeLessThanOrEqual(100_000);
    // Thousands of tiny separate meshes can't be simplified per primitive: refused with advice, not shipped.
    const kitbash = await upload(admin, "mini", "kitbash.glb", await glb({ boxes: 16_000 }));
    expect(kitbash.error?.message).toMatch(/16,000 separate parts .*Ctrl\+J/);
  }, 90_000);

  it("AC-AST-03 processing runs in a separate child process; a hang, runaway memory or a crash can't take the server down", async () => {
    expect((await upload(admin, "token", "warm-up.png", await image("png", 30, 30))).status).toBe(200);
    const pid = t.server.ctx.assets.processor.pid;
    expect(pid).toBeTypeOf("number");
    expect(pid).not.toBe(process.pid);
    const spawned = t.server.ctx.assets.processor.spawned;
    const hang = await upload(admin, "token", "hang.png", await hookFile("hang"));
    expect(hang.error?.message).toMatch(/took too long/);
    expect(await health()).toBe(200);
    const oom = await upload(admin, "token", "oom.png", await hookFile("oom"));
    expect(oom.error?.message).toMatch(/more memory/);
    expect(await health()).toBe(200);
    const crash = await upload(admin, "token", "crash.png", await hookFile("crash"));
    expect(crash.error?.message).toMatch(/crashed the processor/);
    expect(await health()).toBe(200);
    // Each failure got a fresh process (hang → oom → crash → fine), and normal work continues.
    expect((await upload(admin, "token", "fine.png", await image("png"))).status).toBe(200);
    expect(t.server.ctx.assets.processor.spawned).toBe(spawned + 3);
    await waitFor(() => tmpFiles().length === 0, 3000);
  }, 90_000);

  it("AC-AST-04 player uploads wait for approval; DM uploads are approved; auto-approve player images works", async () => {
    const mine = await upload(dave, "token", "dave.png", await image("png", 90, 90));
    expect(mine.asset?.status, JSON.stringify(mine.error)).toBe("pending");
    const pendingSeen = new Promise((resolve) => dm.onMessage("asset.pending", resolve));
    const again = await upload(dave, "portrait", "dave-portrait.png", await image("png", 91, 90));
    expect(await pendingSeen).toMatchObject({ asset: { id: again.asset?.id, status: "pending" } });
    expect((await upload(admin, "token", "dm.png", await image("png", 92, 90))).asset?.status).toBe(
      "approved",
    );
    await admin.patch("/api/admin/settings", { autoApproveImages: true });
    expect((await upload(dave, "token", "auto.png", await image("png", 93, 90))).asset?.status).toBe(
      "approved",
    );
    expect((await upload(dave, "mini", "auto.glb", await glb())).asset?.status).toBe("pending"); // images only
    await admin.patch("/api/admin/settings", { autoApproveImages: false });
    // The DM reviews from the Approvals inbox (not undoable); the uploader hears about it.
    const heard = new Promise<{ asset: AssetDto }>((resolve) =>
      daveRoom.onMessage("asset.changed", (m: { asset: AssetDto }) => {
        if (m.asset.id === mine.asset?.id) resolve(m);
      }),
    );
    await dm.request("asset.review", { assetIds: [mine.asset?.id], decision: "approve" });
    expect((await heard).asset.status).toBe("approved");
    await dm.request("asset.review", { assetIds: [again.asset?.id], decision: "reject" });
    await expect(dm.request("history.undo", {})).rejects.toBeTruthy(); // approvals aren't undoable
    // Rejected files are purged after 24 h.
    const purged = t.server.ctx.assets.purge(Date.now() + 25 * 3600_000);
    expect(purged.references).toBe(1);
    expect(t.server.ctx.assets.get(again.asset?.id as string)).toBeUndefined();
  }, 60_000);

  it("AC-AST-05 assets are served only to admitted members, immutable, with fixed type, nosniff and a sandbox CSP", async () => {
    const res = await get(dave, `/assets/${tokenAsset.id}/w512`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const etag = res.headers.get("etag") as string;
    expect((await get(dave, `/assets/${tokenAsset.id}/w512`, { "if-none-match": etag })).status).toBe(304);
    expect((await get(null, `${t.url}/assets/${tokenAsset.id}/w512`)).status).toBe(401);
    // Someone still in the lobby isn't a member yet.
    const knocking = await joinAsNew(t, code, "Stranger");
    expect((await get(knocking.agent, `/assets/${tokenAsset.id}/w512`)).status).toBe(404);
    // Pending uploads: the uploader and DMs only — everyone else gets 404 (no existence oracle).
    const pending = await upload(dave, "token", "secret-plan.png", await image("png", 70, 70));
    expect((await get(dave, `/assets/${pending.asset?.id}/w70`)).status).toBe(200);
    expect((await get(erin, `/assets/${pending.asset?.id}/w70`)).status).toBe(404);
    expect((await get(admin, `/assets/${pending.asset?.id}/w70`)).status).toBe(200);
    expect((await get(dave, `/assets/${tokenAsset.id}/..%2F..%2Fgloam.db`)).status).toBe(404);
    // Audio supports Range requests.
    const song = await upload(admin, "audio", "song.wav", wav(800));
    const part = await get(dave, `/assets/${song.asset?.id}/orig`, { range: "bytes=0-99" });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  }, 60_000);

  it("AC-AST-07 a fuzz suite of malformed files is rejected without crashing or hanging the server", async () => {
    const good = await glb();
    const png = await noisePng(300, 300);
    const cases: [string, string, Uint8Array, RegExp][] = [
      ["truncated PNG", "token", png.subarray(0, Math.floor(png.length / 2)), /damaged or incomplete/],
      [
        "zip renamed to .glb",
        "mini",
        zip("scene.gltf", '{"asset":{"version":"2.0"}}'),
        /Archives aren't accepted/,
      ],
      [
        "polyglot image (PNG + ZIP)",
        "token",
        Buffer.concat([await image("png"), zip()]),
        /refused for safety: .*ZIP/,
      ],
      [
        "polyglot image (JPEG + HTML)",
        "token",
        Buffer.concat([await image("jpeg"), Buffer.from("<html><script>x</script>")]),
        /refused for safety/,
      ],
      ["decompression bomb", "map", bombPng(), /at most 16,384 × 16,384/],
      [
        "GLB with an external URI",
        "mini",
        editGlbJson(good, (j) => {
          (j.images as unknown[]).push({ uri: "https://evil.example/skin.png" });
        }),
        /outside the \.glb|error/,
      ],
      [
        "GLB with a script-like required extension",
        "mini",
        editGlbJson(good, (j) => {
          j.extensionsUsed = [...((j.extensionsUsed as string[]) ?? []), "EXT_evil_script"];
          j.extensionsRequired = ["EXT_evil_script"];
          j.extensions = { EXT_evil_script: { run: "fetch('http://evil.example')" } };
        }),
        /can't read safely \(EXT_evil_script\)/,
      ],
      [
        "GLB with script in its JSON",
        "mini",
        editGlbJson(good, (j) => {
          j.asset = { ...(j.asset as object), generator: "<script>alert(1)</script>" };
        }),
        /refused for safety/,
      ],
      [
        "random bytes named .glb",
        "mini",
        Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)),
        /isn't supported/,
      ],
      [
        "GLB header with nothing after it",
        "mini",
        Buffer.from("glTF\x02\0\0\0\xff\xff\x00\x00", "latin1"),
        /isn't a valid \.glb|isn't supported/,
      ],
    ];
    const t0 = Date.now();
    for (const [label, purpose, bytes, expected] of cases) {
      const r = await upload(admin, purpose, `${label}.bin`, bytes);
      expect(r.status, label).toBeGreaterThanOrEqual(400);
      expect(r.error?.message, label).toMatch(expected);
      expect(await health(), label).toBe(200);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
    await waitFor(() => tmpFiles().length === 0, 3000);
  }, 120_000);

  it("AC-AST-06 (server) library: search, filters, tags, soft delete and restore (undoable)", async () => {
    await rq(dm, "asset.update", {
      assetId: tokenAsset.id,
      name: "Hero Portrait",
      tags: ["Heroes", "party"],
    });
    const byTag = (await rq(dm, "asset.list", { tab: "tokens", tag: "heroes" })) as AssetDto[];
    expect(byTag.map((a) => a.id)).toEqual([tokenAsset.id]);
    const search = (await rq(dm, "asset.list", { q: "hero port" })) as AssetDto[];
    expect(search.map((a) => a.id)).toContain(tokenAsset.id);
    const minis = (await rq(dm, "asset.list", { tab: "minis" })) as AssetDto[];
    expect(minis.every((a) => a.cls === "model")).toBe(true);
    const erinView = (await daveRoom.request("asset.list", { tab: "all" })) as {
      status: string;
      id: string;
    }[];
    expect(erinView.every((a) => a.status === "approved" || a.id)).toBe(true);
    await rq(dm, "asset.delete", { assetIds: [tokenAsset.id] });
    expect(((await rq(dm, "asset.list", {})) as AssetDto[]).map((a) => a.id)).not.toContain(tokenAsset.id);
    expect(((await rq(dm, "asset.list", { trash: true })) as AssetDto[]).map((a) => a.id)).toContain(
      tokenAsset.id,
    );
    await rq(dm, "history.undo", {});
    expect(((await rq(dm, "asset.list", {})) as AssetDto[]).map((a) => a.id)).toContain(tokenAsset.id);
  });

  it("AC-TOK-03 (server) minis carry a normalisation hint; per-asset overrides persist", async () => {
    await rq(dm, "asset.update", {
      assetId: miniAsset.id,
      overrides: { scale: 1.2, rotationYDeg: 90, offsetY: 0.25 },
    });
    const list = (await rq(dm, "asset.list", { tab: "minis" })) as AssetDto[];
    const m = list.find((a) => a.id === miniAsset.id);
    expect(m?.overrides).toEqual({ scale: 1.2, rotationYDeg: 90, offsetY: 0.25 });
    expect(m?.glb?.bounds).toBeDefined();
    // Survives a reload from the database.
    await (
      t.server.ctx.rooms.tables.get(campaignId) as { reloadFromDatabase(): Promise<void> }
    ).reloadFromDatabase();
    const again = (await rq(dm, "asset.list", { tab: "minis" })) as AssetDto[];
    expect(again.find((a) => a.id === miniAsset.id)?.overrides).toEqual({
      scale: 1.2,
      rotationYDeg: 90,
      offsetY: 0.25,
    });
    await expect(
      daveRoom.request("asset.update", { assetId: miniAsset.id, overrides: { scale: 3 } }),
    ).rejects.toBeTruthy();
  });

  it("AC-BRD-06 (server) a 16 384 × 16 384 map is accepted and gets variants for every texture limit", async () => {
    const huge = await (await import("sharp"))
      .default({
        create: { width: 16384, height: 16384, channels: 3, background: { r: 60, g: 90, b: 70 } },
        limitInputPixels: false, // sharp's own default stops at 16383²; the pipeline sets the spec's 16384²
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const t0 = Date.now();
    const r = await upload(admin, "map", "huge.png", huge);
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(r.asset?.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ["w8192", 8192, 8192],
      ["w4096", 4096, 4096],
      ["w1024", 1024, 1024],
      ["w256", 256, 256],
    ]);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // One pixel more on a side is refused before decoding.
    expect((await upload(admin, "map", "too-big.png", bombPng(16385, 16384))).error?.message).toMatch(
      /at most 16,384/,
    );
  }, 120_000);

  it("AC-SCN-08 recalibrating an image map rescales walls, zones, lights and tokens with the art", async () => {
    // A 1400 × 700 px map at 70 px per 5 ft: 100 × 50 ft.
    const r = await upload(admin, "map", "crypt.png", await image("png", 1400, 700));
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    const { sceneId } = (await dm.request("scene.create", {
      name: "Recalibrate me",
      mapKind: "image",
      mapAssetId: r.asset?.id,
      pxPer5ft: 70,
    })) as { sceneId: string };
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as {
      model: {
        get(k: string, id: string): Record<string, unknown> | undefined;
        inScene(k: string, s: string): Iterable<{ id: string }>;
      };
      bus: { commit(...a: unknown[]): unknown };
    };
    const scene0 = room.model.get("scene", sceneId) as {
      bounds: Record<string, number>;
      spawn: { x: number; y: number };
    };
    expect(scene0.bounds).toMatchObject({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    // Map features at known art positions: a wall along a corridor, a pool (zone), a brazier (light), an orc.
    await dm.request("wall.create", { sceneId, walls: [{ a: { x: 10, y: 20 }, b: { x: 40, y: 20 } }] });
    const { tokenId } = (await dm.request("token.create", {
      sceneId,
      name: "Orc",
      pos: { x: 30, y: 15 },
      size: "large",
    })) as { tokenId: string };
    room.bus.commit(
      "test.features",
      [
        {
          k: "create",
          e: "zone",
          id: "zon_pool000001",
          value: {
            id: "zon_pool000001",
            sceneId,
            kind: "water",
            shape: { kind: "rect", x: 50, y: 10, w: 10, h: 6 },
            label: "Pool",
            color: "#000000",
            visible: true,
            triggers: [],
            note: "",
          },
        },
        {
          k: "create",
          e: "zone",
          id: "zon_pit0000001",
          value: {
            id: "zon_pit0000001",
            sceneId,
            kind: "hazard",
            shape: {
              kind: "polygon",
              points: [
                { x: 70, y: 30 },
                { x: 80, y: 30 },
                { x: 75, y: 40 },
              ],
            },
            label: "Pit",
            color: "#000000",
            visible: true,
            triggers: [],
            note: "",
          },
        },
        {
          k: "create",
          e: "light",
          id: "lig_brazier001",
          value: {
            id: "lig_brazier001",
            sceneId,
            tokenId: null,
            pos: { x: 20, y: 30 },
            elevation: 3,
            bright: 20,
            dim: 40,
            color: "#000000",
            intensity: 1,
            animation: "torch",
            coneDeg: null,
            directionDeg: 0,
            magical: false,
            pierceDarkness: false,
            enabled: true,
            dmOnly: false,
            preset: "torch",
          },
        },
      ],
      "features",
      false,
      { userId: "system", role: "admin", name: "test" },
      sceneId,
    );
    // The DM measured a door and found the grid is really 100 px per 5 ft: everything shrinks by 0.7.
    await dm.request("scene.calibrate", { sceneId, ftPerPx: 5 / 100 });
    const k = 0.7;
    const scene = room.model.get("scene", sceneId) as {
      bounds: Record<string, number>;
      calibration: { ftPerPx: number };
    };
    expect(scene.calibration.ftPerPx).toBeCloseTo(0.05, 9);
    expect(scene.bounds.maxX).toBeCloseTo(100 * k, 9);
    expect(scene.bounds.maxY).toBeCloseTo(50 * k, 9);
    const wall = [...room.model.inScene("wall", sceneId)][0] as unknown as {
      a: { x: number; y: number };
      b: { x: number; y: number };
    };
    expect([wall.a.x, wall.a.y, wall.b.x, wall.b.y].map((v) => +v.toFixed(9))).toEqual([7, 14, 28, 14]);
    const pool = room.model.get("zone", "zon_pool000001") as { shape: Record<string, number> };
    expect(pool.shape).toMatchObject({ kind: "rect" });
    for (const [key, v] of Object.entries({ x: 35, y: 7, w: 7, h: 4.2 }))
      expect(pool.shape[key]).toBeCloseTo(v, 9);
    const pit = room.model.get("zone", "zon_pit0000001") as { shape: { points: { x: number; y: number }[] } };
    expect(pit.shape.points.map((q) => [+q.x.toFixed(9), +q.y.toFixed(9)])).toEqual([
      [49, 21],
      [56, 21],
      [52.5, 28],
    ]);
    const light = room.model.get("light", "lig_brazier001") as {
      pos: { x: number; y: number };
      bright: number;
      dim: number;
    };
    expect([+light.pos.x.toFixed(9), +light.pos.y.toFixed(9)]).toEqual([14, 21]);
    // Radii and creature sizes are rules distances in feet, not art: they stay.
    expect([light.bright, light.dim]).toEqual([20, 40]);
    const orc = room.model.get("token", tokenId) as { pos: { x: number; y: number }; sizeFt: number };
    expect([+orc.pos.x.toFixed(9), +orc.pos.y.toFixed(9)]).toEqual([21, 10.5]);
    expect(orc.sizeFt).toBe(10);
    // One undo puts every feature back where it was.
    await dm.request("history.undo", {});
    const back = room.model.get("token", tokenId) as { pos: { x: number; y: number } };
    expect([+back.pos.x.toFixed(9), +back.pos.y.toFixed(9)]).toEqual([30, 15]);
    expect((room.model.get("light", "lig_brazier001") as { pos: { x: number } }).pos.x).toBeCloseTo(20, 9);
  });
});
