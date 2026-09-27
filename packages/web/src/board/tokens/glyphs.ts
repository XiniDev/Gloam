import { CanvasTexture, SRGBColorSpace } from "three";
import { C } from "../colors.ts";

/** Small canvas-drawn textures for tokens: an initials face for art-less tokens and the DM-hidden eye-slash badge. */

const cache = new Map<string, CanvasTexture>();

function texture(key: string, size: number, draw: (g: CanvasRenderingContext2D) => void): CanvasTexture {
  let t = cache.get(key);
  if (t) return t;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  draw(g);
  t = new CanvasTexture(canvas);
  // Drawn before Cinzel finished loading? Redraw once it has, so the face never shows a fallback font.
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (fonts && !fonts.check("700 64px Cinzel")) {
    const tex = t;
    void fonts.load("700 64px Cinzel").then(() => {
      g.clearRect(0, 0, size, size);
      draw(g);
      tex.needsUpdate = true;
    });
  }
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/** A parchment-and-ink coin face with the token's initials (tokens without an image). */
export function initialsTexture(name: string, ring: string): CanvasTexture {
  const text = initialsOf(name);
  return texture(`initials:${text}:${ring}`, 256, (g) => {
    const grad = g.createRadialGradient(128, 110, 20, 128, 128, 128);
    grad.addColorStop(0, C.parchmentA);
    grad.addColorStop(1, C.parchmentB);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = ring;
    g.lineWidth = 10;
    g.beginPath();
    g.arc(128, 128, 116, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = C.mapInk;
    g.font = `700 ${text.length > 1 ? 84 : 104}px Cinzel, serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 128, 136);
  });
}

/** The eye-slash badge DMs see on hidden tokens (AC-TOK-08). */
export function hiddenBadgeTexture(): CanvasTexture {
  return texture("eye-slash", 128, (g) => {
    g.fillStyle = C.ink950;
    g.globalAlpha = 0.85;
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = C.brass300;
    g.lineWidth = 7;
    g.lineCap = "round";
    g.lineJoin = "round";
    // eye
    g.beginPath();
    g.moveTo(22, 64);
    g.quadraticCurveTo(64, 26, 106, 64);
    g.quadraticCurveTo(64, 102, 22, 64);
    g.stroke();
    g.beginPath();
    g.arc(64, 64, 13, 0, Math.PI * 2);
    g.stroke();
    // slash
    g.strokeStyle = C.ink950;
    g.lineWidth = 15;
    g.beginPath();
    g.moveTo(30, 98);
    g.lineTo(98, 30);
    g.stroke();
    g.strokeStyle = C.brass300;
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(30, 98);
    g.lineTo(98, 30);
    g.stroke();
  });
}
