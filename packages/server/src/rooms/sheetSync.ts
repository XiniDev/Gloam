import type { Client } from "@colyseus/core";
import { diffSheet, type JsonPatchOp, patchOf } from "@gloam/shared/rules";
import type { Sheet } from "@gloam/shared/schemas";
import type { ActorEntity } from "../engine/codecs.ts";
import { readSheet } from "../engine/commands/actor.ts";
import type { CampaignModel } from "../engine/model.ts";
import type { Op } from "../engine/ops.ts";
import type { Role } from "../services/campaigns.ts";

/** A character as a client holds it: who plays it, its lock, and its sheet as read (status filled in). */
export interface ActorView {
  id: string;
  kind: "character" | "npc";
  ownerUserId: string | null;
  lockLevel: "unlocked" | "core" | "full";
  templateId: string | null;
  updatedAt: number;
  sheet: Sheet;
}

interface Viewer {
  userId: string;
  role: Role;
}

/**
 * Character sheets reach only those allowed to read them (SPEC principle P4, §13.4: a sheet is an entity — hiding it
 * only visually would be a bug): DMs every sheet; a player their own characters and those of tokens they control that
 * are linked to them; spectators none. A client gets the whole sheet when it comes into its view (`actor.view`, and
 * `actor.snapshot` on joining), a JSON Patch per change after (`sheet.patch`, cut from the version last sent, so every
 * client applies the same sequence), and word when it leaves its view (`actor.gone`).
 */
export class SheetSync {
  /** Per actor: what was last sent (its meta and sheet). */
  private readonly sent = new Map<string, { meta: string; sheet: Sheet }>();
  /** Per client: the actors in its view. */
  private readonly seen = new Map<Client, Set<string>>();

  private readonly model: CampaignModel;
  constructor(model: CampaignModel) {
    this.model = model;
  }

  /** Who reads each actor beyond DMs and owners: the controllers of its linked tokens. */
  private controllers(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const t of this.model.all("token")) {
      if (!t.actorId || t.link !== "linked") continue;
      let s = out.get(t.actorId);
      if (!s) {
        s = new Set();
        out.set(t.actorId, s);
      }
      for (const u of t.ownerIds) s.add(u);
    }
    return out;
  }

  /** Whether someone may read a character's sheet (and so roll from it). */
  mayRead(v: Viewer, a: ActorEntity): boolean {
    return this.readable(v, a, this.controllers());
  }

  private readable(v: Viewer, a: ActorEntity, controllers: Map<string, Set<string>>): boolean {
    if (a.deletedAt !== null) return false;
    if (v.role === "admin" || v.role === "dm") return true;
    if (v.role !== "player") return false;
    return a.ownerUserId === v.userId || controllers.get(a.id)?.has(v.userId) === true;
  }

  private current(a: ActorEntity): { meta: string; sheet: Sheet } {
    return {
      meta: JSON.stringify([a.kind, a.ownerUserId, a.lockLevel, a.templateId]),
      sheet: readSheet(a),
    };
  }

  private view(a: ActorEntity, sheet: Sheet): ActorView {
    return {
      id: a.id,
      kind: a.kind,
      ownerUserId: a.ownerUserId,
      lockLevel: a.lockLevel,
      templateId: a.templateId,
      updatedAt: a.updatedAt,
      sheet,
    };
  }

  private cached(a: ActorEntity): { meta: string; sheet: Sheet } {
    let c = this.sent.get(a.id);
    if (!c) {
      c = this.current(a);
      this.sent.set(a.id, c);
    }
    return c;
  }

  /** A client joined (or everything was reloaded): every sheet it may read, whole. */
  join(client: Client, v: Viewer): void {
    const controllers = this.controllers();
    const actors: ActorView[] = [];
    const ids = new Set<string>();
    for (const a of this.model.all("actor")) {
      if (!this.readable(v, a, controllers)) continue;
      ids.add(a.id);
      actors.push(this.view(a, this.cached(a).sheet));
    }
    this.seen.set(client, ids);
    client.send("actor.snapshot", { actors });
  }

  leave(client: Client): void {
    this.seen.delete(client);
  }

  /** Whether a commit could change what anyone reads: actor and sheet ops, and who controls linked tokens. */
  static touches(ops: readonly Op[]): boolean {
    return ops.some(
      (o) =>
        o.k === "sheet" ||
        (o.k !== "fog" &&
          (o.e === "actor" ||
            (o.e === "token" &&
              (o.k !== "set" ||
                o.path[0] === "ownerIds" ||
                o.path[0] === "link" ||
                o.path[0] === "actorId")))),
    );
  }

  /** After a commit: to each client, what changed in what it reads — and what came into or left its view. */
  sync(ops: readonly Op[], clients: Iterable<[Client, Viewer]>): void {
    if (!SheetSync.touches(ops)) return;
    const changed = new Set<string>();
    for (const o of ops) {
      if (o.k === "sheet") changed.add(o.actorId);
      else if (o.k !== "fog" && o.e === "actor") changed.add(o.id);
    }
    // New versions of the actors that changed, and the patch from what was last sent.
    const next = new Map<
      string,
      { meta: string; sheet: Sheet; patch: JsonPatchOp[]; metaChanged: boolean }
    >();
    for (const id of changed) {
      const a = this.model.get("actor", id);
      if (!a) {
        this.sent.delete(id);
        continue;
      }
      const before = this.sent.get(id);
      const now = this.current(a);
      const patch = before ? patchOf(diffSheet(before.sheet, now.sheet)).patch : [];
      next.set(id, { ...now, patch, metaChanged: !before || before.meta !== now.meta });
    }
    const controllers = this.controllers();
    for (const [client, v] of clients) {
      const had = this.seen.get(client) ?? new Set<string>();
      const has = new Set<string>();
      for (const a of this.model.all("actor")) if (this.readable(v, a, controllers)) has.add(a.id);
      for (const id of had) if (!has.has(id)) client.send("actor.gone", { id });
      for (const id of has) {
        const a = this.model.get("actor", id) as ActorEntity;
        const n = next.get(id);
        if (!had.has(id)) client.send("actor.view", { actor: this.view(a, (n ?? this.cached(a)).sheet) });
        else if (n?.metaChanged) client.send("actor.view", { actor: this.view(a, n.sheet) });
        else if (n?.patch.length)
          client.send("sheet.patch", { actorId: id, patch: n.patch, updatedAt: a.updatedAt });
      }
      this.seen.set(client, has);
    }
    for (const [id, n] of next) this.sent.set(id, { meta: n.meta, sheet: n.sheet });
  }
}
