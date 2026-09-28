/**
 * Roll requests (SPEC §8.9 Roll requests, §18.5; AC-DICE-06): the DM asks creatures for a check, a save, an attack or
 * any formula. Each target's formula is computed from its sheet when asked (e.g. a DEX save → `1d20 + 5`); the
 * controllers of each target get a card (Roll / Enter physical roll / Skip); DMs get the live board — who's pending,
 * rolled, entered, skipped, and each result against the DC — and may roll for a target, set its result, or close the
 * request. Creatures no player controls are the DM's to roll. Stored in SQLite (`roll_requests`).
 */
import type { Ability, SkillId } from "@gloam/shared";
import { GloamError, type RequestCard } from "@gloam/shared/protocol";
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
  /** Its formula as asked, the sheet's modifiers already in (e.g. "1d20 + 5 adv"). */
  formula: string;
}

export interface RequestResponse {
  state: ResponseState;
  rollId?: string;
  total?: number;
  success?: boolean;
  by?: string;
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
}

const ABILITY_NAME: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

const SKILL_NAME = (s: SkillId) =>
  s
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

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
  if (p.type === "save" && p.ability) return `${ABILITY_NAME[p.ability]} save`;
  if (p.type === "check" && p.skill) return `${SKILL_NAME(p.skill)} check`;
  if (p.type === "check" && p.ability) return `${ABILITY_NAME[p.ability]} check`;
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
  // "+ -3" reads as "- 3".
  const tidy = numeric.replace(/\+\s*-\s*(\d)/g, "- $1").replace(/-\s*-\s*(\d)/g, "+ $1");
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
export function cardFor(r: RollRequest, t: RequestTarget): RequestCard {
  const res = r.responses[t.id] ?? { state: "pending" as const };
  const blind = r.visibility === "blind";
  return {
    requestId: r.id,
    targetId: t.id,
    targetName: t.name,
    label: r.label,
    formula: t.formula,
    ...(r.showDc && r.dc !== undefined ? { dc: r.dc } : {}),
    adv: r.adv,
    visibility: r.visibility,
    state: res.state,
    ...(!blind && res.total !== undefined ? { total: res.total } : {}),
    ...(!blind && r.showDc && res.success !== undefined ? { success: res.success } : {}),
    open: r.status === "open",
  };
}
