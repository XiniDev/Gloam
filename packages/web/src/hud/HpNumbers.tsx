import type { DamageType } from "@gloam/shared";
import type { HpFx } from "@gloam/shared/protocol";
import { useEffect, useRef, useState } from "react";
import { bodyRectOf, plateRectOf } from "../board/tokens/declutter.ts";
import { hpFx } from "../net/health.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";

/** How long a number floats (ms). */
const FLOAT_MS = 1300;
/** The space between one hit's numbers (px), e.g. "−6" slashing and "−4" fire. */
const NUMBER_GAP = 14;

interface Floater {
  key: number;
  tokenId: string;
  text: string;
  /** A colour token: the damage type's, healing's verdigris, temp HP's ice. */
  color: string;
  at: number;
  /** One HP change's numbers share a group: laid out side by side, centred, by their measured widths. */
  group: number;
}

/** The numbers an HP change shows: each damage type in its colour (largest first), healing with a "+", temp HP. */
export function numbersOf(f: HpFx): { text: string; color: string }[] {
  if (f.kind === "heal") return f.amount > 0 ? [{ text: `+${f.amount}`, color: "var(--dmg-healing)" }] : [];
  if (f.kind === "temp") return f.amount > 0 ? [{ text: `+${f.amount} temp`, color: "var(--hp-temp)" }] : [];
  const parts = f.parts?.length
    ? f.parts
    : f.amount > 0
      ? [{ type: "untyped" as const, amount: f.amount }]
      : [];
  return parts.map((p) => ({
    text: `−${p.amount}`,
    color: p.type === "untyped" ? "var(--bone-100)" : `var(--dmg-${p.type as DamageType})`,
  }));
}

let seq = 0;
/** The numbers shown (tests: what floated, in which colour). */
const shownLog: { tokenId: string; text: string; color: string }[] = [];

/**
 * Floating HP numbers (SPEC §8.11 Feedback; AC-HP-11): coloured by damage type — healing verdigris with a "+" — rising
 * from just above the token's plate (or its head, when it shows none) and fading, for everyone who can see it. In the
 * HUD so they stay crisp and the same size at any zoom.
 */
export function HpNumbers() {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  useEffect(() => provideTestHook("hpNumbers", () => shownLog.map((x) => ({ ...x }))), []);
  const els = useRef(new Map<number, HTMLSpanElement>());
  useEffect(
    () =>
      hpFx.on((f) => {
        const now = performance.now();
        const group = ++seq;
        const add = numbersOf(f).map((n, i) => ({
          key: ++seq,
          tokenId: f.tokenId,
          text: n.text,
          color: n.color,
          at: now + i * 110,
          group,
        }));
        if (add.length) setFloaters((fs) => [...fs, ...add]);
        if (__GLOAM_TEST__)
          shownLog.push(...add.map((x) => ({ tokenId: x.tokenId, text: x.text, color: x.color })));
      }),
    [],
  );
  // Each frame: where each number is (above its token's plate, rising) and how faded; gone when done.
  useEffect(() => {
    if (!floaters.length) return;
    let raf = 0;
    const reduced = prefersReducedMotion();
    const tick = () => {
      const now = performance.now();
      let done = false;
      // Each group's numbers in a row: every number's centre offset from the row's centre.
      const dx = new Map<number, number>();
      const rows = new Map<number, Floater[]>();
      for (const f of floaters) rows.set(f.group, [...(rows.get(f.group) ?? []), f]);
      for (const row of rows.values()) {
        const widths = row.map((f) => els.current.get(f.key)?.offsetWidth ?? 0);
        let x = -(widths.reduce((a, b) => a + b, 0) + NUMBER_GAP * (row.length - 1)) / 2;
        row.forEach((f, i) => {
          const w = widths[i] as number;
          dx.set(f.key, x + w / 2);
          x += w + NUMBER_GAP;
        });
      }
      for (const f of floaters) {
        const el = els.current.get(f.key);
        if (!el) continue;
        const t = (now - f.at) / FLOAT_MS;
        if (t > 1) {
          done = true;
          el.style.opacity = "0";
          continue;
        }
        const plate = plateRectOf(f.tokenId);
        const body = bodyRectOf(f.tokenId);
        const anchor = plate ?? body;
        if (!anchor || t < 0) {
          el.style.opacity = "0";
          continue;
        }
        const x = (anchor.x0 + anchor.x1) / 2 + (dx.get(f.key) ?? 0);
        const rise = reduced ? 0 : 42 * (1 - (1 - t) ** 2);
        el.style.transform = `translate(${x}px, ${anchor.y0 - 8 - rise}px) translate(-50%, -100%)`;
        el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      }
      // A hit's numbers go together (so the last one doesn't jump as the row re-centres).
      if (done)
        setFloaters((fs) => {
          const live = new Set(fs.filter((f) => now - f.at <= FLOAT_MS).map((f) => f.group));
          const next = fs.filter((f) => live.has(f.group));
          return next.length === fs.length ? fs : next;
        });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [floaters]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {floaters.map((f) => (
        <span
          key={f.key}
          ref={(el) => {
            if (el) els.current.set(f.key, el);
            else els.current.delete(f.key);
          }}
          data-testid="hp-number"
          className="display tabular absolute left-0 top-0 whitespace-nowrap text-28 leading-none opacity-0 [paint-order:stroke_fill] [-webkit-text-stroke:5px_var(--ink-950)]"
          style={{ color: f.color }}
        >
          {f.text}
        </span>
      ))}
    </div>
  );
}
