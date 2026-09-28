import { HP_BAND_HIDDEN, HP_BAND_LABELS, statusName } from "@gloam/shared/rules";
import { useEffect, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
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
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!token) return;
    let raf = 0;
    const place = () => {
      const p = boardApi.project(token.pos.x, token.pos.y, token.elevation);
      setAt((a) =>
        p && (!a || Math.abs(a.x - p.sx) > 0.5 || Math.abs(a.y - p.sy) > 0.5) ? { x: p.sx, y: p.sy } : a,
      );
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [token]);
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
  const W = 240;
  const left = Math.min(window.innerWidth - W - 12, Math.max(12, at.x + 28));
  const top = Math.min(window.innerHeight - 180, Math.max(64, at.y - 60));
  return (
    <div
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
