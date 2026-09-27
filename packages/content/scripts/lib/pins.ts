/**
 * Pinned sources for the SRD 5.2.1 content pipeline (SPEC §33.1). Changing a pin is a deliberate act:
 * update the value here, rebuild, and review the diff of packs/srd-5.2.1 and docs/research/spells-report.md.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when the pipeline's output format or merge rules change (recorded in MANIFEST.json). */
export const PIPELINE_VERSION = "1.0.0";

export const PACK_ID = "srd-5.2.1";

export const SRD_PDF = {
  url: "https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf",
  sha256: "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87",
  bytes: 6_031_375,
  pages: 364,
  fileName: "SRD_CC_v5.2.1.pdf",
} as const;

export const FOUNDRY = {
  repo: "https://github.com/foundryvtt/dnd5e.git",
  tag: "release-6.0.5",
  commit: "3ee48de02f8f6f7b2638c9f6cf3e9540c9c181cc",
  spellsPath: "packs/_source/spells24",
  levelDirs: [
    "cantrips",
    "1st-level",
    "2nd-level",
    "3rd-level",
    "4th-level",
    "5th-level",
    "6th-level",
    "7th-level",
    "8th-level",
    "9th-level",
  ],
  licence: "MIT (code), CC-BY-4.0 (SRD content)",
} as const;

/**
 * Cross-check sources. SPEC §33.1 pins them by branch, so the fetcher resolves the branch head to a commit
 * once, caches the files under that commit and records both in MANIFEST.json; later builds reuse the cache
 * (pass --refresh to re-resolve).
 */
export const CROSS_CHECK = {
  open5e: {
    owner: "open5e",
    repo: "open5e-api",
    branch: "staging",
    files: {
      spells: "data/v2/wizards-of-the-coast/srd-2024/Spell.json",
      castingOptions: "data/v2/wizards-of-the-coast/srd-2024/SpellCastingOption.json",
    },
  },
  fiveEBits: {
    owner: "5e-bits",
    repo: "5e-srd-api",
    branch: "main",
    files: {
      spells: "packages/5e-database/src/2024/en/5e-SRD-Spells.json",
    },
  },
} as const;

/** Expected counts (SPEC §34.7, AC-SPL-01). */
export const EXPECTED_TOTAL = 339;
export const EXPECTED_PER_LEVEL = [27, 57, 57, 42, 34, 38, 31, 20, 17, 16] as const;
/** SPEC §33.2 step 2: spells with a "Using a Higher-Level Spell Slot." paragraph / cantrips with an upgrade. */
export const EXPECTED_HIGHER_LEVEL_PARAGRAPHS = 109;
export const EXPECTED_CANTRIP_UPGRADES = 15;

/** Foundry slugs that are not SRD content and must never be imported (SPEC §33.2 step 3). */
export const NON_SRD_FOUNDRY_SLUGS = ["arcane-vigor"] as const;

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_ROOT = resolve(here, "..", "..");
export const REPO_ROOT = resolve(CONTENT_ROOT, "..", "..");
export const CACHE_DIR = join(CONTENT_ROOT, ".cache");
export const OVERLAYS_DIR = join(CONTENT_ROOT, "overlays");
export const PACK_DIR = join(CONTENT_ROOT, "packs", PACK_ID);
export const REPORT_PATH = join(REPO_ROOT, "docs", "research", "spells-report.md");
