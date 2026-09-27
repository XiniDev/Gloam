import { useEffect } from "react";
import { request, useTable } from "../net/table.ts";
import { toast, useToasts } from "../ui/Toast.tsx";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

async function undo(force = false): Promise<void> {
  try {
    const r = await request<{ summary: string }>("history.undo", force ? { force: true } : {});
    toast.info(r.summary.replace(/^Undo: /, "Undone: ").replace(/^Forced undo of /, "Undone: "));
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "NOT_FOUND") {
      toast.info("Nothing to undo");
      return;
    }
    const role = useTable.getState().me?.role;
    if (err.code === "CONFLICT" && (role === "dm" || role === "admin") && !force) {
      useToasts.getState().push({
        kind: "warning",
        title: "Someone changed this since",
        body: err.message,
        actions: [{ label: "Undo anyway", variant: "danger", onClick: () => void undo(true) }],
      });
      return;
    }
    toast.warning("Couldn't undo", err.message);
  }
}

async function redo(): Promise<void> {
  try {
    const r = await request<{ summary: string }>("history.redo", {});
    toast.info(`Redone: ${r.summary}`);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "NOT_FOUND") {
      toast.info("Nothing to redo");
      return;
    }
    toast.warning("Couldn't redo", err.message);
  }
}

/** Ctrl/Cmd+Z undoes your own last action; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes it (SPEC §8.14, Appendix H). */
export function useUndoKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyZ") {
        e.preventDefault();
        if (e.repeat) return;
        void (e.shiftKey ? redo() : undo());
      } else if (e.code === "KeyY" && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (!e.repeat) void redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
