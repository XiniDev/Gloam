import type { Client } from "@colyseus/core";
import { $changes, type Ref, StateView } from "@colyseus/schema";
import { controlsToken } from "@gloam/shared/rules";
import type { TokenEntity, WallEntity } from "@gloam/shared/schemas";
import {
  COLLECTIONS,
  TAG_DM,
  TAG_HP,
  TAG_LINK,
  TAG_OWNER,
  TAG_VISION,
  type TableState,
} from "@gloam/shared/state";
import type { CampaignModel } from "../engine/model.ts";
import type { Role } from "../services/campaigns.ts";
import { wallBlocksSight } from "./projector.ts";

/**
 * Per-client views (SPEC §13.4). For every client the manager computes which items of each `.view()` collection
 * it may see and which field tags it holds, diffs against what it currently has, and calls `view.add`/`remove`.
 * Revoking a tag uses `view.remove(item, TAG)`, which sends that client a DELETE for exactly the tagged fields, so it
 * never keeps a stale copy of a field it may no longer read (e.g. exact HP after the DM switches a token to "Bar").
 * (Removing and re-adding the whole item in one patch would NOT do this: the encoder coalesces the two into an ADD.)
 */

export interface Viewer {
  userId: string;
  role: Role;
}

/**
 * What a player's viewpoint perceives (the vision service, §15.5): tokens, carried lights whose light reaches their
 * sight though the carrier is unseen, and tremorsense markers. `null` user = spectators (the union of the players).
 */
export interface Perception {
  perceives(userId: string, token: TokenEntity): boolean;
  seesLight?(userId: string | null, lightId: string): boolean;
  sensedFor?(userId: string | null): { id: string }[];
}

/** No vision engine: every token that isn't DM-hidden is perceivable. */
export const OPEN_PERCEPTION: Perception = { perceives: (_u, t) => !t.hidden };

/** The view-filtered collections: the entity ones plus tremorsense markers. */
const VIEWED = [...COLLECTIONS, "sensed"] as const;
type Viewed = (typeof VIEWED)[number];
type Grants = Record<Viewed, Map<string, number>>;
const ALL_TOKEN_TAGS = TAG_HP | TAG_OWNER | TAG_VISION | TAG_DM;
const VISIBLE = 0;

const emptyGrants = (): Grants => ({
  sensed: new Map(),
  tokens: new Map(),
  walls: new Map(),
  lights: new Map(),
  zones: new Map(),
  effects: new Map(),
});

const isDm = (r: Role) => r === "admin" || r === "dm";

/** Whether a (non-DM) user may see a token at all: DM-hidden tokens never reach players (AC-TOK-08). */
function playerSees(userId: string, t: TokenEntity, perception: Perception): boolean {
  if (t.hidden) return false;
  if (t.ownerIds.includes(userId)) return true;
  if (t.revealTo === "all" || (Array.isArray(t.revealTo) && t.revealTo.includes(userId))) return true;
  return perception.perceives(userId, t);
}

/** Players see walls that aren't hidden, plus hidden ones that block sight (as anonymous occluders). */
function playerSeesWall(w: WallEntity): boolean {
  return !w.hidden || wallBlocksSight(w);
}

export class ViewManager {
  private readonly state: TableState;
  private readonly model: CampaignModel;
  private perception: Perception;
  private readonly granted = new Map<Client, Grants>();

  constructor(state: TableState, model: CampaignModel, perception: Perception = OPEN_PERCEPTION) {
    this.state = state;
    this.model = model;
    this.perception = perception;
  }

  setPerception(p: Perception): void {
    this.perception = p;
  }

  /** What `viewer` should hold in the active scene: item → tag bitmask. */
  desired(viewer: Viewer, activeSceneId: string): Grants {
    const out = emptyGrants();
    if (!activeSceneId) return out;
    const m = this.model;
    const dm = isDm(viewer.role);
    const spectator = viewer.role === "spectator";
    const players = spectator ? this.playerIds() : [];
    const tokens = m.inScene("token", activeSceneId);
    const visibleTokens = new Set<string>();
    for (const t of tokens) {
      if (dm) {
        out.tokens.set(t.id, ALL_TOKEN_TAGS);
        visibleTokens.add(t.id);
        continue;
      }
      const sees = spectator
        ? players.some((u) => playerSees(u, t, this.perception))
        : playerSees(viewer.userId, t, this.perception);
      if (!sees) continue;
      visibleTokens.add(t.id);
      const controls = !spectator && controlsToken(viewer.role, viewer.userId, t);
      let tags = VISIBLE;
      if (controls || t.hpDisplay === "exact") tags |= TAG_HP;
      if (controls) tags |= TAG_OWNER;
      const sharedWith = t.overrides.shareVisionWith ?? [];
      if (controls || sharedWith.includes(viewer.userId) || (spectator && t.ownerIds.length > 0))
        tags |= TAG_VISION;
      out.tokens.set(t.id, tags);
    }
    for (const w of m.inScene("wall", activeSceneId)) {
      if (dm) out.walls.set(w.id, TAG_DM);
      else if (playerSeesWall(w)) out.walls.set(w.id, VISIBLE);
    }
    for (const l of m.inScene("light", activeSceneId)) {
      if (dm) {
        out.lights.set(l.id, TAG_LINK);
        continue;
      }
      if (l.dmOnly) continue;
      if (!l.tokenId) {
        out.lights.set(l.id, VISIBLE);
        continue;
      }
      // A carried light is in view while its carrier is perceivable (with its token link), or while its light
      // reaches the viewer's sight (without: the glow round the corner, not who holds it).
      if (visibleTokens.has(l.tokenId)) out.lights.set(l.id, TAG_LINK);
      else if (this.perception.seesLight?.(spectator ? null : viewer.userId, l.id))
        out.lights.set(l.id, VISIBLE);
    }
    if (!dm)
      for (const m of this.perception.sensedFor?.(spectator ? null : viewer.userId) ?? [])
        out.sensed.set(m.id, VISIBLE);
    for (const z of m.inScene("zone", activeSceneId))
      if (dm) out.zones.set(z.id, TAG_DM);
      else if (z.visible) out.zones.set(z.id, VISIBLE);
    for (const e of m.inScene("effect", activeSceneId)) {
      if (dm) {
        out.effects.set(e.id, TAG_LINK);
        continue;
      }
      const involvesMine =
        (e.attachedTokenId && this.controls(viewer, e.attachedTokenId)) ||
        (e.source.casterTokenId && this.controls(viewer, e.source.casterTokenId));
      if (e.visibility !== "everyone" && !involvesMine) continue;
      const linkVisible =
        (!e.attachedTokenId || visibleTokens.has(e.attachedTokenId)) &&
        (!e.source.casterTokenId || visibleTokens.has(e.source.casterTokenId));
      out.effects.set(e.id, linkVisible ? TAG_LINK : VISIBLE);
    }
    return out;
  }

  private controls(viewer: Viewer, tokenId: string): boolean {
    const t = this.model.get("token", tokenId);
    return Boolean(t && controlsToken(viewer.role, viewer.userId, t));
  }

  /** Users with a player role in this campaign (spectators see the union of their views). */
  private playerIds(): string[] {
    const out: string[] = [];
    this.state.presence.forEach((p, id) => {
      if (p.role === "player") out.push(id);
    });
    return out;
  }

  /** Brings one client's view in line with what it should see. */
  sync(client: Client, viewer: Viewer, activeSceneId: string): void {
    if (!client.view) client.view = new StateView();
    const view = client.view;
    const have = this.granted.get(client) ?? emptyGrants();
    const want = this.desired(viewer, activeSceneId);
    const st = this.state as unknown as Record<Viewed, Map<string, Ref>>;
    for (const c of VIEWED) {
      const map = st[c];
      const cur = have[c];
      const next = want[c];
      for (const [id, tags] of cur) {
        const item = map.get(id);
        if (!item) {
          cur.delete(id); // deleted from state: the deletion reaches every client that saw it
          continue;
        }
        const wantTags = next.get(id);
        if (wantTags === undefined) {
          view.remove(item);
          cur.delete(id);
        } else if ((tags & ~wantTags) !== 0) {
          for (const bit of bits(tags & ~wantTags)) view.remove(item, bit);
          // @colyseus/schema 5.0.34: remove(item, TAG) also clears the item's own visibility bit, after which the
          // client silently stops receiving any update to it. Restore just that bit (no ops are queued).
          const tree = (
            item as unknown as Record<symbol, Parameters<StateView["markVisible"]>[0] | undefined>
          )[$changes];
          if (tree) view.markVisible(tree);
          cur.set(id, tags & wantTags);
        }
      }
      for (const [id, tags] of next) {
        const item = map.get(id);
        if (!item) continue;
        const had = cur.get(id);
        if (had === undefined) {
          view.add(item);
          for (const bit of bits(tags)) view.add(item, bit);
          cur.set(id, tags);
        } else if (had !== tags) {
          for (const bit of bits(tags & ~had)) view.add(item, bit);
          cur.set(id, tags);
        }
      }
    }
    this.granted.set(client, have);
  }

  /**
   * Before the projector rebuilds the collections for another scene: drop every item from every view so no view
   * keeps references to the old scene's schema instances.
   */
  detachAll(): void {
    const st = this.state as unknown as Record<Viewed, Map<string, Ref>>;
    for (const [client, have] of this.granted) {
      for (const c of VIEWED) {
        for (const id of have[c].keys()) {
          const item = st[c].get(id);
          if (item) client.view?.remove(item);
        }
        have[c].clear();
      }
    }
  }

  forget(client: Client): void {
    this.granted.delete(client);
  }

  /** Test/diagnostic: what a client currently holds. */
  grantsOf(client: Client): Grants | undefined {
    return this.granted.get(client);
  }
}

function* bits(mask: number): Generator<number> {
  for (let b = mask; b > 0; b &= b - 1) yield b & -b;
}
