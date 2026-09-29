import { createHash } from "node:crypto";
import type { Room } from "@colyseus/sdk";
import { Table, type TableState } from "@gloam/shared/state";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { image } from "./assetFixtures.ts";
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

type TableRoomClient = Room<unknown, TableState>;
type Doc = { campaign: Record<string, unknown>; tables: Record<string, Record<string, unknown>[]> };

const headers = (a: Agent) => ({
  cookie: a.cookieHeader(),
  origin: a.base,
  "x-gloam-csrf": a.cookies.get("gloam_csrf") ?? "",
});
async function upload(a: Agent, purpose: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const res = await fetch(`${a.base}/api/assets?purpose=${purpose}`, {
    method: "POST",
    headers: headers(a),
    body: form,
  });
  return ((await res.json()) as { data: { asset: { id: string } } }).data.asset;
}
async function importFile(a: Agent, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), "campaign.gloam");
  const res = await fetch(`${a.base}/api/admin/campaigns/import`, {
    method: "POST",
    headers: headers(a),
    body: form,
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      data?: { campaignId: string; counts: Record<string, number>; ids: Record<string, string> };
      error?: { code: string; message: string };
    },
  };
}
/** Every id string in a document mapped (the importer's old → new map), its keys too. */
function mapIds(v: unknown, ids: Record<string, string>): unknown {
  if (typeof v === "string") {
    if (ids[v]) return ids[v];
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(mapIds(JSON.parse(v), ids));
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => mapIds(x, ids));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[ids[k] ?? k] = mapIds(x, ids);
    return out;
  }
  return v;
}
/** JSON text columns compared as documents (formatting aside). */
function canon(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return canon(JSON.parse(v));
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
}
const byId = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) =>
    String(a.id ?? `${a.scene_id}${a.layer}`).localeCompare(String(b.id ?? `${b.scene_id}${b.layer}`)),
  );

/**
 * Moving a campaign to another machine (SPEC §20.5; AC-PER-05): exported from one install as a `.gloam`, imported on a
 * fresh one — the same campaign, row for row, every id new and every reference following it; its assets re-run
 * through the upload pipeline (a file that isn't what it claims fails the import, and leaves nothing behind); a file
 * changed since export is refused; only the Admin does either.
 */
describe("P10 — .gloam export and import (PER-05)", () => {
  let a: TestServer;
  let b: TestServer;
  let adminA: Agent;
  let adminB: Agent;
  let campaignId: string;
  let exported: Uint8Array;
  let docA: Doc;

  // One server at a time (Colyseus's matchmaker is one per process): the campaign made and exported on the first —
  // and a player refused there — then imported on a fresh second install.
  beforeAll(async () => {
    a = await startTestServer();
    adminA = await setupAdmin(a);
    campaignId = await createCampaign(adminA, "The Sunken Library");
    const code = (await openTable(adminA, "local")).code;
    const dm = (await adminA.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const p = await joinAsNew(a, code, "Dave");
    await adminA.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const player = p.agent;
    // A scene with walls, a token with art, an actor with a sheet, homebrew, a handout's worth of library.
    const art = await upload(adminA, "token", "knight.png", await image("png", 96, 96));
    const { sceneId } = await rq<{ sceneId: string }>(dm, "scene.create", {
      name: "Reading room",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await rq(dm, "wall.create", { sceneId, walls: [{ a: { x: 10, y: 0 }, b: { x: 10, y: 20 } }] });
    const { actorId } = await rq<{ actorId: string }>(dm, "actor.create", {
      kind: "npc",
      sheet: { core: { name: "Brother Aldo", size: "medium", hp: { max: 9, current: 9 } } },
    });
    await rq(dm, "token.create", {
      sceneId,
      name: "Brother Aldo",
      actorId,
      pos: { x: 20, y: 20 },
      appearance: { mode: "coin", assetId: art.id },
    });
    await rq(dm, "token.create", {
      sceneId,
      name: "Skeleton",
      pos: { x: 30, y: 10 },
      stats: { hp: 13, hpMax: 13, ac: 13 },
    });
    // Export it, and fetch the file.
    const res = await fetch(`${adminA.base}/api/admin/campaigns/${campaignId}/export`, {
      method: "POST",
      headers: headers(adminA),
    });
    expect(res.status).toBe(200);
    const { file } = ((await res.json()) as { data: { file: string } }).data;
    expect(file).toMatch(/^the-sunken-library-\d{4}-\d{2}-\d{2}\.gloam$/);
    const dl = await fetch(`${adminA.base}/api/admin/exports/${file}`, { headers: headers(adminA) });
    expect(dl.status).toBe(200);
    exported = new Uint8Array(await dl.arrayBuffer());
    docA = a.server.ctx.snapshots.document(campaignId) as unknown as Doc;
    // The Admin's alone: a player can neither export nor import; an export's name can't climb out of its folder.
    const e = await fetch(`${player.base}/api/admin/campaigns/${campaignId}/export`, {
      method: "POST",
      headers: headers(player),
    });
    expect([401, 403]).toContain(e.status);
    expect([401, 403]).toContain((await importFile(player, exported)).status);
    const bad = await fetch(`${adminA.base}/api/admin/exports/..%2F..%2Fgloam.db`, {
      headers: headers(adminA),
    });
    expect([400, 404]).toContain(bad.status);
    await a.stop();
    b = await startTestServer();
    adminB = await setupAdmin(b);
  }, 120_000);
  afterAll(async () => {
    await b?.stop();
  });

  it("imports on a fresh install with identical content — every id new, every reference following it", async () => {
    const r = await importFile(adminB, exported);
    expect(r.status).toBe(200);
    const { campaignId: newId, ids } = r.body.data as { campaignId: string; ids: Record<string, string> };
    expect(newId).not.toBe(campaignId);
    const docB = b.server.ctx.snapshots.document(newId) as unknown as Doc;
    // No id of the old campaign's rows survives anywhere in the new one.
    const text = JSON.stringify(docB);
    for (const old of Object.keys(ids)) expect(text.includes(old), old).toBe(false);
    // Row for row the same, once the old ids are read through the map (the asset's file is re-processed: its file
    // id is new; the importing Admin is its uploader of record; the campaign's updated time is the import's).
    const mapped = mapIds(docA, ids) as Doc;
    for (const t of Object.keys(docA.tables)) {
      const strip = (rows: Record<string, unknown>[]) =>
        byId(rows).map((row) => {
          const { file_id: _f, uploader_id: _u, ...rest } = row;
          return canon(t === "assets" ? rest : row);
        });
      expect(strip(docB.tables[t] ?? []), t).toEqual(strip(mapped.tables[t] ?? []));
    }
    const { updated_at: _u1, ...ca } = mapped.campaign;
    const { updated_at: _u2, ...cb } = docB.campaign;
    expect(canon(cb)).toEqual(canon(ca));
    // Its asset was processed again on this install: its file is in B's store, and the token's art resolves to it.
    const asset = docB.tables.assets?.[0] as { id: string; file_id: string };
    expect(b.server.ctx.assets.file(asset.file_id)).toBeTruthy();
    expect(b.server.ctx.assets.dtoById(asset.id)?.status).toBe("approved");
  });

  it("refuses a file changed since export, and one whose asset isn't what it claims — leaving nothing behind", async () => {
    const campaignsBefore = b.server.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as {
      n: number;
    };
    const files = unzipSync(exported);
    // campaign.json edited: its hash no longer matches the manifest.
    const edited = {
      ...files,
      "campaign.json": strToU8(
        new TextDecoder().decode(files["campaign.json"]).replace("Reading room", "Vault"),
      ),
    };
    const r1 = await importFile(adminB, zipSync(edited));
    expect(r1.status).toBe(400);
    expect(r1.body.error?.message).toMatch(/changed since it was exported/);
    // An asset replaced by a script with a re-computed manifest: the upload pipeline refuses it.
    const assetName = Object.keys(files).find((n) => n.startsWith("assets/")) as string;
    const evil = strToU8("<script>alert(1)</script>");
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"])) as {
      files: Record<string, string>;
    };
    manifest.files[assetName] = createHash("sha256").update(evil).digest("hex");
    const r2 = await importFile(
      adminB,
      zipSync({ ...files, [assetName]: evil, "manifest.json": strToU8(JSON.stringify(manifest)) }),
    );
    expect(r2.status).toBe(400);
    expect(r2.body.error?.message).toMatch(/didn't pass the upload checks/);
    const campaignsAfter = b.server.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as {
      n: number;
    };
    expect(campaignsAfter.n).toBe(campaignsBefore.n);
    // A path out of its folder is refused before anything is read.
    const r3 = await importFile(adminB, zipSync({ ...files, "../../evil.json": strToU8("{}") }));
    expect(r3.status).toBe(400);
  });
});
