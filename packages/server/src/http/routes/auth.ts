import { LIMITS, PLAYER_COLORS } from "@gloam/shared";
import { GloamError } from "@gloam/shared/protocol";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { MIN_PASSWORD } from "../../auth/admin.ts";
import { isLoopback } from "../../auth/localOnly.ts";
import { passwordStrength } from "../../auth/passwords.ts";
import { deviceLabel, sanitizeDisplayName, validDisplayName, validPin } from "../../auth/profiles.ts";
import type { ServerContext } from "../../context.ts";
import {
  body,
  COOKIE,
  clearCookie,
  csrfFor,
  issueDeviceCookie,
  issueSessionCookies,
  ok,
  requireLocal,
  requireSession,
  route,
  sendError,
  setCookie,
} from "../helpers.ts";

const JOIN_TICKET_MS = 20 * 60_000;

const SetupBody = z.strictObject({
  token: z.string().min(10).max(100),
  password: z.string().min(MIN_PASSWORD).max(256),
  createDemo: z.boolean().optional(),
});
const LoginBody = z.strictObject({ password: z.string().min(1).max(256) });
const CodeBody = z.strictObject({ code: z.string().min(1).max(40) });
const IdentityBody = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("device") }),
  z.strictObject({
    mode: z.literal("new"),
    name: z.string().min(1).max(64),
    color: z.enum(PLAYER_COLORS.map((c) => c.id) as [string, ...string[]]),
    pin: z.string().max(LIMITS.pinMax).optional(),
  }),
  z.strictObject({
    mode: z.literal("returning"),
    profileId: z.string().min(3).max(40),
    pin: z.string().max(LIMITS.pinMax).optional(),
  }),
]);

export interface AuthRouteHooks {
  /** Called after the Admin password is set on first run (creates the demo campaign when asked). */
  onSetupComplete?: (opts: { createDemo: boolean }) => Promise<void> | void;
  /** Serves the SPA document for a route (used after the local-only checks on /setup). */
  sendSpa: (req: Request, res: Response) => Promise<void> | void;
}

function colorHex(id: string): string {
  return PLAYER_COLORS.find((c) => c.id === id)?.hex ?? PLAYER_COLORS[0].hex;
}

export function authRoutes(app: Express, ctx: ServerContext, hooks: AuthRouteHooks): void {
  // ── first run ──────────────────────────────────────────────────────────────────────────────────────────
  // (Outside /api, so outside its rate limit: these two have their own — by address, as anyone may ask.)
  const limited = (req: Request, res: Response): boolean => {
    if (ctx.limits.rest.take(`ip:${req.gloam.ip}`)) return false;
    res.status(429).type("text").send("Slow down a little.");
    return true;
  };
  app.get(
    "/setup",
    route(async (req, res) => {
      if (limited(req, res)) return;
      if (!req.gloam.local) {
        ctx.security.record("localonly.refused", { ip: req.gloam.ip, detail: { path: "/setup" } });
        res.status(403).type("text").send("The setup page only works on the host PC.");
        return;
      }
      await hooks.sendSpa(req, res);
    }),
  );

  app.get(
    "/api/setup/status",
    route((req, res) => {
      requireLocal(ctx, req);
      const token = typeof req.query.token === "string" ? req.query.token : "";
      ok(res, {
        needed: !ctx.admin.hasPassword(),
        tokenValid: ctx.admin.peekSetup(token),
        minLength: MIN_PASSWORD,
      });
    }),
  );

  app.post(
    "/api/setup/strength",
    route((req, res) => {
      requireLocal(ctx, req);
      const { password } = body(req, z.strictObject({ password: z.string().max(256) }));
      ok(res, { score: passwordStrength(password), long: password.length >= MIN_PASSWORD });
    }),
  );

  app.post(
    "/api/setup",
    route(async (req, res) => {
      requireLocal(ctx, req);
      const b = body(req, SetupBody);
      if (!ctx.admin.consumeSetup(b.token)) {
        throw new GloamError("FORBIDDEN", "This setup link has expired or was already used.");
      }
      await ctx.admin.setPassword(b.password);
      let adminUser = ctx.profiles.admin();
      if (!adminUser)
        adminUser = await ctx.profiles.create({ displayName: "Admin", color: "amber", isAdmin: true });
      const { token, session } = ctx.sessions.create({
        userId: adminUser.id,
        kind: "admin",
        ip: req.gloam.ip,
      });
      issueSessionCookies(ctx, req, res, token, session.id, "admin");
      ctx.security.record("admin.setup", { userId: adminUser.id, ip: req.gloam.ip });
      await hooks.onSetupComplete?.({ createDemo: b.createDemo ?? false });
      ok(res, { next: "/admin" });
    }),
  );

  // ── admin sign-in ──────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/admin/magic",
    route(async (req, res) => {
      if (limited(req, res)) return;
      if (!req.gloam.local) {
        ctx.security.record("localonly.refused", { ip: req.gloam.ip, detail: { path: "/admin/magic" } });
        res.status(403).type("text").send("Admin links only work on the host PC.");
        return;
      }
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const adminUser = ctx.profiles.admin();
      if (!adminUser || !ctx.admin.consumeMagic(token)) {
        ctx.security.record("admin.login.failed", { ip: req.gloam.ip, detail: { via: "magic" } });
        res.redirect(303, "/admin?magic=expired");
        return;
      }
      const { token: sid, session } = ctx.sessions.create({
        userId: adminUser.id,
        kind: "admin",
        ip: req.gloam.ip,
      });
      issueSessionCookies(ctx, req, res, sid, session.id, "admin");
      ctx.security.record("admin.magic", { userId: adminUser.id, ip: req.gloam.ip });
      res.redirect(303, "/admin");
    }),
  );

  app.post(
    "/api/admin/login",
    route(async (req, res) => {
      if (!req.gloam.local && !ctx.settings.get().allowAdminThroughDoorway) requireLocal(ctx, req);
      const wait = ctx.limits.adminLogin.lockedFor(req.gloam.ip);
      if (wait > 0) {
        res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
        return sendError(res, 429, "RATE_LIMITED", "Too many attempts. Try again later.");
      }
      const { password } = body(req, LoginBody);
      const adminUser = ctx.profiles.admin();
      if (!adminUser || !(await ctx.admin.verifyPassword(password))) {
        ctx.limits.adminLogin.fail(req.gloam.ip);
        ctx.security.record("admin.login.failed", { ip: req.gloam.ip });
        throw new GloamError("UNAUTHENTICATED", "That password didn't work.");
      }
      ctx.limits.adminLogin.succeed(req.gloam.ip);
      // A fresh session (and so a fresh token) on every login (SPEC §22.2 rotation).
      const { token, session } = ctx.sessions.create({
        userId: adminUser.id,
        kind: "admin",
        ip: req.gloam.ip,
      });
      issueSessionCookies(ctx, req, res, token, session.id, "admin");
      ctx.security.record("admin.login", { userId: adminUser.id, ip: req.gloam.ip });
      ok(res, { next: "/admin" });
    }),
  );

  app.post(
    "/api/session/logout",
    route((req, res) => {
      const a = req.gloam.auth;
      if (a) {
        ctx.sessions.revoke(a.session.id);
        if (a.session.kind === "admin")
          ctx.security.record("admin.logout", { userId: a.user.id, ip: req.gloam.ip });
      }
      clearCookie(req, res, COOKIE.sid);
      clearCookie(req, res, COOKIE.csrf);
      ok(res);
    }),
  );

  // ── who am I ───────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/me",
    route((req, res) => {
      const a = req.gloam.auth;
      const table = ctx.table;
      const tableInfo = {
        open: table.isOpen,
        campaignId: table.campaignId,
        sessionNo: table.sessionNo,
      };
      if (!a) {
        ok(res, {
          authenticated: false,
          setupNeeded: !ctx.admin.hasPassword(),
          local: req.gloam.local,
          table: tableInfo,
        });
        return;
      }
      // Refresh the CSRF cookie so a client that lost it can recover.
      if (req.gloam.cookies[COOKIE.csrf] !== csrfFor(ctx, a.session.id)) {
        setCookie(req, res, COOKIE.csrf, csrfFor(ctx, a.session.id), { httpOnly: false, sameSite: "strict" });
      }
      const campaignId = table.campaignId ?? ctx.settings.get().selectedCampaignId;
      const role = campaignId ? ctx.campaigns.roleOf(campaignId, a.user) : a.user.isAdmin ? "admin" : null;
      const currentSession =
        a.session.kind === "admin" || (table.isOpen && a.session.tableSessionNo === table.sessionNo);
      ok(res, {
        authenticated: true,
        local: req.gloam.local,
        user: {
          id: a.user.id,
          name: a.user.displayName,
          color: a.user.color,
          isAdmin: a.user.isAdmin,
          hasPin: a.user.pinHash !== null,
          diceSkin: JSON.parse(a.user.diceSkinJson) as unknown,
          prefs: JSON.parse(a.user.prefsJson) as unknown,
        },
        session: {
          kind: a.session.kind,
          status: currentSession ? a.session.status : "expired",
          admittedAs: a.session.admittedAs,
        },
        role,
        campaignId,
        table: tableInfo,
      });
    }),
  );

  // ── join flow (SPEC §8.2) ──────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/join/code",
    route((req, res) => {
      const ip = req.gloam.ip;
      const wait = ctx.limits.joinCode.lockedFor(ip);
      if (wait > 0) {
        ctx.security.record("join.ratelimited", { ip });
        res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
        return sendError(
          res,
          429,
          "RATE_LIMITED",
          "Too many attempts. Please wait a few minutes and try again.",
        );
      }
      const { code } = body(req, CodeBody);
      const invite =
        ctx.table.isOpen && !ctx.table.locked && ctx.table.acceptingKnocks ? ctx.invites.check(code) : null;
      if (!invite) {
        const r = ctx.limits.joinCode.fail(ip);
        ctx.security.record("join.code.failed", { ip, detail: { locked: r.locked } });
        if (r.locked) {
          res.setHeader("Retry-After", String(Math.ceil(r.lockedForMs / 1000)));
          return sendError(
            res,
            429,
            "RATE_LIMITED",
            "Too many attempts. Please wait a few minutes and try again.",
          );
        }
        // Never reveal whether a code existed or expired (SPEC §8.2).
        return sendError(res, 400, "INVALID", "That code didn't open the door");
      }
      ctx.security.record("join.code.ok", { ip });
      setCookie(req, res, COOKIE.join, ctx.secret.sign("join", invite.id, JOIN_TICKET_MS), {
        maxAgeMs: JOIN_TICKET_MS,
      });
      const deviceToken = req.gloam.cookies[COOKIE.dev];
      const known = ctx.profiles.profileForDevice(deviceToken);
      ok(res, {
        device: known ? { id: known.id, name: known.displayName, color: known.color } : null,
        profiles: ctx.profiles.listReturning(),
        colors: PLAYER_COLORS,
      });
    }),
  );

  app.post(
    "/api/join/identity",
    route(async (req, res) => {
      const ip = req.gloam.ip;
      const ticket = req.gloam.cookies[COOKIE.join];
      const inviteId = ticket ? ctx.secret.verify("join", ticket) : null;
      if (!inviteId || !ctx.table.isOpen || !ctx.table.acceptingKnocks || !ctx.invites.isActive(inviteId)) {
        throw new GloamError("FORBIDDEN", "That code didn't open the door");
      }
      const deviceToken = req.gloam.cookies[COOKIE.dev] ?? ctx.profiles.newDeviceToken();
      if (ctx.profiles.deviceBanned(deviceToken)) {
        ctx.security.record("knock.autodeny", { ip, detail: { reason: "device banned" } });
        throw new GloamError("FORBIDDEN", "You can't join this table");
      }
      const b = body(req, IdentityBody);
      let userId: string;
      let identity: "new" | "pin" | "device" | "unverified";
      if (b.mode === "device") {
        const u = ctx.profiles.profileForDevice(req.gloam.cookies[COOKIE.dev]);
        if (!u)
          throw new GloamError("NOT_FOUND", "We don't recognise this browser — choose “I've played before”.");
        userId = u.id;
        identity = "device";
      } else if (b.mode === "new") {
        // (Each new profile is a knock, a PIN to hash and a waiting-room allowance: so many per address.)
        if (!isLoopback(ip) && !ctx.limits.newProfiles.take(ip))
          return sendError(res, 429, "RATE_LIMITED", "Too many new names from here — wait a few minutes.");
        const name = sanitizeDisplayName(b.name);
        if (!validDisplayName(name)) {
          throw new GloamError("INVALID", "Names are 2–24 characters: letters, digits, spaces and - ' _ .");
        }
        if (b.pin !== undefined && b.pin !== "" && !validPin(b.pin))
          throw new GloamError("INVALID", "A PIN is 4–8 digits.");
        const u = await ctx.profiles.create({
          displayName: name,
          color: colorHex(b.color),
          pin: b.pin || null,
        });
        userId = u.id;
        identity = "new";
      } else {
        const u = ctx.profiles.get(b.profileId);
        if (!u || u.isAdmin || u.deletedAt) throw new GloamError("NOT_FOUND", "That profile doesn't exist.");
        if (u.bannedAt) {
          ctx.security.record("knock.autodeny", { userId: u.id, ip, detail: { reason: "profile banned" } });
          throw new GloamError("FORBIDDEN", "You can't join this table");
        }
        if (u.pinHash) {
          const r = await ctx.profiles.verifyPin(u.id, b.pin ?? "");
          if (r === "locked") {
            ctx.security.record("join.pin.locked", { userId: u.id, ip });
            return sendError(
              res,
              429,
              "RATE_LIMITED",
              "Too many wrong PINs — this profile is locked for 15 minutes.",
            );
          }
          if (r !== "ok") {
            ctx.security.record("join.pin.failed", { userId: u.id, ip });
            throw new GloamError("UNAUTHENTICATED", "That PIN didn't match.");
          }
          identity = "pin";
        } else {
          // No PIN: only device recognition or Admin approval with a warning (SPEC §8.2).
          identity =
            ctx.profiles.profileForDevice(req.gloam.cookies[COOKIE.dev])?.id === u.id
              ? "device"
              : "unverified";
        }
        userId = u.id;
      }
      const user = ctx.profiles.get(userId);
      if (!user || user.bannedAt) throw new GloamError("FORBIDDEN", "You can't join this table");
      const label = deviceLabel(req.headers["user-agent"]);
      // (An unverified claim's browser is recorded unconfirmed: recognised as the profile only once it's admitted.)
      const device = ctx.profiles.linkDevice(userId, deviceToken, label, identity !== "unverified");
      if (!req.gloam.cookies[COOKIE.dev]) issueDeviceCookie(req, res, deviceToken);
      // Replace any previous player session in this browser.
      const prev = req.gloam.auth;
      if (prev && prev.session.kind === "player") ctx.sessions.revoke(prev.session.id);
      const { token, session } = ctx.sessions.create({
        userId,
        kind: "player",
        status: "pending",
        tableSessionNo: ctx.table.sessionNo,
        deviceId: device.id,
        identityKind: identity,
        deviceLabel: label,
        ip,
      });
      ctx.invites.consume(inviteId);
      issueSessionCookies(ctx, req, res, token, session.id, "player");
      clearCookie(req, res, COOKIE.join);
      ok(res, {
        next: "/wait",
        user: { id: user.id, name: user.displayName, color: user.color },
        identity,
      });
    }),
  );

  /** After `admitted` arrives in the lobby: rotate gloam_sid (SPEC §22.2) and hand over to the table. */
  app.post(
    "/api/join/enter",
    route((req, res) => {
      const a = requireSession(req);
      if (a.session.kind !== "player" || a.session.status !== "admitted") throw new GloamError("FORBIDDEN");
      if (!ctx.table.isOpen || a.session.tableSessionNo !== ctx.table.sessionNo)
        throw new GloamError("TABLE_CLOSED");
      const token = ctx.sessions.rotate(a.session.id);
      issueSessionCookies(ctx, req, res, token, a.session.id, "player");
      ok(res, { campaignId: ctx.table.campaignId });
    }),
  );

  /** "Leave the lobby": withdraw the knock and forget this browser's pending session. */
  app.post(
    "/api/join/leave",
    route((req, res) => {
      const a = req.gloam.auth;
      if (a && a.session.kind === "player") {
        ctx.sessions.revoke(a.session.id);
        ctx.rooms.lobby?.removeKnock(a.session.id);
        ctx.rooms.lobby?.broadcastToWatchers("knock.resolved", { sessionId: a.session.id, decision: "left" });
      }
      clearCookie(req, res, COOKIE.sid);
      ok(res);
    }),
  );
}
