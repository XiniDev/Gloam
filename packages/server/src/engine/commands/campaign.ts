import { GloamError } from "@gloam/shared/protocol";
import { can } from "@gloam/shared/rules";
import { CampaignPatch } from "@gloam/shared/schemas";
import type { CommandDef } from "../commandBus.ts";
import { clone, jsonEqual, type Op } from "../ops.ts";

/** `campaign.update`: rename, units, house rules and campaign settings (DM or Admin). */
export const campaignUpdate: CommandDef<CampaignPatch, { changed: number }> = {
  type: "campaign.update",
  schema: CampaignPatch,
  undoable: true,
  authorize(ctx) {
    if (!can(ctx.actor.role, "scene.edit")) throw new GloamError("FORBIDDEN");
  },
  plan(ctx, p) {
    const c = ctx.model.campaign;
    const ops: Op[] = [];
    const set = (path: string[], value: unknown, prev: unknown) => {
      if (!jsonEqual(value, prev))
        ops.push({ k: "set", e: "campaign", id: c.id, path, value, prev: clone(prev) });
    };
    if (p.name !== undefined) set(["name"], p.name, c.name);
    if (p.units !== undefined) set(["units"], p.units, c.units);
    for (const [k, v] of Object.entries(p.houseRules ?? {})) {
      set(["houseRules", k], v, (c.houseRules as Record<string, unknown>)[k]);
    }
    for (const [k, v] of Object.entries(p.settings ?? {})) {
      set(["settings", k], v, (c.settings as Record<string, unknown>)[k]);
    }
    if (ops.length > 0)
      ops.push({ k: "set", e: "campaign", id: c.id, path: ["updatedAt"], value: ctx.now, prev: c.updatedAt });
    const parts = [
      p.name !== undefined ? "name" : null,
      p.units !== undefined ? "units" : null,
      p.houseRules ? "house rules" : null,
      p.settings ? "settings" : null,
    ].filter(Boolean);
    return { ops, summary: `Changed campaign ${parts.join(", ")}`, result: { changed: ops.length } };
  },
};
