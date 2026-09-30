import type { Page } from "@playwright/test";

/**
 * A screen's layout faults (AC-RSP-01), named so a failure says what: the page scrolling sideways, and controls on top
 * of each other — two controls that are both uppermost at their own middles (neither covered by a panel, a dialog or a
 * sheet laid over it) whose visible boxes cross, neither inside the other. A control's visible box is what its clipping
 * ancestors (scroll areas, panels) and the window leave of it.
 */
export async function layoutAudit(p: Page, where: string): Promise<string[]> {
  return p.evaluate((where) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > vw + 1)
      out.push(`${where}: the page scrolls sideways (${se.scrollWidth} px in ${vw})`);
    if (document.body.scrollWidth > vw + 1)
      out.push(`${where}: the body is wider than the window (${document.body.scrollWidth} px in ${vw})`);

    type Box = { x0: number; y0: number; x1: number; y1: number };
    const clipped = (el: Element): Box | null => {
      const r = el.getBoundingClientRect();
      let b: Box = { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        const q = a.getBoundingClientRect();
        if (s.overflowX !== "visible") b = { ...b, x0: Math.max(b.x0, q.left), x1: Math.min(b.x1, q.right) };
        if (s.overflowY !== "visible") b = { ...b, y0: Math.max(b.y0, q.top), y1: Math.min(b.y1, q.bottom) };
        // (A fixed box escapes its ancestors' scroll areas.)
        if (s.position === "fixed") break;
      }
      b = {
        x0: Math.max(b.x0, 0),
        y0: Math.max(b.y0, 0),
        x1: Math.min(b.x1, window.innerWidth),
        y1: Math.min(b.y1, window.innerHeight),
      };
      return b.x1 - b.x0 > 1 && b.y1 - b.y0 > 1 ? b : null;
    };
    const shown = (el: Element): boolean => {
      if (el.closest("[inert], [aria-hidden=true]")) return false;
      for (let a: Element | null = el; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
      }
      return true;
    };
    const name = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    const controls: { el: Element; box: Box }[] = [];
    for (const el of document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=radio], [role=menuitem], [role=checkbox], [role=slider], summary",
    )) {
      if (!shown(el)) continue;
      // A native checkbox or radio stands in a label that is the control.
      const target =
        (el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio"
          ? (el.closest("label") ?? el)
          : el;
      const box = clipped(target);
      if (!box) continue;
      // Uppermost at its own middle: not under a panel, a dialog's scrim or a sheet.
      const top = document.elementFromPoint((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
      if (!top || !(top === target || target.contains(top) || top.contains(target))) continue;
      controls.push({ el: target, box });
    }
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i] as (typeof controls)[number];
        const b = controls[j] as (typeof controls)[number];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0);
        const h = Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0);
        if (w > 2 && h > 2)
          out.push(
            `${where}: "${name(a.el)}" and "${name(b.el)}" overlap by ${Math.round(w)}×${Math.round(h)} px`,
          );
      }
    return out;
  }, where);
}
