import { ShaderCanvas } from "../../board/ambient/ShaderCanvas.tsx";
import { vec3Of } from "../../board/ambient/shaders.ts";
import { FLOOR_LABELS, FLOOR_PREVIEW_GLSL, FLOOR_STYLES, PALETTE } from "../../board/floors.ts";
import type { FloorStyle } from "../../board/scene.ts";

const UNIFORMS = Object.fromEntries(
  FLOOR_STYLES.flatMap((s, i) => {
    const [a, b, j] = PALETTE[s];
    return [
      [`uA${i}`, vec3Of(a)],
      [`uB${i}`, vec3Of(b)],
      [`uJ${i}`, vec3Of(j)],
    ];
  }),
) as Record<string, [number, number, number]>;

/** The six procedural floors, drawn live by the same pattern code the board uses (SPEC §8.3, AC-SCN-05). */
export function FloorPicker({ value, onChange }: { value: FloorStyle; onChange: (s: FloorStyle) => void }) {
  return (
    <div className="relative aspect-[3/1.35] w-full overflow-hidden rounded-[var(--radius-control)] border border-line">
      <ShaderCanvas
        frag={FLOOR_PREVIEW_GLSL}
        uniforms={UNIFORMS}
        scale={1}
        className="absolute inset-0 h-full w-full"
      />
      <div
        role="radiogroup"
        aria-label="Floor style"
        className="absolute inset-0 grid grid-cols-3 grid-rows-2"
      >
        {FLOOR_STYLES.map((s) => {
          const active = s === value;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(s)}
              className={`relative flex items-end justify-start p-2 text-left transition-shadow duration-[var(--dur-fast)] ${
                active
                  ? "shadow-[inset_0_0_0_2px_var(--brass-300)]"
                  : "hover:shadow-[inset_0_0_0_1px_var(--brass-600)]"
              }`}
            >
              <span className="caps rounded-[4px] bg-[var(--scrim)] px-1.5 py-0.5 text-12 text-bone">
                {FLOOR_LABELS[s]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
