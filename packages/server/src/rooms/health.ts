/**
 * The room's half of HP, conditions and death (SPEC §8.11): what a health command leaves to follow — the DM's prompts
 * and concentration saves — and what the answers bring. A prompt the DM applies (or skips) runs as that DM's own
 * undoable command; a concentration save that fails ends concentration (at once under Auto, as a prompt under
 * Assist); a death saving throw moves the tally (a natural 20 brings the creature back with 1 HP, three failures ask
 * the DM "Mark dead?"). Undoing the command a prompt came from closes the prompt.
 */
import {
  type ConsequenceIn,
  type DmPromptView,
  GloamError,
  type PromptResolve,
  type RequestCard,
} from "@gloam/shared/protocol";
import {
  type Consequence,
  deathSave,
  describeConsequence,
  hitDieHealing,
  nextHitDie,
} from "@gloam/shared/rules";
import type { z } from "zod";
import type { RequestResponse, RequestService, RequestTarget, RollRequest } from "../dice/requests.ts";
import type { RollRecord } from "../dice/service.ts";
import type { CommandActor, CommandBus, CommandCtx } from "../engine/commandBus.ts";
import { readSheet } from "../engine/commands/actor.ts";
import type { ConcentrationSpec, Followups, PromptSpec } from "../engine/commands/health.ts";
import { holderOf } from "../engine/commands/health.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import type { CampaignModel } from "../engine/model.ts";
import { type DmPrompt, type PromptService, promptView } from "../health/prompts.ts";
import { roomCtx } from "./roomContext.ts";

/** A request the room asks on the rules' behalf (a concentration save, a death saving throw). */
export interface SystemRequest {
  targets: string[];
  type: "save" | "custom";
  ability?: "con";
  formula?: string;
  label: string;
  dc?: number;
  visibility: "public" | "dm";
  createdBy: string;
  purpose: NonNullable<RollRequest["purpose"]>;
}

export interface HealthHost {
  readonly campaignId: string;
  model(): CampaignModel;
  bus(): CommandBus;
  prompts(): PromptService;
  requests(): RequestService;
  toDms(type: string, payload: unknown): void;
  toUser(userId: string, type: string, payload: unknown): void;
  /** Someone at this table as a command's actor (their role and name now). */
  actorOf(userId: string): CommandActor;
  /** Asks creatures for a roll (cards to their players, the board to the DMs). */
  ask(r: SystemRequest): RollRequest;
  sendRequest(r: RollRequest): void;
}

export class HealthFlow {
  private readonly host: HealthHost;
  constructor(host: HealthHost) {
    this.host = host;
  }

  /** A read-only command context (the holder of a creature's HP and status, as it is now). */
  private ctx(): CommandCtx {
    return { actor: SYSTEM_ACTOR, model: this.host.model(), app: roomCtx(), now: Date.now() };
  }

  private open(spec: PromptSpec, by: string, entryId: number | null): DmPrompt {
    const p = this.host.prompts().create({
      ...spec,
      campaignId: this.host.campaignId,
      createdBy: by,
      entryId,
    });
    this.host.toDms("prompt.update", promptView(p));
    return p;
  }

  /** A health command's follow-ups, after its commit. */
  followups(f: Followups, entryId: number | null): void {
    for (const spec of f.prompts) this.open(spec, f.by, entryId);
    for (const c of f.concentration) this.askConcentration(c, f.by);
  }

  /** A concentration save (AC-HP-07): a CON save at the damage's DC, for the creature's owner (the DM's otherwise). */
  private askConcentration(c: ConcentrationSpec, by: string): void {
    const target = c.tokenId ?? c.actorId;
    if (!target) return;
    this.host.ask({
      targets: [target],
      type: "save",
      ability: "con",
      label: `Concentration${c.spell ? ` · ${c.spell}` : ""}`,
      dc: c.dc,
      visibility: "public",
      createdBy: by,
      purpose: c.spell ? { kind: "concentration", spell: c.spell } : { kind: "concentration" },
    });
  }

  /** The DMs' open prompts. */
  list(): DmPromptView[] {
    return this.host.prompts().open(this.host.campaignId).map(promptView);
  }

  /**
   * The DM applies a prompt — the items kept, each with its choice — or skips it. A player's damage runs as the DM's
   * `hp.apply`, with the DM's total and decisions.
   */
  resolve(dm: CommandActor, p: z.infer<typeof PromptResolve>): DmPromptView {
    const prompts = this.host.prompts();
    const prompt = prompts.get(p.promptId);
    if (!prompt || prompt.campaignId !== this.host.campaignId)
      throw new GloamError("NOT_FOUND", "That prompt no longer exists.");
    if (prompt.status !== "open") throw new GloamError("CONFLICT", "That was already decided.");
    let applied = false;
    if (p.apply) {
      const ref = prompt.tokenId ? { tokenId: prompt.tokenId } : { actorId: prompt.actorId as string };
      if (prompt.kind === "playerDamage" && prompt.damage && prompt.tokenId) {
        const d = prompt.damage;
        const bus = this.host.bus();
        bus.execute(
          "hp.apply",
          {
            targets: [prompt.tokenId],
            kind: d.kind,
            halved: d.halved,
            crit: d.crit,
            ...(d.parts ? { parts: d.parts } : {}),
            ...(d.amount !== undefined ? { amount: d.amount } : {}),
            ...(d.label ? { label: `${d.label} — from ${d.byName}` } : { label: `from ${d.byName}` }),
            ...(p.total !== undefined ? { totals: { [prompt.tokenId]: p.total } } : {}),
            ...(p.keep
              ? {
                  decide: {
                    [prompt.tokenId]: { keep: p.keep, ...(p.choices ? { choices: p.choices } : {}) },
                  },
                }
              : {}),
          },
          dm,
        );
        applied = true;
      } else {
        const keep = prompt.items.filter((i) => !p.keep || p.keep.includes(i.key));
        const items = keep.map((i) => {
          const choice = p.choices?.[i.key] ?? i.choice;
          if (i.choices && choice && !i.choices.some((c) => c.id === choice))
            throw new GloamError("INVALID", `“${choice}” isn't one of the choices.`);
          return {
            consequence: i.consequence as z.infer<typeof ConsequenceIn>,
            ...(choice ? { choice } : {}),
          };
        });
        if (items.length) {
          this.host.bus().execute(
            "health.consequences",
            {
              ...ref,
              items,
              summary: `${prompt.title}: ${keep.map((i) => choiceText(i, p.choices?.[i.key])).join("; ")}`,
            },
            dm,
          );
          applied = true;
        }
      }
    }
    const done = prompts.resolve(prompt, applied ? "applied" : "skipped", dm.userId);
    this.host.toDms("prompt.update", promptView(done));
    if (prompt.kind === "playerDamage")
      this.host.toUser(prompt.createdBy, "prompt.decided", {
        title: prompt.title,
        applied,
        name: prompt.name,
      });
    return promptView(done);
  }

  /** Undoing the command a prompt came from closes the prompt (it no longer applies). */
  undone(entryId: number, by: string): void {
    const prompts = this.host.prompts();
    for (const p of prompts.fromEntry(this.host.campaignId, entryId)) {
      const done = prompts.resolve(p, "skipped", by);
      this.host.toDms("prompt.update", promptView(done));
    }
  }

  /**
   * Death saving throws outside combat (§8.11 "Request death save"): each target that's dying — at 0 HP with death
   * saves running, not stable, not dead — gets a card: Roll / Enter physical / Skip, DC 10, its hearts and skulls.
   */
  requestDeathSaves(dm: CommandActor, targets: readonly string[]): { requestId: string; asked: number } {
    const ctx = this.ctx();
    const dying = [...new Set(targets)].filter((id) => {
      const h = holderOf(ctx, { tokenId: id });
      const d = h.status.deathSaves;
      return h.hp <= 0 && d && !d.stable && !d.dead;
    });
    if (!dying.length)
      throw new GloamError("INVALID", "None of them is dying (at 0 HP, making death saves).");
    const everyone = this.host.model().campaign.houseRules.deathSavesVisibleTo === "everyone";
    const r = this.host.ask({
      targets: dying,
      type: "custom",
      formula: "1d20",
      label: "Death saving throw",
      dc: 10,
      visibility: everyone ? "public" : "dm",
      createdBy: dm.userId,
      purpose: { kind: "deathSave" },
    });
    return { requestId: r.id, asked: dying.length };
  }

  /**
   * A short rest's Hit Die (§8.11 Rests): its player's card — Roll / Enter / Skip — for the largest die left, while
   * the character is hurt; each answer brings the next.
   */
  askHitDie(actorId: string, by: string): void {
    const actor = this.host.model().get("actor", actorId);
    if (!actor || actor.deletedAt !== null) return;
    const next = nextHitDie(readSheet(actor));
    if (!next) return;
    // Where the character stands on the board now (its roll then shows there), else the character itself.
    const scene = this.host.model().activeScene?.id;
    const token = this.host
      .model()
      .all("token")
      .find((t) => t.actorId === actorId && t.link === "linked" && t.sceneId === scene);
    this.host.ask({
      targets: [token?.id ?? actorId],
      type: "custom",
      formula: `1${next.die} + @con`,
      label: `Spend a Hit Die (${next.die}, ${next.left} left)`,
      visibility: "public",
      createdBy: by,
      purpose: { kind: "hitDie", die: next.die, actorId },
    });
  }

  /** What a card shows beyond the request itself (a death save's hearts and skulls so far). */
  cardExtra(r: RollRequest, t: RequestTarget): Partial<RequestCard> {
    if (r.purpose?.kind !== "deathSave") return {};
    try {
      const h = holderOf(this.ctx(), t.kind === "token" ? { tokenId: t.id } : { actorId: t.id });
      return {
        deathSaves: {
          successes: h.status.deathSaves?.successes ?? 0,
          failures: h.status.deathSaves?.failures ?? 0,
        },
      };
    } catch {
      return {};
    }
  }

  /** A target answered a request the rules asked for: what its roll brings. */
  answered(r: RollRequest, t: RequestTarget, res: RequestResponse, roll: RollRecord | null): void {
    if (!r.purpose || res.state === "skipped" || res.total === undefined) return;
    const ref = t.kind === "token" ? { tokenId: t.id } : { actorId: t.id };
    let h: ReturnType<typeof holderOf>;
    try {
      h = holderOf(this.ctx(), ref);
    } catch {
      return;
    }
    const by = this.host.actorOf(r.createdBy);
    if (r.purpose.kind === "hitDie") {
      // The roll with its Con modifier, at least 1 HP (SRD 5.2.1 p. 187); then the next die, if any is left.
      const { actorId, die } = r.purpose;
      this.host.bus().execute("rest.hitDie", { actorId, die, heal: hitDieHealing(res.total) }, by);
      this.askHitDie(actorId, r.createdBy);
      return;
    }
    if (r.purpose.kind === "concentration") {
      if (res.success !== false || !h.status.concentration) return;
      const spell = h.status.concentration.spellName;
      const ends: Consequence = { kind: "concentrationEnds", reason: `failed the DC ${r.dc ?? 10} save` };
      const automation = this.host.model().campaign.houseRules.automation;
      if (automation === "auto")
        this.host.bus().execute(
          "health.consequences",
          {
            ...ref,
            items: [{ consequence: ends }],
            summary: `${h.name} lost concentration${spell ? ` on ${spell}` : ""}`,
          },
          by,
        );
      else if (automation === "assist")
        this.open(
          {
            kind: "consequences",
            tokenId: h.token?.id ?? null,
            actorId: h.actor?.id ?? null,
            name: h.name,
            title: `${h.name}: concentration`,
            detail: `Rolled ${res.total} against DC ${r.dc ?? 10}${spell ? ` (${spell})` : ""}`,
            items: [{ key: ends.kind, consequence: ends, ...describeConsequence(ends) }],
          },
          r.createdBy,
          null,
        );
      return;
    }
    // A death saving throw (§19.5): DC 10; a natural 20 is back with 1 HP; a 1 is two failures; three of either.
    const d = h.status.deathSaves;
    if (!d || d.dead || d.stable || h.hp > 0) return;
    const natural = roll?.natural ?? res.total;
    const out = deathSave({ successes: d.successes, failures: d.failures }, natural, res.total);
    const bus = this.host.bus();
    if (out.regain) {
      bus.execute(
        "health.consequences",
        { ...ref, items: [], regain: 1, summary: `${h.name} is back on their feet (a natural 20)` },
        by,
      );
      for (const u of t.controllers)
        this.host.toUser(u, "health.notice", { kind: "backOnFeet", name: h.name });
      this.host.toDms("health.notice", { kind: "backOnFeet", name: h.name });
      return;
    }
    bus.execute(
      "health.consequences",
      {
        ...ref,
        items: [],
        deathSaves: { successes: out.successes, failures: out.failures },
        ...(out.stable ? { stable: true } : {}),
        summary: `${h.name}'s death save: ${res.total}${natural === 1 ? " (a natural 1)" : ""} — ${out.successes} successes, ${out.failures} failures${out.stable ? ", stable" : ""}`,
      },
      by,
    );
    if (out.dying) {
      const c: Consequence = { kind: "dying", reason: "failures" };
      this.open(
        {
          kind: "consequences",
          tokenId: h.token?.id ?? null,
          actorId: h.actor?.id ?? null,
          name: h.name,
          title: `${h.name}: dead?`,
          detail: "Three failed death saves",
          items: [{ key: c.kind, consequence: c, ...describeConsequence(c) }],
        },
        r.createdBy,
        null,
      );
    }
  }
}

/** An item as applied, in words ("At 0 HP: Unconscious"). */
function choiceText(i: DmPromptView["items"][number], choice: string | undefined): string {
  const c = choice ?? i.choice;
  const label = c ? i.choices?.find((x) => x.id === c)?.label : undefined;
  return label ? `${i.label}: ${label}` : i.label;
}
