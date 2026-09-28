import { ICON_CATEGORIES, STATUS_ICONS } from "@gloam/shared/icons";
import { useEffect, useRef, useState } from "react";
import { ATLAS_CELL, atlasCell, statusAtlas } from "../board/tokens/statusAtlas.ts";
import { StatusIcon } from "../icons/status.tsx";
import { provideTestHook } from "../test/hooks.ts";

const SIZES = [16, 20, 24] as const;

/**
 * The icon sheet (test builds only; AC-DS-03): every Appendix G icon as the DOM draws it — bare and on its badge — at
 * 16, 20 and 24 px, and the board's WebGL atlas they're baked into, whole and each cell drawn down to those sizes (as
 * mipmapping does on a plate). For the journey that checks them and the screenshot that shows them.
 */
export default function IconSheet() {
  const atlasHost = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    const a = statusAtlas();
    let live = true;
    void a.ready.then(() => {
      if (!live) return;
      atlasHost.current?.replaceChildren(a.canvas);
      a.canvas.setAttribute("data-testid", "atlas");
      a.canvas.className = "rounded-[var(--radius-control)] border border-line";
      // Each cell drawn down to 16 / 20 / 24 px with high-quality smoothing (the browser's stand-in for mipmaps).
      const out: Record<string, string> = {};
      for (const icon of STATUS_ICONS) {
        for (const size of SIZES) {
          const c = document.createElement("canvas");
          c.width = size * 2;
          c.height = size * 2;
          const g = c.getContext("2d") as CanvasRenderingContext2D;
          g.imageSmoothingQuality = "high";
          const cell = atlasCell(icon.id);
          const sx = cell.u0 * a.canvas.width;
          const sy = (1 - cell.v1) * a.canvas.height;
          g.drawImage(a.canvas, sx, sy, ATLAS_CELL - 1, ATLAS_CELL - 1, 0, 0, size * 2, size * 2);
          out[`${icon.id}@${size}`] = c.toDataURL();
        }
      }
      setCells(out);
    });
    provideTestHook("atlasCoverage", () => {
      const cv = statusAtlas().canvas;
      const g = cv.getContext("2d") as CanvasRenderingContext2D;
      return STATUS_ICONS.map((icon) => {
        const cell = atlasCell(icon.id);
        const x = Math.round(cell.u0 * cv.width);
        const y = Math.round((1 - cell.v1) * cv.height);
        const d = g.getImageData(x, y, ATLAS_CELL - 1, ATLAS_CELL - 1).data;
        // The glyph: pixels near bone (the badge is a darker category colour).
        let glyph = 0;
        let opaque = 0;
        for (let i = 0; i < d.length; i += 4) {
          if ((d[i + 3] as number) > 200) opaque++;
          if ((d[i] as number) > 200 && (d[i + 1] as number) > 190 && (d[i + 2] as number) > 170) glyph++;
        }
        return { id: icon.id, glyph: glyph / (d.length / 4), opaque: opaque / (d.length / 4) };
      });
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <main className="min-h-[100dvh] bg-bg p-6 text-bone" data-testid="icon-sheet">
      <h1 className="mb-1 text-28">Condition and status icons</h1>
      <p className="mb-5 text-14 text-muted">
        Appendix G — {STATUS_ICONS.length} icons, drawn bare and on their badge at 16, 20 and 24 px; the
        board's atlas below each row's DOM icons.
      </p>
      <table className="border-separate border-spacing-x-4 border-spacing-y-1.5 text-13">
        <thead>
          <tr className="caps text-left text-12 text-fog">
            <th>Icon</th>
            <th>Category</th>
            <th colSpan={3}>Bare 16 · 20 · 24</th>
            <th colSpan={3}>Badge 16 · 20 · 24</th>
            <th colSpan={3}>Atlas 16 · 20 · 24</th>
          </tr>
        </thead>
        <tbody>
          {STATUS_ICONS.map((icon) => (
            <tr key={icon.id} data-testid="icon-row" data-icon-id={icon.id}>
              <td className="text-bone">{icon.name}</td>
              <td>
                <span
                  className="inline-block h-3 w-3 rounded-chip align-middle"
                  style={{ background: ICON_CATEGORIES[icon.category] }}
                />{" "}
                <span className="text-muted">{icon.category}</span>
              </td>
              {SIZES.map((s) => (
                <td key={`b${s}`} data-size={s} data-kind="bare">
                  <StatusIcon id={icon.id} size={s} />
                </td>
              ))}
              {SIZES.map((s) => (
                <td key={`g${s}`} data-size={s} data-kind="badge">
                  <StatusIcon id={icon.id} size={s} badge />
                </td>
              ))}
              {SIZES.map((s) => (
                <td key={`a${s}`} data-size={s} data-kind="atlas">
                  {cells ? (
                    <img
                      src={cells[`${icon.id}@${s}`]}
                      width={s}
                      height={s}
                      alt={`${icon.name} (atlas, ${s} px)`}
                    />
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mt-8 mb-2 text-22">The atlas (64-px cells)</h2>
      <div ref={atlasHost} />
    </main>
  );
}
