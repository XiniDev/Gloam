import { describe, expect, it } from "vitest";
import { type Stroke, StrokeHistory, UNDO_STEPS, widthAt } from "./drawing.ts";

const stroke = (n: number): Stroke => ({
  tool: "ink",
  color: "#000000",
  size: 6,
  points: [{ x: n, y: n, p: 0.5 }],
});

describe("the drawing pad's strokes (SPEC §8.10 Character art, AC-SHEET-10)", () => {
  it("ink follows the pen's pressure; the other tools don't", () => {
    expect(widthAt("ink", 6, 0.1)).toBeLessThan(widthAt("ink", 6, 0.5));
    expect(widthAt("ink", 6, 0.5)).toBeLessThan(widthAt("ink", 6, 1));
    expect(widthAt("ink", 6, 1) / widthAt("ink", 6, 0.1)).toBeGreaterThan(4);
    expect(widthAt("pencil", 6, 0.1)).toBe(widthAt("pencil", 6, 1));
    expect(widthAt("marker", 6, 0.1)).toBe(widthAt("marker", 6, 1));
    expect(widthAt("eraser", 6, 0.2)).toBe(widthAt("eraser", 6, 0.9));
  });

  it("undo and redo step back and forth through the last 50 strokes; older ones are baked in; a new stroke ends redo", () => {
    const baked: Stroke[] = [];
    const h = new StrokeHistory((s) => baked.push(s));
    for (let i = 0; i < UNDO_STEPS + 5; i++) h.push(stroke(i));
    expect(h.recent.length).toBe(UNDO_STEPS);
    expect(baked.map((s) => s.points[0]?.x)).toEqual([0, 1, 2, 3, 4]);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(UNDO_STEPS);
    expect(h.recent.length).toBe(0);
    expect(h.redo()).toBe(true);
    expect(h.recent.map((s) => s.points[0]?.x)).toEqual([5]);
    h.push(stroke(99));
    expect(h.redo()).toBe(false);
    expect(h.recent.map((s) => s.points[0]?.x)).toEqual([5, 99]);
  });
});
