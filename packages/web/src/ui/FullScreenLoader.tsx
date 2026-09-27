import { D20Spinner } from "./Spinner.tsx";

/** Quiet full-screen loading state (no white flash: the page background is ink from the first byte). */
export function FullScreenLoader({ label = "Lighting the candles…" }: { label?: string }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-brass">
        <D20Spinner size={22} />
        <span className="caps text-12 text-fog">{label}</span>
      </div>
    </div>
  );
}
