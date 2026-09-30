import type { ConditionId, DamageType } from "@gloam/shared";
import {
  type DmPromptView,
  GloamError,
  HealthConsequences,
  HpApply,
  type HpFx,
  type HpPreviewRow,
  type PromptItemView,
  StatusChange,
} from "@gloam/shared/protocol";
import {
  applyDamage,
  applyHealing,
  applyToStatus,
  CONDITIONS,
  type Consequence,
  type ConsequenceRules,
  cantActBecause,
  controlsToken,
  damageConsequences,
  describeConsequence,
  effectiveTokenState,
  exhaustedHpMax,
  healingConsequences,
  immuneToCondition,
  incapacitates,
  isDead,
  isDm,
  makesDeathSaves,
  type PartOutcome,
  projectSheet,
  sortConsequences,
  statsFromSheet,
  statusFromActor,
  statusName,
  tempHpChoice,
} from "@gloam/shared/rules";
import type { TokenEntity, TokenStats, TokenStatusT } from "@gloam/shared/schemas";
import { z } from "zod";
import type { ActorEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef, RoomEvent } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { mustGet, setOps } from "../plan.ts";
import { readSheet, sheetEditOps } from "./actor.ts";
import { type Hurt, tallyOps } from "./tally.ts";

/**
 * HP, conditions and death (SPEC §8.11, §19): damage (the §19.2 pipeline), healing and temporary HP for tokens;
 * conditions, markers, exhaustion and concentration; and what follows from them (rules/consequences.ts) — applied at
 * once, or put to the DM as prompts, by the campaign's automation level (§19.1). A creature's HP and status have one
 * home — its character's sheet and status for a linked token (every scene's token follows), the token's own copy for
 * an unlinked one (a "holder"). Everything is one undoable command; prompts and concentration saves are the room's
 * follow-ups (`health.followups`), created after the commit.
 */

/** The room message a command's follow-ups travel in (the room creates the prompts and requests). */
export const FOLLOWUPS = "health.followups";

/** A DM prompt to create. */
export type PromptSpec = Omit<DmPromptView, "id" | "createdAt" | "status" | "resolvedAt">;
/** A concentration save to ask for (a CON save, DC as computed, for the creature's owner — AC-HP-07). */
export interface ConcentrationSpec {
  tokenId: string | null;
  actorId: string | null;
  name: string;
  dc: number;
  spell?: string;
}
export interface Followups {
  prompts: PromptSpec[];
  concentration: ConcentrationSpec[];
  by: string;
}

/** Where a creature's HP and status live: its character (a linked token, or a character asked by id) or its token. */
export interface Holder {
  token?: TokenEntity;
  actor?: ActorEntity;
  name: string;
  hp: number;
  hpMax: number;
  hpTemp: number;
  stats: TokenStats;
  status: TokenStatusT;
  isPC: boolean;
}

/**
 * A player's creature that can't act can't cast, attack or Dash: an Incapacitated creature "can't take any action,
 * Bonus Action, or Reaction" (SRD 5.2.1 p. 184), a dead one does nothing (rules audit A11). The DM still can — a
 * feature, a house rule, their call (§2 P2).
 */
export function mustBeAbleToAct(ctx: CommandCtx, h: Holder, what: string): void {
  if (isDm(ctx.actor.role)) return;
  if (isDead(h.status)) throw new GloamError("CONFLICT", `${h.name} is dead: it can't ${what}.`);
  const by = cantActBecause(h.status.conditions.map((c) => c.id as string));
  if (by) throw new GloamError("CONFLICT", `${h.name} is ${by}: it can't ${what}.`);
}

export function holderOf(
  ctx: CommandCtx,
  ref: { tokenId?: string | undefined; actorId?: string | undefined },
): Holder {
  if (ref.tokenId) {
    const token = mustGet(ctx, "token", ref.tokenId);
    const a = token.actorId ? ctx.model.get("actor", token.actorId) : undefined;
    const actor = a && a.deletedAt === null && token.link === "linked" ? a : undefined;
    const { stats, status } = effectiveTokenState(token, actor);
    // SRD 5.1's Exhaustion 4 halves its HP maximum (rules audit C2): HP held to it.
    const hpMax = exhaustedHpMax(stats.hpMax, status.exhaustion, ctx.model.campaign.rulesPack);
    return {
      token,
      ...(actor ? { actor } : {}),
      name: token.name,
      hp: Math.min(stats.hp, hpMax),
      hpMax,
      hpTemp: stats.hpTemp,
      stats,
      status,
      isPC: stats.isPC,
    };
  }
  const actor = mustGet(ctx, "actor", ref.actorId as string);
  if (actor.deletedAt !== null) throw new GloamError("NOT_FOUND", "That character no longer exists.");
  const stats = { ...statsFromSheet(actor.sheet), isPC: actor.kind === "character" };
  const status = statusFromActor(actor.status);
  const hpMax = exhaustedHpMax(stats.hpMax, status.exhaustion, ctx.model.campaign.rulesPack);
  return {
    actor,
    name: readSheet(actor).core.name,
    hp: Math.min(stats.hp, hpMax),
    hpMax,
    hpTemp: stats.hpTemp,
    stats,
    status,
    isPC: stats.isPC,
  };
}

/** A target by id: a token, else a character. */
export const refOf = (ctx: CommandCtx, id: string): { tokenId: string } | { actorId: string } =>
  ctx.model.get("token", id) ? { tokenId: id } : { actorId: id };

/** The tokens that show a holder: its own, or its character's linked tokens (every scene's). */
export function tokensOf(ctx: CommandCtx, h: Holder): string[] {
  if (h.token) return [h.token.id];
  const actorId = h.actor?.id;
  return ctx.model
    .all("token")
    .filter((t) => t.actorId === actorId && t.link === "linked")
    .map((t) => t.id);
}

/** The ops that give a holder its new HP and status. */
export function holderOps(
  ctx: CommandCtx,
  h: Holder,
  next: { hp: number; hpTemp: number; status: TokenStatusT },
): Op[] {
  if (h.actor) {
    const before = readSheet(h.actor);
    const hp = { ...before.core.hp, current: next.hp, temp: next.hpTemp };
    const after = projectSheet({ ...before, core: { ...before.core, hp } }, next.status);
    return sheetEditOps(ctx, h.actor, before, after, next.status);
  }
  const t = h.token as TokenEntity;
  return setOps("token", t, {
    stats: { ...h.stats, hp: next.hp, hpTemp: next.hpTemp },
    status: next.status,
    updatedAt: ctx.now,
  });
}

/** Who may change a creature's HP or status directly: the DM, or the player who controls it. */
function controls(ctx: CommandCtx, h: Holder): boolean {
  if (isDm(ctx.actor.role)) return true;
  if (ctx.actor.role !== "player") return false;
  if (h.token) return controlsToken(ctx.actor.role, ctx.actor.userId, h.token);
  return h.actor?.ownerUserId === ctx.actor.userId;
}

/**
 * The consequence rules this campaign plays by (Bloodied only in SRD 5.2.1, and only when the DM leaves it on; its
 * rules pack for the Concentration DC's cap).
 */
export function consequenceRules(ctx: CommandCtx): ConsequenceRules {
  const r = ctx.model.campaign.houseRules;
  const pack = ctx.model.campaign.rulesPack;
  return { bloodied: r.bloodied && pack !== "srd-5.1", npcAtZero: r.npcAtZero, rulesPack: pack };
}

export const itemOf = (c: Consequence): PromptItemView => ({
  key: c.kind,
  consequence: c,
  ...describeConsequence(c),
});

/** A prompt's heading for what it asks. */
export function promptTitle(name: string, ask: readonly Consequence[]): string {
  if (ask.some((c) => c.kind === "down" || c.kind === "npcAtZero")) return `${name} dropped to 0 HP`;
  if (ask.some((c) => c.kind === "dying")) return `${name}: dead?`;
  if (ask.some((c) => c.kind === "deathSaveFailures")) return `${name} took damage at 0 HP`;
  if (ask.some((c) => c.kind === "concentrationEnds")) return `${name}: concentration`;
  if (ask.some((c) => c.kind === "revive")) return `${name} is back above 0 HP`;
  return name;
}

/** "7 fire + 3 slashing" (largest first). */
function partsText(parts: readonly { type: string; amount: number }[]): string {
  return parts.map((p) => (p.type === "untyped" ? `${p.amount}` : `${p.amount} ${p.type}`)).join(" + ");
}

/** Applies what's decided to a status (HP changes are the caller's), folding each in turn. */
function fold(
  status: TokenStatusT,
  apply: readonly { consequence: Consequence; choice?: string }[],
): TokenStatusT {
  let s = status;
  for (const { consequence, choice } of apply) s = applyToStatus(s, consequence, choice);
  return s;
}

/** Whether what's decided kills it (for the death animation). */
const kills = (apply: readonly { consequence: Consequence; choice?: string }[]) =>
  apply.some(
    ({ consequence: c, choice }) =>
      (c.kind === "dying" && (choice ?? "dead") === "dead") ||
      (c.kind === "npcAtZero" && (choice ?? c.choice) === "dead"),
  );

/** What an HP change does to one creature: its new HP, what follows, the feedback and the words for it. */
export interface HpOutcome {
  hp: number;
  hpTemp: number;
  cons: Consequence[];
  fx: HpFx;
  detail: string;
  line: string;
  /** Damage: each instance and what happened to it, the total, what temp HP took, the overflow. */
  damage?: { parts: PartOutcome[]; total: number; fromTemp: number; overflow: number };
  /** Temporary HP when some are there already: the choice they don't stack into. */
  temp?: { current: number; incoming: number; best: number };
}

export function outcomeFor(
  h: Holder,
  p: z.infer<typeof HpApply>,
  id: string,
  dm: boolean,
  cRules: ConsequenceRules,
): HpOutcome {
  if (p.kind === "damage") {
    const total = dm ? p.totals?.[id] : undefined;
    const parts =
      total !== undefined
        ? [{ amount: total, type: "untyped" as const }]
        : (p.parts ?? [{ amount: p.amount ?? 0, type: "untyped" as const }]);
    const preview = applyDamage(
      {
        hp: h.hp,
        hpMax: h.hpMax,
        hpTemp: h.hpTemp,
        resistances: h.stats.resist,
        immunities: h.stats.immune,
        vulnerabilities: h.stats.vuln,
        conditions: h.status.conditions.map((c) => c.id),
        concentrating: Boolean(h.status.concentration),
        isPC: makesDeathSaves(h.isPC, h.status),
      },
      parts,
      total !== undefined
        ? { crit: p.crit, final: true, rulesPack: cRules.rulesPack }
        : { halved: p.halved, crit: p.crit, rulesPack: cRules.rulesPack },
    );
    const byType = preview.parts
      .filter((x) => x.applied > 0)
      .map((x) => ({ type: x.type as DamageType | "untyped", amount: x.applied }))
      .sort((a, b) => b.amount - a.amount);
    return {
      hp: preview.hp,
      hpTemp: preview.hpTemp,
      cons: damageConsequences({ hp: h.hp, hpMax: h.hpMax, isPC: h.isPC, status: h.status }, preview, cRules),
      fx: {
        tokenId: id,
        kind: "damage",
        amount: preview.total,
        parts: byType,
        ...(preview.fromTemp ? { fromTemp: preview.fromTemp } : {}),
        ...(preview.down ? { down: true } : {}),
      },
      detail: `Took ${partsText(byType) || "0"} damage`,
      line: `${h.name} took ${preview.total} damage${preview.hp === 0 ? " (0 HP)" : ""}`,
      damage: {
        parts: preview.parts,
        total: preview.total,
        fromTemp: preview.fromTemp,
        overflow: preview.overflow,
      },
    };
  }
  if (p.kind === "heal") {
    const dead = isDead(h.status);
    const out = applyHealing(h, p.amount ?? 0, dead);
    return {
      hp: out.hp,
      hpTemp: h.hpTemp,
      cons: healingConsequences({ hp: h.hp, hpMax: h.hpMax, status: h.status }, out, cRules),
      fx: { tokenId: id, kind: "heal", amount: out.gained, ...(out.revived ? { revived: true } : {}) },
      detail: dead ? "Dead: healing can't bring them back" : `Regained ${out.gained} HP`,
      line: dead ? `${h.name} is dead — no healing takes hold` : `${h.name} regained ${out.gained} HP`,
    };
  }
  // Temporary HP don't stack: keep, replace or the higher (AC-HP-03).
  const amount = p.amount ?? 0;
  const choice = tempHpChoice(h.hpTemp, amount);
  const hpTemp = choice ? choice[p.tempChoice] : Math.max(h.hpTemp, amount);
  return {
    hp: h.hp,
    hpTemp,
    cons: [],
    fx: { tokenId: id, kind: "temp", amount: Math.max(0, hpTemp - h.hpTemp) },
    detail: `${hpTemp} temporary HP`,
    line: `${h.name}: ${hpTemp} temporary HP`,
    ...(choice ? { temp: { current: h.hpTemp, incoming: amount, best: choice.best } } : {}),
  };
}

/**
 * What an `hp.apply` would do, for its dialog (§8.11: "sees a preview … and can edit it before applying"): per target,
 * the numbers and what follows — only for creatures the caller may see the numbers of (the DM; a player their own).
 * Others are named and marked as going to the DM (or applied directly, per house rule), nothing more (§13.4).
 */
export function previewHp(ctx: CommandCtx, p: z.infer<typeof HpApply>): HpPreviewRow[] {
  const dm = isDm(ctx.actor.role);
  const rules = ctx.model.campaign.houseRules;
  const cRules = consequenceRules(ctx);
  return [...new Set(p.targets)].map((id): HpPreviewRow => {
    const h = holderOf(ctx, refOf(ctx, id));
    if (!controls(ctx, h))
      return {
        tokenId: id,
        name: h.name,
        hidden: true,
        viaDm: p.kind === "damage" && rules.playerDamage === "viaDm",
      };
    const o = outcomeFor(h, p, id, dm, cRules);
    const { apply, ask } = sortConsequences(o.cons, rules.automation, dm ? p.decide?.[id] : undefined);
    return {
      tokenId: id,
      name: h.name,
      before: { hp: h.hp, hpMax: h.hpMax, hpTemp: h.hpTemp },
      after: { hp: o.hp, hpTemp: o.hpTemp },
      ...(o.damage ? { damage: o.damage } : {}),
      ...(o.temp ? { temp: o.temp } : {}),
      items: o.cons.map(itemOf),
      now: apply.map((x) => x.consequence.kind),
      asked: ask.map((c) => c.kind),
    };
  });
}

/**
 * `hp.apply` — damage, healing or temporary HP for one or more creatures (§8.11; AC-HP-01/02/03/06/07/09/10/12). A
 * player changes their own creatures directly; their damage to others goes to the DM first unless the campaign says
 * "Direct". The DM may edit what a target takes (`totals`) and decide what follows (`decide`) in the preview.
 */
export const hpApply: CommandDef<z.infer<typeof HpApply>, { applied: number; sent: number }> = {
  type: "hp.apply",
  schema: HpApply,
  undoable: true,
  authorize(ctx, p) {
    if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN", "Spectators watch.");
    if (p.kind === "damage" ? !p.parts && p.amount === undefined : p.amount === undefined)
      throw new GloamError("INVALID", "Give the amount.");
    for (const id of p.targets) {
      if (ctx.model.get("token", id)) {
        if (!isDm(ctx.actor.role) && ctx.actor.sees && !ctx.actor.sees(id))
          throw new GloamError("NOT_FOUND", "That creature isn't here.");
        continue;
      }
      // A character with no token here (its sheet's damage and healing): the DM's, or its player's own.
      const actor = ctx.model.get("actor", id);
      if (!actor || actor.deletedAt !== null) throw new GloamError("NOT_FOUND", "That creature isn't here.");
      if (!isDm(ctx.actor.role) && actor.ownerUserId !== ctx.actor.userId)
        throw new GloamError("FORBIDDEN", "That character isn't yours.");
    }
  },
  plan(ctx, p) {
    const dm = isDm(ctx.actor.role);
    const rules = ctx.model.campaign.houseRules;
    const cRules = consequenceRules(ctx);
    const ops: Op[] = [];
    const events: RoomEvent[] = [];
    const follow: Followups = { prompts: [], concentration: [], by: ctx.actor.userId };
    const lines: string[] = [];
    let applied = 0;
    let sent = 0;
    // What each creature lost, and who dropped to 0 — a running combat's tally.
    const hurt: Hurt = { taken: new Map(), downed: [] };
    for (const id of [...new Set(p.targets)]) {
      const h = holderOf(ctx, refOf(ctx, id));
      // A player's damage to a creature they don't control: to the DM first (house rule "via DM confirmation").
      if (!controls(ctx, h) && p.kind === "damage" && rules.playerDamage === "viaDm") {
        const damage: NonNullable<DmPromptView["damage"]> = {
          by: ctx.actor.userId,
          byName: ctx.actor.name,
          kind: p.kind,
          halved: p.halved,
          crit: p.crit,
          ...(p.parts ? { parts: p.parts } : {}),
          ...(p.amount !== undefined ? { amount: p.amount } : {}),
          ...(p.label ? { label: p.label } : {}),
        };
        follow.prompts.push({
          kind: "playerDamage",
          tokenId: h.token?.id ?? null,
          actorId: h.actor?.id ?? null,
          name: h.name,
          title: `${ctx.actor.name}'s damage to ${h.name}`,
          detail: `${p.parts ? partsText(p.parts) : (p.amount ?? 0)} damage`,
          items: [],
          damage,
        });
        sent++;
        continue;
      }
      const decided = dm ? p.decide?.[id] : undefined;
      const o = outcomeFor(h, p, id, dm, cRules);
      const { hp, hpTemp, cons, fx, detail, line } = o;
      const { apply, ask } = sortConsequences(cons, rules.automation, decided);
      const status = fold(h.status, apply);
      for (const { consequence: c } of apply)
        if (c.kind === "concentrationSave")
          follow.concentration.push({
            tokenId: h.token?.id ?? null,
            actorId: h.actor?.id ?? null,
            name: h.name,
            dc: c.dc,
            ...(h.status.concentration?.spellName ? { spell: h.status.concentration.spellName } : {}),
          });
      if (ask.length)
        follow.prompts.push({
          kind: "consequences",
          tokenId: h.token?.id ?? null,
          actorId: h.actor?.id ?? null,
          name: h.name,
          title: promptTitle(h.name, ask),
          detail,
          items: ask.map(itemOf),
        });
      if (kills(apply)) fx.dead = true;
      ops.push(...holderOps(ctx, h, { hp, hpTemp, status }));
      if (p.kind === "damage") {
        const lost = Math.max(0, h.hp + h.hpTemp - (hp + hpTemp));
        for (const tokenId of tokensOf(ctx, h)) {
          hurt.taken.set(tokenId, (hurt.taken.get(tokenId) ?? 0) + lost);
          if (h.hp > 0 && hp <= 0) hurt.downed.push(tokenId);
        }
      }
      for (const tokenId of tokensOf(ctx, h))
        events.push({ name: "hp.fx", payload: { ...fx, tokenId }, to: { viewersOf: tokenId } });
      lines.push(line);
      applied++;
    }
    if (follow.prompts.length || follow.concentration.length)
      events.push({ name: FOLLOWUPS, payload: follow, to: { dms: true } });
    ops.push(...tallyOps(ctx, hurt));
    const summary = lines.length
      ? `${lines.slice(0, 3).join("; ")}${lines.length > 3 ? ` and ${lines.length - 3} more` : ""}${p.label ? ` (${p.label})` : ""}`
      : "Damage sent to the DM";
    return { ops, summary, events, result: { applied, sent }, ...(ops.length ? {} : { undoable: false }) };
  },
};

/** A creature's status with a condition or marker added (nothing when it has it already). */
function withStatus(
  s: TokenStatusT,
  add: NonNullable<z.infer<typeof StatusChange>["add"]>[number],
): TokenStatusT {
  const id = add.id;
  if (id === "exhaustion")
    return { ...s, exhaustion: Math.max(1, s.exhaustion) as TokenStatusT["exhaustion"] };
  if ((CONDITIONS as Record<string, unknown>)[id]) {
    if (s.conditions.some((c) => c.id === id)) return s;
    const next = {
      ...s,
      conditions: [
        ...s.conditions,
        {
          id: id as ConditionId,
          ...(add.source ? { source: add.source } : {}),
          ...(add.untilRound ? { untilRound: add.untilRound } : {}),
        },
      ],
    };
    // Falling Unconscious, it falls Prone — and stays Prone when it comes round (SRD 5.2.1 p. 191; rules audit A5).
    return id === "unconscious" && !next.conditions.some((c) => c.id === "prone")
      ? { ...next, conditions: [...next.conditions, { id: "prone" as ConditionId }] }
      : next;
  }
  let next = s;
  if (id === "concentrating" && !s.concentration)
    next = { ...next, concentration: add.source ? { spellName: add.source } : {} };
  if (id === "deathsaves" && !s.deathSaves)
    next = { ...next, deathSaves: { successes: 0, failures: 0, stable: false, dead: false } };
  if (id === "stable")
    next = { ...next, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } };
  if (id === "dead")
    next = {
      ...next,
      concentration: undefined,
      deathSaves: { successes: 0, failures: 0, stable: false, dead: true },
    };
  if (next.markers.some((m) => m.id === id)) return next;
  return {
    ...next,
    markers: [
      ...next.markers,
      {
        id: id as TokenStatusT["markers"][number]["id"],
        ...(add.label ? { label: add.label } : {}),
        ...(add.untilRound ? { untilRound: add.untilRound } : {}),
        ...(add.color ? { color: add.color } : {}),
        ...(add.glyph ? { glyph: add.glyph } : {}),
        ...(add.description ? { description: add.description } : {}),
      },
    ],
  };
}

/** A creature's status with a condition or marker taken away. */
function withoutStatus(s: TokenStatusT, id: string): TokenStatusT {
  let next: TokenStatusT = {
    ...s,
    conditions: s.conditions.filter((c) => c.id !== id),
    markers: s.markers.filter((m) => m.id !== id),
  };
  if (id === "exhaustion") next = { ...next, exhaustion: 0 };
  if (id === "concentrating") next = { ...next, concentration: undefined };
  if (id === "deathsaves") next = { ...next, deathSaves: undefined };
  if ((id === "stable" || id === "dead") && next.deathSaves)
    next = { ...next, deathSaves: { ...next.deathSaves, [id]: false } };
  return next;
}

/**
 * `status.change` — conditions and markers on, conditions and markers off, the exhaustion level, concentration
 * (§8.11; AC-HP-04/05). The DM on anything; a player on their own creatures (not the DM's custom markers). Becoming
 * Incapacitated ends concentration; Exhaustion 6 asks the DM "Dead?" (§19.1, as prompts or at once).
 */
export const statusChange: CommandDef<
  z.infer<typeof StatusChange>,
  { conditions: string[]; markers: string[] }
> = {
  type: "status.change",
  schema: StatusChange as unknown as z.ZodType<z.infer<typeof StatusChange>>,
  undoable: true,
  authorize(ctx, p) {
    if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN", "Spectators watch.");
    const h = holderOf(ctx, p);
    if (!controls(ctx, h)) throw new GloamError("FORBIDDEN", "That creature isn't yours.");
    if (!isDm(ctx.actor.role)) {
      if (p.add?.some((a) => a.id.startsWith("custom:")))
        throw new GloamError("FORBIDDEN", "Only the DM adds custom markers.");
      const has = h.status.conditions.map((c) => c.id as string);
      for (const a of p.add ?? []) {
        const why = immuneToCondition(h.stats.conditionImmune, has, a.id);
        if (why)
          throw new GloamError(
            "INVALID",
            `${h.name} can't be ${statusName(a.id).toLowerCase()}${why === "own" ? "" : ` — ${why}`}.`,
          );
      }
    }
  },
  plan(ctx, p) {
    const h = holderOf(ctx, p);
    const before = h.status;
    let s = before;
    for (const id of p.remove ?? []) s = withoutStatus(s, id);
    for (const a of p.add ?? []) s = withStatus(s, a);
    if (p.exhaustion !== undefined) s = { ...s, exhaustion: p.exhaustion as TokenStatusT["exhaustion"] };
    if (p.concentration !== undefined)
      s =
        p.concentration === null
          ? { ...s, concentration: undefined }
          : { ...s, concentration: { spellName: p.concentration } };
    // What follows (§8.11 Automation, §19.5).
    const cons: Consequence[] = [];
    const ids = (x: TokenStatusT) => x.conditions.map((c) => c.id);
    if (s.concentration && incapacitates(ids(s)) && !incapacitates(ids(before))) {
      const cause =
        ids(s).find((c) => CONDITIONS[c].incapacitated && !ids(before).includes(c)) ?? "incapacitated";
      cons.push({ kind: "concentrationEnds", reason: statusName(cause) });
    }
    if (s.exhaustion >= 6 && before.exhaustion < 6 && !s.deathSaves?.dead)
      cons.push({ kind: "dying", reason: "exhaustion" });
    const { apply, ask } = sortConsequences(cons, ctx.model.campaign.houseRules.automation);
    s = fold(s, apply);
    const ops = holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status: s });
    const events: RoomEvent[] = [];
    if (ask.length) {
      const follow: Followups = {
        by: ctx.actor.userId,
        concentration: [],
        prompts: [
          {
            kind: "consequences",
            tokenId: h.token?.id ?? null,
            actorId: h.actor?.id ?? null,
            name: h.name,
            title: promptTitle(h.name, ask),
            detail: ask.some((c) => c.kind === "dying")
              ? "Exhaustion reached level 6"
              : "Became incapacitated",
            items: ask.map(itemOf),
          },
        ],
      };
      events.push({ name: FOLLOWUPS, payload: follow, to: { dms: true } });
    }
    if (kills(apply) && h.token)
      events.push({
        name: "hp.fx",
        payload: { tokenId: h.token.id, kind: "damage", amount: 0, dead: true } satisfies HpFx,
        to: { viewersOf: h.token.id },
      });
    const on = (p.add ?? []).map((a) => a.label ?? statusName(a.id));
    const off = (p.remove ?? []).map(statusName);
    const parts = [
      on.length ? `${on.join(", ")} on` : "",
      off.length ? `${off.join(", ")} off` : "",
      p.exhaustion !== undefined ? `Exhaustion ${p.exhaustion}` : "",
      p.concentration !== undefined
        ? p.concentration
          ? `concentrating on ${p.concentration}`
          : "concentration ended"
        : "",
    ].filter(Boolean);
    return {
      ops,
      summary: `${h.name}: ${parts.join("; ") || "status unchanged"}`,
      events,
      result: { conditions: s.conditions.map((c) => c.id), markers: s.markers.map((m) => m.id) },
    };
  },
};

/**
 * `health.consequences` (internal) — what the DM decided in a prompt, a failed concentration save, a death save's
 * roll: applied to the creature's status as it is now (not as it was when asked), one undoable step.
 */
export const healthConsequences: CommandDef<z.infer<typeof HealthConsequences>, { hp: number }> = {
  type: "health.consequences",
  schema: HealthConsequences as unknown as z.ZodType<z.infer<typeof HealthConsequences>>,
  undoable: true,
  internal: true,
  authorize(ctx, p) {
    holderOf(ctx, p);
  },
  plan(ctx, p) {
    const h = holderOf(ctx, p);
    const apply = p.items.map((i) => ({
      consequence: i.consequence as Consequence,
      ...(i.choice ? { choice: i.choice } : {}),
    }));
    let s = fold(h.status, apply);
    let hp = h.hp;
    if (p.deathSaves && !s.deathSaves?.dead) {
      const d = s.deathSaves ?? { successes: 0, failures: 0, stable: false, dead: false };
      s = {
        ...s,
        deathSaves: {
          ...d,
          successes: p.deathSaves.successes as 0 | 1 | 2 | 3,
          failures: p.deathSaves.failures as 0 | 1 | 2 | 3,
        },
      };
    }
    if (p.stable) s = withStatus(withoutStatus(s, "deathsaves"), { id: "stable" });
    const events: RoomEvent[] = [];
    if (p.regain) {
      const out = applyHealing(h, p.regain, isDead(s));
      hp = out.hp;
      if (out.revived) s = applyToStatus(s, { kind: "revive" });
      if (h.token)
        events.push({
          name: "hp.fx",
          payload: {
            tokenId: h.token.id,
            kind: "heal",
            amount: out.gained,
            ...(out.revived ? { revived: true } : {}),
          } satisfies HpFx,
          to: { viewersOf: h.token.id },
        });
    }
    if (kills(apply) && h.token)
      events.push({
        name: "hp.fx",
        payload: { tokenId: h.token.id, kind: "damage", amount: 0, dead: true } satisfies HpFx,
        to: { viewersOf: h.token.id },
      });
    const concentration: ConcentrationSpec[] = apply
      .filter(({ consequence: c }) => c.kind === "concentrationSave")
      .map(({ consequence: c }) => ({
        tokenId: h.token?.id ?? null,
        actorId: h.actor?.id ?? null,
        name: h.name,
        dc: (c as Extract<Consequence, { kind: "concentrationSave" }>).dc,
        ...(h.status.concentration?.spellName ? { spell: h.status.concentration.spellName } : {}),
      }));
    if (concentration.length)
      events.push({
        name: FOLLOWUPS,
        payload: { prompts: [], concentration, by: ctx.actor.userId } satisfies Followups,
        to: { dms: true },
      });
    return {
      ops: holderOps(ctx, h, { hp, hpTemp: h.hpTemp, status: s }),
      summary: p.summary,
      events,
      result: { hp },
    };
  },
};

export const StatusTurn = z.strictObject({
  tokenId: z.string().min(3).max(40),
  turnOf: z.string().min(3).max(40),
  when: z.enum(["start", "end"]),
});
/**
 * `status.turn` (internal): a turn ended or began — a creature's conditions tied to it end ("until the end of the
 * current turn", "… of your next turn", "until the start of your next turn"), or one more of those turns passes.
 */
export const statusTurn: CommandDef<z.infer<typeof StatusTurn>, { removed: string[] }> = {
  type: "status.turn",
  schema: StatusTurn,
  undoable: true,
  internal: true,
  authorize(ctx, p) {
    mustGet(ctx, "token", p.tokenId);
  },
  plan(ctx, p) {
    const h = holderOf(ctx, { tokenId: p.tokenId });
    const removed: string[] = [];
    let changed = false;
    const conditions = h.status.conditions.flatMap((c) => {
      if (p.when === "end" && c.endsWithTurnOf === p.turnOf) {
        changed = true;
        if ((c.turnsLeft ?? 0) > 0) return [{ ...c, turnsLeft: (c.turnsLeft ?? 0) - 1 }];
        removed.push(c.id);
        return [];
      }
      if (p.when === "start" && c.endsAtStartOf === p.turnOf) {
        changed = true;
        removed.push(c.id);
        return [];
      }
      return [c];
    });
    // Markers tied to a turn likewise (Disengaged at its end, Dodging at the start of the next; rules audit C3).
    const markers = h.status.markers.filter((m) => {
      const ends =
        (p.when === "end" && m.endsWithTurnOf === p.turnOf) ||
        (p.when === "start" && m.endsAtStartOf === p.turnOf);
      if (ends) {
        changed = true;
        removed.push(m.id);
      }
      return !ends;
    });
    if (!changed) return { ops: [], summary: "", result: { removed }, undoable: false };
    return {
      ops: holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status: { ...h.status, conditions, markers } }),
      summary: removed.length ? `${h.name}: ${removed.map((id) => statusName(id)).join(", ")} ended` : "",
      result: { removed },
    };
  },
};

export const HEALTH_COMMANDS = [hpApply, statusChange, healthConsequences, statusTurn] as CommandDef<
  never,
  unknown
>[];
