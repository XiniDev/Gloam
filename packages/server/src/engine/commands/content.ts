import { checkFormula } from "@gloam/shared/dice";
import { GloamError } from "@gloam/shared/protocol";
import { isDm } from "@gloam/shared/rules";
import { issueText, type Spell, SpellSchema } from "@gloam/shared/schemas";
import { z } from "zod";
import { newId } from "../../ids.ts";
import type { ContentEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/**
 * Homebrew spells (SPEC §8.13 Homebrew builder, Import; AC-SPL-10/11): a campaign's own spells beside the SRD's — the
 * DM's in use at once, a player's proposed for the DM to approve — each validated against the published spell schema
 * (§33.3, Appendix F.2; strict: an unknown field is an error) and its dice formulas against the dice grammar (§18.1).
 * Ids are one namespace with the SRD's: a homebrew spell never shadows an SRD one. Imports (the dialog, REST
 * `POST /api/v1/content/spells:import`, later MCP) validate every entry, report, and resolve clashes by skip, overwrite
 * (another homebrew spell only) or rename ("poison-ball-2").
 */

/** A spell's formulas that don't parse (damage, healing, their scaling, triggers'): where, and why. */
export function formulaIssues(s: Spell): string[] {
  const out: string[] = [];
  const check = (where: string, f: string | undefined) => {
    if (!f) return;
    const e = checkFormula(f);
    if (e) out.push(`${where}: ${e.message}`);
  };
  s.damage?.forEach((d, i) => {
    check(`damage[${i}].formula`, d.formula);
    if (d.scaling?.mode === "slot") check(`damage[${i}].scaling.perLevel`, d.scaling.perLevel);
    if (d.scaling?.mode === "cantrip")
      for (const [lvl, f] of Object.entries(d.scaling.atLevels))
        check(`damage[${i}].scaling.atLevels.${lvl}`, f);
  });
  if (s.healing) {
    check("healing.formula", s.healing.formula);
    if (s.healing.scaling?.mode === "slot") check("healing.scaling.perLevel", s.healing.scaling.perLevel);
  }
  s.effect?.triggers.forEach((t, i) => {
    check(`effect.triggers[${i}].damage.formula`, t.damage?.formula);
  });
  return out;
}

/** A homebrew spell as the room lists it. */
export interface HomebrewEntry {
  id: string;
  status: ContentEntity["status"];
  createdBy: string;
  createdByName: string;
  spell: Spell;
}

/** The homebrew spells one person may see: all of them for the DM, those in use and their own proposals for a player. */
export function homebrewFor(
  model: CommandCtx["model"],
  viewer: { userId: string; dm: boolean },
  nameOf: (userId: string) => string,
): HomebrewEntry[] {
  return model
    .all("content")
    .filter((c) => c.type === "spell" && c.campaignId === model.campaign.id)
    .filter(
      (c) =>
        viewer.dm ||
        c.status === "active" ||
        // Their own proposals (never another player's, nor the DM's private spells).
        (c.createdBy === viewer.userId && c.status !== "private"),
    )
    .map((c) => ({
      id: c.id,
      status: c.status,
      createdBy: c.createdBy,
      createdByName: nameOf(c.createdBy),
      spell: c.data as unknown as Spell,
    }))
    .sort((a, b) => a.spell.name.localeCompare(b.spell.name));
}

/**
 * The homebrew spell holding an id: one in use or the DM's own — and `forUser`'s own waiting proposals (by the id
 * they ask for; null: nobody's). `except`: the spell itself (an edit, an approval).
 */
function homebrewBySlug(
  ctx: CommandCtx,
  slug: string,
  forUser: string | null = null,
  except?: string,
): ContentEntity | undefined {
  return ctx.model
    .all("content")
    .find(
      (c) =>
        c.type === "spell" &&
        c.campaignId === ctx.model.campaign.id &&
        c.id !== except &&
        (((c.status === "active" || c.status === "private") && c.slug === slug) ||
          (forUser !== null &&
            c.createdBy === forUser &&
            c.status === "proposed" &&
            (c.data as { id?: string }).id === slug)),
    );
}

/**
 * A waiting proposal's slug: a placeholder that no spell id can be (ids are kebab-case) — a proposal holds no real id
 * (security review L8: it can't squat one the DM wants); approval gives it its id, or the next free one.
 */
const waitingSlug = (contentId: string) => `~${contentId}`;

/** Parses a spell for a campaign: the schema, the formulas, the homebrew pack's mark. */
function parseSpell(raw: unknown): { spell: Spell } | { errors: string[] } {
  const r = SpellSchema.safeParse(raw);
  if (!r.success)
    return {
      // In plain words (SPEC §8.10 "readable errors"): "level must be 9 or less (it's 12)".
      errors: r.error.issues
        .slice(0, 12)
        .map((i) => `${i.path.join(".") || "The spell"} ${issueText(i as never, raw)}`),
    };
  const bad = formulaIssues(r.data);
  if (bad.length) return { errors: bad };
  // Whatever pack it names, in a campaign it's homebrew (never passed off as the SRD's).
  return { spell: { ...r.data, source: { pack: "homebrew" } } };
}

export const ContentSpellSave = z.strictObject({
  spell: z.unknown(),
  /** The homebrew spell it replaces (an edit); absent: a new one. */
  replaces: z.string().min(3).max(40).optional(),
  /** The DM's alone (an NPC's signature spell): no player sees it or can cast it (security review L8). */
  private: z.boolean().optional(),
});

/** How many of a player's spells may wait on the DM at once (security review M5). */
export const PROPOSALS_MAX = 20;

/**
 * `content.spell.save` (§8.13 Homebrew builder): the DM's spell goes into use; a player's is a proposal the DM
 * approves (AC-SPL-10). An edit replaces its spell in place.
 */
export const contentSpellSave: CommandDef<
  z.infer<typeof ContentSpellSave>,
  { id: string; status: ContentEntity["status"] }
> = {
  type: "content.spell.save",
  schema: ContentSpellSave,
  undoable: true,
  authorize(ctx, p) {
    if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN", "Spectators watch.");
    if (p.replaces) {
      const c = mustGet(ctx, "content", p.replaces);
      if (!isDm(ctx.actor.role) && (c.createdBy !== ctx.actor.userId || c.status !== "proposed"))
        throw new GloamError("FORBIDDEN", "Only the DM changes a spell in use.");
    }
  },
  plan(ctx, p) {
    const parsed = parseSpell(p.spell);
    if ("errors" in parsed)
      throw new GloamError("INVALID", parsed.errors.join("; "), { errors: parsed.errors });
    const spell = parsed.spell;
    if (ctx.app.content.spellById.has(spell.id))
      throw new GloamError("CONFLICT", `"${spell.id}" is an SRD spell's id — give yours another.`);
    const dm = isDm(ctx.actor.role);
    // A clash with a spell in use (or the DM's own), or with this person's own proposal — another player's waiting
    // proposal holds no id (it can't squat one the DM wants, nor is its name told to anyone; security review L8).
    const clash = homebrewBySlug(ctx, spell.id, dm ? null : ctx.actor.userId);
    if (clash && clash.id !== p.replaces)
      throw new GloamError(
        "CONFLICT",
        clash.status === "proposed" && clash.createdBy !== ctx.actor.userId
          ? "That id is taken."
          : `There's already a homebrew spell "${clash.name}" with that id.`,
      );
    if (!dm && !p.replaces) {
      const waiting = ctx.model
        .all("content")
        .filter(
          (c) => c.type === "spell" && c.createdBy === ctx.actor.userId && c.status === "proposed",
        ).length;
      if (waiting >= PROPOSALS_MAX)
        throw new GloamError(
          "INVALID",
          `${PROPOSALS_MAX} of your spells are waiting on the DM — wait for those first.`,
        );
    }
    const status: ContentEntity["status"] = dm ? (p.private ? "private" : "active") : "proposed";
    if (p.replaces) {
      const c = mustGet(ctx, "content", p.replaces);
      return {
        ops: setOps("content", c, {
          // A proposal (still waiting, or sent back to wait) keeps its placeholder.
          slug:
            dm && c.status !== "proposed" ? spell.id : c.status === "proposed" ? c.slug : waitingSlug(c.id),
          name: spell.name,
          data: spell as unknown as Record<string, unknown>,
          status: dm
            ? p.private !== undefined && c.status !== "proposed"
              ? p.private
                ? "private"
                : "active"
              : c.status === "rejected"
                ? "active"
                : c.status
            : "proposed",
          updatedAt: ctx.now,
        }),
        summary: `Homebrew spell ${spell.name} changed`,
        result: { id: c.id, status: dm ? "active" : "proposed" },
      };
    }
    const cid = newId("cnt");
    const c: ContentEntity = {
      id: cid,
      campaignId: ctx.model.campaign.id,
      pack: "homebrew",
      type: "spell",
      slug: dm ? spell.id : waitingSlug(cid),
      name: spell.name,
      data: spell as unknown as Record<string, unknown>,
      status,
      createdBy: ctx.actor.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    return {
      ops: [createOp("content", c)],
      summary: dm
        ? `Homebrew spell ${spell.name} added`
        : `${ctx.actor.name} proposed the spell ${spell.name}`,
      result: { id: c.id, status },
    };
  },
};

export const ContentSpellDecide = z.strictObject({ id: z.string().min(3).max(40), approve: z.boolean() });
/** `content.spell.decide` (DM): a player's proposed spell approved (in use) or rejected. */
export const contentSpellDecide: CommandDef<z.infer<typeof ContentSpellDecide>, { status: string }> = {
  type: "content.spell.decide",
  schema: ContentSpellDecide,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    const c = mustGet(ctx, "content", p.id);
    if (c.status !== "proposed") throw new GloamError("CONFLICT", "That spell isn't waiting on you.");
  },
  plan(ctx, p) {
    const c = mustGet(ctx, "content", p.id);
    const status = p.approve ? "active" : "rejected";
    // Approved: under the id it asks for — or the next free one, if a spell took that meanwhile.
    const asked = String((c.data as { id?: string }).id ?? c.slug);
    let slug = asked;
    if (p.approve)
      for (let n = 2; ctx.app.content.spellById.has(slug) || homebrewBySlug(ctx, slug, null, c.id); n++)
        slug = `${asked}-${n}`;
    return {
      ops: setOps(
        "content",
        c,
        !p.approve
          ? { status, updatedAt: ctx.now }
          : { status, slug, data: { ...c.data, id: slug }, updatedAt: ctx.now },
      ),
      summary: `${c.name} ${p.approve ? "approved" : "rejected"}${p.approve && slug !== asked ? ` (as "${slug}")` : ""}`,
      result: { status },
    };
  },
};

export const ContentSpellDelete = z.strictObject({ id: z.string().min(3).max(40) });
/** `content.spell.delete` (the DM; a player their own proposal). */
export const contentSpellDelete: CommandDef<z.infer<typeof ContentSpellDelete>, { ok: true }> = {
  type: "content.spell.delete",
  schema: ContentSpellDelete,
  undoable: true,
  authorize(ctx, p) {
    const c = mustGet(ctx, "content", p.id);
    if (isDm(ctx.actor.role)) return;
    if (c.createdBy !== ctx.actor.userId || c.status === "active")
      throw new GloamError("FORBIDDEN", "Only the DM removes a spell in use.");
  },
  plan(ctx, p) {
    const c = mustGet(ctx, "content", p.id);
    return {
      ops: [deleteOp("content", c)],
      summary: `Homebrew spell ${c.name} removed`,
      result: { ok: true },
    };
  },
};

/** What an import did (or would do, dry). */
export interface ImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: { index: number; name: string | null; errors: string[] }[];
  conflicts: { index: number; id: string; name: string; with: "srd" | "homebrew" }[];
  imported: string[];
  overwritten: string[];
  renamed: { from: string; to: string }[];
  skipped: string[];
  /** Each valid spell by its place in the list: its id as it goes in (renamed, if it was) and what becomes of it. */
  spells: { index: number; id: string; name: string; outcome: "import" | "overwrite" | "rename" | "skip" }[];
}

export const ContentSpellImport = z.strictObject({
  spells: z.array(z.unknown()).min(1).max(1000),
  dryRun: z.boolean().default(true),
  strategy: z.enum(["skip", "overwrite", "rename"]).default("skip"),
});

/**
 * `content.spell.import` (DM; AC-SPL-11): a list of spells in the published schema, each validated; a dry run reports
 * what would happen (valid, invalid with why, clashes with the SRD's or the campaign's own) and changes nothing; a real
 * one imports the valid ones — a clash skipped, overwritten (a homebrew spell; never an SRD one, which is renamed
 * instead) or renamed with the next free "-2", "-3". One undoable step.
 */
export const contentSpellImport: CommandDef<z.infer<typeof ContentSpellImport>, ImportReport> = {
  type: "content.spell.import",
  schema: ContentSpellImport as unknown as z.ZodType<z.infer<typeof ContentSpellImport>>,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const report: ImportReport = {
      dryRun: p.dryRun,
      total: p.spells.length,
      valid: 0,
      invalid: [],
      conflicts: [],
      imported: [],
      overwritten: [],
      renamed: [],
      skipped: [],
      spells: [],
    };
    const ops: Op[] = [];
    // Ids taken so far: the SRD's, the campaign's, and those this import has given out.
    const taken = new Set<string>([
      ...ctx.app.content.spellById.keys(),
      ...ctx.model
        .all("content")
        .filter(
          (c) => c.type === "spell" && c.campaignId === ctx.model.campaign.id && c.status !== "rejected",
        )
        .map((c) => c.slug),
    ]);
    const fresh = (id: string) => {
      for (let n = 2; ; n++) {
        const next = `${id}-${n}`.slice(0, 80);
        if (!taken.has(next)) return next;
      }
    };
    p.spells.forEach((raw, index) => {
      const parsed = parseSpell(raw);
      if ("errors" in parsed) {
        const name =
          raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
            ? (raw as { name: string }).name.slice(0, 80)
            : null;
        report.invalid.push({ index, name, errors: parsed.errors });
        return;
      }
      report.valid++;
      let spell = parsed.spell;
      let outcome: "import" | "rename" = "import";
      const srd = ctx.app.content.spellById.has(spell.id);
      const own = srd ? undefined : homebrewBySlug(ctx, spell.id);
      const dup = !srd && !own && taken.has(spell.id);
      if (srd || own || dup) {
        report.conflicts.push({ index, id: spell.id, name: spell.name, with: srd ? "srd" : "homebrew" });
        const strategy = srd && p.strategy === "overwrite" ? "rename" : p.strategy;
        if (strategy === "skip") {
          report.skipped.push(spell.id);
          report.spells.push({ index, id: spell.id, name: spell.name, outcome: "skip" });
          return;
        }
        if (strategy === "overwrite" && own) {
          report.overwritten.push(spell.id);
          report.spells.push({ index, id: spell.id, name: spell.name, outcome: "overwrite" });
          if (!p.dryRun)
            ops.push(
              ...setOps("content", own, {
                name: spell.name,
                data: spell as unknown as Record<string, unknown>,
                status: "active",
                updatedAt: ctx.now,
              }),
            );
          return;
        }
        const to = fresh(spell.id);
        report.renamed.push({ from: spell.id, to });
        spell = { ...spell, id: to };
        outcome = "rename";
      }
      taken.add(spell.id);
      report.imported.push(spell.id);
      report.spells.push({ index, id: spell.id, name: spell.name, outcome });
      if (!p.dryRun)
        ops.push(
          createOp("content", {
            id: newId("cnt"),
            campaignId: ctx.model.campaign.id,
            pack: "homebrew",
            type: "spell",
            slug: spell.id,
            name: spell.name,
            data: spell as unknown as Record<string, unknown>,
            status: "active",
            createdBy: ctx.actor.userId,
            createdAt: ctx.now,
            updatedAt: ctx.now,
          }),
        );
    });
    const n = report.imported.length + report.overwritten.length;
    return {
      ops,
      summary: `Imported ${n} spell${n === 1 ? "" : "s"}${report.skipped.length ? `, skipped ${report.skipped.length}` : ""}`,
      result: report,
      ...(ops.length ? {} : { undoable: false }),
    };
  },
};

export const CONTENT_COMMANDS = [
  contentSpellSave,
  contentSpellDecide,
  contentSpellDelete,
  contentSpellImport,
] as unknown as CommandDef<never, unknown>[];
