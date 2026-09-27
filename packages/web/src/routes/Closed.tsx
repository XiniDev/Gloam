import { useNavigate } from "react-router";
import { Button } from "../ui/Button.tsx";
import { Filigree, Sparkle } from "../ui/ornaments.tsx";

/** Shown to every non-admin client when the table closes (SPEC §8.1, AC-HOST-04). */
export default function Closed() {
  const navigate = useNavigate();
  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-bg p-4">
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="panel relative w-full max-w-[460px] px-8 pb-8 pt-10 text-center">
        <Filigree />
        <svg width="56" height="80" viewBox="0 0 56 80" className="mx-auto" aria-hidden>
          <path
            d="M28 6c-2 6 4 8 0 14"
            fill="none"
            stroke="var(--fog-400)"
            strokeWidth="1.4"
            strokeLinecap="round"
            opacity=".7"
          >
            <animate attributeName="opacity" values=".7;.15;.7" dur="3.2s" repeatCount="indefinite" />
          </path>
          <path
            d="M28 20c-3 4 3 6 0 10"
            fill="none"
            stroke="var(--fog-400)"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity=".5"
          />
          <path d="M28 30v8" stroke="var(--ink-500)" strokeWidth="1.6" />
          <rect x="18" y="38" width="20" height="34" rx="3" fill="var(--parchment-200)" />
          <ellipse cx="28" cy="38" rx="10" ry="2.6" fill="var(--parchment-100)" />
          <path d="M8 76h40" stroke="var(--ink-700)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Sparkle size={16} />
          <span className="caps text-12 text-brass">Gloam</span>
        </div>
        <h1 className="mt-3 text-28 text-bone">The table is closed — thanks for playing</h1>
        <p className="mt-3 text-14 text-muted">
          When your host opens it again they'll share a new link and code.
        </p>
        <Button className="mt-7" variant="secondary" onClick={() => navigate("/join")}>
          I have a new code
        </Button>
      </div>
    </main>
  );
}
