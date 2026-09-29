import type { Client } from "@colyseus/core";
import {
  type EmoteMessage,
  type EmoteSend,
  GloamError,
  type HandoutView,
  type LogEntryView,
  MAX_PHRASES,
  QUICK_PHRASES,
} from "@gloam/shared/protocol";
import { can } from "@gloam/shared/rules";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.ts";
import type { HandoutEntity } from "../engine/codecs.ts";
import type { CommitInfo } from "../engine/commandBus.ts";
import { readSheet } from "../engine/commands/actor.ts";
import { handoutView, holds } from "../engine/commands/handout.ts";
import type { CampaignModel } from "../engine/model.ts";
import type { ClientAuth } from "./dispatch.ts";
import { roomCtx } from "./roomContext.ts";

export interface FunHost {
  campaignId: string;
  model(): CampaignModel;
  clients(): Iterable<Client>;
  /** Whether a client's view holds a token (DMs hold every one). */
  perceives(client: Client, tokenId: string): boolean;
}

const isDmRole = (role: string) => role === "dm" || role === "admin";

/**
 * The table's flavour on the server (SPEC §8.18): emotes and phrases (each client told of the sender's token only
 * when it sees it — otherwise the emote pops over their portrait), players' own phrases, the campaign log (its
 * automatic entries, manual ones, who may read which) and each person's handouts.
 */
export class FunFlow {
  private readonly host: FunHost;
  /** Character levels as last seen: a change is a level-up for the log. */
  private levels = new Map<string, number>();

  constructor(host: FunHost) {
    this.host = host;
    for (const a of host.model().all("actor")) this.levels.set(a.id, levelOf(a));
  }

  // ── Emotes ────────────────────────────────────────────────────────────────────────────────────────────

  /** A person's own phrases (kept on their profile, so they follow them from device to device). */
  phrasesOf(userId: string): string[] {
    const row = roomCtx().db.select({ prefs: users.prefsJson }).from(users).where(eq(users.id, userId)).get();
    const prefs = parsePrefs(row?.prefs) as { phrases?: unknown };
    return Array.isArray(prefs.phrases)
      ? prefs.phrases.filter((p): p is string => typeof p === "string")
      : [];
  }

  setPhrases(userId: string, phrases: string[]): string[] {
    const ctx = roomCtx();
    const row = ctx.db.select({ prefs: users.prefsJson }).from(users).where(eq(users.id, userId)).get();
    const kept = phrases.slice(0, MAX_PHRASES);
    ctx.db
      .update(users)
      .set({ prefsJson: JSON.stringify({ ...parsePrefs(row?.prefs), phrases: kept }) })
      .where(eq(users.id, userId))
      .run();
    return kept;
  }

  /** The sender's token on the active scene: their character's, else one they own. */
  private tokenOf(userId: string): string | undefined {
    const model = this.host.model();
    const scene = model.campaign.activeSceneId;
    const mine = model.all("token").filter((t) => t.sceneId === scene && t.ownerIds.includes(userId));
    const actor = model.all("actor").find((a) => a.ownerUserId === userId && a.kind === "character");
    return (mine.find((t) => actor && t.actorId === actor.id) ?? mine[0])?.id;
  }

  emote(auth: ClientAuth, p: EmoteSend): void {
    if (!can(auth.role, "social")) throw new GloamError("FORBIDDEN");
    if (p.phrase !== undefined) {
      const known =
        (QUICK_PHRASES as readonly string[]).includes(p.phrase) ||
        this.phrasesOf(auth.userId).includes(p.phrase);
      if (!known) throw new GloamError("INVALID", "Save it as one of your phrases first.");
    }
    const tokenId = this.tokenOf(auth.userId);
    const base: EmoteMessage = {
      userId: auth.userId,
      name: auth.name,
      color: auth.color,
      ...(p.emote ? { emote: p.emote } : { phrase: p.phrase as string }),
      at: Date.now(),
    };
    for (const c of this.host.clients())
      c.send("emote", tokenId && this.host.perceives(c, tokenId) ? { ...base, tokenId } : base);
  }

  // ── The campaign log ──────────────────────────────────────────────────────────────────────────────────

  /** Whether a person may read an entry: everyone's, or one given to them; DMs read them all. */
  private readable(visibility: string, userId: string, dm: boolean): boolean {
    if (dm || visibility === "everyone") return true;
    return visibility.startsWith("only:") && visibility.slice(5).split(",").includes(userId);
  }

  private view(e: {
    id: string;
    sessionNo: number;
    kind: string;
    text: string;
    userId: string | null;
    createdAt: number;
    data?: Record<string, unknown>;
  }): LogEntryView {
    const author = typeof e.data?.author === "string" ? e.data.author : undefined;
    return {
      id: e.id,
      sessionNo: e.sessionNo,
      kind: e.kind,
      text: e.text,
      userId: e.userId,
      ...(author ? { author } : {}),
      createdAt: e.createdAt,
    };
  }

  list(auth: ClientAuth, sinceSession: number | undefined, limit: number): LogEntryView[] {
    const dm = isDmRole(auth.role);
    return roomCtx()
      .campaigns.log(this.host.campaignId, {
        ...(sinceSession !== undefined ? { sinceSession } : {}),
        limit: 5000,
      })
      .filter((e) => this.readable(e.visibility, auth.userId, dm))
      .slice(-limit)
      .map((e) => this.view(e));
  }

  /** An entry for the log, and to everyone who may read it as it's written. */
  append(
    kind: string,
    text: string,
    opts: { visibility?: string; userId?: string | null; data?: Record<string, unknown> } = {},
  ): void {
    const e = roomCtx().campaigns.appendLog(this.host.campaignId, {
      kind,
      text,
      visibility: opts.visibility ?? "everyone",
      userId: opts.userId ?? null,
      ...(opts.data ? { data: opts.data } : {}),
    });
    const view = this.view(e);
    for (const c of this.host.clients()) {
      const a = c.auth as ClientAuth | undefined;
      if (a && this.readable(e.visibility, a.userId, isDmRole(a.role))) c.send("log.entry", view);
    }
  }

  /** A manual entry: the DM's or a player's (a recap, a note to the party). */
  add(auth: ClientAuth, text: string): LogEntryView {
    if (auth.role === "spectator") throw new GloamError("FORBIDDEN");
    this.append("manual", text, { userId: auth.userId, data: { author: auth.name } });
    const last = this.list(auth, undefined, 1)[0];
    if (!last) throw new GloamError("INVALID");
    return last;
  }

  /**
   * The log's automatic entries from what the table does (SPEC §8.18): the party moving to another scene, a creature
   * dying, becoming stable or back on its feet, a character's level changing. (Session open/close, combat summaries
   * and handouts write their own.) Undoing and redoing write nothing: the log says what happened.
   */
  committed(info: CommitInfo): void {
    if (/^history\./.test(info.type)) {
      for (const a of this.host.model().all("actor")) this.levels.set(a.id, levelOf(a));
      return;
    }
    const model = this.host.model();
    for (const op of info.ops) {
      if (op.k === "set" && op.e === "campaign" && op.path[0] === "activeSceneId" && op.value) {
        const scene = model.get("scene", op.value as string);
        if (scene) this.append("scene", `The table moved to ${scene.name}.`, { data: { sceneId: scene.id } });
      }
      if (
        op.k === "set" &&
        (op.e === "token" || op.e === "actor") &&
        op.path.length === 1 &&
        op.path[0] === "status"
      ) {
        const before = (op.prev as { deathSaves?: { dead?: boolean; stable?: boolean } } | null)?.deathSaves;
        const after = (op.value as { deathSaves?: { dead?: boolean; stable?: boolean } } | null)?.deathSaves;
        const name = nameOf(model, op.e, op.id);
        if (!name) continue;
        if (after?.dead && !before?.dead) this.append("death", `${name} died.`, { data: { [op.e]: op.id } });
        else if (after?.stable && !before?.stable)
          this.append("stable", `${name} is stable.`, { data: { [op.e]: op.id } });
      }
      if (op.k === "sheet" || (op.k === "create" && op.e === "actor")) {
        const id = op.k === "sheet" ? op.actorId : op.id;
        const a = model.get("actor", id);
        if (!a || a.kind !== "character") continue;
        const now = levelOf(a);
        const was = this.levels.get(id);
        this.levels.set(id, now);
        if (was !== undefined && now > was)
          this.append("level", `${readSheet(a).core.name} reached level ${now}.`, { data: { actorId: id } });
      }
    }
  }

  // ── Handouts ──────────────────────────────────────────────────────────────────────────────────────────

  /** A DM's every handout and note; a player's own (those shown to them, and notes for them). */
  handouts(auth: ClientAuth): HandoutView[] {
    const dm = isDmRole(auth.role);
    return this.host
      .model()
      .all("handout")
      .filter((h: HandoutEntity) => dm || holds(h, auth.userId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((h) => handoutView(h, dm));
  }
}

/** A profile's preferences (stored as JSON text). */
function parsePrefs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  try {
    const o = JSON.parse(String(v ?? "{}")) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function levelOf(a: Parameters<typeof readSheet>[0]): number {
  try {
    return readSheet(a).core.classes.reduce((n, c) => n + c.level, 0);
  } catch {
    return 0;
  }
}

function nameOf(model: CampaignModel, kind: "token" | "actor", id: string): string | null {
  if (kind === "token") return model.get("token", id)?.name ?? null;
  const a = model.get("actor", id);
  return a ? readSheet(a).core.name : null;
}
