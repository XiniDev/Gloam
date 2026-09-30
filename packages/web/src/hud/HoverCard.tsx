import { HP_BAND_HIDDEN, HP_BAND_LABELS, statusName, statusSummary } from "@gloam/shared/rules";
import { parseCustomMarkers } from "@gloam/shared/state";
import { useEffect, useRef, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { bodyRectOf, bodyRects, plateCovers, plateRectOf, plateRects } from "../board/tokens/declutter.ts";
import { StatusIcon } from "../icons/status.tsx";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Portrait } from "../ui/Portrait.tsx";
import { overrideBadges } from "./dm/tokenDm.tsx";
import { useIsPhone } from "./insets.ts";
import { useAssetImage } from "./useAssetImage.ts";

/** How long the pointer rests on a token before its card shows (AC-TOK-12). */
export const HOVER_CARD_MS = 400;

/**
 * The token hover card (SPEC §8.5; AC-TOK-12): after the pointer rests on a token for 400 ms, a small card beside it —
 * its name, HP as its display mode allows this viewer, its conditions and markers by name, concentration and
 * exhaustion — and its AC for the DM and its owners only (the server sends AC to no one else: §13.4). Not on touch,
 * where there is no hover (the radial menu and the sheet are there).
 */
export function HoverCard() {
  const hover = useUi((s) => s.hover);
  const radial = useUi((s) => s.radial);
  const people = useTable((s) => s.presence);
  const npcHp = useTable((s) => s.houseRules.npcHpDisplay);
  const phone = useIsPhone();
  const [shown, setShown] = useState<string | null>(null);
  // How long the pointer had rested when it showed (ms; the tests check the 400 ms).
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    setShown(null);
    if (!hover) return;
    const began = performance.now();
    const t = window.setTimeout(() => {
      setWaited(Math.round(performance.now() - began));
      setShown(hover);
    }, HOVER_CARD_MS);
    return () => window.clearTimeout(t);
  }, [hover]);
  const token = useBoard((d) => (shown ? d.tokens.get(shown) : undefined));
  const portrait = useAssetImage(token ? token.portraitAssetId || token.assetId : null, 96);
  // What the card keeps beside: the token on screen and its plate (never over either — the plate says the same).
  const [at, setAt] = useState<Box | null>(null);
  useEffect(() => {
    if (!token) return;
    let raf = 0;
    const place = () => {
      const p = boardApi.project(token.pos.x, token.pos.y, token.elevation);
      const parts = [bodyRectOf(token.id), plateRectOf(token.id)].filter((r): r is Box => Boolean(r));
      const box = parts.length
        ? {
            x0: Math.min(...parts.map((r) => r.x0)),
            y0: Math.min(...parts.map((r) => r.y0)),
            x1: Math.max(...parts.map((r) => r.x1)),
            y1: Math.max(...parts.map((r) => r.y1)),
          }
        : p
          ? { x0: p.sx - 28, y0: p.sy - 28, x1: p.sx + 28, y1: p.sy + 28 }
          : null;
      setAt((a) => (box && (!a || moved(a, box)) ? box : a));
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [token]);
  const card = useRef<HTMLDivElement>(null);
  if (!token || !at || radial || phone || window.matchMedia?.("(hover: none)").matches) return null;
  const hp =
    token.hp !== undefined
      ? `${token.hp.hp} / ${token.hp.hpMax}${token.hp.hpTemp ? ` (+${token.hp.hpTemp} temp)` : ""}`
      : token.hpBand !== HP_BAND_HIDDEN
        ? HP_BAND_LABELS[token.hpBand]
        : null;
  const statuses = [...token.conditions, ...token.markers.filter((m) => !m.startsWith("custom:"))];
  // The DM's view: the token's overrides and settings that aren't its defaults, as badges (AC-DMP-02).
  const badges = token.dm
    ? overrideBadges(token, (id) => people.find((p) => p.userId === id)?.name ?? "someone", npcHp)
    : [];
  const customs = parseCustomMarkers(token.customMarkers);
  const { left, top } = placeCard(token.id, at, W, card.current?.offsetHeight ?? 200);
  return (
    <div
      ref={card}
      role="tooltip"
      data-testid="hover-card"
      data-token={token.id}
      data-waited={waited}
      className="panel pointer-events-none absolute z-40 flex flex-col gap-1.5 p-3 shadow-[var(--shadow-float)] motion-safe:animate-[rise-in_var(--dur-fast)_var(--ease-out)_both]"
      style={{ left, top, width: W }}
    >
      {/* §8.5: portrait, name, HP (per mode), AC (DM / owner), speeds, conditions with their one-line summaries. */}
      <div className="flex items-center gap-2.5">
        <Portrait name={token.name} color={token.ringColor || "var(--line)"} size={40} src={portrait} />
        <span className="display min-w-0 flex-1 truncate text-18 text-bone">{token.name}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-13">
        {hp ? (
          <>
            <dt className="caps text-12 text-fog">HP</dt>
            <dd className="tabular text-bone" data-testid="hover-hp">
              {hp}
            </dd>
          </>
        ) : null}
        {token.own ? (
          <>
            <dt className="caps text-12 text-fog">AC</dt>
            <dd className="tabular text-bone" data-testid="hover-ac">
              {token.own.ac}
            </dd>
            <dt className="caps text-12 text-fog">Speed</dt>
            <dd className="tabular text-bone">{token.own.budgetFt} ft</dd>
          </>
        ) : null}
      </dl>
      {badges.length ? (
        <ul
          className="flex flex-wrap gap-1 border-t border-line/60 pt-2"
          aria-label="DM settings"
          data-testid="dm-badges"
        >
          {badges.map((b) => (
            <li
              key={b.key}
              title={b.title}
              data-badge={b.key}
              className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-chip)] border border-brass-deep/60 bg-ink-900 px-1.5 py-0.5 text-12 text-bone"
            >
              <b.icon size={12} className="shrink-0 text-brass" aria-hidden />
              <span className="truncate">{b.text}</span>
              <span className="sr-only">: {b.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {statuses.length || customs.length || token.exhaustion ? (
        <ul
          className="flex flex-col gap-1.5 border-t border-line/60 pt-2"
          aria-label="Conditions and markers"
        >
          {token.exhaustion ? (
            <Condition
              icon={<StatusIcon id="exhaustion" size={18} badge label="" level={token.exhaustion} />}
              name={`Exhaustion ${token.exhaustion}`}
              summary={statusSummary("exhaustion")}
            />
          ) : null}
          {statuses.slice(0, 8).map((id) => (
            <Condition
              key={id}
              icon={<StatusIcon id={id} size={18} badge label="" />}
              name={statusName(id)}
              summary={statusSummary(id)}
            />
          ))}
          {customs.map((c) => (
            <Condition
              key={c.id}
              icon={<StatusIcon id={c.id} size={18} badge label="" glyph={c.glyph} color={c.color} />}
              name={c.label}
              summary={c.description}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A condition or marker: its badge and name, its one-line summary under them. */
function Condition({ icon, name, summary }: { icon: React.ReactNode; name: string; summary?: string }) {
  return (
    <li className="grid grid-cols-[18px_1fr] items-start gap-x-2 text-13 text-bone">
      <span className="mt-px">{icon}</span>
      <span className="min-w-0">
        {name}
        {summary ? <span className="block text-12 leading-snug text-muted">{summary}</span> : null}
      </span>
    </li>
  );
}

const W = 240;
const GAP = 12;

/**
 * Where the card stands: beside the token and its plate (never over them — they say the same), where it covers least:
 * another creature's plate worst (it names that creature; critic P7 r2 #8), then the HUD, then other tokens. Each side
 * — right, left, below, above, preferred in that order — is tried at several spots along it (slid up or down beside
 * the token, left or right under or over it), the nearer the better when it's a tie. Kept on the screen, below the
 * top bar.
 */
function placeCard(tokenId: string, at: Box, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(vw - w - GAP, Math.max(GAP, x));
  const clampY = (y: number) => Math.min(vh - h - GAP, Math.max(64, y));
  const midX = (at.x0 + at.x1) / 2 - w / 2;
  const midY = (at.y0 + at.y1) / 2 - h / 2;
  // Slides along a side: from level with the token's top, both ways, up to the card's own height.
  const slidesY = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1].map((f) => f * h);
  const slidesX = [0, 0.25, -0.25, 0.5, -0.5].map((f) => f * w);
  const candidates: { left: number; top: number; rank: number; slide: number }[] = [];
  for (const dy of slidesY) {
    candidates.push({ left: at.x1 + GAP, top: clampY(at.y0 + dy), rank: 0, slide: Math.abs(dy) });
    candidates.push({ left: at.x0 - GAP - w, top: clampY(at.y0 + dy), rank: 1, slide: Math.abs(dy) });
  }
  candidates.push({ left: at.x1 + GAP, top: clampY(midY), rank: 0, slide: Math.abs(midY - at.y0) });
  candidates.push({ left: at.x0 - GAP - w, top: clampY(midY), rank: 1, slide: Math.abs(midY - at.y0) });
  for (const dx of slidesX) {
    candidates.push({ left: clampX(midX + dx), top: at.y1 + GAP, rank: 2, slide: Math.abs(dx) });
    candidates.push({ left: clampX(midX + dx), top: at.y0 - GAP - h, rank: 3, slide: Math.abs(dx) });
  }
  const bodies = bodyRects()
    .filter((b) => b.id !== tokenId)
    .map((x) => x.r);
  const plates = plateRects()
    .filter((p) => p.id !== tokenId)
    .map((x) => x.r);
  const hud = plateCovers();
  const area = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
    Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  let best = candidates[0] as (typeof candidates)[number];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const box = { x0: c.left, y0: c.top, x1: c.left + w, y1: c.top + h };
    const offscreen = box.x0 < GAP || box.x1 > vw - GAP || box.y0 < 64 || box.y1 > vh - GAP;
    // Never over its own token and plate; off the screen only if nothing else is possible.
    const cover =
      (offscreen ? 1e9 : 0) +
      area(box, at) * 1e3 +
      plates.reduce((s, r) => s + 40 * area(box, r), 0) +
      hud.reduce((s, r) => s + 8 * area(box, r), 0) +
      bodies.reduce((s, r) => s + area(box, r), 0);
    // A tie goes to the preferred side, then the nearer spot along it.
    const cost = cover + c.rank * 2 + c.slide * 0.01;
    if (cost < bestCost) {
      best = c;
      bestCost = cost;
    }
  }
  return { left: clampX(best.left), top: clampY(best.top) };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const moved = (a: Box, b: Box) =>
  Math.abs(a.x0 - b.x0) > 0.5 ||
  Math.abs(a.y0 - b.y0) > 0.5 ||
  Math.abs(a.x1 - b.x1) > 0.5 ||
  Math.abs(a.y1 - b.y1) > 0.5;
