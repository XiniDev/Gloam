import { DICE_BODY_COLORS, DICE_NUMBER_COLORS } from "@gloam/shared";
import { DEFAULT_SKIN, type DiceSkin } from "@gloam/shared/dice";
import { useEffect, useRef, useState } from "react";
import { drawDiePreview } from "../dice/preview.ts";
import { request, useTable } from "../net/table.ts";
import { toast } from "../ui/Toast.tsx";

const MATERIALS: { value: DiceSkin["material"]; label: string }[] = [
  { value: "resin", label: "Resin" },
  { value: "gemstone", label: "Gem" },
  { value: "metal", label: "Metal" },
  { value: "bone", label: "Bone" },
  { value: "obsidian", label: "Obsidian" },
];

/** A skin from its stored JSON (anything unreadable falls back to the defaults, field by field). */
export function parseSkin(json: string | undefined): DiceSkin {
  try {
    const s = JSON.parse(json || "{}") as Partial<DiceSkin>;
    return {
      body: typeof s.body === "string" ? s.body : DEFAULT_SKIN.body,
      number: typeof s.number === "string" ? s.number : DEFAULT_SKIN.number,
      material: MATERIALS.some((m) => m.value === s.material)
        ? (s.material as DiceSkin["material"])
        : DEFAULT_SKIN.material,
    };
  } catch {
    return DEFAULT_SKIN;
  }
}

/**
 * Your dice (SPEC §8.9 Dice skins): body colour, material and number colour, saved to your profile — everyone sees
 * your rolls in them (AC-DICE-07). A d20 drawn as the table draws it — its material, reflections and all — shows the
 * choice as you make it.
 */
export function DiceSkinPicker() {
  const me = useTable((s) => s.me?.userId ?? "");
  const stored = useTable((s) => s.presence.find((p) => p.userId === me)?.diceSkin);
  const [skin, setSkin] = useState<DiceSkin>(() => parseSkin(stored));
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setSkin(parseSkin(stored));
  }, [stored]);
  const save = (next: DiceSkin) => {
    setSkin(next);
    dirty.current = true;
    void request("profile.diceSkin", next)
      .catch((e) => toast.danger("Couldn't save your dice", (e as Error).message))
      .finally(() => {
        dirty.current = false;
      });
  };
  return (
    // One column of labels, one of choices: every row starts at the same line.
    <div className="grid grid-cols-[4.5rem_1fr] items-start gap-x-3 gap-y-3" data-testid="dice-skin">
      <span className="caps pt-2.5 text-12 text-fog" aria-hidden>
        Material
      </span>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5" role="radiogroup" aria-label="Dice material">
          {MATERIALS.map((m) => {
            const active = m.value === skin.material;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => save({ ...skin, material: m.value })}
                className={`flex h-8 min-h-[var(--touch-min)] items-center rounded-chip px-3 text-left text-13 font-bold transition-[background-color,color,box-shadow] duration-[var(--dur-fast)] ${
                  active
                    ? "bg-raised text-brass-bright shadow-[inset_2px_0_0_var(--brass-400)]"
                    : "text-muted shadow-[inset_2px_0_0_transparent] hover:text-bone"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <DiePreview skin={skin} />
      </div>
      <span className="caps pt-2.5 text-12 text-fog" aria-hidden>
        Dice
      </span>
      <Swatches
        label="Dice colour"
        value={skin.body}
        colors={DICE_BODY_COLORS}
        onChange={(body) => save({ ...skin, body })}
      />
      <span className="caps pt-2.5 text-12 text-fog" aria-hidden>
        Number
      </span>
      <Swatches
        label="Number colour"
        value={skin.number}
        colors={DICE_NUMBER_COLORS}
        onChange={(number) => save({ ...skin, number })}
      />
    </div>
  );
}

function Swatches({
  label,
  value,
  colors,
  onChange,
}: {
  label: string;
  value: string;
  colors: readonly { name: string; hex: string }[];
  onChange: (hex: string) => void;
}) {
  return (
    // Rows of five: the ten body colours are two full rows, never a straggler on a third.
    <div className="grid w-fit grid-cols-5 gap-0.5" role="radiogroup" aria-label={label}>
      {colors.map((c) => {
        const active = c.hex.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={c.name}
            title={c.name}
            onClick={() => onChange(c.hex)}
            className="group grid h-8 min-h-[var(--touch-min)] w-8 min-w-[var(--touch-min)] place-items-center"
          >
            <span
              className={`grid h-7 w-7 place-items-center rounded-full border-2 ${active ? "border-bone" : "border-transparent group-hover:border-line-strong"}`}
              aria-hidden
            >
              {/* A fog hairline round every swatch: the near-black ones stay visible on the ink. */}
              <span
                className="block h-5 w-5 rounded-full"
                style={{
                  background: c.hex,
                  boxShadow: "0 0 0 1px color-mix(in srgb, var(--fog-300) 55%, transparent)",
                }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

const PREVIEW_PX = 88;

/** Your d20 as the table draws it; a flat glyph where there's no WebGL. */
function DiePreview({ skin }: { skin: DiceSkin }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [flat, setFlat] = useState(false);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(PREVIEW_PX * dpr);
    c.height = Math.round(PREVIEW_PX * dpr);
    if (!drawDiePreview(c, skin)) setFlat(true);
  }, [skin]);
  const name = `Your dice: ${MATERIALS.find((m) => m.value === skin.material)?.label ?? ""}`;
  if (flat)
    return (
      <svg width={PREVIEW_PX} height={PREVIEW_PX} viewBox="0 0 40 40" role="img" aria-label={name}>
        <polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill={skin.body} />
        <polygon points="20,8 32,28 8,28" fill={skin.body} stroke="var(--ink-950)" strokeOpacity="0.35" />
        <text
          x="20"
          y="24"
          textAnchor="middle"
          fontFamily="var(--font-display)"
          fontWeight="700"
          fontSize="10"
          fill={skin.number}
        >
          20
        </text>
      </svg>
    );
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={name}
      data-testid="dice-preview"
      data-material={skin.material}
      style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
      className="shrink-0"
    />
  );
}
