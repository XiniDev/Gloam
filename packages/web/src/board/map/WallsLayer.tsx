import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Color } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { useBoard } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { useDmView } from "../../state/viewAs.ts";
import { C, col, WALL_COLORS } from "../colors.ts";
import { setSegments } from "../lines.ts";
import { useWallTool } from "../tools/walls.ts";
import { useDrawn } from "../warmup/state.ts";

/** Just above the map so the lines never z-fight with it. */
const LIFT_FT = 0.06;

/**
 * How each kind is drawn, besides its colour (kinds must not differ by hue alone): walls, doors and secret doors
 * solid; windows in tight dashes; curtains in long dashes; invisible walls dotted; any wall hidden from players dimmed
 * with wide gaps. Dash lengths are in feet.
 */
const PATTERNS = {
  solid: null,
  window: { dashSize: 0.35, gapSize: 0.2 },
  curtain: { dashSize: 1.2, gapSize: 0.35 },
  invisible: { dashSize: 0.12, gapSize: 0.28 },
  hidden: { dashSize: 0.5, gapSize: 0.75 },
} as const;
type Pattern = keyof typeof PATTERNS;
const PATTERN_KEYS = Object.keys(PATTERNS) as Pattern[];

function patternOf(kind: string, hidden: boolean): Pattern {
  if (hidden) return "hidden";
  if (kind === "window" || kind === "curtain" || kind === "invisible") return kind;
  return "solid";
}

function fatLine(name: string, params: ConstructorParameters<typeof LineMaterial>[0], order: number) {
  const m = new LineMaterial({ depthTest: false, transparent: true, ...params });
  const l = new LineSegments2(new LineSegmentsGeometry(), m);
  l.renderOrder = order;
  l.frustumCulled = false;
  l.raycast = () => {};
  l.name = name;
  return l;
}

/**
 * The DM's walls overlay (SPEC §8.7): every wall of the scene as a crisp line in its kind's colour and pattern over an
 * ink underlay (so it holds on pale floors and busy maps) — a handful of batched draw calls however many walls there
 * are. Walls the Walls tool is moving are drawn where the edit puts them (its preview) until the server's echo
 * arrives; the selection shows as the tool's glow and handles, never by recolouring (a brass wall would read as a
 * door).
 */
export function WallsLayer() {
  const walls = useDrawn("walls");
  // The DM's overlay (not while the DM views the board as a player).
  const dm = useDmView();
  // Which walls it draws: all of them while the Walls tool is out (editing wants every line), else as the DM chose.
  const walls3d = useBoard((d) => d.scene?.walls3d === true);
  const chosen = useSettings((s) => s.wallLines);
  const editing = useUi((s) => s.tool === "walls");
  const mode = editing ? "all" : (chosen ?? (walls3d ? "special" : "all"));
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const [under, lines] = useMemo(() => {
    const byPattern = {} as Record<Pattern, LineSegments2>;
    for (const p of PATTERN_KEYS) {
      const dash = PATTERNS[p];
      byPattern[p] = fatLine(
        p === "solid" ? "walls-overlay" : `walls-overlay-${p}`,
        dash
          ? { linewidth: 3, vertexColors: true, dashed: true, ...dash }
          : { linewidth: 3, vertexColors: true },
        4,
      );
    }
    return [
      fatLine("walls-overlay-underlay", { linewidth: 7, color: col(C.ink950), opacity: 0.55 }, 3),
      byPattern,
    ];
  }, []);
  const all = useMemo(() => [under, ...Object.values(lines)], [under, lines]);
  useEffect(
    () => () => {
      for (const l of all) {
        l.geometry.dispose();
        l.material.dispose();
      }
    },
    [all],
  );
  useEffect(() => {
    for (const l of all) l.material.resolution.set(size.width, size.height);
  }, [all, size]);

  const preview = useWallTool((s) => s.preview);
  // A layout effect: the lines match the store in the same commit (no frame drawn with stale walls while editing).
  useLayoutEffect(() => {
    const everything = new Float32Array(walls.size * 6);
    const pos = Object.fromEntries(PATTERN_KEYS.map((p) => [p, [] as number[]])) as Record<Pattern, number[]>;
    const rgb = Object.fromEntries(PATTERN_KEYS.map((p) => [p, [] as number[]])) as Record<Pattern, number[]>;
    const c = new Color();
    let i = 0;
    for (const w of walls.values()) {
      const kind = w.dmKind ?? w.kind;
      // Only what 3D walls don't show for what it is: never a plain wall the stone already draws.
      if (mode === "none" || (mode === "special" && kind === "wall" && w.dmHidden !== true)) continue;
      const moved = preview?.get(w.id);
      const seg = [
        moved ? moved.a.x : w.ax,
        LIFT_FT,
        moved ? moved.a.y : w.ay,
        moved ? moved.b.x : w.bx,
        LIFT_FT,
        moved ? moved.b.y : w.by,
      ];
      everything.set(seg, i * 6);
      const p = patternOf(kind, w.dmHidden === true);
      c.set(WALL_COLORS[kind as keyof typeof WALL_COLORS] ?? WALL_COLORS.wall);
      if (p === "hidden") c.multiplyScalar(0.6);
      pos[p].push(...seg);
      rgb[p].push(c.r, c.g, c.b, c.r, c.g, c.b);
      i++;
    }
    setSegments(under, everything.subarray(0, i * 6));
    for (const p of PATTERN_KEYS) {
      setSegments(lines[p], new Float32Array(pos[p]), new Float32Array(rgb[p]));
      if (PATTERNS[p] && pos[p].length) lines[p].computeLineDistances();
    }
    invalidate();
  }, [walls, preview, under, lines, invalidate, mode]);

  if (!dm) return null;
  return (
    <group name="walls-overlay-group">
      {all.map((l) => (
        <primitive key={l.name} object={l} />
      ))}
    </group>
  );
}
