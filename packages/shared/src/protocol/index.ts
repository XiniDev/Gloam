import { z } from "zod";

/** Rejection codes (SPEC §13.5). Clients map each to a friendly toast. */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_YOUR_TURN",
  "MOVEMENT_LOCKED",
  "SPEED_ZERO",
  "OVER_BUDGET",
  "BLOCKED",
  "INVALID",
  "CONFLICT",
  "NOT_FOUND",
  "LOCKED_SHEET",
  "RATE_LIMITED",
  "TABLE_CLOSED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Rejection {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

/** Friendly defaults for rejection toasts (clients may use the server's message instead). */
export const ERROR_TOAST: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "Your session has ended — please rejoin.",
  FORBIDDEN: "You can't do that here.",
  NOT_YOUR_TURN: "It isn't your turn yet.",
  MOVEMENT_LOCKED: "This token's movement is locked.",
  SPEED_ZERO: "Can't move right now.",
  OVER_BUDGET: "Not enough movement left.",
  BLOCKED: "Something is in the way.",
  INVALID: "That didn't look right.",
  CONFLICT: "Someone else changed this since.",
  NOT_FOUND: "That no longer exists.",
  LOCKED_SHEET: "This sheet is locked — propose the change instead.",
  RATE_LIMITED: "Slow down a little.",
  TABLE_CLOSED: "The table is closed.",
};

export class GloamError extends Error {
  readonly code: ErrorCode;
  readonly detail: unknown;
  constructor(code: ErrorCode, message?: string, detail?: unknown) {
    super(message ?? ERROR_TOAST[code]);
    this.code = code;
    this.detail = detail;
  }
  toRejection(): Rejection {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** Client command id for de-duplication after reconnects (§13.5). */
export const Cid = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,40}$/)
  .optional();

export const Id = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z]{3}_[A-Za-z0-9]{8,32}$/);

export interface RateSpec {
  capacity: number;
  perSecond: number;
}

/** Per-user token bucket per message type (§13.5 rate-limit column). */
export const rate = (perSecond: number, burst = Math.max(1, Math.ceil(perSecond))): RateSpec => ({
  capacity: burst,
  perSecond,
});

// ── lobby / people ───────────────────────────────────────────────────────────────────────────────────────

export const LobbyDecide = z
  .object({
    sessionId: z.string().min(3).max(40),
    decision: z.enum(["admitPlayer", "admitSpectator", "deny", "ban"]),
    reason: z.string().max(200).optional(),
  })
  .strict();
export type LobbyDecide = z.infer<typeof LobbyDecide>;

export const TableKick = z.object({ userId: Id }).strict();
export const AdminBan = z.object({ userId: Id, reason: z.string().max(200).optional() }).strict();
export const AdminUnban = z.object({ userId: Id }).strict();
export const ClockSync = z.object({ t0: z.number().finite() }).strict();
export const HandToggle = z.object({ raised: z.boolean().optional() }).strict();

/** Knock card payload sent to Admin/DMs (`knock` message). */
export interface KnockCard {
  sessionId: string;
  userId: string;
  name: string;
  color: string;
  identity: "new" | "pin" | "device" | "unverified";
  deviceLabel: string;
  knockedAt: number;
  autoAdmitted?: boolean;
}

/** Table lifecycle status shown to the Admin (SPEC §8.1). */
export type TableStatus = "closed" | "opening" | "open" | "closing" | "reconnecting";
export type DoorwayMode = "quick" | "named" | "lan" | "local";

export const MESSAGE_RATES = {
  "lobby.decide": rate(5),
  "table.kick": rate(2),
  "admin.ban": rate(2),
  "admin.unban": rate(2),
  "clock.sync": rate(1, 6),
  "hand.toggle": rate(1),
  "prep.open": rate(2),
  "prep.close": rate(2),
  "scene.list": rate(5),
  "scene.preload": rate(1),
} as const satisfies Record<string, RateSpec>;

export * from "./commands.ts";
