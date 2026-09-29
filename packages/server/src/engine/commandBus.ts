import { LIMITS } from "@gloam/shared";
import { GloamError } from "@gloam/shared/protocol";
import { applyPatch, controlsToken, lockedChanges } from "@gloam/shared/rules";
import type { TokenEntity } from "@gloam/shared/schemas";
import type { Raster } from "@gloam/shared/vision";
import { and, desc, eq, gt, isNull, like, lt, ne } from "drizzle-orm";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import { history } from "../db/schema.ts";
import type { Role } from "../services/campaigns.ts";
import { CODECS, type EntityMap } from "./codecs.ts";
import type { CampaignModel } from "./model.ts";
import {
  clone,
  type EntityKind,
  getPath,
  inverse,
  jsonEqual,
  keysOverlap,
  type Op,
  setPath,
  touchedKeys,
} from "./ops.ts";

export interface CommandActor {
  userId: string;
  role: Role;
  name: string;
  /** "Act as": the character the DM is controlling (AC-DMP-03). */
  actingAs?: { actorId: string; name: string } | null;
  /**
   * Whether this person can see a token now (their view, §13.4) — for commands a player may aim at others' tokens
   * (damage, healing): a token they can't see is as good as not there. Absent: the server itself, or a test.
   */
  sees?: (tokenId: string) => boolean;
}

export interface CommandCtx {
  actor: CommandActor;
  model: CampaignModel;
  app: ServerContext;
  now: number;
  /** Fog layers (painted reveals, explored memory), when the room has a vision service. */
  fog?: FogApplier;
}

export interface Plan<R = unknown> {
  ops: Op[];
  summary: string;
  sceneId?: string | null;
  result?: R;
  /** Post-commit effects (vision invalidation is automatic; these are messages, sounds, log entries). */
  after?: ((info: CommitInfo) => void)[];
  /** Messages for the room to deliver after the commit (even when nothing changed, e.g. a move that bumped). */
  events?: RoomEvent[];
  /** Overrides the definition's undoable flag for this plan (e.g. a no-op). */
  undoable?: boolean;
}

export interface CommandDef<P = unknown, R = unknown> {
  type: string;
  schema: z.ZodType<P>;
  undoable: boolean;
  /** Executed only by the server itself (e.g. the upload route); never exposed as a room message. */
  internal?: boolean;
  authorize(ctx: CommandCtx, p: P): void;
  plan(ctx: CommandCtx, p: P): Plan<R>;
}

export interface HistoryEntry {
  id: number;
  userId: string;
  actingAs: string | null;
  type: string;
  ops: Op[];
  inverse: Op[];
  summary: string;
  undoable: boolean;
  sceneId: string | null;
  createdAt: number;
  undoneAt: number | null;
  undoneBy: string | null;
}

export interface CommitInfo {
  entry: HistoryEntry | null;
  ops: Op[];
  actor: CommandActor;
  type: string;
}

/**
 * A message a command asks the room to deliver: to everyone who can see a token (after the commit's view
 * changes), to particular users (all their tabs), or to the DMs.
 */
export interface RoomEvent {
  name: string;
  payload: unknown;
  to: { viewersOf: string; except?: string } | { users: string[] } | { dms: true } | { all: true };
}

/** Applies one op to a working set of entities (clones), returning which entities changed. */
type Working = Map<string, { kind: EntityKind; id: string; value: unknown | null }>;

export interface FogApplier {
  /** Stages a fog op's cells on a copy of the layer (inside the commit's transaction). */
  apply(op: Extract<Op, { k: "fog" }>): void;
  /** Writes the staged layer's row (same transaction). */
  persist(sceneId: string, layer: string): void;
  /** The transaction committed: the staged layers become the live ones. */
  commit(): void;
  /** The transaction failed: the staged layers are dropped. */
  discard(): void;
  /** The layer as it is now (commands read it to plan a fog op's before/after). */
  layer(sceneId: string, layer: string): Raster;
  /** The scene's fog raster shape (null for no such scene). */
  shape(sceneId: string): Raster | null;
  /** The layers a scene has with a prefix ("reveal:", "explored:"), stored or in memory. */
  layerNames(sceneId: string, prefix: string): string[];
}

export interface SheetApplier {
  apply(sheet: Record<string, unknown>, patch: Extract<Op, { k: "sheet" }>["patch"]): Record<string, unknown>;
}

export interface BusHooks {
  /** Called after commit with the ops, before post-commit effects: sync Colyseus state, invalidate vision. */
  onCommitted(info: CommitInfo): void;
  /** Delivers a command's events (after onCommitted, so views already reflect the change). */
  onEvents?(events: RoomEvent[], info: CommitInfo): void;
  fog?: FogApplier;
  sheet?: SheetApplier;
  /** An entry was undone (Ctrl+Z, a revert, a forced undo): what it left pending can be let go (a DM prompt). */
  onUndone?(entry: HistoryEntry, actor: CommandActor): void;
}

interface UndoStep {
  ids: number[];
  group: string | null;
}

/**
 * The command bus (SPEC §14.1): parse → authorize → plan (pure) → ONE SQLite transaction (rows + history) →
 * apply to the in-memory model → sync state and post-commit effects → respond. better-sqlite3 is synchronous,
 * so steps 4–5 cannot interleave with other commands.
 */
export class CommandBus {
  private readonly app: ServerContext;
  readonly model: CampaignModel;
  private readonly hooks: BusHooks;
  private readonly defs = new Map<string, CommandDef<unknown, unknown>>();
  /**
   * Per-user undo/redo stacks. Each step is one or more history entries: consecutive commands sent with the same
   * `undoGroup` (e.g. Generate walls in 500-wall batches) undo and redo as one step.
   */
  private readonly undoStacks = new Map<string, UndoStep[]>();
  private readonly redoStacks = new Map<string, UndoStep[]>();
  private readonly recentCids = new Map<string, { result: unknown; at: number }>();
  /** Test/diagnostic hook: called inside post-commit, after the transaction (AC-PER-01). */
  postCommitProbe: ((info: CommitInfo) => void) | null = null;
  /** Durations of recent executions (ms), for the benchmark (AC-PERF-03). */
  readonly timings: number[] = [];

  constructor(app: ServerContext, model: CampaignModel, hooks: BusHooks) {
    this.app = app;
    this.model = model;
    this.hooks = hooks;
  }

  register<P, R>(def: CommandDef<P, R>): void {
    this.defs.set(def.type, def as CommandDef<unknown, unknown>);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  execute<R = unknown>(
    type: string,
    raw: unknown,
    actor: CommandActor,
    opts: {
      cid?: string;
      undoGroup?: string;
      /** A follow-up of that entry (concentration's cleanup): undone and redone with it, one step for its user. */
      joinEntry?: number;
    } = {},
  ): R {
    const t0 = performance.now();
    if (opts.cid) {
      const prev = this.recentCids.get(`${actor.userId}:${opts.cid}`);
      if (prev) return prev.result as R;
    }
    const def = this.defs.get(type);
    if (!def) throw new GloamError("INVALID", `Unknown command ${type}.`);
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new GloamError(
        "INVALID",
        i ? `${i.path.join(".") || "payload"}: ${i.message}` : "Invalid command.",
      );
    }
    const ctx: CommandCtx = { actor, model: this.model, app: this.app, now: Date.now(), fog: this.hooks.fog };
    def.authorize(ctx, parsed.data);
    const plan = def.plan(ctx, parsed.data);
    const undoable = plan.undoable ?? def.undoable;
    const entry =
      plan.ops.length > 0
        ? this.commit(type, plan.ops, plan.summary, undoable, actor, plan.sceneId ?? this.sceneOf(plan.ops))
        : null;
    if (entry && undoable) this.pushUndo(actor.userId, entry.id, opts.undoGroup ?? null, opts.joinEntry);
    const info: CommitInfo = { entry, ops: plan.ops, actor, type };
    if (plan.ops.length > 0) {
      this.hooks.onCommitted(info);
      this.postCommitProbe?.(info);
    }
    if (plan.events?.length) {
      try {
        this.hooks.onEvents?.(plan.events, info);
      } catch (err) {
        this.app.log.error({ err, type }, "post-commit events failed");
      }
    }
    for (const fn of plan.after ?? []) {
      try {
        fn(info);
      } catch (err) {
        this.app.log.error({ err, type }, "post-commit effect failed");
      }
    }
    const result = plan.result as R;
    if (opts.cid) {
      this.recentCids.set(`${actor.userId}:${opts.cid}`, { result, at: Date.now() });
      if (this.recentCids.size > 2000) {
        const cutoff = Date.now() - 5 * 60_000;
        for (const [k, v] of this.recentCids) if (v.at < cutoff) this.recentCids.delete(k);
      }
    }
    this.timings.push(performance.now() - t0);
    if (this.timings.length > 5000) this.timings.splice(0, this.timings.length - 5000);
    return result;
  }

  /** Steps 4–5: one transaction for rows + history, then the in-memory model. Returns the history entry. */
  commit(
    type: string,
    ops: Op[],
    summary: string,
    undoable: boolean,
    actor: CommandActor,
    sceneId: string | null,
  ): HistoryEntry {
    const working: Working = new Map();
    const read = (kind: EntityKind, id: string): unknown | null => {
      const key = `${kind}:${id}`;
      const w = working.get(key);
      if (w) return w.value;
      const cur = this.model.get(kind, id);
      return cur === undefined ? null : cur;
    };
    const touchedActors = new Set<string>();
    for (const op of ops) {
      if (op.k === "set") {
        const cur = read(op.e, op.id);
        if (cur === null) throw new GloamError("NOT_FOUND", `${op.e} ${op.id} no longer exists.`);
        working.set(`${op.e}:${op.id}`, { kind: op.e, id: op.id, value: setPath(cur, op.path, op.value) });
      } else if (op.k === "create") {
        working.set(`${op.e}:${op.id}`, { kind: op.e, id: op.id, value: clone(op.value) });
      } else if (op.k === "delete") {
        working.set(`${op.e}:${op.id}`, { kind: op.e, id: op.id, value: null });
      } else if (op.k === "sheet") {
        const cur = read("actor", op.actorId) as EntityMap["actor"] | null;
        if (!cur) throw new GloamError("NOT_FOUND", "That character no longer exists.");
        if (!this.hooks.sheet) throw new Error("no sheet applier");
        const sheet = this.hooks.sheet.apply(clone(cur.sheet), op.patch);
        working.set(`actor:${op.actorId}`, { kind: "actor", id: op.actorId, value: { ...cur, sheet } });
        touchedActors.add(op.actorId);
      }
    }
    const now = Date.now();
    let entry: HistoryEntry | null = null;
    const tx = this.app.sqlite.transaction(() => {
      for (const w of working.values()) {
        const codec = CODECS[w.kind];
        if (w.value === null) {
          this.app.db
            .delete(codec.table)
            .where(eq((codec.table as unknown as { id: never }).id, w.id as never))
            .run();
        } else {
          const toRow = codec.toRow as (e: unknown) => Record<string, unknown>;
          const row = toRow(w.value);
          const before = this.model.get(w.kind, w.id);
          const idCol = (codec.table as unknown as { id: never }).id;
          // A change writes only the columns it changed: a column written outside the bus meanwhile (the campaign's
          // session counter, bumped when the table opens) must not be put back to the model's older copy of it —
          // after a crash the next session took the same number again.
          const changed: Record<string, unknown> = {};
          if (before !== undefined) {
            const old = toRow(before);
            for (const [k, v] of Object.entries(row))
              if (k !== "id" && !sameColumn(v, old[k])) changed[k] = v;
          }
          const wrote =
            before !== undefined && Object.keys(changed).length
              ? this.app.db
                  .update(codec.table)
                  .set(changed as never)
                  .where(eq(idCol, w.id as never))
                  .run().changes
              : before !== undefined
                ? 1
                : 0;
          if (wrote === 0) {
            const { id: _id, ...rest } = row;
            this.app.db
              .insert(codec.table)
              .values(row as never)
              .onConflictDoUpdate({ target: idCol, set: rest as never })
              .run();
          }
        }
      }
      for (const op of ops) if (op.k === "fog") this.hooks.fog?.apply(op);
      for (const op of ops) if (op.k === "fog") this.hooks.fog?.persist(op.sceneId, op.layer);
      const inv = inverse(ops);
      const res = this.app.db
        .insert(history)
        .values({
          campaignId: this.model.campaign.id,
          sceneId,
          userId: actor.userId,
          actingAs: actor.actingAs?.name ?? null,
          type,
          opsJson: JSON.stringify(ops),
          inverseJson: JSON.stringify(inv),
          summary: actor.actingAs ? `${actor.name} as ${actor.actingAs.name}: ${summary}` : summary,
          undoable,
          createdAt: now,
          tableSessionNo: this.app.table.sessionNo,
        })
        .run();
      entry = {
        id: Number(res.lastInsertRowid),
        userId: actor.userId,
        actingAs: actor.actingAs?.name ?? null,
        type,
        ops,
        inverse: inv,
        summary,
        undoable,
        sceneId,
        createdAt: now,
        undoneAt: null,
        undoneBy: null,
      };
    });
    try {
      tx();
    } catch (e) {
      this.hooks.fog?.discard();
      throw e;
    }
    this.hooks.fog?.commit();
    for (const w of working.values()) {
      if (w.value === null) this.model.remove(w.kind, w.id);
      else this.model.put(w.kind, w.value as never);
    }
    this.model.version++;
    return entry as unknown as HistoryEntry;
  }

  // ── undo / redo / revert (SPEC §14.4) ─────────────────────────────────────────────────────────────────

  private pushUndo(userId: string, id: number, group: string | null, join?: number): void {
    const s = this.undoStacks.get(userId) ?? [];
    const top = s[s.length - 1];
    if (join !== undefined && top?.ids.includes(join)) top.ids.push(id);
    else if (group && top?.group === group) top.ids.push(id);
    else s.push({ ids: [id], group });
    if (s.length > LIMITS.undoStack) s.shift();
    this.undoStacks.set(userId, s);
    this.redoStacks.set(userId, []);
  }

  entry(id: number): HistoryEntry | null {
    const r = this.app.db.select().from(history).where(eq(history.id, id)).get();
    if (!r || r.campaignId !== this.model.campaign.id) return null;
    return {
      id: r.id,
      userId: r.userId,
      actingAs: r.actingAs,
      type: r.type,
      ops: JSON.parse(r.opsJson) as Op[],
      inverse: JSON.parse(r.inverseJson) as Op[],
      summary: r.summary,
      undoable: r.undoable,
      sceneId: r.sceneId,
      createdAt: r.createdAt,
      undoneAt: r.undoneAt,
      undoneBy: r.undoneBy,
    };
  }

  /** Later, not-undone entries by anyone that touch keys overlapping `e`'s (SPEC §14.4). */
  conflicts(e: HistoryEntry): HistoryEntry[] {
    const keys = touchedKeys(e.ops);
    const later = this.app.db
      .select()
      .from(history)
      .where(
        and(eq(history.campaignId, this.model.campaign.id), gt(history.id, e.id), isNull(history.undoneAt)),
      )
      .all();
    const out: HistoryEntry[] = [];
    for (const r of later) {
      const ops = JSON.parse(r.opsJson) as Op[];
      const k2 = touchedKeys(ops);
      if (keys.some((a) => k2.some((b) => keysOverlap(a, b)))) {
        const full = this.entry(r.id);
        if (full) out.push(full);
      }
    }
    return out;
  }

  /**
   * The scene a command's changes are on, when its plan doesn't say (HP applied, a condition): the first scene-bound
   * thing its ops touch — a token, wall, light, zone or effect, or a fog layer — so the History panel's Scene filter
   * finds it. Null for campaign-wide changes (a sheet, the house rules).
   */
  private sceneOf(ops: readonly Op[]): string | null {
    for (const o of ops) {
      if (o.k === "fog") return o.sceneId;
      if (o.k === "sheet") continue;
      const ent = o.k === "create" ? o.value : o.k === "delete" ? o.prev : this.model.get(o.e as never, o.id);
      const sid = (ent as { sceneId?: unknown } | null | undefined)?.sceneId;
      if (typeof sid === "string") return sid;
    }
    return null;
  }

  private who(userId: string): string {
    return this.app.profiles.get(userId)?.displayName ?? "someone";
  }

  /** Ops that force `target` values onto the current model (last writer wins), with correct `prev`s. */
  private forcedOps(target: Op[]): Op[] {
    const out: Op[] = [];
    for (const op of target) {
      if (op.k === "set") {
        const cur = this.model.get(op.e, op.id);
        if (cur === undefined) continue;
        out.push({ ...op, prev: clone(getPath(cur, op.path)) });
      } else if (op.k === "create") {
        const cur = this.model.get(op.e, op.id);
        if (cur === undefined) out.push(op);
        else out.push({ k: "set", e: op.e, id: op.id, path: [], value: op.value, prev: clone(cur) });
      } else if (op.k === "delete") {
        const cur = this.model.get(op.e, op.id);
        if (cur !== undefined) out.push({ ...op, prev: clone(cur) });
      } else {
        out.push(op);
      }
    }
    return out;
  }

  /**
   * Undo and redo re-apply stored ops rather than run a command, so no command's permission check runs again: for a
   * player, every token the ops touch must still be theirs to change — theirs, and not locked by the DM since — and
   * every light must be carried by such a token; every character sheet must still be theirs, and a sheet change must
   * pass the sheet's lock as it is now; every template must be theirs (SPEC §8.14, §8.10: a DM's lock can't be undone
   * around).
   */
  private authorizeReplay(actor: CommandActor, ops: readonly Op[]): void {
    if (actor.role === "admin" || actor.role === "dm") return;
    const check = (t: TokenEntity | undefined) => {
      if (!t || !controlsToken(actor.role, actor.userId, t))
        throw new GloamError("FORBIDDEN", "That isn't yours to change.");
      if (t.locked) throw new GloamError("FORBIDDEN", "The DM locked this token.");
    };
    const ownActor = (a: EntityMap["actor"] | undefined): EntityMap["actor"] => {
      if (!a || a.ownerUserId !== actor.userId || actor.role !== "player")
        throw new GloamError("FORBIDDEN", "That isn't your sheet.");
      return a;
    };
    for (const op of ops) {
      if (op.k === "fog") continue;
      if (op.k === "sheet") {
        const a = ownActor(this.model.get("actor", op.actorId));
        if (a.lockLevel === "unlocked") continue;
        let after: unknown;
        try {
          after = applyPatch(a.sheet, op.patch);
        } catch {
          throw new GloamError("CONFLICT", "That sheet has changed since.");
        }
        if (lockedChanges(a.lockLevel, a.sheet, after, false).length)
          throw new GloamError("LOCKED_SHEET", "The DM has locked that part of the sheet since.");
        continue;
      }
      if (op.e === "actor") {
        const a = ownActor(
          this.model.get("actor", op.id) ??
            ((op.k === "delete" ? op.prev : undefined) as EntityMap["actor"] | undefined),
        );
        // Status (conditions, exhaustion, death saves, concentration) is play-state: changeable unless fully locked.
        if (op.k === "set" && op.path[0] === "status" && a.lockLevel === "full")
          throw new GloamError("LOCKED_SHEET", "The DM has locked that sheet since.");
        continue;
      }
      if (op.e === "template") {
        const tpl =
          this.model.get("template", op.id) ??
          ((op.k === "delete" ? op.prev : undefined) as EntityMap["template"] | undefined);
        if (!tpl || tpl.createdBy !== actor.userId)
          throw new GloamError("FORBIDDEN", "That template isn't yours.");
        continue;
      }
      if (op.e === "token")
        check(
          this.model.get("token", op.id) ??
            ((op.k === "delete" ? op.prev : undefined) as TokenEntity | undefined),
        );
      else if (op.e === "light") {
        const l =
          this.model.get("light", op.id) ??
          (op.k === "delete" ? (op.prev as { tokenId?: string | null }) : undefined);
        const carrier = l?.tokenId ? this.model.get("token", l.tokenId) : undefined;
        check(carrier);
      }
    }
  }

  private markUndone(id: number, by: string): void {
    this.app.db.update(history).set({ undoneAt: Date.now(), undoneBy: by }).where(eq(history.id, id)).run();
  }

  undoEntry(
    e: HistoryEntry,
    actor: CommandActor,
    opts: { force?: boolean; ignore?: ReadonlySet<number> } = {},
  ): HistoryEntry {
    if (!e.undoable) throw new GloamError("INVALID", "That can't be undone.");
    if (e.undoneAt !== null) throw new GloamError("CONFLICT", "That was already undone.");
    this.authorizeReplay(actor, e.inverse);
    const isDm = actor.role === "admin" || actor.role === "dm";
    const conflicts = this.conflicts(e).filter((c) => !opts.ignore?.has(c.id));
    let ops: Op[];
    let summary = `Undo: ${e.summary}`;
    if (conflicts.length > 0) {
      const c = conflicts[conflicts.length - 1] as HistoryEntry;
      const msg = `Can't undo: ${this.who(c.userId)} changed this since (${c.summary}).`;
      if (!isDm || !opts.force) throw new GloamError("CONFLICT", msg, { canForce: isDm });
      ops = this.forcedOps(e.inverse);
      summary = `Forced undo of ${e.summary}`;
    } else {
      ops = this.forcedOps(e.inverse);
    }
    const next = this.commit("history.undo", ops, summary, true, actor, e.sceneId);
    this.markUndone(e.id, actor.userId);
    this.hooks.onCommitted({ entry: next, ops, actor, type: "history.undo" });
    try {
      this.hooks.onUndone?.(e, actor);
    } catch (err) {
      this.app.log.error({ err }, "after-undo hook failed");
    }
    this.markUndone(next.id, "system");
    return next;
  }

  /**
   * Ctrl/Cmd+Z: the user's own most recent undoable step (SPEC §8.14). A grouped step is checked as a whole before
   * anything changes (entries of the same step don't conflict with each other), then undone newest first.
   */
  undo(actor: CommandActor, opts: { force?: boolean } = {}): HistoryEntry {
    const stack = this.undoStacks.get(actor.userId) ?? [];
    for (;;) {
      const step = stack[stack.length - 1];
      if (!step) throw new GloamError("NOT_FOUND", "Nothing to undo.");
      const entries = step.ids
        .map((id) => this.entry(id))
        .filter((e): e is HistoryEntry => e !== null && e.undoneAt === null);
      if (!entries.length) {
        stack.pop();
        continue;
      }
      const ids = new Set(entries.map((e) => e.id));
      const isDm = actor.role === "admin" || actor.role === "dm";
      // The whole step, before any of it changes.
      for (const e of entries) this.authorizeReplay(actor, e.inverse);
      if (!(isDm && opts.force)) {
        for (const e of entries) {
          const c = this.conflicts(e).filter((x) => !ids.has(x.id));
          if (c.length) {
            const last = c[c.length - 1] as HistoryEntry;
            throw new GloamError(
              "CONFLICT",
              `Can't undo: ${this.who(last.userId)} changed this since (${last.summary}).`,
              { canForce: isDm },
            );
          }
        }
      }
      let last: HistoryEntry | null = null;
      for (const e of [...entries].reverse())
        last = this.undoEntry(e, actor, { force: opts.force, ignore: ids });
      stack.pop();
      const r = this.redoStacks.get(actor.userId) ?? [];
      r.push({ ids: entries.map((e) => e.id), group: step.group });
      this.redoStacks.set(actor.userId, r);
      return last as HistoryEntry;
    }
  }

  /** Ctrl/Cmd+Shift+Z / Ctrl+Y: re-apply a step after checking that its keys still hold the undo's values. */
  redo(actor: CommandActor): HistoryEntry {
    const stack = this.redoStacks.get(actor.userId) ?? [];
    const step = stack[stack.length - 1];
    if (!step) throw new GloamError("NOT_FOUND", "Nothing to redo.");
    const entries = step.ids.map((id) => this.entry(id));
    if (entries.some((e) => !e)) {
      stack.pop();
      throw new GloamError("NOT_FOUND", "Nothing to redo.");
    }
    for (const e of entries as HistoryEntry[]) {
      for (const op of e.ops) {
        if (op.k === "set") {
          const cur = this.model.get(op.e, op.id);
          if (cur === undefined || !jsonEqual(getPath(cur, op.path), op.prev)) {
            throw new GloamError("CONFLICT", "Can't redo: this changed since the undo.");
          }
        }
      }
    }
    for (const e of entries as HistoryEntry[]) this.authorizeReplay(actor, e.ops);
    const redone: number[] = [];
    let next: HistoryEntry | null = null;
    for (const e of entries as HistoryEntry[]) {
      const ops = this.forcedOps(e.ops);
      next = this.commit(e.type, ops, e.summary, true, actor, e.sceneId);
      redone.push(next.id);
      this.hooks.onCommitted({ entry: next, ops, actor, type: "history.redo" });
    }
    stack.pop();
    const u = this.undoStacks.get(actor.userId) ?? [];
    u.push({ ids: redone, group: step.group });
    this.undoStacks.set(actor.userId, u);
    return next as HistoryEntry;
  }

  /**
   * The History panel's list (SPEC §8.14): this campaign's entries, newest first, before `before`, filtered by person,
   * command family ("token" for token.*) and scene; `limit + 1` read to know there's more.
   */
  list(q: { userId?: string; family?: string; sceneId?: string; before?: number; limit: number }): {
    rows: HistoryEntry[];
    more: boolean;
  } {
    // (An undo's own record isn't listed: the entry it undid shows struck through, "undone by …".)
    const where = [eq(history.campaignId, this.model.campaign.id), ne(history.type, "history.undo")];
    if (q.userId) where.push(eq(history.userId, q.userId));
    if (q.family) where.push(like(history.type, `${q.family}.%`));
    if (q.sceneId) where.push(eq(history.sceneId, q.sceneId));
    if (q.before) where.push(lt(history.id, q.before));
    const rows = this.app.db
      .select({ id: history.id })
      .from(history)
      .where(and(...where))
      .orderBy(desc(history.id))
      .limit(q.limit + 1)
      .all();
    const out = rows.slice(0, q.limit).flatMap((r) => this.entry(r.id) ?? []);
    return { rows: out, more: rows.length > q.limit };
  }

  /** Who appears in this campaign's history (the Person filter). */
  people(): string[] {
    return this.app.db
      .selectDistinct({ userId: history.userId })
      .from(history)
      .where(eq(history.campaignId, this.model.campaign.id))
      .all()
      .map((r) => r.userId);
  }

  /** The entries a Restore to here would revert: every later undoable one not undone, newest first. */
  laterThan(id: number): HistoryEntry[] {
    return this.app.db
      .select({ id: history.id })
      .from(history)
      .where(
        and(
          eq(history.campaignId, this.model.campaign.id),
          gt(history.id, id),
          isNull(history.undoneAt),
          eq(history.undoable, true),
        ),
      )
      .orderBy(desc(history.id))
      .all()
      .flatMap((r) => this.entry(r.id) ?? []);
  }

  /** History panel Revert (DM): undo with force semantics. */
  revert(id: number, actor: CommandActor): HistoryEntry {
    const e = this.entry(id);
    if (!e) throw new GloamError("NOT_FOUND");
    return this.undoEntry(e, actor, { force: true });
  }

  /** Restore to here: revert every later entry in reverse order (one transaction per entry, newest first). */
  restoreTo(id: number, actor: CommandActor): number {
    const later = this.app.db
      .select()
      .from(history)
      .where(
        and(
          eq(history.campaignId, this.model.campaign.id),
          gt(history.id, id),
          isNull(history.undoneAt),
          eq(history.undoable, true),
        ),
      )
      .orderBy(desc(history.id))
      .all();
    let n = 0;
    const run = this.app.sqlite.transaction(() => {
      for (const r of later) {
        const e = this.entry(r.id);
        if (e && e.undoneAt === null) {
          this.undoEntry(e, actor, { force: true });
          n++;
        }
      }
    });
    run();
    return n;
  }

  /** Clears per-user stacks (new table session, restore). */
  resetStacks(): void {
    this.undoStacks.clear();
    this.redoStacks.clear();
  }

  canUndo(userId: string): boolean {
    return (this.undoStacks.get(userId)?.length ?? 0) > 0;
  }
  canRedo(userId: string): boolean {
    return (this.redoStacks.get(userId)?.length ?? 0) > 0;
  }
}

/** Whether a column's value is unchanged (JSON documents and blobs by content). */
function sameColumn(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
  if (a && b && typeof a === "object" && typeof b === "object")
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
