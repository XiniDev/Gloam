import { provideTestHook } from "../test/hooks.ts";

/**
 * Copies text. The async Clipboard API needs a secure context (localhost, the HTTPS tunnel); LAN mode is plain
 * HTTP, so fall back to a hidden textarea + execCommand (SPEC §22.2 LAN note).
 */
/** What was copied last (test builds read it through a hook; the clipboard itself is the browser's). */
let lastCopied = "";

export async function copyText(text: string): Promise<boolean> {
  lastCopied = text;
  provideTestHook("lastCopied", () => lastCopied);
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
