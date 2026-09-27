import { LIMITS } from "@gloam/shared";
import { GloamError } from "@gloam/shared/protocol";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
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
}

export interface CommandCtx {
  actor: CommandActor;
  model: CampaignModel;
  app: ServerContext;
  now: number;
}

export interface Plan<R = unknown> {
  ops: Op[];
  summary: string;
  sceneId?: string | null;
  result?: R;
  /** Post-commit effects (vision invalidation is automatic; these are messages, sounds, log entries). */
  after?: ((info: CommitInfo) => void)[];
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

/** Applies one op to a working set of entities (clones), returning which entities changed. */
type Working = Map<string, { kind: EntityKind; id: string; value: unknown | null }>;

export interface FogApplier {
  /** Applies a fog op to the in-memory raster and returns the new stored layer bytes (for the fog_masks row). */
  apply(op: Extract<Op, { k: "fog" }>): void;
  persist(sceneId: string, layer: string): void;
}

export interface SheetApplier {
  apply(sheet: Record<string, unknown>, patch: Extract<Op, { k: "sheet" }>["patch"]): Record<string, unknown>;
}

export interface BusHooks {
  /** Called after commit with the ops, before post-commit effects: sync Colyseus state, invalidate vision. */
  onCommitted(info: CommitInfo): void;
  fog?: FogApplier;
  sheet?: SheetApplier;
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
    opts: { cid?: string; undoGroup?: string } = {},
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
    const ctx: CommandCtx = { actor, model: this.model, app: this.app, now: Date.now() };
    def.authorize(ctx, parsed.data);
    const plan = def.plan(ctx, parsed.data);
    const undoable = plan.undoable ?? def.undoable;
    const entry =
      plan.ops.length > 0
        ? this.commit(type, plan.ops, plan.summary, undoable, actor, plan.sceneId ?? null)
        : null;
    if (entry && undoable) this.pushUndo(actor.userId, entry.id, opts.undoGroup ?? null);
    const info: CommitInfo = { entry, ops: plan.ops, actor, type };
    if (plan.ops.length > 0) {
      this.hooks.onCommitted(info);
      this.postCommitProbe?.(info);
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
          const row = (codec.toRow as (e: unknown) => Record<string, unknown>)(w.value);
          const { id: _id, ...rest } = row;
          this.app.db
            .insert(codec.table)
            .values(row as never)
            .onConflictDoUpdate({ target: (codec.table as unknown as { id: never }).id, set: rest as never })
            .run();
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
    tx();
    for (const w of working.values()) {
      if (w.value === null) this.model.remove(w.kind, w.id);
      else this.model.put(w.kind, w.value as never);
    }
    this.model.version++;
    return entry as unknown as HistoryEntry;
  }

  // ── undo / redo / revert (SPEC §14.4) ─────────────────────────────────────────────────────────────────

  private pushUndo(userId: string, id: number, group: string | null): void {
    const s = this.undoStacks.get(userId) ?? [];
    const top = s[s.length - 1];
    if (group && top?.group === group) top.ids.push(id);
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
