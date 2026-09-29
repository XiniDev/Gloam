import { CanvasTexture, SRGBColorSpace } from "three";
import { initialsOf } from "../../ui/initials.ts";
import { C } from "../colors.ts";
import { wake } from "../frames.ts";

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
      wake();
    });
  }
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
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

/** Door handle icons (SPEC §8.7 Doors): shut (a ring pull), open (an open doorway), locked (a padlock). */
export function doorIconTexture(state: "closed" | "open" | "locked"): CanvasTexture {
  return texture(`door-${state}`, 128, (g) => {
    g.fillStyle = C.ink950;
    g.globalAlpha = 0.88;
    g.beginPath();
    g.arc(64, 64, 58, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = state === "locked" ? C.ember400 : C.brass300;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(64, 64, 54, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 8;
    g.lineCap = "round";
    g.lineJoin = "round";
    if (state === "closed") {
      // A ring pull on its plate.
      g.beginPath();
      g.moveTo(64, 30);
      g.lineTo(64, 46);
      g.stroke();
      g.beginPath();
      g.arc(64, 70, 22, 0, Math.PI * 2);
      g.stroke();
    } else if (state === "open") {
      // A doorway with its leaf swung open.
      g.beginPath();
      g.moveTo(40, 96);
      g.lineTo(40, 32);
      g.lineTo(88, 32);
      g.lineTo(88, 96);
      g.stroke();
      g.beginPath();
      g.moveTo(40, 32);
      g.lineTo(62, 44);
      g.lineTo(62, 104);
      g.lineTo(40, 96);
      g.closePath();
      g.stroke();
    } else {
      // A padlock.
      g.beginPath();
      g.arc(64, 54, 16, Math.PI, 0);
      g.stroke();
      g.fillStyle = C.ember400;
      g.beginPath();
      g.roundRect(40, 54, 48, 38, 6);
      g.fill();
      g.fillStyle = C.ink950;
      g.beginPath();
      g.arc(64, 70, 5, 0, Math.PI * 2);
      g.fill();
    }
  });
}
