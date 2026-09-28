import { DICE_BODY_COLORS, DICE_NUMBER_COLORS } from "@gloam/shared";
import { DEFAULT_SKIN, type DiceSkin } from "@gloam/shared/dice";
import { useEffect, useRef, useState } from "react";
import { request, useTable } from "../net/table.ts";
import { Segmented } from "../ui/controls.tsx";
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
 * your rolls in them (AC-DICE-07). A small d20 shows the choice as you make it.
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
    <div className="flex flex-col gap-2.5" data-testid="dice-skin">
      <div className="flex items-center gap-3">
        <DiePreview skin={skin} />
        <Segmented<DiceSkin["material"]>
          label="Dice material"
          size="S"
          value={skin.material}
          onChange={(material) => save({ ...skin, material })}
          options={MATERIALS}
        />
      </div>
      <Swatches
        label="Dice colour"
        value={skin.body}
        colors={DICE_BODY_COLORS}
        onChange={(body) => save({ ...skin, body })}
      />
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
    <div className="flex flex-wrap items-center gap-0.5" role="radiogroup" aria-label={label}>
      <span className="caps w-16 text-12 text-fog" aria-hidden>
        {label.split(" ")[0]}
      </span>
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
              <span className="block h-5 w-5 rounded-full border border-line" style={{ background: c.hex }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A d20 face-on in the skin: the body's colour, "20" in the number colour, a sheen for metal and gems. */
function DiePreview({ skin }: { skin: DiceSkin }) {
  const sheen = skin.material === "metal" || skin.material === "gemstone" || skin.material === "obsidian";
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" role="img" aria-label="Your dice">
      <polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill={skin.body} />
      <polygon points="20,8 32,28 8,28" fill={skin.body} stroke="var(--ink-950)" strokeOpacity="0.35" />
      {sheen ? (
        <polygon
          points="20,2 36,11 20,8"
          fill="var(--bone-100)"
          opacity={skin.material === "metal" ? 0.3 : 0.18}
        />
      ) : null}
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
}
