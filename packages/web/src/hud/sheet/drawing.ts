/**
 * The drawing pad's strokes (SPEC §8.10 Character art, AC-SHEET-10): pencil (fine, a little grainy), ink (its width
 * following the pen's pressure), marker (broad and translucent) and eraser; kept as strokes so undo and redo (50
 * steps) replay them, with anything older baked into the base picture so a long drawing stays quick to redraw.
 */

export type DrawTool = "pencil" | "ink" | "marker" | "eraser";

export interface StrokePoint {
  x: number;
  y: number;
  /** Pen pressure 0–1 (a mouse reports 0.5 while pressed). */
  p: number;
}

export interface Stroke {
  tool: DrawTool;
  color: string;
  /** The brush size (px on the 1024 canvas). */
  size: number;
  points: StrokePoint[];
}

export const PAD_SIZE = 1024;
export const UNDO_STEPS = 50;

/** A stroke's width at a point: ink from a hair (light touch) to twice the size (hard press); the rest fixed. */
export function widthAt(tool: DrawTool, size: number, pressure: number): number {
  const p = Math.min(1, Math.max(0, pressure));
  switch (tool) {
    case "ink":
      return Math.max(0.6, size * (0.15 + 1.85 * p));
    case "pencil":
      return Math.max(0.8, size * 0.5);
    case "marker":
      return size * 1.6;
    case "eraser":
      return size * 1.5;
  }
}

/** Draws one stroke. */
export function drawStroke(g: CanvasRenderingContext2D, s: Stroke): void {
  if (!s.points.length) return;
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
  g.globalAlpha = s.tool === "marker" ? 0.35 : s.tool === "pencil" ? 0.85 : 1;
  const first = s.points[0] as StrokePoint;
  if (s.points.length === 1) {
    g.beginPath();
    g.arc(first.x, first.y, widthAt(s.tool, s.size, first.p) / 2, 0, Math.PI * 2);
    g.fill();
  } else if (s.tool === "ink") {
    // Segment by segment: each as wide as the pressure where it was drawn.
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1] as StrokePoint;
      const b = s.points[i] as StrokePoint;
      g.lineWidth = widthAt("ink", s.size, (a.p + b.p) / 2);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  } else {
    // One path, so a translucent marker doesn't darken where its own segments overlap.
    g.lineWidth = widthAt(s.tool, s.size, first.p);
    g.beginPath();
    g.moveTo(first.x, first.y);
    for (const q of s.points.slice(1)) g.lineTo(q.x, q.y);
    g.stroke();
  }
  g.restore();
}

/**
 * Strokes with undo and redo: the latest 50 can be undone; an older one is handed to `bake` (drawn into the base
 * picture for good). A new stroke clears what could be redone.
 */
export class StrokeHistory {
  recent: Stroke[] = [];
  undone: Stroke[] = [];
  private readonly bake: (s: Stroke) => void;
  constructor(bake: (s: Stroke) => void) {
    this.bake = bake;
  }
  push(s: Stroke): void {
    this.recent.push(s);
    this.undone = [];
    while (this.recent.length > UNDO_STEPS) this.bake(this.recent.shift() as Stroke);
  }
  undo(): boolean {
    const s = this.recent.pop();
    if (!s) return false;
    this.undone.push(s);
    return true;
  }
  redo(): boolean {
    const s = this.undone.pop();
    if (!s) return false;
    this.recent.push(s);
    return true;
  }
  clear(): void {
    this.recent = [];
    this.undone = [];
  }
}
