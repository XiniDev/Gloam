import { describe, expect, it } from "vitest";
import {
  CampaignLogEntrySchema,
  HandoutSchema,
  IMPORT_SCHEMA_NAMES,
  ItemSchema,
  importJsonSchema,
  MonsterSchema,
} from "./imports.ts";

describe("the published import schemas (AC-API-03)", () => {
  it("every import format has one, strict (unknown fields refused) and in draft 2020-12", () => {
    expect(IMPORT_SCHEMA_NAMES).toEqual([
      "spell",
      "character",
      "monster",
      "item",
      "handout",
      "campaign-log-entry",
    ]);
    for (const name of IMPORT_SCHEMA_NAMES) {
      const s = importJsonSchema(name);
      expect(s.$schema, name).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(s.additionalProperties, `${name} is strict`).toBe(false);
    }
  });

  it("Appendix F.4's monster is valid, and an unknown field isn't", () => {
    const bog = {
      id: "bog-lurker",
      name: "Bog Lurker",
      size: "large",
      type: "monstrosity",
      ac: 13,
      hp: { average: 59, formula: "7d10 + 21" },
      speeds: { walk: 20, swim: 40 },
      senses: { darkvision: 60, tremorsense: 30 },
      abilities: { str: 18, dex: 12, con: 16, int: 3, wis: 12, cha: 5 },
      saves: { con: 5 },
      resistances: ["cold"],
      immunities: [],
      vulnerabilities: [],
      conditionImmunities: ["prone"],
      cr: "3",
      statBlockMarkdown: "…",
      tokenAssetId: null,
      source: { pack: "homebrew" },
    };
    const m = MonsterSchema.parse(bog);
    expect(m.speeds).toEqual({ walk: 20, fly: 0, swim: 40, climb: 0, burrow: 0, hover: false });
    expect(MonsterSchema.safeParse({ ...bog, legendary: true }).success).toBe(false);
    expect(MonsterSchema.safeParse({ ...bog, cr: "31" }).success).toBe(false);
    expect(MonsterSchema.safeParse({ ...bog, resistances: ["sonic"] }).success).toBe(false);
  });

  it("items, handouts and log entries take their defaults and refuse what isn't theirs", () => {
    expect(ItemSchema.parse({ id: "rope", name: "Hempen rope" })).toMatchObject({ kind: "gear", weight: 0 });
    expect(HandoutSchema.parse({ title: "A torn map" })).toEqual({
      title: "A torn map",
      bodyMd: "",
      imageAssetId: null,
    });
    expect(CampaignLogEntrySchema.parse({ text: "The party fled the crypt." }).kind).toBe("recap");
    expect(CampaignLogEntrySchema.safeParse({ text: "   " }).success).toBe(false);
    expect(HandoutSchema.safeParse({ title: "x", secret: true }).success).toBe(false);
  });
});
