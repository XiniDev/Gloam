#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/**
 * Gloam's MCP server (SPEC §8.23, §26.2): a stdio server Claude starts on the host computer, calling Gloam's local
 * REST API (`/api/v1`) with an API token made in Admin → API & MCP. It adds no AI to Gloam — it lets the DM's own
 * Claude import spell lists, monsters and characters, and read and write the campaign log.
 *
 * Configuration: `GLOAM_URL` (default http://127.0.0.1:4747) and `GLOAM_TOKEN`. stdout is the protocol; anything
 * this says goes to stderr.
 */

const BASE = (process.env.GLOAM_URL ?? "http://127.0.0.1:4747").replace(/\/+$/, "");
const TOKEN = process.env.GLOAM_TOKEN ?? "";
const log = (message: string) => process.stderr.write(`[gloam-mcp] ${message}\n`);

/** The import formats whose JSON Schemas Gloam publishes. */
const SCHEMA_KINDS = ["spell", "character", "monster", "item", "handout", "campaign-log-entry"] as const;
const Strategy = z
  .enum(["skip", "overwrite", "rename"])
  .describe(
    "What to do with an entry whose id is taken: skip it, overwrite ours, or import it under a new id.",
  );
const CampaignId = z.string().min(3).max(40).describe("The campaign's id (from list_campaigns).");
const DryRun = z
  .boolean()
  .default(true)
  .describe(
    "true (the default): check and report, change nothing. Run once dry, show the report, then for real.",
  );

/** A call to Gloam's API; its `data` (and an import's `report`), or its error in words. */
async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  if (!TOKEN)
    throw new Error(
      "No GLOAM_TOKEN. Make one in Gloam: Admin → API & MCP, then add it to this server's env.",
    );
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new Error(`Gloam isn't answering at ${BASE} (${(e as Error).message}). Is it running?`);
  }
  const text = await res.text();
  let json: { data?: unknown; report?: unknown; errors?: unknown; error?: { message?: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // A schema document, or something that isn't JSON.
  }
  if (!res.ok) throw new Error(json.error?.message ?? `Gloam said ${res.status}.`);
  if (path.startsWith("/api/v1/schemas/")) return json;
  return json.report === undefined ? json.data : { report: json.report, details: json.data };
}

const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});
/** A tool's work, with any failure told to the model in words (never a crash of the server). */
async function run(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text((e as Error).message), isError: true };
  }
}
const query = (params: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** One server, its tools registered once (the stdio entry pins it to the connection). */
export function gloamServer(): McpServer {
  const server = new McpServer({ name: "gloam", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.registerTool(
    "get_schema",
    {
      title: "Get an import schema",
      description:
        "The JSON Schema Gloam checks an import against (strict: unknown fields are refused). Read it before writing spells, monsters, characters, items, handouts or log entries for Gloam.",
      inputSchema: z.object({ kind: z.enum(SCHEMA_KINDS) }),
    },
    ({ kind }) => run(() => api("GET", `/api/v1/schemas/${kind}.json`)),
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "Gloam's campaigns: id, name, the scene showing, the session number, and which one is at the table.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => api("GET", "/api/v1/campaigns")),
  );

  server.registerTool(
    "search_spells",
    {
      title: "Search spells",
      description:
        "Find spells by name, level or pack — the SRD 5.2.1's, and with a campaign id, that campaign's own homebrew too.",
      inputSchema: z.object({
        query: z.string().max(80).optional(),
        level: z.number().int().min(0).max(9).optional(),
        pack: z.enum(["srd-5.2.1", "homebrew"]).optional(),
        campaignId: CampaignId.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (p) => run(() => api("GET", `/api/v1/content/spells${query(p)}`)),
  );

  server.registerTool(
    "import_spells",
    {
      title: "Import homebrew spells",
      description:
        "Import spells (each in the spell schema — get_schema kind 'spell') into a campaign. A dry run first reports what's valid, what clashes and what would be made.",
      inputSchema: z.object({
        campaignId: CampaignId,
        spells: z.array(z.unknown()).min(1).max(1000),
        dryRun: DryRun,
        onConflict: Strategy.optional(),
      }),
    },
    ({ campaignId, spells, dryRun, onConflict }) =>
      run(() =>
        api("POST", `/api/v1/content/spells:import${query({ campaignId, dryRun, onConflict })}`, spells),
      ),
  );

  server.registerTool(
    "import_monsters",
    {
      title: "Import homebrew monsters",
      description:
        "Import monsters (each in the monster schema) into a campaign's Bestiary: each becomes an NPC sheet the DM places, every copy with its own HP. Dry run first.",
      inputSchema: z.object({
        campaignId: CampaignId,
        monsters: z.array(z.unknown()).min(1).max(500),
        dryRun: DryRun,
        onConflict: Strategy.optional(),
      }),
    },
    ({ campaignId, monsters, dryRun, onConflict }) =>
      run(() =>
        api("POST", `/api/v1/content/monsters:import${query({ campaignId, dryRun, onConflict })}`, monsters),
      ),
  );

  server.registerTool(
    "import_character",
    {
      title: "Import a character",
      description:
        "Import one character sheet (the character schema) into a campaign, for the DMs to hand to a player. Dry run first.",
      inputSchema: z.object({ campaignId: CampaignId, sheet: z.unknown(), dryRun: DryRun }),
    },
    ({ campaignId, sheet, dryRun }) =>
      run(() => api("POST", `/api/v1/actors:import${query({ campaignId, dryRun })}`, [sheet])),
  );

  server.registerTool(
    "get_campaign_log",
    {
      title: "Read the campaign log",
      description:
        "The campaign log — what happened, session by session (for a recap). sinceSession limits it to that session and later.",
      inputSchema: z.object({ campaignId: CampaignId, sinceSession: z.number().int().min(0).optional() }),
      annotations: { readOnlyHint: true },
    },
    ({ campaignId, sinceSession }) =>
      run(() =>
        api("GET", `/api/v1/campaigns/${encodeURIComponent(campaignId)}/log${query({ sinceSession })}`),
      ),
  );

  server.registerTool(
    "add_log_entry",
    {
      title: "Add to the campaign log",
      description: "Write a recap or a note into the campaign log; the table sees it at once if it's open.",
      inputSchema: z.object({
        campaignId: CampaignId,
        text: z.string().min(1).max(4000),
        kind: z.enum(["recap", "note"]).optional(),
      }),
    },
    ({ campaignId, text: body, kind }) =>
      run(() =>
        api("POST", `/api/v1/campaigns/${encodeURIComponent(campaignId)}/log`, {
          text: body,
          ...(kind ? { kind } : {}),
        }),
      ),
  );

  return server;
}

// Started as a program (not imported by a test): serve on stdio.
if (import.meta.main ?? process.argv[1]?.endsWith("index.ts")) {
  if (!TOKEN)
    log("GLOAM_TOKEN isn't set: make a token in Gloam (Admin → API & MCP). Tools will say so until then.");
  serveStdio(gloamServer, { onerror: (e) => log(e.message) });
  log(`ready — Gloam at ${BASE}`);
}
