import { afterEach, describe, expect, it, vi } from "vitest";

// The store's timers use window.setTimeout: a window of this process's own for the test.
vi.stubGlobal("window", { setTimeout, clearTimeout });
const { toast, useToasts } = await import("./Toast.tsx");

afterEach(() => {
  for (const t of useToasts.getState().items) useToasts.getState().dismiss(t.id);
});

describe("toasts don't stack copies of themselves", () => {
  it("the same message again replaces the one showing (a DM's third Spotlight covered the board)", () => {
    toast.info("Spotlight", "Players who allow it are looking here.");
    toast.info("Spotlight", "Players who allow it are looking here.");
    toast.info("Spotlight", "Players who allow it are looking here.");
    expect(useToasts.getState().items).toHaveLength(1);
    // A different message, or one with actions, still takes its own place.
    toast.info("Spotlight", "Somewhere else.");
    toast.success("Spotlight", "Players who allow it are looking here.");
    useToasts
      .getState()
      .push({ kind: "info", title: "Undo?", actions: [{ label: "Undo", onClick: () => {} }] });
    useToasts
      .getState()
      .push({ kind: "info", title: "Undo?", actions: [{ label: "Undo", onClick: () => {} }] });
    expect(useToasts.getState().items).toHaveLength(4);
  });

  it("the replaced one's timer goes with it: the new one gets its full time", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    toast.info("Saved");
    vi.advanceTimersByTime(4000);
    toast.info("Saved");
    vi.advanceTimersByTime(2000);
    // The first one's 5 s ran out, but it was replaced: the second is still showing.
    expect(useToasts.getState().items.map((t) => t.title)).toEqual(["Saved"]);
    vi.advanceTimersByTime(3500);
    expect(useToasts.getState().items).toHaveLength(0);
    vi.useRealTimers();
  });
});
