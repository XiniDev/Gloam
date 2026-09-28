import { useNavigate } from "react-router";
import { type PresenceView, useTable } from "../net/table.ts";
import { Sparkle } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";
import { hudOrder } from "./Intro.tsx";
import { useIsPhone } from "./insets.ts";
import { SettingsPopover } from "./SettingsPopover.tsx";

function Initials({ p }: { p: PresenceView }) {
  return (
    <div className="relative" title={`${p.name}${p.online ? "" : " (away)"}`}>
      <Portrait
        name={p.name}
        color={p.color}
        size={32}
        dim={!p.online}
        {...(p.role === "dm" || p.role === "admin" ? { dm: p.role === "admin" ? "Host" : "DM" } : {})}
      />
      {p.handRaised ? (
        <span
          className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-accent"
          role="img"
          aria-label="Hand raised"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--ink-950)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13c0 4.5-2.5 8-6.5 8-2.5 0-4.2-1.3-5.4-3.4L3.4 14.4a1.6 1.6 0 0 1 2.6-1.8L8 15" />
          </svg>
        </span>
      ) : null}
    </div>
  );
}

/** Top bar (SPEC §29.3): scene/campaign title, party presence, sound and settings. 56 px. */
export function TopBar() {
  const navigate = useNavigate();
  const name = useTable((s) => s.campaignName);
  const sessionNo = useTable((s) => s.sessionNo);
  const presence = useTable((s) => s.presence);
  const me = useTable((s) => s.me);
  // A phone's top bar keeps its room for the title: the Admin console moves into Settings there.
  const phone = useIsPhone();
  return (
    <header
      {...hudOrder(0)}
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center gap-3 px-3 sm:px-4"
    >
      <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--scrim-soft)] px-3 py-1.5 backdrop-blur-[3px]">
        <Sparkle size={16} />
        <h1
          className={phone ? "line-clamp-2 text-14 leading-tight text-bone" : "truncate text-18 text-bone"}
          title={name || undefined}
        >
          {name || "The table"}
        </h1>
        {sessionNo ? (
          <span className="caps hidden text-12 text-fog sm:inline">Session {sessionNo}</span>
        ) : null}
      </div>
      {/* Backed like the title: the grey sound and settings icons stay readable over pale stone. */}
      <div className="pointer-events-auto ml-auto flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--scrim-soft)] py-1 pl-2 pr-1 backdrop-blur-[3px] sm:gap-3">
        {/* 16-px gaps: a portrait's seal or raised hand never touches its neighbour's ring. */}
        <ul className="flex items-center gap-4" aria-label="At the table">
          {presence
            .filter((p) => p.online || p.role !== "admin")
            .map((p) => (
              <li key={p.userId}>
                <Initials p={p} />
              </li>
            ))}
        </ul>
        <SoundChip />
        <SettingsPopover />
        {me?.role === "admin" && !phone ? (
          <button
            type="button"
            aria-label="Admin console"
            onClick={() => navigate("/admin")}
            className="hit whitespace-nowrap rounded-[var(--radius-control)] border border-line bg-raised px-3 text-13 font-bold text-bone hover:border-brass"
          >
            <span className="sm:hidden">Admin</span>
            <span className="hidden sm:inline">Admin console</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
