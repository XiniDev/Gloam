import { LIGHT_PRESETS } from "@gloam/shared";
import {
  ArrowDown,
  ArrowUp,
  Backpack,
  Copy,
  Eye,
  EyeOff,
  Flame,
  FlameKindling,
  Heart,
  HeartCrack,
  HeartPulse,
  Lamp,
  Lock,
  Palette,
  RotateCcw,
  RotateCw,
  ScrollText,
  ShieldPlus,
  SlidersHorizontal,
  Smile,
  Trash2,
  Unlock,
  VenetianMask,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { D20Icon } from "../icons/dice.tsx";
import { LightPresetIcon } from "../icons/lights.tsx";
import { StatusIcon } from "../icons/status.tsx";
import { actAs, useActAs } from "../net/actAs.ts";
import { request, useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useLibrary } from "../state/library.ts";
import { useUi } from "../state/ui.ts";
import { KeyHint } from "../ui/KeyHint.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";
import { toast } from "../ui/Toast.tsx";
import { toastUndo } from "./dm/ScenesPanel.tsx";
import { openEmoteWheel } from "./EmoteWheel.tsx";
import { clearArea, isPhoneNow, useHudInsets } from "./insets.ts";
import { openSheetFor, sheetOfToken } from "./sheet/open.ts";

interface Slice {
  id: string;
  label: string;
  /** What the slice shows when its label is too long for it (the label stays its accessible name). */
  short?: string;
  icon: ReactElement;
  run?: () => unknown;
  /** Opens a second ring instead of acting. */
  ring?: Slice[];
  danger?: boolean;
}

async function send(what: string, type: string, payload: unknown): Promise<void> {
  try {
    await request(type, payload);
  } catch (e) {
    toast.danger(`Couldn't ${what}`, (e as Error).message);
  }
}

/**
 * The token radial menu (SPEC §28 RadialMenu, §8.5 Interaction; AC-TOK-06): 6–8 slices around the pointer with icons
 * and labels, keyboard numbers, Esc to close. It offers only what this viewer may do to this token; later phases add
 * their slices (sheet, conditions, damage, light, target, emote).
 */
export function RadialMenu() {
  const radial = useUi((s) => s.radial);
  const me = useTable((s) => s.me);
  const assets = useLibrary((s) => s.assets);
  const [ring, setRing] = useState<Slice[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const token = useEntities((s) => (radial ? boardData(s).tokens.get(radial.tokenId) : undefined));
  // The light this token carries, if any (SPEC §8.8: owners light, douse and hood their own).
  const carried = useEntities((s) => {
    if (!radial) return undefined;
    for (const l of boardData(s).lights.values()) if (l.link?.tokenId === radial.tokenId) return l;
    return undefined;
  });

  const acting = useActAs((s) => s.mine);
  const slices = useMemo<Slice[]>(() => {
    if (!token || !me) return [];
    const dm = me.role === "dm" || me.role === "admin";
    const controls = dm || token.ownerIds.includes(me.userId);
    const out: Slice[] = [];
    const id = token.id;
    // The character sheet behind it, when this person may read it (§8.5 radial: Sheet).
    if (sheetOfToken(id))
      out.push({
        id: "sheet",
        label: "Sheet",
        icon: <ScrollText size={18} />,
        run: () => void openSheetFor(id),
      });
    // On your own token: an emote over it (SPEC §8.5 radial, §8.18).
    if (token.ownerIds.includes(me.userId))
      out.push({
        id: "emote",
        label: "Emote",
        icon: <Smile size={18} />,
        run: () => openEmoteWheel(radial ? { x: radial.x, y: radial.y } : undefined),
      });
    if (controls && (dm || !token.locked)) {
      out.push({
        id: "elevation",
        label: "Elevation",
        icon: <ArrowUp size={18} />,
        ring: [
          {
            id: "up",
            label: "Up 5 ft",
            icon: <ArrowUp size={18} />,
            run: () => send("raise it", "token.elevation", { tokenId: id, delta: 5 }),
          },
          {
            id: "down",
            label: "Down 5 ft",
            icon: <ArrowDown size={18} />,
            run: () => send("lower it", "token.elevation", { tokenId: id, delta: -5 }),
          },
        ],
      });
      out.push({
        id: "facing",
        label: "Facing",
        icon: <RotateCw size={18} />,
        ring: [
          {
            id: "left",
            label: "Turn left",
            icon: <RotateCcw size={18} />,
            run: () => send("turn it", "token.facing", { tokenId: id, delta: -45 }),
          },
          {
            id: "right",
            label: "Turn right",
            icon: <RotateCw size={18} />,
            run: () => send("turn it", "token.facing", { tokenId: id, delta: 45 }),
          },
        ],
      });
    }
    if (controls) {
      const isModel = token.assetId ? assets.get(token.assetId)?.cls === "model" : false;
      const modes = [
        ...(isModel ? [["model", "3D model"]] : []),
        ["standee", "Standee"],
        ["coin", "Coin"],
        ["auto", "Auto"],
      ] as const;
      out.push({
        id: "look",
        label: "Look",
        icon: <Palette size={18} />,
        ring: modes.map(([mode, label]) => ({
          id: `look-${mode}`,
          label,
          icon: <span className="text-12 font-bold">{label.slice(0, 2)}</span>,
          run: () => send("change its look", "token.update", { tokenId: id, appearance: { mode } }),
        })),
      });
      const lightRing: Slice[] = LIGHT_PRESETS.filter((p) => p.id !== carried?.preset).map((p) => ({
        id: `light-${p.id}`,
        label: p.name,
        icon: <LightPresetIcon preset={p.id} />,
        run: () => send("light it", "light.carry", { tokenId: id, preset: p.id }),
      }));
      if (carried) {
        lightRing.unshift({
          id: "light-toggle",
          label: carried.on ? "Put out" : "Light it",
          icon: carried.on ? <FlameKindling size={18} /> : <Flame size={18} />,
          run: () => send("change the light", "light.toggle", { lightId: carried.id, enabled: !carried.on }),
        });
        if (carried.preset === "hooded-lantern")
          lightRing.splice(1, 0, {
            id: "light-hood",
            label: carried.shuttered ? "Raise the hood" : "Lower the hood",
            icon: <Lamp size={18} />,
            run: () =>
              send("change the hood", "light.toggle", { lightId: carried.id, shuttered: !carried.shuttered }),
          });
        lightRing.push({
          id: "light-away",
          label: "Put it away",
          icon: <Backpack size={18} />,
          run: () => send("put it away", "light.carry", { tokenId: id, preset: null }),
        });
      }
      // A token's light is one of its controls: not for its owners while the DM has locked it.
      if (dm || !token.locked)
        out.push({ id: "light", label: "Light", icon: <Flame size={18} />, ring: lightRing.slice(0, 8) });
    }
    // HP (§8.11): damage, healing and temporary HP — for this token, or the selection it's part of. Anyone at the table
    // may aim damage (a player's at others goes to the DM first).
    if (me.role !== "spectator") {
      const targets = () => {
        const sel = useUi.getState().selection;
        return sel.includes(id) ? sel : [id];
      };
      const open = (kind: "damage" | "heal" | "temp") => () =>
        useUi.getState().set({ hpDialog: { targets: targets(), kind } });
      out.push({
        id: "hp",
        label: "HP",
        icon: <HeartPulse size={18} />,
        ring: [
          { id: "hp-damage", label: "Damage…", icon: <HeartCrack size={18} />, run: open("damage") },
          { id: "hp-heal", label: "Heal…", icon: <Heart size={18} />, run: open("heal") },
          {
            id: "hp-temp",
            label: "Temporary HP…",
            short: "Temp HP",
            icon: <ShieldPlus size={18} />,
            run: open("temp"),
          },
        ],
      });
    }
    // Conditions and markers (§8.11; AC-HP-04): the picker, for those who control it.
    if (controls)
      out.push({
        id: "conditions",
        label: "Conditions",
        icon: <StatusIcon id="poisoned" size={18} label="" />,
        run: () => useUi.getState().set({ statusPicker: { tokenId: id } }),
      });
    if (dm) {
      // The DM's own actions under one slice (§8.19 "token radial menu → DM"): the ring keeps to §28's 6–8 slices.
      const dmRing: Slice[] = [
        // A DM asks for a roll: the selection (this token among it) goes to DM panel → Requests (§8.9).
        {
          id: "request",
          label: "Request a roll",
          short: "Request",
          icon: <D20Icon size={18} />,
          run: () => {
            const sel = useUi.getState().selection;
            useUi.getState().set({
              dock: "dm",
              dmSection: "requests",
              requestTargets: sel.includes(id) ? sel : [id],
            });
          },
        },
        token.dm?.dmHidden
          ? {
              id: "reveal",
              label: "Reveal",
              icon: <Eye size={18} />,
              run: () => send("reveal it", "token.update", { tokenId: id, hidden: false }),
            }
          : {
              id: "hide",
              label: "Hide",
              icon: <EyeOff size={18} />,
              run: () => send("hide it", "token.update", { tokenId: id, hidden: true }),
            },
        token.locked
          ? {
              id: "unlock",
              label: "Unlock",
              icon: <Unlock size={18} />,
              run: () => send("unlock it", "token.update", { tokenId: id, locked: false }),
            }
          : {
              id: "lock",
              label: "Lock",
              icon: <Lock size={18} />,
              run: () => send("lock it", "token.update", { tokenId: id, locked: true }),
            },
        // Its DM settings (§8.19 per-token overrides): speed, movement, who sees it, its link, its note.
        {
          id: "settings",
          label: "DM settings…",
          short: "Settings",
          icon: <SlidersHorizontal size={18} />,
          run: () => useUi.getState().set({ tokenSettings: id }),
        },
        // Act as (§8.19): a character's controls, on its player's behalf — or back to its player.
        ...(token.kind === "character" && token.actorId
          ? [
              acting?.actorId === token.actorId
                ? {
                    id: "actas",
                    label: `Stop acting as ${token.name}`,
                    short: "Stop acting",
                    icon: <VenetianMask size={18} />,
                    run: () =>
                      void actAs(null).catch((e: Error) => toast.danger("Couldn't let go", e.message)),
                  }
                : {
                    id: "actas",
                    label: `Act as ${token.name}`,
                    short: "Act as",
                    icon: <VenetianMask size={18} />,
                    run: () =>
                      void actAs(token.actorId).catch((e: Error) =>
                        toast.danger("Couldn't take its controls", e.message),
                      ),
                  },
            ]
          : []),
        // Dying (at 0 HP, death saves running): ask for a death saving throw, outside combat (§8.11).
        ...(token.markers.includes("deathsaves") && !token.markers.includes("stable") && !token.dead
          ? [
              {
                id: "deathsave",
                label: "Request a death save",
                short: "Death save",
                icon: <StatusIcon id="deathsaves" size={18} label="" />,
                run: () => send("ask for a death save", "death.request", { targets: [id] }),
              },
            ]
          : []),
        {
          id: "duplicate",
          label: "Duplicate",
          icon: <Copy size={18} />,
          run: async () => {
            try {
              const r = await request<{ tokenIds: string[] }>("token.duplicate", { tokenIds: [id] });
              useUi.getState().select(r.tokenIds);
            } catch (e) {
              toast.danger("Couldn't duplicate it", (e as Error).message);
            }
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash2 size={18} />,
          danger: true,
          run: async () => {
            try {
              await request("token.delete", { tokenIds: [id] });
              toastUndo(`Deleted ${token.name}`, () => request("history.undo", {}));
            } catch (e) {
              toast.danger("Couldn't delete it", (e as Error).message);
            }
          },
        },
      ];
      out.push({ id: "dm", label: "DM", icon: <WaxSeal size={20} />, ring: dmRing });
    }
    return out;
  }, [token, me, assets, carried, radial, acting]);

  const shown = ring ?? slices;
  const close = () => {
    setRing(null);
    useUi.getState().set({ radial: null });
  };

  // Nothing this viewer may do: no menu at all.
  useEffect(() => {
    if (radial && token && slices.length === 0) useUi.getState().set({ radial: null });
  }, [radial, token, slices.length]);

  useEffect(() => {
    if (!radial) return;
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (ring) setRing(null);
        else close();
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= shown.length) {
        e.preventDefault();
        choose(shown[n - 1] as Slice);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  });

  function choose(s: Slice) {
    if (s.ring) {
      setRing(s.ring);
      return;
    }
    void s.run?.();
    close();
  }

  // Slices are 74 × 62 px: the ring grows with their number so neighbours never touch, corner to corner, at any angle
  // (chord 2R·sin(π/n) ≥ their 97-px diagonal, plus a gap).
  const R = Math.max(96, 52 / Math.sin(Math.PI / Math.max(3, shown.length)));
  // The whole ring stays inside the part of the screen the HUD leaves clear (never over the toolbar, the dock, the top
  // or bottom bars): near an edge it shifts inward, its centre dot still marking the pressed point. Where the clear
  // part is too small for it, it centres there.
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  const area = clearArea(useHudInsets.getState(), vw, vh, isPhoneNow());
  const fit = (v: number, lo: number, hi: number) =>
    lo <= hi ? Math.min(Math.max(v, lo), hi) : (lo + hi) / 2;
  const cx = radial ? fit(radial.x, area.left + R + 37, area.right - R - 37) : 0;
  const cy = radial ? fit(radial.y, area.top + R + 31, area.bottom - R - 31) : 0;
  return (
    <AnimatePresence>
      {radial && token && shown.length ? (
        <motion.div
          ref={box}
          role="menu"
          aria-label={`Actions for ${token.name}`}
          className="pointer-events-none fixed z-50"
          style={{ left: cx, top: cy }}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 520, damping: 30 }}
        >
          <span
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--brass-300)] bg-ink-950"
            style={{ left: radial.x - cx, top: radial.y - cy }}
            aria-hidden
          />
          {shown.map((s, i) => {
            const a = -Math.PI / 2 + (i / shown.length) * Math.PI * 2;
            return (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                aria-label={s.label}
                aria-haspopup={s.ring ? "menu" : undefined}
                onClick={() => choose(s)}
                className={`panel pointer-events-auto absolute flex h-[62px] w-[74px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 px-1 transition-colors duration-[var(--dur-fast)] focus-visible:border-brass ${
                  s.danger
                    ? "text-danger-text hover:bg-[var(--danger-soft)]"
                    : "text-bone hover:bg-raised hover:text-brass-bright"
                }`}
                style={{ left: Math.cos(a) * R, top: Math.sin(a) * R }}
              >
                {s.icon}
                <span className="text-12 leading-none">{s.short ?? s.label}</span>
                <span className="absolute -right-1.5 -top-1.5" aria-hidden>
                  <KeyHint keys={String(i + 1)} />
                </span>
              </button>
            );
          })}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
