import { circlePolygon, type P } from "@gloam/shared/geometry";
import { controlsToken } from "@gloam/shared/rules";
import type { EffectControl, EffectView } from "@gloam/shared/state";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { actEffect, moveEffect } from "../../net/spells.ts";
import { useTable } from "../../net/table.ts";
import { useEffectUi } from "../../state/effectUi.ts";
import { useBoard } from "../../state/entities.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { C } from "../colors.ts";
import { again } from "../frames.ts";
import { setBoardMarks } from "../tokens/declutter.ts";
import { Segments } from "../tools/marks.tsx";
import { whereOf } from "./presets.ts";

/** What can be done with an effect from the board, by this viewer. */
export interface Handle {
  id: string;
  name: string;
  /** The effect's own point (what a move moves). */
  at: P;
  /** Where its handle is drawn: its point — or beside the creature standing on it (Call Lightning's cloud over its
   *  caster), so the handle and the creature can each be clicked. */
  mark: P;
  /** Its footprint (to draw where a drag would put it). */
  outline: P[] | null;
  movable: boolean;
  /** How far a move may take it (its caster's limit; the DM's moves aren't held to it). */
  maxFt: number | null;
  strike: number | null;
  endable: boolean;
  drifts: boolean;
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** An effect's handle for this viewer, or null (nothing they can do with it, or it goes with its creature). */
export function handleOf(e: EffectView, dm: boolean, mine: (tokenId: string) => boolean): Handle | null {
  const shape = parse<{ kind?: string; origin?: P; points?: P[] }>(e.shapeJson);
  const control = parse<EffectControl>(e.controlJson) ?? {};
  if (!shape?.kind || shape.kind === "emanation") return null;
  const at = shape.kind === "wall" ? shape.points?.[0] : shape.origin;
  if (!at) return null;
  const caster = Boolean(e.link?.casterId && mine(e.link.casterId));
  const movable = dm || (control.moveBy === "caster" && caster);
  const strike = control.strike !== undefined && (dm || caster) ? control.strike : null;
  if (!movable && strike === null && !dm && !caster) return null;
  const where = whereOf(shape, null, () => null);
  const f = where?.f ?? null;
  const outline = f
    ? f.kind === "circle"
      ? circlePolygon(f.c, f.r, 72, true)
      : f.kind === "poly"
        ? f.points
        : null
    : null;
  return {
    id: e.id,
    name: e.name,
    at: { x: at.x, y: at.y },
    mark: { x: at.x, y: at.y },
    outline,
    movable,
    maxFt: control.maxFt ?? null,
    strike,
    endable: dm || caster,
    drifts: control.drifts === true,
  };
}

let current: Handle[] = [];

/**
 * Handles on lasting effects (SPEC §8.13 "movement rules"): a small brass diamond at an effect's centre for whoever
 * may do something with it — its caster (moving Moonbeam up to 60 ft, rolling Flaming Sphere up to 30, calling Call
 * Lightning's next bolt) or the DM (anything). A drag shows where it would go, and its caster's reach; a click picks it
 * (its chip says what can be done). Aiming a strike: a ring under the pointer, green inside the effect, a click to
 * strike, Esc to stop.
 */
/** A handle's half-size on screen, as the plates keep off it (its ring and a little room). */
const HANDLE_PX = 14;

export function EffectHandles() {
  const effects = useBoard((d) => d.effects);
  const tokens = useBoard((d) => d.tokens);
  const me = useTable((s) => s.me);
  const drag = useEffectUi((s) => s.drag);
  const strike = useEffectUi((s) => s.strike);
  const dm = me?.role === "dm" || me?.role === "admin";
  const handles = useMemo(() => {
    const mine = (id: string) => {
      const t = tokens.get(id);
      return Boolean(t && me && controlsToken(me.role, me.userId, t));
    };
    return [...effects.values()].flatMap((e) => {
      const h = handleOf(e, dm, mine);
      if (!h) return [];
      // A creature on its point: the handle beside its base, to the south (name plates sit above their creatures).
      const on = [...tokens.values()].find(
        (t) => Math.hypot(t.pos.x - h.at.x, t.pos.y - h.at.y) < t.sizeFt / 2 + 1,
      );
      if (on) h.mark = { x: on.pos.x, y: on.pos.y + on.sizeFt / 2 + 1.6 };
      return [h];
    });
  }, [effects, tokens, dm, me]);
  current = handles;
  useEffect(() => {
    if (!__GLOAM_TEST__) return;
    provideTestHook("effectHandles", () =>
      current.map((h) => {
        const s = boardApi.project(h.mark.x, h.mark.y, 0.14);
        return { ...h, sx: s?.sx ?? null, sy: s?.sy ?? null };
      }),
    );
  }, []);
  // Where the handles are on screen, for the name plates to keep off them (declutter's marks).
  useFrame(() => {
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const h of current) {
      const s = boardApi.project(h.mark.x, h.mark.y, 0.14);
      if (s)
        rects.push({
          x0: s.sx - HANDLE_PX,
          y0: s.sy - HANDLE_PX,
          x1: s.sx + HANDLE_PX,
          y1: s.sy + HANDLE_PX,
        });
    }
    setBoardMarks("effect-handles", rects);
  });
  useEffect(() => () => setBoardMarks("effect-handles", []), []);
  // A picked effect that's gone (ended, or no longer this viewer's to handle): nothing picked.
  const selected = useEffectUi((s) => s.selected);
  useEffect(() => {
    if (selected && !handles.some((h) => h.id === selected)) useEffectUi.getState().set({ selected: null });
  }, [selected, handles]);
  return (
    <group name="effect-handles">
      {handles.map((h) => (
        <HandleMark key={h.id} h={h} dm={dm} />
      ))}
      {drag ? <DragPreview /> : null}
      {strike ? <StrikeAim /> : null}
    </group>
  );
}

function HandleMark({ h, dm }: { h: Handle; dm: boolean }) {
  const selected = useEffectUi((s) => s.selected === h.id);
  const [hover, setHover] = useState(false);
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    if (ev.button !== 0 || useEffectUi.getState().strike) return;
    ev.stopPropagation();
    boardApi.claimedPointer = ev.pointerId;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const grab = boardApi.groundAt(x0, y0) ?? h.at;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== ev.pointerId || !h.movable) return;
      if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
      dragging = true;
      const g = boardApi.groundAt(e.clientX, e.clientY);
      if (!g) return;
      let to = { x: h.at.x + g.x - grab.x, y: h.at.y + g.y - grab.y };
      // A player's move stops at its reach (the DM's may go past it: P2).
      if (h.maxFt !== null && !dm) {
        const d = Math.hypot(to.x - h.at.x, to.y - h.at.y);
        if (d > h.maxFt) {
          const k = h.maxFt / d;
          to = { x: h.at.x + (to.x - h.at.x) * k, y: h.at.y + (to.y - h.at.y) * k };
        }
      }
      useEffectUi.getState().set({ drag: { effectId: h.id, from: h.at, to, maxFt: h.maxFt } });
      again();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== ev.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const d = useEffectUi.getState().drag;
      if (dragging && d) {
        useEffectUi.getState().set({ drag: null });
        if (e.type !== "pointercancel" && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) > 0.25)
          void moveEffect(h.id, d.to).catch((err: Error) =>
            toast.warning(`Couldn't move ${h.name}`, err.message),
          );
      } else if (!dragging) {
        const s = useEffectUi.getState();
        s.set({ selected: s.selected === h.id ? null : h.id });
      }
      again();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const lit = hover || selected;
  return (
    <group
      position={[h.mark.x, 0.14, h.mark.y]}
      userData={{ effectHandle: h.id }}
      onPointerDown={onDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        again();
      }}
      onPointerOut={() => {
        setHover(false);
        again();
      }}
    >
      {/* Quiet until the pointer comes to it (a DM's board holds a handle on every effect). */}
      <mesh rotation-x={-Math.PI / 2} renderOrder={20}>
        <circleGeometry args={[lit ? 1 : 0.75, 32]} />
        <meshBasicMaterial
          color={C.ink950}
          transparent
          opacity={lit ? 0.85 : 0.5}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      {/* A diamond: the effect's own mark (tokens' are round). */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.01} renderOrder={21}>
        <circleGeometry args={[lit ? 0.62 : 0.4, 4]} />
        <meshBasicMaterial
          color={lit ? C.brass300 : C.brass400}
          transparent
          opacity={lit ? 0.95 : 0.6}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      {selected ? (
        <mesh rotation-x={-Math.PI / 2} position-y={0.02} renderOrder={21}>
          <ringGeometry args={[1.05, 1.2, 40]} />
          <meshBasicMaterial
            color={C.brass300}
            transparent
            opacity={0.9}
            depthTest={false}
            toneMapped={false}
          />
        </mesh>
      ) : null}
    </group>
  );
}

/** Where a drag would put the effect (its outline there) and, for its caster, how far a move may take it. */
function DragPreview() {
  const drag = useEffectUi((s) => s.drag);
  const h = current.find((x) => x.id === drag?.effectId);
  if (!drag || !h) return null;
  const dx = drag.to.x - drag.from.x;
  const dy = drag.to.y - drag.from.y;
  const ring = (pts: P[]) => pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] as P }));
  return (
    <group>
      {h.outline ? (
        <Segments
          segs={ring(h.outline.map((p) => ({ x: p.x + dx, y: p.y + dy })))}
          color={C.brass300}
          width={2}
          opacity={0.9}
          order={22}
          dashed
        />
      ) : null}
      {drag.maxFt !== null ? (
        <Segments
          segs={ring(circlePolygon(drag.from, drag.maxFt, 96, true))}
          color={C.bone100}
          width={1.5}
          opacity={0.45}
          order={22}
          dashed
        />
      ) : null}
    </group>
  );
}

/** A strike being aimed: a ring under the pointer — the effect's colour inside it, dim outside — a click to strike. */
function StrikeAim() {
  const strike = useEffectUi((s) => s.strike);
  const h = current.find((x) => x.id === strike?.effectId);
  const aiming = strike?.effectId ?? null;
  useEffect(() => {
    if (!aiming) return;
    const el = boardApi.element;
    const move = (e: PointerEvent) => {
      const g = boardApi.groundAt(e.clientX, e.clientY);
      const s = useEffectUi.getState().strike;
      if (s) useEffectUi.getState().set({ strike: { ...s, at: g } });
      again();
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !el || !(e.target instanceof Node) || !el.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const g = boardApi.groundAt(e.clientX, e.clientY);
      const s = useEffectUi.getState().strike;
      if (!g || !s) return;
      useEffectUi.getState().set({ strike: null });
      void actEffect(s.effectId, g).catch((err: Error) =>
        toast.warning("Couldn't strike there", err.message),
      );
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") useEffectUi.getState().set({ strike: null });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("keydown", key);
    };
  }, [aiming]);
  if (!strike?.at || !h) return null;
  const inside = h.outline ? pointIn(strike.at, h.outline) : true;
  const pts = circlePolygon(strike.at, strike.radius, 48, true);
  return (
    <Segments
      segs={pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] as P }))}
      color={inside ? C.brass300 : C.fog400}
      width={2}
      opacity={inside ? 0.95 : 0.5}
      order={22}
      dashed={!inside}
    />
  );
}

function pointIn(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P;
    const b = poly[j] as P;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
