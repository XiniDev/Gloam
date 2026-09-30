import { SKILLS } from "@gloam/shared";
import { checkFormula } from "@gloam/shared/dice";
import { GloamError } from "@gloam/shared/protocol";
import { issueText, type Monster, MonsterSchema, Sheet } from "@gloam/shared/schemas";
import { z } from "zod";
import { newId } from "../../ids.ts";
import type { ActorEntity, ContentEntity } from "../codecs.ts";
import type { CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, requireDm, setOps } from "../plan.ts";
import { assertSheetAssets, checkSheet, newActor } from "./actor.ts";

/**
 * Imports through the local API (SPEC §8.23, §26.1; AC-API-04): homebrew monsters and characters, each a list checked
 * entry by entry against the published schema, a dry run reporting what would happen and changing nothing, a real one
 * making the valid entries in one undoable step.
 *
 * A monster (Appendix F.4) becomes an NPC sheet — what the DM panel's Bestiary places, each copy with its own HP —
 * and a homebrew content row that keeps its id (the clash key: skip, overwrite or rename, as spells do) and which
 * sheet it made.
 */

const IdRef = z.string().min(1).max(40);

/** One entry refused: where and why, in words. */
export interface ImportIssue {
  path: string;
  message: string;
}

// ── Monsters ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MonsterImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: { index: number; name: string | null; issues: ImportIssue[] }[];
  imported: string[];
  overwritten: string[];
  renamed: { from: string; to: string }[];
  skipped: string[];
  /** Each valid monster by its place in the list: its id as it goes in, what becomes of it, its sheet (real runs). */
  monsters: {
    index: number;
    id: string;
    name: string;
    outcome: "import" | "overwrite" | "rename" | "skip";
    actorId?: string;
  }[];
}

export const ContentMonsterImport = z.strictObject({
  monsters: z.array(z.unknown()).min(1).max(500),
  dryRun: z.boolean().default(true),
  strategy: z.enum(["skip", "overwrite", "rename"]).default("skip"),
});

const mod = (score: number) => Math.floor((score - 10) / 2);

/** A monster as an NPC sheet: its numbers where automation reads them, its words in features and notes. */
export function monsterSheet(m: Monster): Sheet {
  const dice = m.hp.formula?.match(/^\s*(\d+)\s*d\s*(6|8|10|12)\b/);
  const typeLine = `${m.type.charAt(0).toUpperCase()}${m.type.slice(1)}`;
  return Sheet.parse({
    core: {
      name: m.name,
      species: typeLine,
      ...(m.alignment ? { alignment: m.alignment } : {}),
      size: m.size,
      abilities: m.abilities,
      ac: { value: m.ac, ...(m.acNote ? { note: m.acNote } : {}) },
      hp: { max: m.hp.average, current: m.hp.average, temp: 0 },
      ...(dice ? { hitDice: [{ die: `d${dice[2]}`, total: Math.min(99, Number(dice[1])) }] } : {}),
      speeds: m.speeds,
      senses: m.senses,
      // The stat block's whole bonuses, as what's on top of the ability modifier.
      saves: Object.fromEntries(
        Object.entries(m.saves).map(([a, total]) => [
          a,
          { proficient: false, bonus: (total ?? 0) - mod(m.abilities[a as keyof typeof m.abilities]) },
        ]),
      ),
      skills: Object.fromEntries(
        Object.entries(m.skills).map(([k, total]) => [
          k,
          { prof: "none", bonus: (total ?? 0) - mod(m.abilities[SKILLS[k as keyof typeof SKILLS]]) },
        ]),
      ),
      resistances: m.resistances,
      immunities: m.immunities,
      vulnerabilities: m.vulnerabilities,
      conditionImmunities: m.conditionImmunities,
      languages: m.languages,
      attacks: m.attacks,
      features: m.features,
      ...(m.tokenAssetId ? { tokenAssetId: m.tokenAssetId } : {}),
      notes: [`${typeLine} · Challenge ${m.cr}`, m.statBlockMarkdown.trim()].filter(Boolean).join("\n\n"),
    },
  });
}

/** A monster checked: the schema, then its dice (hit points, attacks). */
function parseMonster(raw: unknown): { monster: Monster } | { issues: ImportIssue[] } {
  const r = MonsterSchema.safeParse(raw);
  if (!r.success)
    return {
      issues: r.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join(".") || "(the monster)",
        message: issueText(i as never, raw),
      })),
    };
  const m = r.data;
  const issues: ImportIssue[] = [];
  const check = (path: string, f: string | undefined) => {
    const e = f ? checkFormula(f) : null;
    if (e) issues.push({ path, message: e.message });
  };
  check("hp.formula", m.hp.formula);
  m.attacks.forEach((a, i) => {
    check(`attacks.${i}.attack`, a.attack);
    check(`attacks.${i}.damage`, a.damage);
  });
  if (issues.length) return { issues };
  // Whatever pack it names, in a campaign it's homebrew.
  return { monster: { ...m, source: { pack: "homebrew" } } };
}

const nameOf = (raw: unknown) =>
  raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
    ? (raw as { name: string }).name.slice(0, 80)
    : null;

/**
 * `content.monster.import` (DM; §26.1 `POST /content/monsters:import`): each valid monster becomes an NPC sheet in
 * the Bestiary; a clash with one imported before is skipped, overwritten (its sheet replaced) or renamed ("-2").
 */
export const contentMonsterImport: CommandDef<z.infer<typeof ContentMonsterImport>, MonsterImportReport> = {
  type: "content.monster.import",
  schema: ContentMonsterImport as unknown as z.ZodType<z.infer<typeof ContentMonsterImport>>,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const report: MonsterImportReport = {
      dryRun: p.dryRun,
      total: p.monsters.length,
      valid: 0,
      invalid: [],
      imported: [],
      overwritten: [],
      renamed: [],
      skipped: [],
      monsters: [],
    };
    const ops: Op[] = [];
    const mine = ctx.model
      .all("content")
      .filter((c) => c.type === "monster" && c.campaignId === ctx.model.campaign.id);
    const own = (slug: string) => mine.find((c) => c.slug === slug);
    const taken = new Set(mine.map((c) => c.slug));
    const fresh = (id: string) => {
      for (let n = 2; ; n++) {
        const next = `${id}-${n}`.slice(0, 80);
        if (!taken.has(next)) return next;
      }
    };
    p.monsters.forEach((raw, index) => {
      const parsed = parseMonster(raw);
      if ("issues" in parsed) {
        report.invalid.push({ index, name: nameOf(raw), issues: parsed.issues });
        return;
      }
      let m = parsed.monster;
      let sheet: Sheet;
      try {
        sheet = monsterSheet(m);
        assertSheetAssets(ctx, null, sheet);
      } catch (e) {
        report.invalid.push({
          index,
          name: m.name,
          issues: [{ path: "tokenAssetId", message: (e as Error).message }],
        });
        return;
      }
      report.valid++;
      const clash = own(m.id);
      let outcome: "import" | "rename" = "import";
      if (taken.has(m.id)) {
        if (p.strategy === "skip") {
          report.skipped.push(m.id);
          report.monsters.push({ index, id: m.id, name: m.name, outcome: "skip" });
          return;
        }
        if (p.strategy === "overwrite" && clash) {
          report.overwritten.push(m.id);
          const entry = { index, id: m.id, name: m.name, outcome: "overwrite" as const };
          if (p.dryRun) {
            report.monsters.push(entry);
            return;
          }
          const actorId = (clash.data as { actorId?: string }).actorId;
          const actor = actorId ? ctx.model.get("actor", actorId) : undefined;
          let sheetOf: string;
          if (actor && actor.deletedAt === null) {
            ops.push(
              ...setOps("actor", actor, {
                sheet: newActor(ctx, "npc", null, sheet).sheet,
                updatedAt: ctx.now,
              }),
            );
            sheetOf = actor.id;
          } else {
            // Its sheet was deleted since: a new one.
            const made = newActor(ctx, "npc", null, sheet);
            ops.push(createOp("actor", made));
            sheetOf = made.id;
          }
          ops.push(
            ...setOps("content", clash, {
              name: m.name,
              data: { ...m, actorId: sheetOf } as unknown as Record<string, unknown>,
              updatedAt: ctx.now,
            }),
          );
          report.monsters.push({ ...entry, actorId: sheetOf });
          return;
        }
        const to = fresh(m.id);
        report.renamed.push({ from: m.id, to });
        m = { ...m, id: to };
        outcome = "rename";
      }
      taken.add(m.id);
      report.imported.push(m.id);
      if (p.dryRun) {
        report.monsters.push({ index, id: m.id, name: m.name, outcome });
        return;
      }
      const actor: ActorEntity = newActor(ctx, "npc", null, sheet);
      const row: ContentEntity = {
        id: newId("cnt"),
        campaignId: ctx.model.campaign.id,
        pack: "homebrew",
        type: "monster",
        slug: m.id,
        name: m.name,
        data: { ...m, actorId: actor.id } as unknown as Record<string, unknown>,
        status: "active",
        createdBy: ctx.actor.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      ops.push(createOp("actor", actor), createOp("content", row));
      report.monsters.push({ index, id: m.id, name: m.name, outcome, actorId: actor.id });
    });
    const n = report.imported.length + report.overwritten.length;
    return {
      ops,
      summary: `Imported ${n} monster${n === 1 ? "" : "s"}${report.skipped.length ? `, skipped ${report.skipped.length}` : ""}`,
      result: report,
      ...(ops.length ? {} : { undoable: false }),
    };
  },
};

// ── Characters ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActorImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: { index: number; name: string | null; issues: ImportIssue[] }[];
  /** Each valid sheet by its place in the list, and (real runs) the character it made. */
  created: { index: number; name: string; actorId?: string }[];
}

export const ActorImport = z.strictObject({
  sheets: z.array(z.unknown()).min(1).max(100),
  dryRun: z.boolean().default(true),
  /** Whose characters they are (null: the DMs'). */
  ownerUserId: IdRef.nullable().default(null),
});

/** `actor.import` (DM; §26.1 `POST /actors:import`): whole character sheets (Appendix F.3), each checked. */
export const actorImport: CommandDef<z.infer<typeof ActorImport>, ActorImportReport> = {
  type: "actor.import",
  schema: ActorImport as unknown as z.ZodType<z.infer<typeof ActorImport>>,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    if (p.ownerUserId && !ctx.app.campaigns.membership(ctx.model.campaign.id, p.ownerUserId))
      throw new GloamError("NOT_FOUND", "That person doesn't play in this campaign.");
  },
  plan(ctx, p) {
    const report: ActorImportReport = {
      dryRun: p.dryRun,
      total: p.sheets.length,
      valid: 0,
      invalid: [],
      created: [],
    };
    const ops: Op[] = [];
    p.sheets.forEach((raw, index) => {
      const core = raw && typeof raw === "object" ? (raw as { core?: { name?: unknown } }).core : undefined;
      const name = typeof core?.name === "string" ? core.name.slice(0, 80) : null;
      let sheet: Sheet;
      try {
        sheet = checkSheet(raw);
        assertSheetAssets(ctx, null, sheet);
      } catch (e) {
        const detail = (e as GloamError).detail as { issues?: ImportIssue[] } | undefined;
        report.invalid.push({
          index,
          name,
          issues: detail?.issues ?? [{ path: "(the sheet)", message: (e as Error).message }],
        });
        return;
      }
      report.valid++;
      if (p.dryRun) {
        report.created.push({ index, name: sheet.core.name });
        return;
      }
      const actor = newActor(ctx, "character", p.ownerUserId, sheet);
      ops.push(createOp("actor", actor));
      report.created.push({ index, name: sheet.core.name, actorId: actor.id });
    });
    const n = p.dryRun ? 0 : report.created.length;
    return {
      ops,
      summary: `Imported ${n} character${n === 1 ? "" : "s"}`,
      result: report,
      ...(ops.length ? {} : { undoable: false }),
    };
  },
};

export const IMPORT_COMMANDS = [contentMonsterImport, actorImport] as unknown as CommandDef<never, unknown>[];
