import { ShaderCanvas } from "../board/ambient/ShaderCanvas.tsx";
import { BACKDROP_UNIFORMS, TABLE_BACKDROP } from "../board/ambient/shaders.ts";
import { useTable } from "../net/table.ts";

/**
 * The stage behind the HUD: the candle-lit table. Phase 2 mounts the 3D board (R3F canvas) here; until a scene
 * is active the table itself is what everyone sees, with a short line telling them what's happening.
 */
export function TableStage() {
  const role = useTable((s) => s.me?.role);
  const dm = role === "admin" || role === "dm";
  return (
    <div className="absolute inset-0">
      <ShaderCanvas
        frag={TABLE_BACKDROP}
        uniforms={BACKDROP_UNIFORMS}
        scale={0.6}
        className="absolute inset-0 h-full w-full"
      />
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="absolute inset-x-0 bottom-[14%] flex justify-center px-4">
        <p className="rounded-[var(--radius-control)] bg-[var(--scrim-soft)] px-4 py-2 text-center text-14 text-muted backdrop-blur-[3px]">
          {dm
            ? "No scene is active yet — prepare one for your players."
            : "Waiting for the DM to set the scene…"}
        </p>
      </div>
    </div>
  );
}
