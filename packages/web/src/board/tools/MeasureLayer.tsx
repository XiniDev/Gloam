import { formatDistance } from "@gloam/shared/units";
import { Html, Line } from "@react-three/drei";
import { useMemo } from "react";
import { DoubleSide, Shape, ShapeGeometry } from "three";
import { useTable } from "../../net/table.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { C } from "../colors.ts";
import {
  conePolygon,
  cubePolygon,
  current,
  linePolygon,
  type Measurement,
  measuredFt,
  type P3,
  useMeasure,
} from "./measure.ts";

/**
 * Measurements on the table (SPEC §8.6): the one being drawn (brass) and those others shared (in their colour, 3 s).
 * Distances in the viewer's units: feet to the nearest 0.5, metres at 5 ft = 1.5 m to 0.1 (AC-MOV-12).
 */
export function MeasureLayer() {
  const points = useMeasure((s) => s.points);
  const pointer = useMeasure((s) => s.pointer);
  const done = useMeasure((s) => s.done);
  const shared = useMeasure((s) => s.shared);
  const shape = useUi((s) => s.measureShape);
  const width = useUi((s) => s.lineWidthFt);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current() reads these stores
  const mine = useMemo(() => current(), [points, pointer, done, shape, width]);
  return (
    <group name="measure">
      {mine ? <MeasureShapeView m={mine} color={C.brass300} /> : null}
      {shared.map((m) => (
        <MeasureShapeView key={`${m.by}:${m.at}`} m={m} color={m.color || C.brass300} who={m.name} />
      ))}
    </group>
  );
}

function useUnits(): "ft" | "m" {
  const campaign = useTable((s) => s.units);
  const pref = useSettings((s) => s.units);
  return pref === "campaign" ? campaign : pref;
}

function MeasureShapeView({ m, color, who }: { m: Measurement; color: string; who?: string }) {
  const units = useUnits();
  const a = m.points[0] as P3;
  const b = m.points[m.points.length - 1] as P3;
  const area = useMemo(() => {
    if (m.shape === "ruler") return null;
    const poly =
      m.shape === "cone"
        ? conePolygon(a, b)
        : m.shape === "line"
          ? linePolygon(a, b, m.widthFt ?? 5)
          : m.shape === "cube"
            ? cubePolygon(a, b)
            : Array.from({ length: 72 }, (_, k) => {
                const r = Math.hypot(b.x - a.x, b.y - a.y);
                return {
                  x: a.x + Math.cos((k / 72) * Math.PI * 2) * r,
                  y: a.y + Math.sin((k / 72) * Math.PI * 2) * r,
                };
              });
    return poly;
  }, [m.shape, a, b, m.widthFt]);
  const fill = useMemo(
    () => (area ? new ShapeGeometry(new Shape(area.map((p) => ({ x: p.x, y: p.y }) as never))) : null),
    [area],
  );
  const lift = 0.12;
  const outline: [number, number, number][] = area
    ? [...area, area[0] as { x: number; y: number }].map((p) => [p.x, lift, p.y])
    : m.points.map((p) => [p.x, p.z + lift, p.y]);
  const total = measuredFt(m);
  return (
    <group userData={{ part: "measure", shape: m.shape }}>
      {fill ? (
        <mesh
          geometry={fill}
          rotation-x={Math.PI / 2}
          position-y={lift - 0.01}
          renderOrder={8}
          raycast={() => null}
        >
          <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} side={DoubleSide} />
        </mesh>
      ) : null}
      <Line points={outline} color={color} lineWidth={2.5} dashed={false} renderOrder={9} depthTest={false} />
      {m.shape !== "ruler" ? (
        <Line
          points={[
            [a.x, lift, a.y],
            [b.x, lift, b.y],
          ]}
          color={color}
          lineWidth={1.5}
          dashed
          dashSize={0.6}
          gapSize={0.4}
          depthTest={false}
        />
      ) : null}
      {/* Each ruler segment's length at its middle; the total (or the shape's measure) at the end. */}
      {m.shape === "ruler" && m.points.length > 2
        ? m.points.slice(1).map((p, i) => {
            const q = m.points[i] as P3;
            const len = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            return (
              <Html
                key={`${p.x},${p.y},${i}`}
                position={[(p.x + q.x) / 2, lift, (p.y + q.y) / 2]}
                center
                zIndexRange={[20, 0]}
              >
                <span className="pointer-events-none whitespace-nowrap rounded-chip bg-ink-950 px-1.5 text-12 text-muted tabular">
                  {formatDistance(len, units)}
                </span>
              </Html>
            );
          })
        : null}
      <Html
        position={[b.x, b.z + lift, b.y]}
        center
        zIndexRange={[21, 0]}
        style={{ transform: "translateY(-22px)" }}
      >
        <span
          data-testid={who ? "measure-shared-label" : "measure-label"}
          className="pointer-events-none whitespace-nowrap rounded-chip border border-line bg-ink-950 px-2 py-0.5 text-13 font-bold text-bone tabular shadow-[var(--shadow-float)]"
        >
          {formatDistance(total, units)}
          {who ? <span className="ml-1.5 font-normal text-muted">{who}</span> : null}
        </span>
      </Html>
    </group>
  );
}
