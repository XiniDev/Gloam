import { afterEach, describe, expect, it, vi } from "vitest";

// The store's timers use window.setTimeout: a window of this process's own for the test.
vi.stubGlobal("window", { setTimeout, clearTimeout });
const { toast, useToasts } = await import("./Toast.tsx");

afterEach(() => {
  useToasts.getState().hold(false);
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

describe("a stack with nowhere to stand waits (a tall dialog on a narrow screen)", () => {
  it("its clocks stop and go on from where they were; an error from the dialog's own work still shows and counts down", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const titles = () => useToasts.getState().items.map((t) => t.title);
    toast.info("Erin was let in");
    vi.advanceTimersByTime(2000);
    useToasts.getState().hold(true);
    toast.danger("Couldn't save the note");
    toast.success("Saved elsewhere");
    vi.advanceTimersByTime(10_000);
    // The error ran its 5 s; the others waited, unseen and unexpired.
    expect(titles()).toEqual(["Erin was let in", "Saved elsewhere"]);
    useToasts.getState().hold(false);
    // The first had 3 s left; the one that came while held gets all of its 5.
    vi.advanceTimersByTime(2900);
    expect(titles()).toEqual(["Erin was let in", "Saved elsewhere"]);
    vi.advanceTimersByTime(200);
    expect(titles()).toEqual(["Saved elsewhere"]);
    vi.advanceTimersByTime(2000);
    expect(titles()).toHaveLength(0);
    vi.useRealTimers();
  });
});
