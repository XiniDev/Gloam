/**
 * `pnpm content:build` — the SRD 5.2.1 content pipeline end to end (SPEC §33):
 * fetch + verify sources → parse the PDF spell chapter → import Foundry mechanics → merge with prose
 * patterns and overlays → validate with the spell schema and assert the counts → cross-check against
 * Open5e / 5e-bits → write packs/srd-5.2.1/* and docs/research/spells-report.md.
 *
 * Exits non-zero on any validation failure, count mismatch, stale overlay or unverifiable citation.
 * Flags: --refresh (re-fetch Foundry and re-resolve the cross-check branches).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Spell, SpellSchema } from "@gloam/shared/schemas";
import { z } from "zod";
import { fetchSources, readCached } from "./fetch-srd.ts";
import { importFoundry } from "./import-foundry.ts";
import {
  CACHE_DIR,
  EXPECTED_CANTRIP_UPGRADES,
  EXPECTED_HIGHER_LEVEL_PARAGRAPHS,
  FOUNDRY,
  NON_SRD_FOUNDRY_SLUGS,
  OVERLAYS_DIR,
  PACK_DIR,
  PACK_ID,
  PIPELINE_VERSION,
  REPORT_PATH,
  SRD_PDF,
} from "./lib/pins.ts";
import { sha256, toJson, writeText } from "./lib/util.ts";
import { type MergedSpell, mergeSpell } from "./merge.ts";
import { loadOverlays, SPELL_OVERLAY_FILES } from "./overlays.ts";
import { parseSrdPdf } from "./parse-srd-pdf.ts";
import { renderReport } from "./report.ts";
import { assertCounts, crossCheck, perLevelCounts, validateSpells } from "./verify.ts";

/** Additive, optional changes made to the shared spell schema for this pack (listed in the report). */
const SCHEMA_CHANGES = [
  "`SpellDamage.typeOptions?: DamageType[]` (2–13) — the caster chooses the damage type when casting (Chromatic Orb, Dragon's Breath, Spirit Guardians radiant/necrotic…); `type` stays the default. Without it a choice would be recorded as one fixed type.",
  "`SpellArea` (wall) `.ringHeight?: Ft` — height of the ring form when it differs from the straight wall (Wall of Thorns: 10 ft straight, 20 ft circle, p. 173).",
  "`SpellSchema.areaAlternatives?: { label, area, attach? }[]` (≤ 4) — an alternative form the caster can pick instead of `area` (Darkness/Daylight cast on an object become a 15/60-ft Emanation that moves with the object, SPEC §33.4).",
  "`EffectPropsTemplate.speedHalved?: boolean` — a creature's Speed is halved while inside (Spirit Guardians, p. 164); Difficult Terrain is a different rule, so it can't stand in.",
  '`castingTime.text?: ShortText` — the printed casting time when amount/unit can\'t express it (Plant Growth: "Action (Overgrowth) or 8 hours (Enrichment)"; the 8 hours appears nowhere else).',
  '`duration.text?: ShortText` — the printed duration when kind/amount/unit lose information ("Until dispelled or triggered", non-concentration "Up to 8 hours").',
  '`range.text?: ShortText` — the printed range when `ft` can\'t express it (Project Image: "500 miles" exceeds the shared Ft bound of 100,000 ft).',
];

/** How the pack models things the schema has no dedicated field for (printed in the report). */
const MODELLING_POLICIES = [
  "**Text is the SRD's, structure is derived.** Header fields and descriptions come from the PDF; every structured field names its source in `provenance`. Where prose and Foundry disagree the PDF wins, and hand-verified overlays (which quote the PDF, checked by the build) win over both.",
  "**`damage` lists what the resolution card rolls for the spell's own effect:** the immediate damage and repeatable attacks or riders (Hex, Hunter's Mark, Spiritual Weapon…). Damage that lands on a later turn from the same hit (Acid Arrow's 2d4, Vitriolic Sphere's 5d4), mishap damage to the caster (Dimension Door, Teleport, Meld into Stone, Wish) and situational damage (Earthquake's collapsing structures, Web's burning) stay in the text so they are never rolled at casting. Persistent-area damage lives in the effect's triggers.",
  "**`typeOptions`** marks a damage type chosen by the caster or decided by the text (Chromatic Orb, Spirit Guardians' radiant/necrotic by alignment, Prismatic Spray's ray roll); `type` is the first option as printed.",
  "**`save.onSuccess`** describes what a successful save does to the spell's effect: `half` (half damage), `none` (the effect is avoided, including saves whose success just ends the spell) or `special` (the text says; e.g. Ray of Enfeeblement, Heat Metal, whose save doesn't touch the damage). Saves that only end an ongoing effect or that a creature makes to escape (Power Word Stun, Forcecage) are not the spell's save.",
  "**`conditions`** lists only conditions the spell can impose (as checkboxes for the DM); conditions it prevents, removes, or that occur when it ends (Protection from Evil and Good, Mass Heal, Haste) are excluded.",
  '**`healing`** is only Hit Points regained. Hit Point maximum increases (Aid, Heroes\' Feast), "all its Hit Points" (Power Word Heal) and Temporary Hit Points are not healing formulas.',
  "**`castingTime.reactionTrigger`** also carries the trigger of the smites' \"Bonus Action, which you take immediately after hitting…\" casting time, so it isn't lost.",
  "**Flat shapes.** §17.1 has no square or circle: a square on the ground is a Cube of the same side and a circle a Sphere of the same radius (same footprint); such spells are on the manual-review list.",
  "**`light.dim`** is the additional dim radius beyond `bright` (the SRD's \"Dim Light for an additional N feet\"), matching the vision engine's `r ≤ bright + dim` (SPEC §15.3).",
];

const TRADEMARKS = /\bD&D\b|Dungeons\s*&\s*Dragons|Wizards of the Coast|D&D Beyond/i;

const LightSourceFile = z
  .object({
    $comment: z.string().optional(),
    sources: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          name: z.string().min(1),
          bright: z.number().min(0),
          dim: z.number().min(0),
          cone: z.number().min(1).max(360).optional(),
          durationText: z.string().min(1),
          page: z.number().int().min(1).max(SRD_PDF.pages),
          notes: z.string(),
          verify: z.array(z.string().min(10)).min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** Letters and digits only, lower-case: robust against line breaks and hyphenation in page text. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Passages in double quotes, split at ellipses; fragments under four words (e.g. "half") are labels. */
function quotedFragments(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/"([^"]+)"/g)) {
    for (const piece of m[1]!.split("…")) {
      const t = piece.trim();
      if (t.split(/\s+/).length >= 4) out.push(t);
    }
  }
  return out;
}

function log(msg: string): void {
  console.log(`[content] ${msg}`);
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const sources = await fetchSources({ refresh, log: (m) => log(`fetch: ${m}`) });
  const overlays = loadOverlays();
  log(`overlays: ${overlays.files.map((f) => `${f.file} (${f.entries})`).join(", ")}`);

  // 1–2. Canonical list and text from the PDF.
  const parsed = await parseSrdPdf(sources.pdf.path, { hyphenation: overlays.hyphenation });
  if (parsed.unusedHyphenationExceptions.length > 0) {
    throw new Error(
      `Stale hyphenation exceptions (match no line break): ${parsed.unusedHyphenationExceptions.join(", ")}`,
    );
  }
  log(`PDF: ${parsed.spells.length} spells on pp. ${parsed.firstPage}–${parsed.lastPage}`);
  const higherLevelCount = parsed.spells.filter((s) => s.higherLevels).length;
  const cantripUpgradeCount = parsed.spells.filter((s) => s.cantripUpgrade).length;
  if (
    higherLevelCount !== EXPECTED_HIGHER_LEVEL_PARAGRAPHS ||
    cantripUpgradeCount !== EXPECTED_CANTRIP_UPGRADES
  ) {
    throw new Error(
      `Expected ${EXPECTED_HIGHER_LEVEL_PARAGRAPHS} "Using a Higher-Level Spell Slot" and ${EXPECTED_CANTRIP_UPGRADES} "Cantrip Upgrade" paragraphs; parsed ${higherLevelCount} and ${cantripUpgradeCount}`,
    );
  }
  for (const s of parsed.spells) {
    const all = [s.name, s.text, s.higherLevels?.md ?? "", s.cantripUpgrade?.md ?? ""].join("\n");
    if (TRADEMARKS.test(all)) throw new Error(`${s.name}: text contains a trademark (SPEC §33.6)`);
  }

  // 3. Foundry mechanics, restricted to the canonical list.
  const foundry = importFoundry(sources.foundry.spellsDir);
  const canonical = new Set(parsed.spells.map((s) => s.id));
  const dropped = [...foundry.spells.keys()].filter((k) => !canonical.has(k)).sort();
  for (const slug of dropped) foundry.spells.delete(slug);
  for (const slug of NON_SRD_FOUNDRY_SLUGS) {
    if (canonical.has(slug)) throw new Error(`Non-SRD spell ${slug} appeared in the canonical list`);
  }
  log(`Foundry: ${foundry.spells.size} matched; dropped ${dropped.join(", ") || "none"}`);
  for (const id of overlays.bySpell.keys()) {
    if (!canonical.has(id)) throw new Error(`Overlay entry for unknown spell "${id}"`);
  }

  // 4–5. Merge.
  const merged = new Map<string, MergedSpell>();
  for (const s of parsed.spells) merged.set(s.id, mergeSpell(s, foundry.spells.get(s.id), overlays));

  // Overlay citations must point at a page the spell is printed on.
  for (const [id, apps] of overlays.bySpell) {
    const pdf = parsed.spells.find((s) => s.id === id)!;
    for (const a of apps) {
      if (!pdf.pages.includes(a.page)) {
        throw new Error(
          `Overlay ${a.file} cites p. ${a.page} for ${id}, which is printed on pp. ${pdf.pages.join(", ")}`,
        );
      }
    }
  }

  // Every quoted passage (4+ words) in an overlay's `source` must occur in that spell's PDF text, so an
  // overlay can't cite words the SRD doesn't contain.
  const quoteErrors: string[] = [];
  for (const [id, apps] of overlays.bySpell) {
    const pdf = parsed.spells.find((s) => s.id === id)!;
    const hay = squash(
      [
        pdf.text,
        pdf.higherLevels?.plain ?? "",
        pdf.cantripUpgrade?.plain ?? "",
        ...Object.values(pdf.header),
      ].join(" "),
    );
    for (const a of apps) {
      for (const quote of quotedFragments(a.source)) {
        if (!hay.includes(squash(quote))) quoteErrors.push(`${a.file} → ${id}: "${quote}"`);
      }
    }
  }
  if (quoteErrors.length > 0)
    throw new Error(`Overlay quotes not found in the PDF text:\n${quoteErrors.join("\n")}`);

  // 6. Validate and assert.
  const { spells: validated, errors } = validateSpells([...merged.values()].map((m) => m.record));
  if (errors.length > 0) throw new Error(`Schema validation failed:\n${errors.join("\n")}`);
  assertCounts(validated);
  const spells: Spell[] = [...validated].sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name, "en"),
  );
  for (const s of spells) SpellSchema.parse(s); // round-trip: the written JSON re-validates as-is
  log(`validated ${spells.length} spells; per level ${perLevelCounts(spells).join("/")}`);

  const xc = crossCheck(
    spells,
    readCached(sources.open5e, "spells"),
    readCached(sources.open5e, "castingOptions"),
    readCached(sources.fiveEBits, "spells"),
  );
  log(`cross-check: ${xc.disagreements.length} disagreements, ${xc.missing.length} presence issues`);

  // Light sources (§34.3): verify every cited phrase against its PDF page.
  const lightFile = LightSourceFile.parse(
    JSON.parse(readFileSync(join(OVERLAYS_DIR, "light-sources.json"), "utf8")),
  );
  for (const l of lightFile.sources) {
    const page = squash(parsed.pageText.get(l.page) ?? "");
    for (const phrase of l.verify) {
      if (!page.includes(squash(phrase)))
        throw new Error(`light-sources.json: "${phrase}" not found on p. ${l.page}`);
    }
  }
  const lightSources = lightFile.sources.map(({ verify: _verify, ...rest }) => rest);

  // 7. Write outputs.
  const outputs: Record<string, string> = {};
  outputs["spells.json"] = toJson(spells);
  outputs["light-sources.json"] = toJson(lightSources);
  const conditionsPath = join(OVERLAYS_DIR, "conditions.json");
  if (!existsSync(conditionsPath))
    throw new Error(`${conditionsPath} is missing (written by research task R1).`);
  const rawConditions = readFileSync(conditionsPath, "utf8");
  const conditions = JSON.parse(rawConditions) as { conditions?: unknown[]; markers?: unknown[] };
  if (conditions.conditions?.length !== 15)
    throw new Error("conditions.json must list all 15 SRD conditions");
  if ((conditions.markers?.length ?? 0) < 18)
    throw new Error("conditions.json must list every status marker");
  outputs["conditions.json"] = rawConditions.endsWith("\n") ? rawConditions : `${rawConditions}\n`;
  outputs["ATTRIBUTION.md"] = attribution();
  for (const [name, content] of Object.entries(outputs)) writeText(join(PACK_DIR, name), content);

  const manifestPath = join(PACK_DIR, "MANIFEST.json");
  const manifestBody = {
    pack: PACK_ID,
    pipelineVersion: PIPELINE_VERSION,
    sources: {
      srdPdf: {
        url: SRD_PDF.url,
        sha256: sources.pdf.sha256,
        bytes: sources.pdf.bytes,
        pages: SRD_PDF.pages,
      },
      foundry: {
        repo: FOUNDRY.repo,
        tag: FOUNDRY.tag,
        commit: sources.foundry.commit,
        path: FOUNDRY.spellsPath,
        spellsTree: sources.foundry.spellsTree,
        licence: FOUNDRY.licence,
        droppedNonSrd: dropped,
      },
      crossCheck: Object.fromEntries(
        [sources.open5e, sources.fiveEBits].map((src) => [
          `${src.owner}/${src.repo}`,
          {
            branch: src.branch,
            commit: src.commit,
            files: Object.fromEntries(
              Object.entries(src.files).map(([k, f]) => [
                k,
                { path: f.path, sha256: f.sha256, bytes: f.bytes },
              ]),
            ),
          },
        ]),
      ),
    },
    counts: {
      spells: spells.length,
      perLevel: perLevelCounts(spells),
      higherLevelParagraphs: higherLevelCount,
      cantripUpgrades: cantripUpgradeCount,
      lightSources: lightSources.length,
      manualReview: [...merged.values()].filter((m) => m.review.length > 0).length,
    },
    overlays: Object.fromEntries(
      [...SPELL_OVERLAY_FILES, "hyphenation.json", "light-sources.json"].map((f) => [
        f,
        sha256(readFileSync(join(OVERLAYS_DIR, f))),
      ]),
    ),
    files: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, sha256(v)])),
  };
  // Keep generatedAt stable when nothing else changed, so a no-op rebuild leaves the pack untouched.
  let generatedAt = new Date().toISOString();
  if (existsSync(manifestPath)) {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as { generatedAt?: string };
    const { generatedAt: prevAt, ...prevBody } = prev;
    if (prevAt && JSON.stringify(prevBody) === JSON.stringify(manifestBody)) generatedAt = prevAt;
  }
  writeText(manifestPath, toJson({ ...manifestBody, generatedAt }));

  writeText(
    REPORT_PATH,
    renderReport({
      spells,
      merged,
      crossCheck: xc,
      sources,
      hyphenation: parsed.hyphenation,
      parserWarnings: parsed.warnings,
      droppedFoundry: dropped,
      overlayFiles: overlays.files,
      schemaChanges: SCHEMA_CHANGES,
      policies: MODELLING_POLICIES,
      higherLevelCount,
      cantripUpgradeCount,
      pipelineVersion: PIPELINE_VERSION,
    }),
  );
  // Machine-readable diagnostics for maintainers (gitignored cache, not part of the pack).
  writeText(
    join(CACHE_DIR, "build-diagnostics.json"),
    toJson({
      notes: Object.fromEntries([...merged].map(([id, m]) => [id, { notes: m.notes, review: m.review }])),
      crossCheck: xc,
      hyphenation: parsed.hyphenation,
    }),
  );
  const review = [...merged.values()].filter((m) => m.review.length > 0).length;
  log(
    `wrote ${Object.keys(outputs).length + 1} files to ${PACK_DIR} and the report; ${review} spells need manual review`,
  );
}

function attribution(): string {
  return `# Attribution — SRD 5.2.1 content pack

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

## Other sources

- **Foundry VTT \`dnd5e\` system** (${FOUNDRY.repo}, tag \`${FOUNDRY.tag}\`, commit \`${FOUNDRY.commit}\`) — used at build time only, as a structured source for SRD mechanics (area templates, saves, damage parts and scaling, attack types). Code MIT; SRD content CC-BY-4.0. Non-SRD entries (e.g. \`arcane-vigor\`) are dropped.
- **Open5e** and **5e-bits** SRD data — used at build time only to cross-check header fields, saves and per-slot dice; nothing from them is copied into this pack.

## Changes made to the SRD text (CC-BY-4.0 §3(a)(1)(B))

The spell descriptions are the SRD 5.2.1 text, extracted from the official PDF (spell chapter, pp. 107–175). The following changes were made:

1. **Format.** The two-column PDF layout was converted to Markdown: paragraphs, bullet lists, bold run-in labels, italics, tables and the creature stat blocks some spells include. Tables printed in two halves side by side (Reincarnate) were unfolded into one table; tables continued across a page (Prismatic Spray) were rejoined; tables printed side by side (Control Weather) were separated.
2. **Hyphenation.** Words hyphenated at line ends were rejoined (using the word forms that occur elsewhere in the SRD, plus the reviewed exceptions in \`overlays/hyphenation.json\`).
3. **Structure.** Each spell's name, level, school, class list, Casting Time, Range, Components and Duration were moved from the printed header into structured fields (the printed wording is kept in \`text\` fields where the structure would lose information, e.g. Plant Growth's two casting times); the "Using a Higher-Level Spell Slot." and "Cantrip Upgrade." paragraphs were moved into separate fields without their lead-in labels. The header label printed as "Component:" in a few entries is treated as "Components:".
4. **Typography.** Spell names printed in small capitals are stored in normal title case; typographic quotes and dashes are kept as printed.
5. **Added data.** Structured mechanics (areas, saves, damage, conditions, light, obscurement, persistent-effect templates, VFX presets) are derived from the SRD text, Foundry data and hand-authored overlays citing SRD pages. They are not SRD text.
6. **Scope.** Only the spell chapter (pp. 107–175) and the light-source entries of the equipment chapter (pp. 96–100) are used. \`conditions.json\` holds short paraphrased summaries and rule flags for conditions and status markers, written for this project (SPEC §32, task R1) with SRD page references — not SRD text. Passages that name trademarks (SRD pp. 5 and 24) are not included, and the build fails if any imported text contains one.
`;
}

main().catch((err: unknown) => {
  console.error(`[content] BUILD FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
