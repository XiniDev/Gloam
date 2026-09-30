import {
  Eye,
  History,
  Inbox,
  Library,
  ListChecks,
  Map as MapIcon,
  Music,
  Scale,
  ScrollText,
  Users,
  UsersRound,
} from "lucide-react";
import type { ComponentType } from "react";
import { CombatIcon } from "../../icons/combat.tsx";
import { HoodedLanternIcon } from "../../icons/lights.tsx";
import { EffectIcon, HealthIcon, SpellbookIcon, WallsIcon } from "../../icons/table.tsx";
import type { DmSection } from "../../state/ui.ts";

export interface SectionDef {
  id: DmSection;
  label: string;
  /**
   * Its glyph: the table's own for a game concept (combat, health, effects, spells, lights, walls — SPEC §27.6, critic
   * RSP-01 r1 DS-02), a plain interface one for the table's records (scenes, history, the rules).
   */
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  /** What it holds, in a line (the Jump to palette's hint). */
  holds: string;
  /** Other words it answers to in Jump to. */
  keywords: string;
}

/**
 * The DM panel's sections (SPEC §8.19), in the rail's order: the scene and what's on it, then play, then the table's
 * records and rules. §8.19's fifteen, plus Health (the creatures' HP and the DM's prompts, §8.11) and Spells (the
 * campaign's homebrew, §8.13).
 */
export const SECTIONS: readonly SectionDef[] = [
  {
    id: "scenes",
    label: "Scenes",
    icon: MapIcon,
    holds: "List, new, prep view, activate, calibrate, fog mode, spawn",
    keywords: "maps travel prep activate",
  },
  {
    id: "tokens",
    label: "Tokens & Units",
    icon: Users,
    holds: "Tokens on the scene, Quick Unit, Bestiary, hide and reveal",
    keywords: "creatures monsters npcs bestiary quick unit hide reveal disposition",
  },
  {
    id: "vision",
    label: "Vision & Fog",
    icon: Eye,
    holds: "Fog tools, explored memory, vision sharing, View as",
    keywords: "fog of war darkness view as reset explored",
  },
  {
    id: "walls",
    label: "Walls & Zones",
    icon: WallsIcon,
    holds: "Wall and zone tools, 3D walls, the zones on the scene",
    keywords: "doors windows terrain water difficult hazard",
  },
  {
    id: "lights",
    label: "Lights",
    icon: HoodedLanternIcon,
    holds: "The lights on the scene, presets, ambient light",
    keywords: "torch lantern sconce ambient darkness",
  },
  {
    id: "combat",
    label: "Combat",
    icon: CombatIcon,
    holds: "Start and stop, the turn order, initiative",
    keywords: "initiative tracker round turn fight encounter",
  },
  {
    id: "health",
    label: "Health",
    icon: HealthIcon,
    holds: "Every creature's HP and conditions, the DM's prompts",
    keywords: "hp damage heal conditions dying death saves",
  },
  {
    id: "requests",
    label: "Requests",
    icon: ListChecks,
    holds: "Ask for rolls, the requests board",
    keywords: "roll request check save",
  },
  {
    id: "effects",
    label: "Effects",
    icon: EffectIcon,
    holds: "Lasting spell effects on the scene",
    keywords: "spells areas concentration",
  },
  {
    id: "spells",
    label: "Spells",
    icon: SpellbookIcon,
    holds: "The spell browser, homebrew, imports",
    keywords: "homebrew import spell list",
  },
  {
    id: "library",
    label: "Library",
    icon: Library,
    holds: "Maps, tokens, models and sounds",
    keywords: "assets upload images art models",
  },
  {
    id: "sound",
    label: "Sound",
    icon: Music,
    holds: "Music, playlists and ambience",
    keywords: "music ambience playlist audio",
  },
  {
    id: "party",
    label: "Party",
    icon: UsersRound,
    holds: "The characters at a glance, rests, Heroic Inspiration, Act as",
    keywords: "characters rest inspiration act as passive",
  },
  {
    id: "handouts",
    label: "Handouts & Notes",
    icon: ScrollText,
    holds: "Handouts, secret notes, the DM's notes on scenes and tokens",
    keywords: "handout note secret dm notes",
  },
  {
    id: "approvals",
    label: "Approvals",
    icon: Inbox,
    holds: "Knocks at the door, uploads, sheet and homebrew proposals",
    keywords: "knock admit lobby upload proposal approve",
  },
  {
    id: "history",
    label: "History",
    icon: History,
    holds: "Every change, revert and restore",
    keywords: "undo revert restore timeline",
  },
  {
    id: "rules",
    label: "House rules",
    icon: Scale,
    holds: "The campaign's rule choices",
    keywords: "settings options rules automation",
  },
];

export const sectionOf = (id: DmSection): SectionDef =>
  SECTIONS.find((s) => s.id === id) ?? (SECTIONS[0] as SectionDef);
