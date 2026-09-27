/**
 * The roles-and-permissions matrix (SPEC §6) in one module. The server enforces it in every command's
 * `authorize`; the client imports it only to decide which controls to show. The server's answer is final.
 */

export type Role = "admin" | "dm" | "player" | "spectator" | "pending";

export type Capability =
  | "table.see"
  | "table.open" // open/close table, invite codes, doorway
  | "lobby.admit" // admit / deny / kick lobby users (DM: setting "DMs can admit")
  | "admin.manage" // ban/unban, rename profiles, API tokens, campaigns, snapshot restore, settings
  | "role.assign"
  | "scene.edit" // scenes, walls, lights, zones, fog
  | "token.manage" // create/delete any token, set any value, hide/reveal
  | "token.moveOwn"
  | "token.moveAny"
  | "door.use"
  | "light.toggleOwn"
  | "dice.roll"
  | "dice.request"
  | "sheet.editOwn"
  | "sheet.editAny"
  | "cast.own"
  | "hp.applyOthers"
  | "combat.manage"
  | "turn.endOwn"
  | "upload"
  | "upload.approve"
  | "homebrew.create"
  | "homebrew.propose"
  | "audio.control"
  | "social" // emotes, pings, hand raise
  | "undo.own"
  | "history.revert"
  | "actAs"
  | "viewAs";

const DM_LIKE: ReadonlySet<Role> = new Set(["admin", "dm"]);

/** Static matrix: capabilities per role before settings, house rules and per-token overrides. */
const MATRIX: Record<Capability, readonly Role[]> = {
  "table.see": ["admin", "dm", "player", "spectator"],
  "table.open": ["admin"],
  "lobby.admit": ["admin", "dm"],
  "admin.manage": ["admin"],
  "role.assign": ["admin"],
  "scene.edit": ["admin", "dm"],
  "token.manage": ["admin", "dm"],
  "token.moveOwn": ["admin", "dm", "player"],
  "token.moveAny": ["admin", "dm"],
  "door.use": ["admin", "dm", "player"],
  "light.toggleOwn": ["admin", "dm", "player"],
  "dice.roll": ["admin", "dm", "player"],
  "dice.request": ["admin", "dm"],
  "sheet.editOwn": ["admin", "dm", "player"],
  "sheet.editAny": ["admin", "dm"],
  "cast.own": ["admin", "dm", "player"],
  "hp.applyOthers": ["admin", "dm"],
  "combat.manage": ["admin", "dm"],
  "turn.endOwn": ["admin", "dm", "player"],
  upload: ["admin", "dm", "player", "pending"],
  "upload.approve": ["admin", "dm"],
  "homebrew.create": ["admin", "dm"],
  "homebrew.propose": ["player"],
  "audio.control": ["admin", "dm"],
  social: ["admin", "dm", "player", "spectator"],
  "undo.own": ["admin", "dm", "player"],
  "history.revert": ["admin", "dm"],
  actAs: ["admin", "dm"],
  viewAs: ["admin", "dm"],
};

export interface PermissionContext {
  /** Admin setting "DMs can admit" (default on). */
  dmsCanAdmit?: boolean;
  /** House rule "Player-applied damage": direct lets players apply damage to others (DM-grantable). */
  playerDamageDirect?: boolean;
}

export function isDm(role: Role | null | undefined): boolean {
  return role !== null && role !== undefined && DM_LIKE.has(role);
}

export function can(role: Role | null | undefined, cap: Capability, ctx: PermissionContext = {}): boolean {
  if (!role) return false;
  if (cap === "lobby.admit" && role === "dm") return ctx.dmsCanAdmit !== false;
  if (cap === "hp.applyOthers" && role === "player") return ctx.playerDamageDirect === true;
  return MATRIX[cap].includes(role);
}

/** Token control: DMs control everything; players control tokens they own (or the linked actor they own). */
export function controlsToken(
  role: Role | null | undefined,
  userId: string,
  token: { ownerIds: readonly string[] },
): boolean {
  if (isDm(role)) return true;
  if (role !== "player") return false;
  return token.ownerIds.includes(userId);
}
