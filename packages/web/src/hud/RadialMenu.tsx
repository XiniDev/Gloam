import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Palette,
  RotateCcw,
  RotateCw,
  Trash2,
  Unlock,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { request, useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useLibrary } from "../state/library.ts";
import { useUi } from "../state/ui.ts";
import { toast } from "../ui/Toast.tsx";
import { toastUndo } from "./dm/ScenesPanel.tsx";

interface Slice {
  id: string;
  label: string;
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

  const slices = useMemo<Slice[]>(() => {
    if (!token || !me) return [];
    const dm = me.role === "dm" || me.role === "admin";
    const controls = dm || token.ownerIds.includes(me.userId);
    const out: Slice[] = [];
    const id = token.id;
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
    }
    if (dm) {
      out.push(
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
      );
    }
    return out;
  }, [token, me, assets]);

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

  // Slices are 74 × 62 px: the ring grows with their number so neighbours never touch (chord 2R·sin(π/n) ≥ 84 px).
  const R = Math.max(86, 42 / Math.sin(Math.PI / Math.max(3, shown.length)));
  // The whole ring stays on screen and below the top bar: near an edge it shifts inward (its centre dot still marks
  // the pressed point).
  const reach = R + 37 + 8;
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  const cx = radial ? Math.min(Math.max(radial.x, reach), Math.max(reach, vw - reach)) : 0;
  const cy = radial
    ? Math.min(Math.max(radial.y, 56 + reach - 6), Math.max(56 + reach - 6, vh - reach + 6))
    : 0;
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
                    ? "text-[var(--blood-500)] hover:bg-[var(--danger-soft)]"
                    : "text-bone hover:bg-raised hover:text-brass-bright"
                }`}
                style={{ left: Math.cos(a) * R, top: Math.sin(a) * R }}
              >
                {s.icon}
                <span className="text-12 leading-none">{s.label}</span>
                <span className="absolute right-1 top-0.5 text-12 text-faint" aria-hidden>
                  {i + 1}
                </span>
              </button>
            );
          })}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
