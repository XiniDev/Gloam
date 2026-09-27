# Attribution — SRD 5.2.1 content pack

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

## Other sources

- **Foundry VTT `dnd5e` system** (https://github.com/foundryvtt/dnd5e.git, tag `release-6.0.5`, commit `3ee48de02f8f6f7b2638c9f6cf3e9540c9c181cc`) — used at build time only, as a structured source for SRD mechanics (area templates, saves, damage parts and scaling, attack types). Code MIT; SRD content CC-BY-4.0. Non-SRD entries (e.g. `arcane-vigor`) are dropped.
- **Open5e** and **5e-bits** SRD data — used at build time only to cross-check header fields, saves and per-slot dice; nothing from them is copied into this pack.

## Changes made to the SRD text (CC-BY-4.0 §3(a)(1)(B))

The spell descriptions are the SRD 5.2.1 text, extracted from the official PDF (spell chapter, pp. 107–175). The following changes were made:

1. **Format.** The two-column PDF layout was converted to Markdown: paragraphs, bullet lists, bold run-in labels, italics, tables and the creature stat blocks some spells include. Tables printed in two halves side by side (Reincarnate) were unfolded into one table; tables continued across a page (Prismatic Spray) were rejoined; tables printed side by side (Control Weather) were separated.
2. **Hyphenation.** Words hyphenated at line ends were rejoined (using the word forms that occur elsewhere in the SRD, plus the reviewed exceptions in `overlays/hyphenation.json`).
3. **Structure.** Each spell's name, level, school, class list, Casting Time, Range, Components and Duration were moved from the printed header into structured fields (the printed wording is kept in `text` fields where the structure would lose information, e.g. Plant Growth's two casting times); the "Using a Higher-Level Spell Slot." and "Cantrip Upgrade." paragraphs were moved into separate fields without their lead-in labels. The header label printed as "Component:" in a few entries is treated as "Components:".
4. **Typography.** Spell names printed in small capitals are stored in normal title case; typographic quotes and dashes are kept as printed.
5. **Added data.** Structured mechanics (areas, saves, damage, conditions, light, obscurement, persistent-effect templates, VFX presets) are derived from the SRD text, Foundry data and hand-authored overlays citing SRD pages. They are not SRD text.
6. **Scope.** Only the spell chapter (pp. 107–175) and the light-source entries of the equipment chapter (pp. 96–100) are used. `conditions.json` holds short paraphrased summaries and rule flags for conditions and status markers, written for this project (SPEC §32, task R1) with SRD page references — not SRD text. Passages that name trademarks (SRD pp. 5 and 24) are not included, and the build fails if any imported text contains one.
