import { useRef } from "react";
import { useNavigate } from "react-router";
import { type PresenceView, useTable } from "../net/table.ts";
import { Sparkle } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";
import { openEmoteWheel } from "./EmoteWheel.tsx";
import { HandBadge } from "./HandBadge.tsx";
import { hudOrder } from "./Intro.tsx";
import { useCover, useIsPhone } from "./insets.ts";
import { SettingsPopover } from "./SettingsPopover.tsx";

function Initials({ p, mine }: { p: PresenceView; mine: boolean }) {
  const portrait = (
    <Portrait
      name={p.name}
      color={p.color}
      size={32}
      dim={!p.online}
      {...(p.role === "dm" || p.role === "admin" ? { dm: p.role === "admin" ? "Host" : "DM" } : {})}
    />
  );
  return (
    <div className="relative" title={`${p.name}${p.online ? "" : " (away)"}`} data-presence={p.userId}>
      {mine ? (
        // Your own: a tap (or a long press on touch) opens the emote wheel beneath it (SPEC §8.18).
        <button
          type="button"
          aria-label="Emotes"
          className="block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openEmoteWheel({ x: r.left + r.width / 2, y: r.bottom + 150 });
          }}
        >
          {portrait}
        </button>
      ) : (
        portrait
      )}
      {p.handRaised ? <HandBadge className="absolute -right-1.5 -top-1.5" /> : null}
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
  const title = useRef<HTMLDivElement>(null);
  const people = useRef<HTMLDivElement>(null);
  useCover("title", title);
  useCover("people", people);
  return (
    <header
      {...hudOrder(0)}
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center gap-3 px-3 sm:px-4"
    >
      <div
        ref={title}
        className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--scrim-soft)] px-3 py-1.5 backdrop-blur-[3px]"
      >
        <Sparkle size={16} />
        <h1
          // A phone: two lines rather than the name cut short (critic P8 r1 #30).
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
      <div
        ref={people}
        className="pointer-events-auto ml-auto flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--scrim-soft)] py-1 pl-2 pr-1 backdrop-blur-[3px] sm:gap-3"
      >
        {/* 16-px gaps: a portrait's seal or raised hand never touches its neighbour's ring. */}
        <ul className="flex items-center gap-4" aria-label="At the table">
          {presence
            .filter((p) => p.online || p.role !== "admin")
            .map((p) => (
              <li key={p.userId}>
                <Initials p={p} mine={p.userId === me?.userId} />
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
