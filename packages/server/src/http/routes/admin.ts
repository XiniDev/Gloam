import { rmSync } from "node:fs";
import { GloamError } from "@gloam/shared/protocol";
import { CONTENT_PACKS, parseCampaignSettings } from "@gloam/shared/schemas";
import type express from "express";
import type { Express } from "express";
import { z } from "zod";
import { aboutGloam } from "../../about/about.ts";
import { sanitizeDisplayName, validDisplayName, validPin } from "../../auth/profiles.ts";
import type { ServerContext } from "../../context.ts";
import { dirSize } from "../../dataDir.ts";
import { addBenchmarkScene } from "../../demo/benchmark.ts";
import { createLanternCrypt } from "../../demo/lanternCrypt.ts";
import { API_SCOPES, ApiScope } from "../../services/apiTokens.ts";
import { LOCAL_ONLY_SETTINGS, type SettingKey, type Settings } from "../../services/settings.ts";
import { body, ok, requireAdmin, requireLocal, route } from "../helpers.ts";

const OpenBody = z.strictObject({
  mode: z.enum(["quick", "named", "lan", "local"]),
  confirmLan: z.boolean().optional(),
});

const SettingsPatch = z.strictObject({
  tunnelMode: z.enum(["quick", "named", "lan", "local"]).optional(),
  tunnelToken: z.string().min(20).max(4096).nullable().optional(),
  publicHostname: z
    .string()
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/)
    .nullable()
    .optional(),
  cloudflaredPath: z.string().min(1).max(1024).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  autoAdmitReturning: z.boolean().optional(),
  dmsCanAdmit: z.boolean().optional(),
  autoApproveImages: z.boolean().optional(),
  allowAdminThroughDoorway: z.boolean().optional(),
  allowRemoteApi: z.boolean().optional(),
  newCampaignDefaults: z
    .strictObject({ rulesPack: z.enum(["srd-5.2.1", "srd-5.1"]), units: z.enum(["ft", "m"]) })
    .optional(),
});

export function adminRoutes(app: Express, ctx: ServerContext): void {
  const actor = (req: express.Request) => {
    const a = requireAdmin(req);
    return { userId: a.user.id, role: "admin" as const, ip: req.gloam.ip };
  };

  // ── table ──────────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/admin/table",
    route((req, res) => {
      requireAdmin(req);
      ok(res, ctx.table.dto());
    }),
  );
  app.post(
    "/api/admin/table/open",
    route(async (req, res) => {
      const a = actor(req);
      const b = body(req, OpenBody);
      if (b.mode === "lan") requireLocal(ctx, req);
      ok(res, await ctx.table.open(b.mode, { confirmLan: b.confirmLan, ip: a.ip, userId: a.userId }));
    }),
  );
  app.post(
    "/api/admin/table/close",
    route(async (req, res) => {
      const a = actor(req);
      ok(res, await ctx.table.close({ ip: a.ip, userId: a.userId }));
    }),
  );
  app.post(
    "/api/admin/table/invite/rotate",
    route((req, res) => {
      const a = actor(req);
      ok(res, ctx.table.rotateInvite({ ip: a.ip, userId: a.userId }));
    }),
  );
  app.post(
    "/api/admin/table/invite/revoke",
    route((req, res) => {
      const a = actor(req);
      ok(res, ctx.table.revokeInvite({ ip: a.ip, userId: a.userId }));
    }),
  );
  app.post(
    "/api/admin/table/invite/policy",
    route((req, res) => {
      actor(req);
      const b = body(
        req,
        z.strictObject({
          expiry: z.enum(["close", "2h", "4h", "8h"]).optional(),
          maxUses: z.number().int().min(1).max(1000).nullable().optional(),
        }),
      );
      ok(res, ctx.table.setInvitePolicy(b));
    }),
  );
  app.post(
    "/api/admin/table/lock",
    route((req, res) => {
      const a = actor(req);
      const { locked } = body(req, z.strictObject({ locked: z.boolean() }));
      ok(res, ctx.table.setLock(locked, { ip: a.ip, userId: a.userId }));
    }),
  );
  app.post(
    "/api/admin/table/cloudflared/recheck",
    route(async (req, res) => {
      actor(req);
      await ctx.table.checkCloudflared();
      ok(res, ctx.table.dto());
    }),
  );
  app.post(
    "/api/admin/table/doorway/ack",
    route((req, res) => {
      actor(req);
      ctx.tunnel.acknowledgeHostnameChange();
      ok(res, ctx.table.dto());
    }),
  );
  app.post(
    "/api/admin/table/knocks/decide",
    route((req, res) => {
      const a = actor(req);
      const b = body(
        req,
        z.strictObject({
          sessionId: z.string().min(3).max(40),
          decision: z.enum(["admitPlayer", "admitSpectator", "deny", "ban"]),
          reason: z.string().max(200).optional(),
        }),
      );
      ctx.people.decide(a, b);
      ok(res, ctx.table.dto());
    }),
  );

  // ── settings ───────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/admin/settings",
    route((req, res) => {
      requireAdmin(req);
      ok(res, {
        ...ctx.settings.publicView(),
        localOnlyKeys: [...LOCAL_ONLY_SETTINGS],
        local: req.gloam.local,
      });
    }),
  );
  app.patch(
    "/api/admin/settings",
    route((req, res) => {
      const a = actor(req);
      const b = body(req, SettingsPatch);
      const keys = Object.keys(b) as (keyof typeof b)[];
      // Port, LAN, tunnel and cloudflared-path settings only from the host PC (SPEC §8.20, §22.3).
      const touchesLocalOnly = keys.some(
        (k) => k === "tunnelToken" || LOCAL_ONLY_SETTINGS.has(k as SettingKey),
      );
      if (touchesLocalOnly) requireLocal(ctx, req);
      const { tunnelToken, ...rest } = b;
      if (tunnelToken !== undefined) ctx.settings.setTunnelToken(tunnelToken);
      const patch: Partial<Settings> = {};
      for (const [k, v] of Object.entries(rest))
        if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      ctx.settings.update(patch);
      ctx.security.record("settings.change", { userId: a.userId, ip: a.ip, detail: { keys } });
      ok(res, ctx.settings.publicView());
    }),
  );

  // ── campaigns (core; the full console section lands in P12) ─────────────────────────────────────────────
  app.get(
    "/api/admin/campaigns",
    route((req, res) => {
      requireAdmin(req);
      const selected = ctx.settings.get().selectedCampaignId;
      ok(
        res,
        ctx.campaigns.list(true).map((c) => ({
          id: c.id,
          name: c.name,
          rulesPack: c.rulesPack,
          units: c.units,
          sessionNo: c.sessionNo,
          archived: c.archivedAt !== null,
          selected: c.id === selected,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      );
    }),
  );
  app.post(
    "/api/admin/campaigns",
    route(async (req, res) => {
      requireAdmin(req);
      const b = body(
        req,
        z.strictObject({ name: z.string().trim().min(1).max(80), select: z.boolean().optional() }),
      );
      const defaults = ctx.settings.get().newCampaignDefaults;
      const c = ctx.campaigns.create({ name: b.name, rulesPack: defaults.rulesPack, units: defaults.units });
      // Made the table's only while the table is closed: an open table never changes campaign under its players (the
      // select route refuses the same).
      const select = (b.select || !ctx.settings.get().selectedCampaignId) && !ctx.table.isOpen;
      if (select) await selectCampaign(ctx, c.id);
      ok(res, { id: c.id, selected: select });
    }),
  );
  // The demo campaign (SPEC §8.24): the Lantern Crypt, made by code, selected for the table.
  app.post(
    "/api/admin/campaigns/demo",
    route(async (req, res) => {
      const a = requireAdmin(req);
      const { campaignId } = await createLanternCrypt(ctx, {
        userId: a.user.id,
        name: a.user.displayName,
        role: "admin",
        lobby: false,
      });
      if (!ctx.table.isOpen) await selectCampaign(ctx, campaignId);
      ok(res, { id: campaignId });
    }),
  );
  // Rename and archive (SPEC §8.20 Campaigns); an archived campaign keeps everything, out of the way.
  app.patch(
    "/api/admin/campaigns/:id",
    route(async (req, res) => {
      const a = requireAdmin(req);
      const id = String(req.params.id);
      const c = ctx.campaigns.get(id);
      if (!c) throw new GloamError("NOT_FOUND");
      const b = body(
        req,
        z.strictObject({
          name: z.string().trim().min(1).max(80).optional(),
          archived: z.boolean().optional(),
        }),
      );
      if (b.archived && ctx.table.isOpen && ctx.table.campaignId === id)
        throw new GloamError("CONFLICT", "Close the table before archiving the campaign it runs.");
      const room = ctx.rooms.table(id);
      // Renamed: through the room's bus when it's live (the table's title follows, the history has it), else on disk.
      if (b.name !== undefined && room)
        room.bus.execute(
          "campaign.update",
          { name: b.name },
          { userId: a.user.id, role: "admin", name: a.user.displayName, actingAs: null },
        );
      else if (b.name !== undefined) ctx.campaigns.update(id, { name: b.name });
      if (b.archived !== undefined) ctx.campaigns.update(id, { archivedAt: b.archived ? Date.now() : null });
      ok(res);
    }),
  );
  // Delete, confirmed by typing its name (SPEC §8.20: "delete with confirmation"): everything in it goes; its
  // uploaded files stay until Assets → Clean up.
  app.post(
    "/api/admin/campaigns/:id/delete",
    route(async (req, res) => {
      const a = requireAdmin(req);
      const id = String(req.params.id);
      const c = ctx.campaigns.get(id);
      if (!c) throw new GloamError("NOT_FOUND");
      const { confirm } = body(req, z.strictObject({ confirm: z.string().max(80) }));
      if (confirm.trim() !== c.name)
        throw new GloamError("INVALID", "Type the campaign's name to delete it.");
      if (ctx.table.isOpen && ctx.table.campaignId === id)
        throw new GloamError("CONFLICT", "Close the table before deleting the campaign it runs.");
      const { disposeTableRoom } = await import("../../rooms/lifecycle.ts");
      await disposeTableRoom(ctx, id);
      // Its snapshots' files go with their rows (the daily backups still hold it).
      for (const snap of ctx.snapshots.list(id)) rmSync(snap.path, { force: true });
      ctx.campaigns.delete(id);
      if (ctx.settings.get().selectedCampaignId === id) {
        const next = ctx.campaigns.list(false)[0];
        ctx.settings.update({ selectedCampaignId: next?.id ?? null });
        ctx.table.campaignId = next?.id ?? null;
      }
      ctx.security.record("settings.change", {
        userId: a.user.id,
        ip: req.gloam.ip,
        detail: { campaignDeleted: c.name },
      });
      ctx.table.changed();
      ok(res);
    }),
  );
  app.post(
    "/api/admin/campaigns/:id/select",
    route(async (req, res) => {
      requireAdmin(req);
      const id = String(req.params.id);
      if (!ctx.campaigns.get(id)) throw new GloamError("NOT_FOUND");
      if (ctx.table.isOpen) throw new GloamError("CONFLICT", "Close the table before switching campaigns.");
      await selectCampaign(ctx, id);
      ok(res, { id });
    }),
  );

  // ── people ─────────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/admin/people",
    route((req, res) => {
      requireAdmin(req);
      const campaignId = ctx.table.campaignId ?? ctx.settings.get().selectedCampaignId;
      const online = ctx.rooms.table(campaignId)?.onlineUserIds() ?? new Set<string>();
      ok(
        res,
        ctx.profiles.all().map((u) => ({
          id: u.id,
          name: u.displayName,
          color: u.color,
          isAdmin: u.isAdmin,
          hasPin: u.pinHash !== null,
          banned: u.bannedAt !== null,
          banReason: u.banReason,
          lastSeenAt: u.lastSeenAt,
          role: campaignId ? ctx.campaigns.roleOf(campaignId, u) : null,
          devices: ctx.profiles
            .devicesFor(u.id)
            .map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt })),
          online: online.has(u.id),
        })),
      );
    }),
  );
  app.post(
    "/api/admin/people/:id/kick",
    route((req, res) => {
      ctx.people.kick(String(req.params.id), actor(req));
      ok(res);
    }),
  );
  app.post(
    "/api/admin/people/:id/ban",
    route((req, res) => {
      const { reason } = body(req, z.strictObject({ reason: z.string().max(200).optional() }));
      ctx.people.ban(String(req.params.id), actor(req), reason ?? null);
      ok(res);
    }),
  );
  // Rename, PIN, role per campaign, delete with reassignment (SPEC §8.20 People; AC-ADM-02).
  app.patch(
    "/api/admin/people/:id",
    route((req, res) => {
      const { name } = body(req, z.strictObject({ name: z.string().max(48) }));
      const clean = sanitizeDisplayName(name);
      if (!validDisplayName(clean))
        throw new GloamError("INVALID", "Names are 2–24 characters: letters, digits, spaces and - ' _ .");
      ctx.people.rename(String(req.params.id), clean, actor(req));
      ok(res);
    }),
  );
  app.post(
    "/api/admin/people/:id/pin",
    route(async (req, res) => {
      const { pin } = body(req, z.strictObject({ pin: z.string().max(8).nullable() }));
      if (pin !== null && !validPin(pin)) throw new GloamError("INVALID", "A PIN is 4–8 digits.");
      await ctx.people.setPin(String(req.params.id), pin, actor(req));
      ok(res);
    }),
  );
  app.post(
    "/api/admin/people/:id/role",
    route((req, res) => {
      const b = body(
        req,
        z.strictObject({
          campaignId: z.string().min(1).max(64),
          role: z.enum(["dm", "player", "spectator"]).nullable(),
        }),
      );
      ctx.people.setRole(String(req.params.id), b.campaignId, b.role, actor(req));
      ok(res);
    }),
  );
  app.post(
    "/api/admin/people/:id/delete",
    route((req, res) => {
      const b = body(req, z.strictObject({ reassignTo: z.string().min(1).max(64).nullable() }));
      ok(res, ctx.people.deleteProfile(String(req.params.id), b.reassignTo, actor(req)));
    }),
  );
  app.post(
    "/api/admin/people/:id/unban",
    route((req, res) => {
      ctx.people.unban(String(req.params.id), actor(req));
      ok(res);
    }),
  );

  // ── saves & backups ────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/admin/campaigns/:id/snapshots",
    route((req, res) => {
      requireAdmin(req);
      ok(
        res,
        ctx.snapshots.list(String(req.params.id)).map(({ path: _p, ...s }) => s),
      );
    }),
  );
  app.post(
    "/api/admin/campaigns/:id/snapshots",
    route((req, res) => {
      requireAdmin(req);
      const { name } = body(req, z.strictObject({ name: z.string().max(80).optional() }));
      const id = String(req.params.id);
      if (!ctx.campaigns.get(id)) throw new GloamError("NOT_FOUND");
      const { path: _p, ...s } = ctx.snapshots.write(id, "manual", name);
      ok(res, s);
    }),
  );
  app.post(
    "/api/admin/snapshots/:id/restore",
    route(async (req, res) => {
      requireAdmin(req);
      const snap = ctx.snapshots.get(String(req.params.id));
      if (!snap) throw new GloamError("NOT_FOUND");
      const r = ctx.snapshots.restore(snap.id);
      await ctx.rooms.table(snap.campaignId)?.reloadFromDatabase();
      ok(res, r);
    }),
  );
  app.delete(
    "/api/admin/snapshots/:id",
    route((req, res) => {
      requireAdmin(req);
      ctx.snapshots.remove(String(req.params.id));
      ok(res);
    }),
  );
  app.get(
    "/api/admin/backups",
    route((req, res) => {
      requireAdmin(req);
      ok(res, {
        backups: ctx.backups
          .list()
          .map((b) => ({ name: b.file.split(/[\\/]/).pop(), bytes: b.bytes, createdAt: b.createdAt })),
        dataDirBytes: dirSize(ctx.paths.root),
      });
    }),
  );
  app.post(
    "/api/admin/backups",
    route(async (req, res) => {
      requireAdmin(req);
      const b = await ctx.backups.backupNow("manual");
      ok(res, { name: b.file.split(/[\\/]/).pop(), bytes: b.bytes, createdAt: b.createdAt });
    }),
  );

  // ── assets (SPEC §8.20 Assets): every campaign's, the storage they take, orphans cleaned up ───────────────
  app.get(
    "/api/admin/assets",
    route((req, res) => {
      requireAdmin(req);
      ok(res, { ...ctx.assets.overview(), diskBytes: dirSize(ctx.paths.assets) });
    }),
  );
  app.post(
    "/api/admin/assets/cleanup",
    route((req, res) => {
      const a = requireAdmin(req);
      const before = dirSize(ctx.paths.assets);
      const r = ctx.assets.purge();
      const freed = Math.max(0, before - dirSize(ctx.paths.assets));
      ctx.security.record("settings.change", { userId: a.user.id, ip: req.gloam.ip, detail: { cleanup: r } });
      ok(res, { ...r, freedBytes: freed });
    }),
  );

  // ── content (SPEC §8.20 Content): the packs and which campaigns play with them; homebrew at a glance ─────
  app.get(
    "/api/admin/content",
    route((req, res) => {
      requireAdmin(req);
      const pack = ctx.content;
      ok(res, {
        packs: [
          {
            id: pack.id,
            name: "System Reference Document 5.2.1",
            spells: pack.spells.length,
            conditions: pack.conditions.length,
            lightSources: pack.lightSources.length,
          },
        ],
        campaigns: ctx.campaigns.list(true).map((c) => ({
          id: c.id,
          name: c.name,
          archived: c.archivedAt !== null,
          packs: parseCampaignSettings(String(c.settingsJson)).packs,
          homebrew: ctx.campaigns.homebrewCounts(c.id),
        })),
      });
    }),
  );
  app.post(
    "/api/admin/campaigns/:id/packs",
    route((req, res) => {
      const a = requireAdmin(req);
      const id = String(req.params.id);
      const c = ctx.campaigns.get(id);
      if (!c) throw new GloamError("NOT_FOUND");
      const { packs } = body(req, z.strictObject({ packs: z.array(z.enum(CONTENT_PACKS)).max(8) }));
      const room = ctx.rooms.table(id);
      // Through the room's bus when it's at the table (everyone's spell lists follow), else on disk.
      if (room)
        room.bus.execute(
          "campaign.update",
          { settings: { packs } },
          { userId: a.user.id, role: "admin", name: a.user.displayName, actingAs: null },
        );
      else
        ctx.campaigns.update(id, {
          settingsJson: JSON.stringify({ ...parseCampaignSettings(String(c.settingsJson)), packs }),
        });
      ok(res);
    }),
  );

  // ── the benchmark scene (SPEC §37): seeded on request into a campaign (the bench puts it in the demo), host only ──
  app.post(
    "/api/admin/campaigns/:id/benchmark-scene",
    route(async (req, res) => {
      const a = actor(req);
      requireLocal(ctx, req);
      const id = String(req.params.id);
      if (!ctx.campaigns.get(id)) throw new GloamError("NOT_FOUND", "No such campaign.");
      const b = body(req, z.strictObject({ archived: z.boolean().default(true) }));
      const admin = ctx.profiles.get(a.userId);
      const made = await addBenchmarkScene(
        ctx,
        id,
        { userId: a.userId, name: admin?.displayName ?? "Admin", role: "admin", lobby: false },
        { archived: b.archived },
      );
      // An open table for it takes it in (written as the demo is, straight to the database).
      await ctx.rooms.table(id)?.reloadFromDatabase();
      ok(res, made);
    }),
  );

  // ── API & MCP (SPEC §8.20, §8.23; AC-API-01/05): tokens, Allow remote API, the Connect Claude setup ──────────
  app.get(
    "/api/admin/api",
    route((req, res) => {
      requireAdmin(req);
      // Forward slashes: node takes them on every system, and they need no escaping in the JSON config.
      const repo = ctx.config.repoRoot.split("\\").join("/");
      ok(res, {
        tokens: ctx.apiTokens.list(),
        scopes: API_SCOPES,
        allowRemoteApi: ctx.settings.get().allowRemoteApi,
        url: `http://127.0.0.1:${ctx.http.address().port}`,
        repoPath: repo,
        mcpEntry: `${repo}/packages/mcp/src/index.ts`,
        local: req.gloam.local,
      });
    }),
  );
  app.post(
    "/api/admin/api/tokens",
    route((req, res) => {
      const a = actor(req);
      const b = body(
        req,
        z.strictObject({
          name: z.string().trim().min(1).max(60),
          scopes: z.array(ApiScope).min(1).max(API_SCOPES.length),
        }),
      );
      // The secret goes back this once; only its hash is kept.
      ok(res, ctx.apiTokens.create(b.name, b.scopes, { userId: a.userId, ip: a.ip }));
    }),
  );
  app.post(
    "/api/admin/api/tokens/:id/revoke",
    route((req, res) => {
      const a = actor(req);
      ctx.apiTokens.revoke(String(req.params.id), { userId: a.userId, ip: a.ip });
      ok(res, { tokens: ctx.apiTokens.list() });
    }),
  );

  // ── the first-run checklist (SPEC §8.20; AC-ADM-06): five steps, on top of the console until done ──────────
  app.get(
    "/api/admin/checklist",
    route(async (req, res) => {
      requireAdmin(req);
      // Never checked since the server started: checked now — a fresh install's list read "Install cloudflared" undone
      // while it was installed, until something else looked.
      if (!ctx.settings.get().checklist.cloudflaredSeen && ctx.table.cloudflared === null)
        await ctx.table.checkCloudflared();
      const s = ctx.settings.get();
      const steps = {
        password: ctx.admin.hasPassword(),
        cloudflared: s.checklist.cloudflaredSeen || ctx.table.cloudflared?.installed === true,
        campaign: ctx.campaigns.list(true).length > 0,
        map: ctx.campaigns.anyMap(),
        tableOpened: s.checklist.tableOpened,
      };
      ok(res, { steps, done: Object.values(steps).every(Boolean) });
    }),
  );

  // ── about & credits (SPEC §8.20; AC-ADM-05): version, the SRD attribution verbatim, the licences ──────────
  app.get(
    "/api/admin/about",
    route((req, res) => {
      requireAdmin(req);
      ok(res, aboutGloam(ctx));
    }),
  );

  // ── security log ───────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/admin/security-log",
    route((req, res) => {
      requireAdmin(req);
      const event = typeof req.query.event === "string" ? req.query.event : undefined;
      const before = typeof req.query.before === "string" ? Number(req.query.before) : undefined;
      const names = new Map(ctx.profiles.all().map((u) => [u.id, u.displayName]));
      ok(
        res,
        ctx.security
          .list({ event, before, limit: 200 })
          .map((e) => ({ ...e, userName: e.userId ? names.get(e.userId) : null })),
      );
    }),
  );
}

/** Makes a campaign the one the table runs; (re)creates its table room. */
export async function selectCampaign(ctx: ServerContext, campaignId: string): Promise<void> {
  const previous = ctx.settings.get().selectedCampaignId;
  ctx.settings.update({ selectedCampaignId: campaignId });
  ctx.table.campaignId = campaignId;
  const { ensureTableRoom, disposeTableRoom } = await import("../../rooms/lifecycle.ts");
  if (previous && previous !== campaignId) await disposeTableRoom(ctx, previous);
  await ensureTableRoom(ctx, campaignId);
  ctx.table.changed();
}
