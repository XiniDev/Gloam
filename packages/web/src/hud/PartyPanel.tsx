import { useTable } from "../net/table.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";

const ROLE_LABEL: Record<string, string> = {
  admin: "Host",
  dm: "DM",
  player: "Player",
  spectator: "Watching",
};

/** Who's at the table (SPEC §29.3 dock "Party"): presence, role and raised hands. Characters join in Phase 6. */
export function PartyPanel() {
  const presence = useTable((s) => s.presence);
  const people = presence.filter((p) => p.role !== "admin" || p.online);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-18 text-bone">At the table</h2>
        <p className="text-13 text-muted">
          {people.filter((p) => p.online).length} here · {people.filter((p) => !p.online).length} away
        </p>
      </header>
      {people.length === 0 ? (
        <EmptyState art="candle" title="Nobody else is here yet." />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {people.map((p) => (
            <li
              key={p.userId}
              className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 hover:bg-raised"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: p.color, opacity: p.online ? 1 : 0.4 }}
                aria-hidden
              />
              <span className={`min-w-0 flex-1 truncate text-14 ${p.online ? "text-bone" : "text-faint"}`}>
                {p.name}
              </span>
              {p.handRaised ? <span className="caps text-12 text-accent">hand raised</span> : null}
              {/* Every role reads as a word; the DM/Host also wear the wax seal (SPEC §27.4 ornaments). */}
              <span className="flex items-center gap-1.5">
                {p.role === "dm" || p.role === "admin" ? (
                  <WaxSeal size={20} label={ROLE_LABEL[p.role]} />
                ) : null}
                <span
                  className={`caps text-12 ${p.role === "dm" || p.role === "admin" ? "text-brass" : "text-fog"}`}
                >
                  {ROLE_LABEL[p.role] ?? p.role}
                </span>
              </span>
              {!p.online ? <span className="text-12 text-faint">away</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
