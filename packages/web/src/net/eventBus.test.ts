import { describe, expect, it } from "vitest";
import { ReplayBus } from "./eventBus.ts";

type Map = { message: { type: string; payload: unknown }; kicked: { message: string } };

describe("the table's replay buffer (events before anyone listens)", () => {
  it("keeps the one message of a kind through a flood of another, and replays in the order they came", () => {
    const bus = new ReplayBus<Map>();
    bus.emit("message", { type: "actor.snapshot", payload: { actors: ["mira"] } });
    for (let i = 0; i < 1000; i++) bus.emit("message", { type: "cast.view", payload: i });
    bus.emit("message", { type: "sheet.patch", payload: "after" });
    const seen: string[] = [];
    bus.on("message", (m) => seen.push(m.type));
    // The snapshot survived (a player's sheets), and still comes before the patch that follows it.
    expect(seen[0]).toBe("actor.snapshot");
    expect(seen.at(-1)).toBe("sheet.patch");
    // The flood kept only its newest, per kind.
    expect(seen.filter((t) => t === "cast.view")).toHaveLength(200);
  });

  it("delivers straight to listeners once there are some, and replays each type to its first listener only", () => {
    const bus = new ReplayBus<Map>();
    bus.emit("kicked", { message: "early" });
    const a: string[] = [];
    bus.on("kicked", (m) => a.push(m.message));
    bus.emit("kicked", { message: "live" });
    const b: string[] = [];
    bus.on("kicked", (m) => b.push(m.message));
    expect(a).toEqual(["early", "live"]);
    expect(b).toEqual([]);
  });
});
