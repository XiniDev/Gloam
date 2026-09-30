import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AC-API-04: the MCP server with a real MCP client over stdio, against a real Gloam server — list the tools, import
 * three spells (a dry run, then for real), import a character, read the log. The server is started as Claude would
 * start it (`node packages/mcp/src/index.ts` with GLOAM_URL and GLOAM_TOKEN).
 *
 * Gloam itself comes from the server package's test harness, loaded at run time (this package doesn't compile the
 * server's sources).
 */

const HERE = import.meta.dirname;
const SERVER = join(HERE, "..", "..", "server", "src");
const ENTRY = join(HERE, "index.ts");

interface Harness {
  startTestServer(): Promise<{ url: string; stop(): Promise<void>; server: { ctx: GloamCtx } }>;
  setupAdmin(t: unknown): Promise<AgentLike>;
  createCampaign(admin: AgentLike, name?: string): Promise<string>;
}
interface AgentLike {
  post(path: string, body?: unknown): Promise<{ status: number; json: { data?: unknown } }>;
}
interface GloamCtx {
  campaigns: { log(id: string): { kind: string; text: string }[] };
}
type Spell = { id: string; name: string; provenance?: unknown };

const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(SERVER, file)).href)) as T;

/** The text a tool answered with, as JSON. */
const answer = <T>(r: unknown): T => {
  const c = (r as { content: { type: string; text: string }[]; isError?: boolean }).content[0];
  if ((r as { isError?: boolean }).isError) throw new Error(c?.text);
  return JSON.parse(c?.text ?? "null") as T;
};

describe("P13 — the MCP server (AC-API-04)", () => {
  let t: Awaited<ReturnType<Harness["startTestServer"]>>;
  let campaignId: string;
  let client: Client;
  let spells: Record<string, unknown>[];

  beforeAll(async () => {
    const h = await load<Harness>("test/harness.ts");
    t = await h.startTestServer();
    const admin = await h.setupAdmin(t);
    campaignId = await h.createCampaign(admin, "The Sunless Road");
    const made = await admin.post("/api/admin/api/tokens", {
      name: "Claude Code",
      scopes: ["content:read", "content:write", "sheets:write", "log:read", "log:write", "campaign:read"],
    });
    const token = (made.json.data as { token: string }).token;
    // Three homebrew spells, each started from an SRD one as a person would.
    const { loadSrdPack } = await load<{ loadSrdPack(): { spells: Spell[] } }>("content/packs.ts");
    const srd = loadSrdPack().spells;
    spells = [
      ["fireball", "ember-storm", "Ember Storm"],
      ["magic-missile", "cinder-darts", "Cinder Darts"],
      ["cure-wounds", "moss-balm", "Moss Balm"],
    ].map(([from, id, name]) => {
      const { provenance: _p, ...rest } = srd.find((s) => s.id === from) as Spell;
      return { ...rest, id, name, source: { pack: "homebrew" } };
    });
    client = new Client({ name: "gloam-roundtrip-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: { ...(process.env as Record<string, string>), GLOAM_URL: t.url, GLOAM_TOKEN: token },
        stderr: "pipe",
      }),
    );
  }, 90_000);
  afterAll(async () => {
    await client?.close();
    await t?.stop();
  });

  it("lists its tools; imports three spells dry, then for real; imports a character; reads the log", async () => {
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual(
      [
        "add_log_entry",
        "get_campaign_log",
        "get_schema",
        "import_character",
        "import_monsters",
        "import_spells",
        "list_campaigns",
        "search_spells",
      ].sort(),
    );

    // It finds the campaign by listing.
    const campaigns = answer<{ id: string; name: string }[]>(
      await client.callTool({ name: "list_campaigns", arguments: {} }),
    );
    expect(campaigns.find((c) => c.name === "The Sunless Road")?.id).toBe(campaignId);
    // The schema to write against.
    const schema = answer<{ $schema: string }>(
      await client.callTool({ name: "get_schema", arguments: { kind: "spell" } }),
    );
    expect(schema.$schema).toMatch(/2020-12/);

    // Dry: a report, nothing made.
    const dry = answer<{ report: { created: string[]; invalid: unknown[] } }>(
      await client.callTool({ name: "import_spells", arguments: { campaignId, spells, dryRun: true } }),
    );
    expect(dry.report.created).toEqual(["ember-storm", "cinder-darts", "moss-balm"]);
    expect(dry.report.invalid).toEqual([]);
    const homebrew = async () =>
      answer<{ id: string }[]>(
        await client.callTool({ name: "search_spells", arguments: { pack: "homebrew", campaignId } }),
      ).map((s) => s.id);
    expect(await homebrew()).toEqual([]);
    // Real: made.
    const real = answer<{ report: { created: string[] } }>(
      await client.callTool({ name: "import_spells", arguments: { campaignId, spells, dryRun: false } }),
    );
    expect(real.report.created).toHaveLength(3);
    expect((await homebrew()).sort()).toEqual(["cinder-darts", "ember-storm", "moss-balm"]);

    // A character.
    const pc = answer<{ report: { created: string[]; invalid: unknown[] } }>(
      await client.callTool({
        name: "import_character",
        arguments: {
          campaignId,
          dryRun: false,
          sheet: {
            core: {
              name: "Mira Holloway",
              classes: [{ name: "Fighter", level: 3 }],
              hp: { max: 28, current: 28 },
            },
          },
        },
      }),
    );
    expect(pc.report.created).toHaveLength(1);
    expect(pc.report.invalid).toEqual([]);

    // The log: a recap written through it, and read back.
    answer(
      await client.callTool({
        name: "add_log_entry",
        arguments: { campaignId, text: "Mira joined the party at the crossroads." },
      }),
    );
    const log = answer<{ text: string; kind: string; author: string }[]>(
      await client.callTool({ name: "get_campaign_log", arguments: { campaignId } }),
    );
    expect(log.at(-1)).toMatchObject({
      kind: "recap",
      text: "Mira joined the party at the crossroads.",
      author: "Claude Code (API)",
    });
    expect(t.server.ctx.campaigns.log(campaignId).at(-1)?.text).toBe(
      "Mira joined the party at the crossroads.",
    );

    // A failure comes back in words, not as a broken server.
    const bad = (await client.callTool({
      name: "get_campaign_log",
      arguments: { campaignId: "cmp_does_not_exist" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/campaign/i);
  });
});
