import type { Spell } from "@gloam/shared/schemas";

/**
 * The twelve VFX presets' colours (SPEC §24.5), from the damage-type tokens (§27.2 --dmg-*): a core (the bright heart,
 * the part that blooms), a glow (the body of the effect), and a shadow (smoke, edges, a scorch). Arcane is the spell
 * colour for everything with no damage of its own.
 */
export type Preset = Spell["vfx"];

export const PRESETS: readonly Preset[] = [
  "fire",
  "cold",
  "lightning",
  "thunder",
  "acid",
  "poison",
  "necrotic",
  "radiant",
  "force",
  "psychic",
  "healing",
  "arcane",
];

export const VFX: Record<Preset, { core: string; glow: string; shadow: string }> = {
  fire: { core: "#FFE3A3", glow: "#FF7A2F", shadow: "#3A1C10" },
  cold: { core: "#F2FBFF", glow: "#7FD3F5", shadow: "#2B4A5C" },
  lightning: { core: "#FFFBE0", glow: "#F5E663", shadow: "#3B3A55" },
  thunder: { core: "#DDEBF5", glow: "#6FA3C9", shadow: "#2A3440" },
  acid: { core: "#EAF7B0", glow: "#B5D33D", shadow: "#39461A" },
  poison: { core: "#CDEBC9", glow: "#5FAE6B", shadow: "#2E3B2C" },
  necrotic: { core: "#D7C6EE", glow: "#8C6BB1", shadow: "#1C1426" },
  radiant: { core: "#FFF6D6", glow: "#FFD66B", shadow: "#6B5424" },
  force: { core: "#E3EAFF", glow: "#8FA8FF", shadow: "#27305A" },
  psychic: { core: "#FFE0F4", glow: "#F07BC8", shadow: "#4A1E3A" },
  healing: { core: "#F4FFE8", glow: "#5FBF9A", shadow: "#6B5A24" },
  arcane: { core: "#EEF2FF", glow: "#7FA7E8", shadow: "#232C46" },
};
