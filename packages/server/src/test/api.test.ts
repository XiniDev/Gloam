import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_SCHEMA_NAMES, importJsonSchema, type Spell } from "@gloam/shared/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../auth/crypto.ts";
import { loadSrdPack } from "../content/packs.ts";
import { apiTokens } from "../db/schema.ts";
import { CampaignModel } from "../engine/model.ts";
import {
  Agent,
  createCampaign,
  joinAsNew,
  openTable,
  setupAdmin,
  startTestServer,
  type TestServer,
} from "./harness.ts";

const DOCS = join(import.meta.dirname, "..", "..", "..", "..", "docs", "schemas");
const fireball = loadSrdPack().spells.find((s) => s.id === "fireball") as Spell;
const spell = (id: string, name: string): Record<string, unknown> => {
  const { provenance: _p, ...rest } = fireball as Spell & { provenance?: unknown };
  return { ...rest, id, name, source: { pack: "homebrew" } };
};
const BOG = {
  id: "bog-lurker",
  name: "Bog Lurker",
  size: "large",
  type: "monstrosity",
  ac: 13,
  hp: { average: 59, formula: "7d10 + 21" },
  speeds: { walk: 20, swim: 40 },
  senses: { darkvision: 60, tremorsense: 30 },
  abilities: { str: 18, dex: 12, con: 16, int: 3, wis: 12, cha: 5 },
  saves: { con: 5 },
  resistances: ["cold"],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: ["prone"],
  cr: "3",
  attacks: [{ name: "Bite", attack: "1d20 + 6", damage: "2d8 + 4 [piercing]" }],
  statBlockMarkdown: "Ambusher. It has advantage on attack rolls against surprised creatures.",
  tokenAssetId: null,
  source: { pack: "homebrew" },
};

type Json = { data?: unknown; report?: unknown; error?: { code: string; message: string } };

/**
 * The local REST API (SPEC §8.23, §26.1): tokens with scopes, made and listed in the console, shown once and kept as
 * hashes (AC-API-01); refused from anywhere but this computer unless Allow remote API is on (AC-API-02); the import
 * schemas served as generated (AC-API-03); and every endpoint the MCP server uses doing its job.
 */
describe("P13 — the local API (API)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let secret: string;
  const bearer = (token: string, extra: Record<string, string> = {}) =>
    new Agent(t.url, { authorization: `Bearer ${token}`, ...extra });
  const make = async (name: string, scopes: string[]) => {
    const r = await admin.post("/api/admin/api/tokens", { name, scopes });
    expect(r.status).toBe(200);
    return r.json.data as { token: string; info: { id: string; name: string; scopes: string[] } };
  };
  const events = (event: string) =>
    t.server.ctx.security.list({ event }).map((e) => ({ ...e, detail: e.detail as Record<string, unknown> }));

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin, "The Sunless Road");
  }, 60_000);
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-API-01: a token is shown once and kept only as its hash; its scopes are enforced; sessions work too", async () => {
    const made = await make("Claude at home", [
      "content:read",
      "content:write",
      "sheets:read",
      "sheets:write",
      "log:read",
      "log:write",
      "campaign:read",
    ]);
    secret = made.token;
    expect(secret).toMatch(/^gloam_[A-Za-z0-9_-]{43}$/);
    // Stored as SHA-256 only: nowhere in the row is the secret.
    const row = t.server.ctx.db
      .select()
      .from(apiTokens)
      .all()
      .find((r) => r.id === made.info.id);
    expect(row?.tokenHash).toBe(sha256Hex(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    // Listed without it, ever again.
    const page = (await admin.get("/api/admin/api")).json.data as { tokens: unknown[]; mcpEntry: string };
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(page.tokens).toHaveLength(1);
    expect(page.mcpEntry).toMatch(/\/packages\/mcp\/src\/index\.ts$/);

    // The token opens the API…
    const api = bearer(secret);
    const list = await api.get("/api/v1/campaigns");
    expect(list.status).toBe(200);
    expect((list.json.data as { id: string; name: string }[]).map((c) => c.name)).toContain(
      "The Sunless Road",
    );
    // …nothing else (the Admin's own routes want the Admin's session).
    expect((await api.get("/api/admin/people")).status).toBe(401);

    // Scopes: a read-only token can't write.
    const reader = bearer((await make("Reader", ["content:read", "campaign:read"])).token);
    expect((await reader.get("/api/v1/content/spells?query=fire")).status).toBe(200);
    const denied = await reader.post(`/api/v1/content/spells:import?campaignId=${campaignId}&dryRun=true`, [
      spell("ember-storm", "Ember Storm"),
    ]);
    expect(denied.status).toBe(403);
    expect(denied.json.error?.message).toMatch(/content:write/);
    expect((await reader.get(`/api/v1/campaigns/${campaignId}/log`)).status).toBe(403);

    // No credentials, a wrong token: refused.
    expect((await new Agent(t.url).get("/api/v1/campaigns")).status).toBe(401);
    expect((await bearer("gloam_not-a-real-one").get("/api/v1/campaigns")).status).toBe(401);

    // The Admin's session works like a token with every scope.
    expect((await admin.get("/api/v1/campaigns")).status).toBe(200);

    // Revoked: gone at once.
    const once = await make("Once", ["campaign:read"]);
    expect((await bearer(once.token).get("/api/v1/campaigns")).status).toBe(200);
    expect((await admin.post(`/api/admin/api/tokens/${once.info.id}/revoke`)).status).toBe(200);
    expect((await bearer(once.token).get("/api/v1/campaigns")).status).toBe(401);

    // All of it in the Security log (AC-ADM-04) — never the secret.
    expect(events("api.token.create").map((e) => e.detail.name)).toEqual(
      expect.arrayContaining(["Claude at home", "Reader", "Once"]),
    );
    expect(events("api.token.use").some((e) => e.detail.name === "Claude at home" && e.ip)).toBe(true);
    expect(events("api.token.revoke").map((e) => e.detail.name)).toEqual(["Once"]);
    expect(events("api.token.refused").map((e) => e.detail.reason)).toEqual(
      expect.arrayContaining(["scope", "unknown"]),
    );
    expect(JSON.stringify(t.server.ctx.security.list({ limit: 1000 }))).not.toContain(secret);
  });

  it("AC-API-01: a player's session can't use the API; the DM's can, for the campaign at the table", async () => {
    const { code } = await openTable(admin, "local");
    const player = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", {
      sessionId: player.sessionId,
      decision: "admitPlayer",
    });
    const r = await player.agent.get("/api/v1/campaigns");
    expect(r.status).toBe(403);
    // Made the campaign's DM, the same person may — for the campaign at the table, and only that one.
    expect(
      (await admin.post(`/api/admin/people/${player.userId}/role`, { campaignId, role: "dm" })).status,
    ).toBe(200);
    const other = await createCampaign(admin, "Another Road");
    const dmList = await player.agent.get("/api/v1/campaigns");
    expect(dmList.status).toBe(200);
    expect((dmList.json.data as { id: string }[]).map((c) => c.id)).toEqual([campaignId]);
    expect((await player.agent.get(`/api/v1/campaigns/${other}/summary`)).status).toBe(403);
  });

  it("AC-API-02: tokens are refused through Cloudflare (or from another computer) unless Allow remote API is on", async () => {
    const via: Record<string, string>[] = [
      { "cf-ray": "8a1b2c3d4e5f6a7b-LHR" },
      { "cf-connecting-ip": "203.0.113.9" },
    ];
    for (const header of via) {
      const r = await bearer(secret, header).get("/api/v1/campaigns");
      expect(r.status, JSON.stringify(header)).toBe(403);
      expect(r.json.error?.message).toMatch(/this computer only/);
    }
    expect(events("api.token.refused").some((e) => e.detail.reason === "remote")).toBe(true);
    // Allowed (from this computer only — a remote session can't widen it)…
    expect((await admin.patch("/api/admin/settings", { allowRemoteApi: true })).status).toBe(200);
    expect((await bearer(secret, { "cf-ray": "8a1b2c3d4e5f6a7b-LHR" }).get("/api/v1/campaigns")).status).toBe(
      200,
    );
    // …and off again.
    await admin.patch("/api/admin/settings", { allowRemoteApi: false });
    expect((await bearer(secret, { "cf-ray": "8a1b2c3d4e5f6a7b-LHR" }).get("/api/v1/campaigns")).status).toBe(
      403,
    );
    // A session is a session wherever it comes from (the doorway's own rules apply to it).
  });

  it("AC-API-03: every import format's JSON Schema is served, as generated from its zod schema and as published", async () => {
    for (const name of IMPORT_SCHEMA_NAMES) {
      const r = await fetch(`${t.url}/api/v1/schemas/${name}.json`);
      expect(r.status, name).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/application\/schema\+json/);
      const served = await r.json();
      // Regenerated here, and the committed file: all three the same (run `node tools/gen-schemas.mjs` if not).
      expect(served, `${name}.json vs zod`).toEqual(importJsonSchema(name));
      expect(served, `${name}.json vs docs/schemas`).toEqual(
        JSON.parse(readFileSync(join(DOCS, `${name}.json`), "utf8")),
      );
    }
  });

  it("§26.1: spells (search, dry run then real), monsters as Bestiary sheets, characters, sheets, summary and the log", async () => {
    const api = bearer(secret);
    // Search.
    const found = (await api.get(`/api/v1/content/spells?query=fire&level=3&campaignId=${campaignId}`)).json
      .data as { id: string; pack: string }[];
    expect(found.map((s) => s.id)).toContain("fireball");

    // Three spells: the dry run changes nothing and says what would happen.
    const three = [
      spell("ember-storm", "Ember Storm"),
      spell("cinder-veil", "Cinder Veil"),
      spell("ash-rain", "Ash Rain"),
    ];
    const homebrew = () =>
      (CampaignModel.load(t.server.ctx.db, campaignId) as CampaignModel)
        .all("content")
        .filter((c) => c.type === "spell").length;
    const dry = await api.post(`/api/v1/content/spells:import?campaignId=${campaignId}&dryRun=true`, three);
    expect(dry.status).toBe(200);
    expect(dry.json.report).toEqual({
      created: ["ember-storm", "cinder-veil", "ash-rain"],
      updated: [],
      skipped: [],
      invalid: [],
    });
    expect(homebrew()).toBe(0);
    const real = await api.post(`/api/v1/content/spells:import?campaignId=${campaignId}&dryRun=false`, {
      spells: three,
    });
    expect((real.json.report as { created: string[] }).created).toHaveLength(3);
    expect(homebrew()).toBe(3);
    expect(
      (
        (await api.get(`/api/v1/content/spells?pack=homebrew&campaignId=${campaignId}`)).json
          .data as unknown[]
      ).length,
    ).toBe(3);
    // Again: skipped, as asked.
    const again = await api.post(
      `/api/v1/content/spells:import?campaignId=${campaignId}&dryRun=false&onConflict=skip`,
      three,
    );
    expect((again.json.report as { skipped: string[] }).skipped).toHaveLength(3);
    // An invalid one says where and why.
    const bad = await api.post(`/api/v1/content/spells:import?campaignId=${campaignId}`, [
      { ...spell("x", "X"), level: 12 },
    ]);
    expect((bad.json.report as { invalid: { index: number; path: string }[] }).invalid[0]).toMatchObject({
      index: 0,
    });

    // A monster: an NPC sheet the Bestiary places.
    const monsters = await api.post(`/api/v1/content/monsters:import?campaignId=${campaignId}&dryRun=false`, [
      BOG,
    ]);
    expect(monsters.status).toBe(200);
    expect(monsters.json.report).toMatchObject({ created: ["bog-lurker"], invalid: [] });
    const npc = (CampaignModel.load(t.server.ctx.db, campaignId) as CampaignModel)
      .all("actor")
      .find((a) => a.kind === "npc" && (a.sheet as { core: { name: string } }).core.name === "Bog Lurker");
    expect(npc).toBeDefined();
    const sheet = (await api.get(`/api/v1/actors/${npc?.id}`)).json.data as {
      sheet: {
        core: {
          hp: { max: number };
          speeds: { swim: number };
          saves: { con?: { bonus: number } };
          hitDice: unknown[];
        };
      };
    };
    expect(sheet.sheet.core.hp.max).toBe(59);
    expect(sheet.sheet.core.speeds.swim).toBe(40);
    // Con +5 in the stat block: +3 from Constitution 16, +2 on top.
    expect(sheet.sheet.core.saves.con?.bonus).toBe(2);
    expect(sheet.sheet.core.hitDice).toEqual([{ die: "d10", total: 7, used: 0 }]);
    // Overwritten: the same sheet, updated; renamed: a second one.
    const over = await api.post(
      `/api/v1/content/monsters:import?campaignId=${campaignId}&dryRun=false&onConflict=overwrite`,
      [{ ...BOG, ac: 14 }],
    );
    expect(over.json.report).toMatchObject({ updated: ["bog-lurker"] });
    const renamed = await api.post(
      `/api/v1/content/monsters:import?campaignId=${campaignId}&dryRun=false&onConflict=rename`,
      [BOG],
    );
    expect(renamed.json.report).toMatchObject({ created: ["bog-lurker-2"] });

    // A character.
    const pc = await api.post(`/api/v1/actors:import?campaignId=${campaignId}&dryRun=false`, {
      core: { name: "Mira Holloway", classes: [{ name: "Fighter", level: 3 }], hp: { max: 28, current: 28 } },
    });
    expect(pc.status).toBe(200);
    const actorId = ((pc.json.data as { created: { actorId: string }[] }).created[0] as { actorId: string })
      .actorId;
    expect(
      ((await api.get(`/api/v1/actors/${actorId}`)).json.data as { sheet: { core: { name: string } } }).sheet
        .core.name,
    ).toBe("Mira Holloway");
    const badSheet = await api.post(`/api/v1/actors:import?campaignId=${campaignId}`, [
      { core: { name: "X", hp: { max: -4 } } },
    ]);
    expect((badSheet.json.report as { invalid: { path: string }[] }).invalid[0]?.path).toMatch(/hp/);

    // The summary names the party.
    const summary = (await api.get(`/api/v1/campaigns/${campaignId}/summary`)).json.data as {
      party: { name: string; classes: string; level: number }[];
    };
    expect(summary.party).toContainEqual(
      expect.objectContaining({ name: "Mira Holloway", classes: "Fighter 3", level: 3 }),
    );

    // The log: a recap written, and read back with who wrote it.
    const wrote = await api.post(`/api/v1/campaigns/${campaignId}/log`, {
      text: "The party found the drowned road and turned back at the bog.",
    });
    expect(wrote.status).toBe(201);
    const log = (await api.get(`/api/v1/campaigns/${campaignId}/log`)).json.data as {
      text: string;
      kind: string;
      author: string;
    }[];
    expect(log.at(-1)).toMatchObject({ kind: "recap", author: "Claude at home (API)" });
  });

  it("AC-API-01: a caller guessing tokens is locked out for a minute", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await bearer(`gloam_guess-${i}`).get("/api/v1/campaigns")).status;
    expect(last).toBe(429);
    // (Even a real token, from there, until the minute is up.)
    expect((await bearer(secret).get("/api/v1/campaigns")).status).toBe(429);
  });
});
