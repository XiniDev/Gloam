import type { TokenView } from "@gloam/shared/state";
import {
  Anchor,
  Eye,
  EyeOff,
  Feather,
  Footprints,
  Gauge,
  Link2,
  Link2Off,
  Lock,
  type LucideIcon,
  Megaphone,
  NotebookPen,
  ShieldOff,
  Timer,
} from "lucide-react";
import { cameraRig } from "../../board/CameraRig.tsx";
import { request } from "../../net/table.ts";
import { useUi } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";

/** Runs a DM action, a failure said in a toast. */
export const act = (p: Promise<unknown>, what: string): void =>
  void p.catch((e: Error) => toast.danger(what, e.message));

/** A token.update from the DM's panels. */
export const updateToken = (tokenId: string, patch: Record<string, unknown>, what = "Couldn't change it") =>
  act(request("token.update", { tokenId, ...patch }), what);

/** Selects a creature and brings the view to it. */
export function focusToken(t: TokenView): void {
  useUi.getState().set({ selection: [t.id] });
  cameraRig.moveTargetTo(t.pos.x, t.pos.y);
}

/** A token's per-token overrides (SPEC §8.19), as the DM's view of it carries them. */
export interface Overrides {
  speedOverride?: number;
  bonusMove?: { ft: number; until: "turn" | "rounds" | "removed"; rounds?: number; untilRound?: number };
  freeMovement?: boolean;
  lockMovement?: boolean;
  ignoreConditionSpeed?: boolean;
  countAsMovement?: boolean;
  shareVisionWith?: string[];
}

export function overridesOf(t: TokenView): Overrides {
  try {
    return (JSON.parse(t.dm?.overridesJson || "{}") as Overrides) ?? {};
  } catch {
    return {};
  }
}

/** Who a token is shown to beyond sight: by vision (the default), always to everyone, or always to these players. */
export function revealOf(t: TokenView): "vision" | "all" | string[] {
  try {
    const r = JSON.parse(t.dm?.revealJson || '"vision"') as unknown;
    return r === "all" || Array.isArray(r) ? (r as "all" | string[]) : "vision";
  } catch {
    return "vision";
  }
}

export interface OverrideBadge {
  key: string;
  icon: LucideIcon;
  text: string;
  /** Its full meaning (a tooltip, a screen reader). */
  title: string;
}

const LINK_DEFAULT = (t: TokenView) => (t.kind === "character" ? "linked" : "unlinked");

/**
 * Every per-token override and DM setting a token has that isn't its default (AC-DMP-02), as badges: hidden, locked,
 * speed, bonus movement, free or locked movement, condition speed ignored, the DM's moves counted, vision shared, an
 * always-reveal, a link that isn't the kind's usual one, an HP display other than the campaign's, a DM note.
 */
export function overrideBadges(
  t: TokenView,
  names: (userId: string) => string,
  npcHpDisplay = "bar",
): OverrideBadge[] {
  const o = overridesOf(t);
  const out: OverrideBadge[] = [];
  if (t.dm?.dmHidden)
    out.push({ key: "hidden", icon: EyeOff, text: "Hidden", title: "Hidden from the players" });
  if (t.locked)
    out.push({ key: "locked", icon: Lock, text: "Locked", title: "Locked: its players can't move it" });
  if (o.speedOverride !== undefined)
    out.push({
      key: "speed",
      icon: Gauge,
      text: `${o.speedOverride} ft`,
      title: `Speed set to ${o.speedOverride} ft`,
    });
  if (o.bonusMove)
    out.push({
      key: "bonus",
      icon: Footprints,
      text: `+${o.bonusMove.ft} ft`,
      title: `Bonus movement +${o.bonusMove.ft} ft ${
        o.bonusMove.until === "turn"
          ? "this turn"
          : o.bonusMove.until === "rounds"
            ? `for ${o.bonusMove.rounds ?? 1} rounds`
            : "until removed"
      }`,
    });
  if (o.freeMovement)
    out.push({ key: "free", icon: Feather, text: "Free", title: "Moves freely (no turn order, no budget)" });
  if (o.lockMovement) out.push({ key: "stuck", icon: Anchor, text: "Can't move", title: "Movement locked" });
  if (o.ignoreConditionSpeed)
    out.push({
      key: "ignore",
      icon: ShieldOff,
      text: "No condition speed",
      title: "Ignores conditions' effects on its speed",
    });
  if (o.countAsMovement)
    out.push({ key: "count", icon: Timer, text: "DM moves count", title: "The DM's moves use its movement" });
  if (o.shareVisionWith?.length)
    out.push({
      key: "share",
      icon: Eye,
      text: `Sight: ${o.shareVisionWith.map(names).join(", ")}`,
      title: `Shares what it sees with ${o.shareVisionWith.map(names).join(", ")}`,
    });
  const reveal = revealOf(t);
  if (reveal === "all")
    out.push({ key: "reveal", icon: Megaphone, text: "Shown to all", title: "Always shown to everyone" });
  else if (Array.isArray(reveal) && reveal.length)
    out.push({
      key: "reveal",
      icon: Megaphone,
      text: `Shown: ${reveal.map(names).join(", ")}`,
      title: `Always shown to ${reveal.map(names).join(", ")}`,
    });
  if (t.actorId && t.dm?.link && t.dm.link !== LINK_DEFAULT(t))
    out.push(
      t.dm.link === "linked"
        ? { key: "link", icon: Link2, text: "Linked", title: "Linked to its sheet" }
        : { key: "link", icon: Link2Off, text: "Unlinked", title: "Unlinked: its own HP and conditions" },
    );
  if (t.kind !== "character" && t.hpDisplay && t.hpDisplay !== npcHpDisplay)
    out.push({
      key: "hp",
      icon: Gauge,
      text: `HP: ${t.hpDisplay}`,
      title: `Players see its HP as: ${t.hpDisplay}`,
    });
  if (t.dm?.secretNote)
    out.push({ key: "note", icon: NotebookPen, text: "Note", title: `DM note: ${t.dm.secretNote}` });
  return out;
}
