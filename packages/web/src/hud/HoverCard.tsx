import { HP_BAND_HIDDEN, HP_BAND_LABELS, statusName } from "@gloam/shared/rules";
import { useEffect, useRef, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { bodyRectOf, plateRectOf } from "../board/tokens/declutter.ts";
import { StatusIcon } from "../icons/status.tsx";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { useIsPhone } from "./insets.ts";

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
  const customs = token.customMarkers.map((s) => {
    const [id, label, color, glyph] = s.split("|") as [string, string, string, string];
    return { id, label, color, glyph };
  });
  // Right of the token and its plate, else left of them, else (no room either side) as near as fits; level with the
  // top of them, kept on the screen below the top bar.
  const W = 240;
  const GAP = 12;
  const h = card.current?.offsetHeight ?? 200;
  const vw = window.innerWidth;
  const left =
    at.x1 + GAP + W <= vw - GAP
      ? at.x1 + GAP
      : at.x0 - GAP - W >= GAP
        ? at.x0 - GAP - W
        : Math.min(vw - W - GAP, Math.max(GAP, at.x1 + GAP));
  const top = Math.min(window.innerHeight - h - GAP, Math.max(64, at.y0));
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
      <span className="display truncate text-18 text-bone">{token.name}</span>
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
      {statuses.length || customs.length || token.exhaustion ? (
        <ul className="flex flex-col gap-1" aria-label="Conditions and markers">
          {token.exhaustion ? (
            <li className="flex items-center gap-1.5 text-13 text-bone">
              <StatusIcon id="exhaustion" size={18} badge label="" />
              Exhaustion {token.exhaustion}
            </li>
          ) : null}
          {statuses.slice(0, 8).map((id) => (
            <li key={id} className="flex items-center gap-1.5 text-13 text-bone">
              <StatusIcon id={id} size={18} badge label="" />
              {statusName(id)}
            </li>
          ))}
          {customs.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5 text-13 text-bone">
              <StatusIcon id={c.id} size={18} badge label="" glyph={c.glyph} color={c.color} />
              {c.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
