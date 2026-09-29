import { GloamError } from "@gloam/shared/protocol";
import type express from "express";
import type { Express } from "express";
import { z } from "zod";
import type { ServerContext } from "../../context.ts";
import { dirSize } from "../../dataDir.ts";
import { createLanternCrypt } from "../../demo/lanternCrypt.ts";
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
      if (b.select || !ctx.settings.get().selectedCampaignId) await selectCampaign(ctx, c.id);
      ok(res, { id: c.id });
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
