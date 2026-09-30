/**
 * Roll requests (SPEC §8.9 Roll requests, §18.5; AC-DICE-06): the DM asks creatures for a check, a save, an attack or
 * any formula. Each target's formula is computed from its sheet when asked (e.g. a DEX save → `1d20 + 5`); the
 * controllers of each target get a card (Roll / Enter physical roll / Skip); DMs get the live board — who's pending,
 * rolled, entered, skipped, and each result against the DC — and may roll for a target, set its result, or close the
 * request. Creatures no player controls are the DM's to roll. Stored in SQLite (`roll_requests`).
 */
import type { Ability, SkillId } from "@gloam/shared";
import { GloamError, type RequestCard } from "@gloam/shared/protocol";
import { ABILITY_NAMES, skillName } from "@gloam/shared/rules";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { rollRequests } from "../db/schema.ts";
import { newId } from "../ids.ts";

export type RequestType = "check" | "save" | "attack" | "custom";
export type RequestVisibility = "public" | "dm" | "blind";
export type ResponseState = "pending" | "rolled" | "manual" | "skipped" | "dm";

export interface RequestTarget {
  /** The token or character asked. */
  id: string;
  kind: "token" | "actor";
  name: string;
  /** Who answers for it (players); none → the DM rolls it. */
  controllers: string[];
  /** Its formula as asked, the sheet's modifiers already in (e.g. "1d20 + 5 adv"), Exhaustion's penalty too. */
  formula: string;
  /** What its conditions suggest (applied unless the roller sets it aside, AC-DICE-11). */
  hint?: { mode: "adv" | "dis"; from: string[] };
  /** Conditions that fail this save outright. */
  autoFail?: string[];
}

export interface RequestResponse {
  state: ResponseState;
  rollId?: string;
  /** The formula as it was rolled (a hint taken or set aside): the answered card shows it. */
  formula?: string;
  total?: number;
  success?: boolean;
  by?: string;
  /** Rolled, the roller yet to keep it or spend Heroic Inspiration on a die (rules audit C4): nothing follows yet. */
  held?: { dice: { sides: number; value: number; kept: boolean }[] };
}

export interface RollRequest {
  id: string;
  campaignId: string;
  createdBy: string;
  createdAt: number;
  type: RequestType;
  ability?: Ability;
  skill?: SkillId;
  /** What it's called on every card: "Dexterity save", "Perception check", or the DM's own label. */
  label: string;
  dc?: number;
  showDc: boolean;
  adv: "none" | "adv" | "dis";
  visibility: RequestVisibility;
  targets: RequestTarget[];
  responses: Record<string, RequestResponse>;
  status: "open" | "closed";
  closedAt: number | null;
  /**
   * What the room does with the answers (P7, §8.11): a concentration save (a failure ends concentration, at once or
   * via the DM's prompt) or a death saving throw (the tally moves; a 20 brings the creature back; three failures ask
   * the DM). Absent: an ordinary request.
   */
  purpose?:
    | { kind: "concentration"; spell?: string }
    | { kind: "deathSave" }
    /** A Hit Die to spend on a short rest (its character; one die a card). */
    | { kind: "hitDie"; die: string; actorId: string }
    /** Initiative in a combat (§8.12): its answers go into the order; the surprised roll with disadvantage. */
    | { kind: "initiative"; combatId: string; surprised: string[] }
    /** A spell's save (§8.13 Resolution card): its answers go onto the cast's card. */
    | { kind: "castSave"; castId: string };
}

/** The formula a request asks of everyone, with its `@` references (resolved per target). */
export function requestFormula(p: {
  type: RequestType;
  ability?: Ability | undefined;
  skill?: SkillId | undefined;
  formula?: string | undefined;
}): string {
  if (p.type === "check") {
    if (p.skill) return `1d20 + @skill.${p.skill}`;
    if (p.ability) return `1d20 + @${p.ability}`;
    throw new GloamError("INVALID", "A check needs an ability or a skill.");
  }
  if (p.type === "save") {
    if (!p.ability) throw new GloamError("INVALID", "A save needs an ability.");
    return `1d20 + @${p.ability}.save`;
  }
  if (!p.formula) throw new GloamError("INVALID", "Give the formula to roll.");
  return p.formula;
}

/** What a request is called: the DM's label, or "Dexterity save", "Perception check", "Strength check", "Attack". */
export function requestLabel(p: {
  type: RequestType;
  ability?: Ability | undefined;
  skill?: SkillId | undefined;
  label?: string | undefined;
}): string {
  if (p.label) return p.label;
  if (p.type === "save" && p.ability) return `${ABILITY_NAMES[p.ability]} save`;
  if (p.type === "check" && p.skill) return `${skillName(p.skill)} check`;
  if (p.type === "check" && p.ability) return `${ABILITY_NAMES[p.ability]} check`;
  return p.type === "attack" ? "Attack" : "Roll";
}

/**
 * A target's own formula: each `@` reference replaced by its value on the target's sheet (an unknown one by 0 — a
 * unit without a skill rolls its plain d20), advantage or disadvantage added for d20 rolls.
 */
export function targetFormula(
  base: string,
  resolve: (path: readonly string[]) => number | undefined,
  adv: "none" | "adv" | "dis",
): string {
  const numeric = base.replace(/@([a-z][a-zA-Z.]*)/g, (_, ref: string) =>
    String(resolve(ref.split(".")) ?? 0),
  );
  // "+ -3" reads as "- 3"; a "+ 0" says nothing (a creature without the modifier rolls its plain d20).
  const tidy = numeric
    .replace(/\+\s*-\s*(\d)/g, "- $1")
    .replace(/-\s*-\s*(\d)/g, "+ $1")
    .replace(/\s*[+-]\s*0(?![\d.])/g, "")
    .trim();
  return adv !== "none" && /d20/i.test(tidy) ? `${tidy} ${adv}` : tidy;
}

export class RequestService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(r: Omit<RollRequest, "id" | "createdAt" | "status" | "closedAt" | "responses">): RollRequest {
    const req: RollRequest = {
      ...r,
      id: newId("req"),
      createdAt: Date.now(),
      status: "open",
      closedAt: null,
      responses: Object.fromEntries(r.targets.map((t) => [t.id, { state: "pending" as const }])),
    };
    this.db
      .insert(rollRequests)
      .values({
        id: req.id,
        campaignId: req.campaignId,
        createdBy: req.createdBy,
        dataJson: JSON.stringify(req),
        status: "open",
        createdAt: req.createdAt,
        closedAt: null,
      })
      .run();
    return req;
  }

  get(id: string): RollRequest | null {
    const row = this.db.select().from(rollRequests).where(eq(rollRequests.id, id)).get();
    if (!row) return null;
    try {
      return {
        ...(JSON.parse(row.dataJson as string) as RollRequest),
        status: row.status,
        closedAt: row.closedAt,
      };
    } catch {
      return null;
    }
  }

  save(r: RollRequest): void {
    this.db
      .update(rollRequests)
      .set({ dataJson: JSON.stringify(r), status: r.status, closedAt: r.closedAt })
      .where(eq(rollRequests.id, r.id))
      .run();
  }

  /** A campaign's open requests, newest first. */
  open(campaignId: string): RollRequest[] {
    return this.db
      .select()
      .from(rollRequests)
      .where(eq(rollRequests.campaignId, campaignId))
      .orderBy(desc(rollRequests.createdAt))
      .limit(50)
      .all()
      .filter((r) => r.status === "open")
      .map((r) => this.get(r.id))
      .filter((r): r is RollRequest => r !== null);
  }
}

/**
 * A target's card for one of its controllers (never another target's result, never a hidden DC, never the total of a
 * blind roll — the player sees "?" for those).
 */
export function cardFor(r: RollRequest, t: RequestTarget, extra: Partial<RequestCard> = {}): RequestCard {
  const res = r.responses[t.id] ?? { state: "pending" as const };
  const blind = r.visibility === "blind";
  return {
    requestId: r.id,
    targetId: t.id,
    targetName: t.name,
    label: r.label,
    formula: res.formula ?? t.formula,
    ...(r.showDc && r.dc !== undefined ? { dc: r.dc } : {}),
    adv: r.adv,
    visibility: r.visibility,
    state: res.state,
    ...(!blind && res.total !== undefined ? { total: res.total } : {}),
    ...(!blind && r.showDc && res.success !== undefined ? { success: res.success } : {}),
    ...(t.hint ? { hint: t.hint } : {}),
    ...(t.autoFail?.length ? { autoFail: t.autoFail } : {}),
    ...(res.held && !blind ? { held: res.held } : {}),
    open: r.status === "open",
    ...extra,
  };
}
