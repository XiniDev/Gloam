import cinzelWoff from "@fontsource/cinzel/files/cinzel-latin-600-normal.woff?url";
import frauncesWoff from "@fontsource/fraunces/files/fraunces-latin-700-normal.woff?url";
import { configureTextBuilder } from "troika-three-text";

/** Name plates use the local Cinzel face (troika reads .woff, not .woff2; SPEC §24.4, R3 note G8). */
export const CAPS_FONT = cinzelWoff;
/** HP numbers on the board use the display face (SPEC §27.3), from the static Fraunces package's .woff. */
export const NUMBER_FONT = frauncesWoff;

let configured = false;
/**
 * troika-three-text must never reach a CDN (R3 notes 43–44): no worker (its `importScripts(blob:)` is blocked by our
 * CSP), a local default font, and same-origin Unicode fallbacks served by the Gloam server at /fonts/ufr.
 */
export function setupText(): void {
  if (configured) return;
  configured = true;
  configureTextBuilder({ useWorker: false, defaultFontURL: cinzelWoff, unicodeFontsURL: "/fonts/ufr" });
}
