import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { adminSection, expect, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p13";
const REPO = resolve(import.meta.dirname, "..", "..")
  .split("\\")
  .join("/");

const nav = (p: Page, name: string) => adminSection(p, name);

/**
 * Speaks MCP over stdio to a server started exactly as a setup says (its command, args and env), the way Claude
 * would: `initialize`, `tools/list`, one `tools/call`. Newline-delimited JSON-RPC.
 */
async function mcpRoundTrip(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ tools: string[]; campaigns: { name: string }[] }> {
  const child = spawn(command === "node" ? process.execPath : command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { id?: number };
      if (typeof m.id === "number") waiting.get(m.id)?.(m as Record<string, unknown>);
    }
  });
  let next = 1;
  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      const id = next++;
      const timer = setTimeout(() => fail(new Error(`${method}: no answer`)), 20_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        ok(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gloam-e2e", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = (await call("tools/list", {})) as { result: { tools: { name: string }[] } };
    const res = (await call("tools/call", { name: "list_campaigns", arguments: {} })) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    if (res.result.isError) throw new Error(res.result.content[0]?.text);
    return {
      tools: list.result.tools.map((t) => t.name).sort(),
      campaigns: JSON.parse(res.result.content[0]?.text ?? "[]"),
    };
  } finally {
    child.kill();
  }
}

/**
 * Admin → API & MCP (SPEC §8.20, §8.23): a token made in the console — shown once — and Connect Claude's setup with
 * this repository's path and that token, which works as written (AC-API-05); revoked, gone. The console's other
 * sections' new settings (port, new-campaign defaults, auto-approve images, allow remote API) round out AC-ADM-01.
 */
test.describe("P13 — API & MCP in the Admin console (API)", () => {
  test("AC-API-05 / AC-ADM-01: a token made once; Connect Claude's setup has the real path and the token, and works as written; the Settings", async ({
    admin,
    gloam,
  }) => {
    test.setTimeout(240_000);
    await admin.getByRole("button", { name: "Start with the demo" }).click();
    await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });

    await nav(admin, "API & MCP");
    await expect(admin.getByRole("heading", { name: "API & MCP" })).toBeVisible();
    await expect(admin.getByTestId("setup-claude-code")).toContainText("GLOAM_TOKEN=<your token>");
    // A token: named, its scopes chosen.
    await admin.getByRole("button", { name: "Make a token" }).click();
    const dialog = admin.getByRole("dialog", { name: "Make a token" });
    await dialog.getByLabel("Name").fill("Claude Code");
    await dialog.getByRole("button", { name: "Make it" }).click();
    const fresh = admin.getByTestId("fresh-token");
    await expect(fresh).toBeVisible();
    const token = (await fresh.locator("code").innerText()).trim();
    expect(token).toMatch(/^gloam_[A-Za-z0-9_-]{43}$/);
    await expect(admin.getByTestId("api-token-row")).toHaveCount(1);
    await expect(admin.getByTestId("api-token-row")).toContainText("Claude Code");

    // Connect Claude: this computer's address, the MCP server in this repository, the token.
    const port = new URL(gloam.url).port;
    const code = await admin.getByTestId("setup-claude-code").innerText();
    expect(code).toBe(
      `claude mcp add gloam --env GLOAM_URL=http://127.0.0.1:${port} --env GLOAM_TOKEN=${token} -- node ${REPO}/packages/mcp/src/index.ts`,
    );
    const desktop = JSON.parse(await admin.getByTestId("setup-claude-desktop").innerText()) as {
      mcpServers: { gloam: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(desktop.mcpServers.gloam).toEqual({
      command: "node",
      args: [`${REPO}/packages/mcp/src/index.ts`],
      env: { GLOAM_URL: `http://127.0.0.1:${port}`, GLOAM_TOKEN: token },
    });
    await admin.screenshot({ path: `${SHOTS}/api-connect-claude.png`, fullPage: true });
    // …and it works as written: the server that config starts lists its tools and, with the token, the campaigns.
    const g = desktop.mcpServers.gloam;
    const rt = await mcpRoundTrip(g.command, g.args, g.env);
    expect(rt.tools).toEqual(
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
    expect(rt.campaigns.map((c) => c.name)).toContain("The Lantern Crypt");

    // The token was used: it says when; the Security log has it (never the token itself).
    await admin.reload();
    await expect(admin.getByTestId("api-token-row")).not.toContainText("last used never");
    await nav(admin, "Security log");
    await expect(
      admin.getByTestId("security-row").filter({ hasText: "API token used" }).first(),
    ).toBeVisible();
    await expect(
      admin.getByTestId("security-row").filter({ hasText: "API token made" }).first(),
    ).toBeVisible();
    await expect(admin.getByTestId("security-page")).not.toContainText(token);

    // Revoked: the setup no longer works.
    await nav(admin, "API & MCP");
    await admin.getByTestId("api-token-row").getByRole("button", { name: "Revoke" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
    await expect(admin.getByTestId("api-token-row")).toHaveCount(0);
    await expect(mcpRoundTrip(g.command, g.args, g.env)).rejects.toThrow(/isn't known|revoked/);

    // ── Settings: the port (host only; on the next start), new campaigns' defaults, images auto-approved, remote API ──
    await nav(admin, "Settings");
    await admin.getByLabel("Port").fill("4848");
    await admin.getByRole("button", { name: "Save port" }).click();
    await expect(admin.getByText("Port saved — restart Gloam to use it")).toBeVisible();
    await admin.getByLabel("Distances in").selectOption("m");
    await expect(admin.getByText("Saved").first()).toBeVisible();
    await admin.getByRole("switch", { name: "Auto-approve players' images" }).click();
    await admin.getByRole("switch", { name: "Allow remote API" }).click();
    const settings = (await (await admin.request.get(`${gloam.url}/api/admin/settings`)).json()) as {
      data: {
        port: number;
        newCampaignDefaults: { units: string };
        autoApproveImages: boolean;
        allowRemoteApi: boolean;
      };
    };
    expect(settings.data).toMatchObject({
      port: 4848,
      newCampaignDefaults: { units: "m" },
      autoApproveImages: true,
      allowRemoteApi: true,
    });
    // A campaign made now measures in metres.
    await nav(admin, "Campaigns");
    await admin.getByLabel("A new campaign").fill("The Metric Road");
    await admin.getByRole("button", { name: "Make it" }).click();
    await expect(admin.getByTestId("campaign-row").filter({ hasText: "The Metric Road" })).toBeVisible();
    const list = (await (await admin.request.get(`${gloam.url}/api/admin/campaigns`)).json()) as {
      data: { name: string; units: string }[];
    };
    expect(list.data.find((c) => c.name === "The Metric Road")?.units).toBe("m");
    expect(list.data.find((c) => c.name === "The Lantern Crypt")?.units).toBe("ft");
    await admin.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
  });
});
