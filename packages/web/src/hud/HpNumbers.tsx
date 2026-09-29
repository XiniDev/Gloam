import type { DamageType } from "@gloam/shared";
import type { HpFx } from "@gloam/shared/protocol";
import { useEffect, useRef, useState } from "react";
import {
  bodyRectOf,
  bodyRects,
  type Placed,
  plateCovers,
  plateRectOf,
  plateRects,
} from "../board/tokens/declutter.ts";
import { hpFx } from "../net/health.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";

/** How long a number floats (ms). */
const FLOAT_MS = 1300;
/** The space between one hit's numbers (px), e.g. "−6" slashing and "−4" fire. */
const NUMBER_GAP = 14;
/** How far a number rises (px), and its line's height. */
const RISE = 42;
const LINE = 28;
/** Where a hit's numbers stand, in order of preference: over the plate, beside it (either side), under the base. */
type Side = "above" | "right" | "left" | "below";
const SIDES: Side[] = ["above", "right", "left", "below"];

const overlapArea = (a: Placed, b: Placed) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * Where a row of numbers `w` wide stands for a token, on one side: its centre x and its bottom before rising. Over or
 * beside its plate it starts within 10 px of it (critic P7 r2 #3: at most 12), beside it level with the plate's foot;
 * under the base, just below it.
 */
function rowAt(side: Side, tokenId: string, w: number): { cx: number; bottom: number } | null {
  const plate = plateRectOf(tokenId);
  const body = bodyRectOf(tokenId);
  const top = plate ?? body;
  if (!top) return null;
  switch (side) {
    case "above":
      return { cx: (top.x0 + top.x1) / 2, bottom: top.y0 - 8 };
    case "right":
      return { cx: top.x1 + 10 + w / 2, bottom: top.y1 };
    case "left":
      return { cx: top.x0 - 10 - w / 2, bottom: top.y1 };
    case "below":
      return body ? { cx: (body.x0 + body.x1) / 2, bottom: body.y1 + 8 + LINE } : null;
  }
}

/** How far a hit's numbers keep from any other creature's plate (px): nearer, they read as that creature's. */
const CLEAR_OF_PLATES = 24;

/**
 * The first side where the row's whole rise is clear (critic P7 r2 #3) — on the screen, off the HUD (the top bar's
 * pills, the dock, cards and the toasts), off other tokens, and at least CLEAR_OF_PLATES from every other plate —
 * else the one that breaks those least: a number under the HUD or beside another creature's plate worst.
 */
function chooseSide(tokenId: string, w: number): { side: Side; box: Placed; clear: boolean } {
  const plates = plateRects()
    .filter((p) => p.id !== tokenId)
    .map((x) => x.r);
  const bodies = bodyRects()
    .filter((b) => b.id !== tokenId)
    .map((x) => x.r);
  const hud = [
    ...plateCovers(),
    ...[...document.querySelectorAll<HTMLElement>("[data-toast]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    }),
  ];
  let best: { side: Side; box: Placed; clear: boolean } | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const side of SIDES) {
    const at = rowAt(side, tokenId, w);
    if (!at) continue;
    const box = { x0: at.cx - w / 2, x1: at.cx + w / 2, y0: at.bottom - LINE - RISE, y1: at.bottom };
    const near = {
      x0: box.x0 - CLEAR_OF_PLATES,
      x1: box.x1 + CLEAR_OF_PLATES,
      y0: box.y0 - CLEAR_OF_PLATES,
      y1: box.y1 + CLEAR_OF_PLATES,
    };
    const off =
      Math.max(0, -box.x0) +
      Math.max(0, box.x1 - window.innerWidth) +
      Math.max(0, -box.y0) +
      Math.max(0, box.y1 - window.innerHeight);
    const cost =
      plates.reduce((c, r) => c + 4 * overlapArea(near, r), 0) +
      bodies.reduce((c, r) => c + overlapArea(box, r), 0) +
      hud.reduce((c, r) => c + 8 * overlapArea(box, r), 0) +
      off * LINE * 8;
    if (cost === 0) return { side, box, clear: true };
    if (cost < bestCost - 1) {
      best = { side, box, clear: false };
      bestCost = cost;
    }
  }
  return best ?? { side: "above", box: { x0: 0, y0: 0, x1: 0, y1: 0 }, clear: false };
}

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
/** Each hit's row: the side it took, the box its rise sweeps, and whether that was clear (tests). */
const rowLog: { tokenId: string; side: Side; box: Placed; clear: boolean }[] = [];

/**
 * Floating HP numbers (SPEC §8.11 Feedback; AC-HP-11): coloured by damage type — healing verdigris with a "+" — rising
 * from just above the token's plate (or its head, when it shows none) and fading, for everyone who can see it. In the
 * HUD so they stay crisp and the same size at any zoom.
 */
export function HpNumbers() {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  useEffect(() => provideTestHook("hpNumbers", () => shownLog.map((x) => ({ ...x }))), []);
  useEffect(() => provideTestHook("hpNumberRows", () => rowLog.map((x) => ({ ...x }))), []);
  const els = useRef(new Map<number, HTMLSpanElement>());
  const sides = useRef(new Map<number, Side>());
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
      // Each group's numbers in a row: every number's centre offset from the row's centre, and the row's side —
      // chosen once, when its numbers are first measured, then kept for the whole rise.
      const dx = new Map<number, number>();
      const rowW = new Map<number, number>();
      const rows = new Map<number, Floater[]>();
      for (const f of floaters) rows.set(f.group, [...(rows.get(f.group) ?? []), f]);
      for (const [group, row] of rows) {
        const widths = row.map((f) => els.current.get(f.key)?.offsetWidth ?? 0);
        const w = widths.reduce((a, b) => a + b, 0) + NUMBER_GAP * (row.length - 1);
        rowW.set(group, w);
        let x = -w / 2;
        row.forEach((f, i) => {
          const wi = widths[i] as number;
          dx.set(f.key, x + wi / 2);
          x += wi + NUMBER_GAP;
        });
        const first = row[0] as Floater;
        if (!sides.current.has(group) && w > 0 && (plateRectOf(first.tokenId) || bodyRectOf(first.tokenId))) {
          const c = chooseSide(first.tokenId, w);
          sides.current.set(group, c.side);
          if (__GLOAM_TEST__) rowLog.push({ tokenId: first.tokenId, ...c });
        }
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
        const at = rowAt(sides.current.get(f.group) ?? "above", f.tokenId, rowW.get(f.group) ?? 0);
        if (!at || t < 0) {
          el.style.opacity = "0";
          continue;
        }
        const x = at.cx + (dx.get(f.key) ?? 0);
        const rise = reduced ? 0 : RISE * (1 - (1 - t) ** 2);
        el.style.transform = `translate(${x}px, ${at.bottom - rise}px) translate(-50%, -100%)`;
        el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      }
      // A hit's numbers go together (so the last one doesn't jump as the row re-centres).
      if (done)
        setFloaters((fs) => {
          const live = new Set(fs.filter((f) => now - f.at <= FLOAT_MS).map((f) => f.group));
          for (const g of sides.current.keys()) if (!live.has(g)) sides.current.delete(g);
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
