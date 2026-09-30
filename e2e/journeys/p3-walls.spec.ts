import type { Page } from "@playwright/test";
import { adminAtTable, boardSettled, camera, createScene, hook, introDone, req } from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };

interface P {
  x: number;
  y: number;
}
interface WallHook {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: string;
  dmKind?: string;
  dmHidden?: boolean;
}
interface ToolHook {
  mode: string;
  chain: P[];
  pointer: P | null;
  snap: string | null;
  rect: { a: P; b: P } | null;
  selected: string[];
  preview: unknown[] | null;
  ghosts: number;
}
const tool = (p: Page) => hook<ToolHook>(p, "wallTool");
/** Counts only: polling the full tool state (a 1 000-wall preview) would itself load the page being measured. */
const summary = (p: Page) =>
  hook<{ mode: string; selected: number; preview: number | null }>(p, "wallToolSummary");
const walls = (p: Page) => hook<WallHook[]>(p, "walls");

async function screen(p: Page, x: number, y: number) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, 0)) as { sx: number; sy: number };
  return { x: s.sx, y: s.sy };
}
async function moveTo(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  await p.mouse.move(s.x, s.y);
}
async function clickAt(p: Page, x: number, y: number, modifiers: ("Shift" | "Control")[] = []) {
  for (const m of modifiers) await p.keyboard.down(m);
  const s = await screen(p, x, y);
  await p.mouse.move(s.x, s.y);
  await p.mouse.down();
  await p.mouse.up();
  for (const m of modifiers) await p.keyboard.up(m);
}
async function dragOn(p: Page, a: P, b: P, steps = 8) {
  await moveTo(p, a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++)
    await moveTo(p, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await p.mouse.up();
}
const near = (p: P | null | undefined, q: P, tol = 1e-6) =>
  !!p && Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
/** Walls whose ends are (in either order) a and b. */
const between = (ws: WallHook[], a: P, b: P, tol = 1e-3) =>
  ws.filter(
    (w) =>
      (near({ x: w.ax, y: w.ay }, a, tol) && near({ x: w.bx, y: w.by }, b, tol)) ||
      (near({ x: w.ax, y: w.ay }, b, tol) && near({ x: w.bx, y: w.by }, a, tol)),
  );
const endsAt = (ws: WallHook[], q: P, tol = 1e-3) =>
  ws.filter((w) => near({ x: w.ax, y: w.ay }, q, tol) || near({ x: w.bx, y: w.by }, q, tol));

test.describe("P3 — the Walls tool (WAL-02, WAL-07)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-WAL-02: chains with 1-ft end snapping, Shift 15°, Ctrl free, Backspace; rooms; select, joints, split, join, kind, box-select and delete", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    await camera(admin, { pitchDeg: 90, distance: 58, target: [30, 18], ms: 0 });
    await admin.waitForTimeout(300);

    // W: the Walls tool, drawing.
    await admin.keyboard.press("w");
    await expect(admin.getByTestId("walls-panel")).toBeVisible();
    await expect.poll(async () => (await tool(admin)).mode).toBe("draw");

    // A chain: three clicks, the pill showing the segment under way; Backspace takes the last segment back.
    await clickAt(admin, 10, 10);
    await clickAt(admin, 20, 10);
    const [p0, p1] = (await tool(admin)).chain as [P, P];
    await moveTo(admin, 20, 16);
    await expect(admin.getByTestId("wall-length")).toHaveText(/^\d+(\.5)? ft$/);
    await clickAt(admin, 20, 16);
    expect((await tool(admin)).chain).toHaveLength(3);
    await admin.keyboard.press("Backspace");
    expect((await tool(admin)).chain).toHaveLength(2);
    // Shift: 15° steps from the last point — a slanted pointer gives an exactly vertical wall.
    await admin.keyboard.down("Shift");
    await moveTo(admin, 20.9, 18);
    await expect.poll(async () => (await tool(admin)).snap).toBe("angle");
    const shifted = (await tool(admin)).pointer as P;
    expect(shifted.x).toBe(p1.x);
    expect(shifted.y).toBeGreaterThan(17.5);
    await admin.mouse.down();
    await admin.mouse.up();
    await admin.keyboard.up("Shift");
    const corner = (await tool(admin)).chain[2] as P;
    expect(corner.x).toBe(p1.x);
    // Enter finishes: two walls, joined exactly.
    await admin.keyboard.press("Enter");
    await expect.poll(async () => (await walls(admin)).length).toBe(2);
    let ws = await walls(admin);
    expect(between(ws, p1, corner)).toHaveLength(1);
    expect(endsAt(ws, p1)).toHaveLength(2);

    // Snapping: a click 0.8 ft from an end lands exactly on it (the ring shows while hovering); Esc finishes.
    await moveTo(admin, corner.x + 0.6, corner.y + 0.5);
    await expect.poll(async () => (await tool(admin)).snap).toBe("end");
    await clickAt(admin, corner.x + 0.6, corner.y + 0.5);
    expect(near((await tool(admin)).chain[0], corner)).toBe(true);
    await clickAt(admin, 30, corner.y);
    await clickAt(admin, p0.x + 0.7, p0.y + 0.4); // lands on the first wall's start
    expect(near((await tool(admin)).chain[2], p0)).toBe(true);
    await admin.keyboard.press("Escape");
    await expect.poll(async () => (await walls(admin)).length).toBe(4);
    ws = await walls(admin);
    expect(endsAt(ws, p0)).toHaveLength(2);
    expect(endsAt(ws, corner)).toHaveLength(2);
    // Ctrl/Cmd: no snapping at all — the same kind of near-miss stays where it was clicked.
    await clickAt(admin, corner.x + 0.6, corner.y + 0.5, ["Control"]);
    const free = (await tool(admin)).chain[0] as P;
    expect(Math.hypot(free.x - corner.x, free.y - corner.y)).toBeGreaterThan(0.5);
    await admin.keyboard.press("Escape"); // one point: nothing drawn
    expect((await tool(admin)).chain).toEqual([]);
    expect(await walls(admin)).toHaveLength(4);

    // The Room tool: a dragged rectangle (its size shows while dragging) …
    await admin.getByRole("radio", { name: "Room" }).click();
    await moveTo(admin, 35, 5);
    await admin.mouse.down();
    for (let i = 1; i <= 8; i++) await moveTo(admin, 35 + (15 * i) / 8, 5 + (10 * i) / 8);
    await expect(admin.getByTestId("room-size")).toHaveText(/15 ft × 10 ft/);
    await admin.mouse.up();
    await expect.poll(async () => (await walls(admin)).length).toBe(8);
    ws = await walls(admin);
    const [c0, c1, c2, c3] = [
      { x: 35, y: 5 },
      { x: 50, y: 5 },
      { x: 50, y: 15 },
      { x: 35, y: 15 },
    ];
    const snapped = (q: P) => endsAt(ws, q, 0.15).length;
    for (const c of [c0, c1, c2, c3]) expect(snapped(c)).toBe(2);
    // … or a clicked polygon, closed on its first corner.
    await clickAt(admin, 40, 24);
    await clickAt(admin, 50, 24);
    await clickAt(admin, 45, 33);
    await clickAt(admin, 40.4, 24.3);
    await expect.poll(async () => (await walls(admin)).length).toBe(11);

    // Select: click a wall, Shift+click another; bulk kind and "hidden".
    await admin.getByRole("radio", { name: "Select walls" }).click();
    const room = await walls(admin);
    const top = room.find((w) => Math.abs(w.ay - 5) < 0.2 && Math.abs(w.by - 5) < 0.2) as WallHook;
    const right = room.find((w) => Math.abs(w.ax - 50) < 0.2 && Math.abs(w.bx - 50) < 0.2) as WallHook;
    await clickAt(admin, 43, top.ay);
    await expect.poll(async () => (await tool(admin)).selected).toEqual([top.id]);
    await clickAt(admin, right.ax, 10, ["Shift"]);
    await expect.poll(async () => (await tool(admin)).selected.length).toBe(2);
    await expect(admin.getByTestId("walls-selected")).toHaveText("2 walls");
    await admin.getByRole("radio", { name: /Door/ }).click();
    await expect
      .poll(async () =>
        (await walls(admin))
          .filter((w) => w.dmKind === "door")
          .map((w) => w.id)
          .sort(),
      )
      .toEqual([top.id, right.id].sort());
    await admin.getByRole("button", { name: "Players see these walls" }).click();
    await expect.poll(async () => (await walls(admin)).filter((w) => w.dmHidden).length).toBe(2);
    await admin.getByRole("radio", { name: /^Wall/ }).click();
    await admin.getByRole("button", { name: "Hidden from players" }).click();
    await expect
      .poll(async () => (await walls(admin)).filter((w) => w.dmKind === "door" || w.dmHidden).length)
      .toBe(0);

    // A joint: dragging the room's corner moves both walls meeting there, as one edit.
    const cornerNow =
      Math.abs(top.ax - 50) < Math.abs(top.bx - 50) ? { x: top.ax, y: top.ay } : { x: top.bx, y: top.by };
    await admin.keyboard.press("Escape"); // clear the selection
    await clickAt(admin, 43, top.ay); // select the top wall: its ends get handles
    await dragOn(admin, cornerNow, { x: 53, y: 2 });
    await expect.poll(async () => endsAt(await walls(admin), cornerNow, 0.01).length).toBe(0);
    ws = await walls(admin);
    expect(endsAt(ws, { x: 53, y: 2 }, 0.15)).toHaveLength(2);
    await expect.poll(async () => (await tool(admin)).preview).toBeNull();
    // Ctrl+Z puts the joint back in one step.
    await admin.keyboard.press("Control+z");
    await expect.poll(async () => endsAt(await walls(admin), cornerNow, 0.01).length).toBe(2);

    // Split (double-click a wall) and Join.
    const before = (await walls(admin)).length;
    const bottom = (await walls(admin)).find(
      (w) => Math.abs(w.ay - 15) < 0.2 && Math.abs(w.by - 15) < 0.2,
    ) as WallHook;
    const at = await screen(admin, 42, bottom.ay);
    await admin.mouse.dblclick(at.x, at.y);
    await expect.poll(async () => (await walls(admin)).length).toBe(before + 1);
    await expect.poll(async () => (await tool(admin)).selected.length).toBe(2);
    await admin.getByRole("button", { name: "Join the two walls" }).click();
    await expect.poll(async () => (await walls(admin)).length).toBe(before);
    expect(
      between(await walls(admin), { x: bottom.ax, y: bottom.ay }, { x: bottom.bx, y: bottom.by }, 0.01),
    ).toHaveLength(1);

    // Box-select the rectangular room and delete it; Ctrl+Z brings it back.
    await admin.keyboard.press("Escape");
    await dragOn(admin, { x: 33, y: 2.5 }, { x: 53, y: 17 });
    await expect.poll(async () => (await tool(admin)).selected.length).toBe(4);
    await admin.keyboard.press("Delete");
    await expect.poll(async () => (await walls(admin)).length).toBe(before - 4);
    await admin.keyboard.press("Control+z");
    await expect.poll(async () => (await walls(admin)).length).toBe(before);

    // W again: back to drawing walls; Shift+W draws doors.
    await admin.keyboard.press("Shift+W");
    await expect.poll(async () => (await tool(admin)).mode).toBe("draw");
    await clickAt(admin, 5, 30);
    await clickAt(admin, 12, 30);
    await admin.keyboard.press("Enter");
    await expect
      .poll(async () => (await walls(admin)).filter((w) => (w.dmKind ?? w.kind) === "door").length)
      .toBe(1);
  });

  test("AC-WAL-07: with 1 000 walls, dragging a joint and moving a 1 000-wall selection stay under 16 ms of main-thread work per frame @timing", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Warren",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 200,
      heightFt: 130,
    });
    await boardSettled(admin, sceneId);
    // A 1 000-wall warren: 20 × 25 cells, each an L of two walls meeting at a joint.
    const all: { a: P; b: P }[] = [];
    for (let r = 0; r < 25; r++)
      for (let c = 0; c < 20; c++) {
        const x = 5 + c * 9.5;
        const y = 5 + r * 5;
        all.push({ a: { x, y }, b: { x: x + 4.75, y } });
        all.push({ a: { x: x + 4.75, y }, b: { x: x + 4.75, y: y + 4 } });
      }
    expect(all).toHaveLength(1000);
    // The Walls tool out from the start: the overlay draws every wall (with 3D walls on and no tool it draws only the
    // special ones) — its first draw holds the first 500, and it must grow to the thousand.
    await admin.keyboard.press("w");
    await req(admin, "wall.create", { sceneId, walls: all.slice(0, 500) });
    await expect.poll(async () => (await walls(admin)).length).toBe(500);
    await admin.waitForTimeout(300);
    await req(admin, "wall.create", { sceneId, walls: all.slice(500) });
    await expect.poll(async () => (await walls(admin)).length).toBe(1000);
    await camera(admin, { pitchDeg: 90, distance: 190, target: [100, 66], ms: 0 });
    await admin.waitForTimeout(400);
    // All thousand are drawn — the overlay grew from 500 to 1 000 between two frames.
    await expect
      .poll(() => hook<{ segments: number; drawn: number | null }>(admin, "wallsOverlay"))
      .toEqual({ segments: 1000, drawn: 1000 });
    await admin.getByRole("radio", { name: "Select walls" }).click();

    // A joint drag: select a wall mid-warren and drag its shared end in a circle for 60 moves.
    const w = all[520] as { a: P; b: P };
    await clickAt(admin, (w.a.x + w.b.x) / 2, w.a.y);
    await expect.poll(async () => (await tool(admin)).selected.length).toBe(1);
    // Chrome's trace of everything from here to the end of the edits: each main-thread task's own CPU time.
    const browser = admin.context().browser();
    if (!browser) throw new Error("no browser");
    await browser.startTracing(admin, {
      categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline"],
    });
    await hook(admin, "editPerf", "on");
    const j = w.b;
    await moveTo(admin, j.x, j.y);
    await admin.mouse.down();
    for (let i = 1; i <= 60; i++) {
      const ang = (i / 60) * Math.PI * 2;
      await moveTo(admin, j.x + Math.cos(ang) * 3, j.y + Math.sin(ang) * 3 + (i === 60 ? 0.5 : 0));
    }
    await admin.mouse.up();
    // Until the server's echo has been applied: its patch counts too.
    await expect.poll(async () => (await summary(admin)).preview).toBeNull();
    await admin.waitForTimeout(300);
    const joint = (await hook<number[]>(admin, "editPerf", "read")).slice();

    // Box-select every wall and move the whole warren 5 ft, in 60 moves.
    await admin.keyboard.press("Escape");
    // From the clear bottom-right corner (the top-left one is under the top bar).
    await dragOn(admin, { x: 199, y: 129 }, { x: 1, y: 1 });
    await expect.poll(async () => (await summary(admin)).selected).toBe(1000);
    await hook(admin, "editPerf", "on");
    const g = all[0] as { a: P; b: P };
    await moveTo(admin, (g.a.x + g.b.x) / 2, g.a.y);
    await admin.mouse.down();
    for (let i = 1; i <= 60; i++)
      await moveTo(admin, (g.a.x + g.b.x) / 2 + (5 * i) / 60, g.a.y + (3 * i) / 60);
    await admin.mouse.up();
    await expect.poll(async () => (await summary(admin)).preview).toBeNull();
    await admin.waitForTimeout(300);
    const bulk = (await hook<number[]>(admin, "editPerf", "read")).slice();
    await hook(admin, "editPerf", "off");
    const traceBuf = await browser.stopTracing();
    const trace = JSON.parse(traceBuf.toString("utf8")) as {
      traceEvents: {
        name: string;
        ph: string;
        pid: number;
        tid: number;
        ts?: number;
        dur?: number;
        tdur?: number;
        args?: { name?: string };
      }[];
    };
    // The move landed: the first wall is 5 ft right, 3 ft down (every wall moved with it).
    await expect
      .poll(async () => {
        const first = (await walls(admin)).find((x) =>
          near({ x: x.ax, y: x.ay }, { x: g.a.x + 5, y: g.a.y + 3 }, 0.5),
        );
        return !!first;
      })
      .toBe(true);

    const pct = (xs: number[], q: number) => {
      const sorted = [...xs].sort((x, y) => x - y);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
    };
    // The app's own per-frame account (wall clock: input, patch handling, commits and the frame), reported.
    for (const [name, frames] of [
      ["joint drag", joint],
      ["1 000-wall move", bulk],
    ] as const) {
      expect(frames.length, `${name}: frames measured`).toBeGreaterThan(20);
      test.info().annotations.push({
        type: `${name} (main-thread ms per frame, wall clock)`,
        description: `p50 ${pct(frames, 0.5).toFixed(2)} · p95 ${pct(frames, 0.95).toFixed(2)} · max ${Math.max(...frames).toFixed(2)} · n ${frames.length}`,
      });
    }
    // Per frame, exactly: in every frame period of the edits the main thread spends under 16 ms of CPU — every task in
    // it: input, network patches, commits and the frame itself. CPU time, not wall clock: on a machine busy rendering
    // in software the OS schedules the page's thread out for tens of milliseconds at a time, which the trace shows as
    // wall time with no CPU behind it.
    const main = new Set(
      trace.traceEvents
        .filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain")
        .map((e) => `${e.pid}:${e.tid}`),
    );
    const onMain = (e: { pid: number; tid: number }) => main.has(`${e.pid}:${e.tid}`);
    const tasks = trace.traceEvents
      .filter(
        (e) =>
          e.ph === "X" &&
          e.name === "ThreadControllerImpl::RunTask" &&
          onMain(e) &&
          typeof e.tdur === "number",
      )
      .sort((a, b) => (a.ts as number) - (b.ts as number));
    const frameStarts = trace.traceEvents
      .filter((e) => e.name === "FireAnimationFrame" && onMain(e))
      .map((e) => e.ts as number)
      .sort((a, b) => a - b);
    expect(tasks.length, "main-thread tasks traced").toBeGreaterThan(100);
    expect(frameStarts.length, "frames traced").toBeGreaterThan(100);
    // Each frame period: the 16.7 ms from a frame's start, and the CPU of every task in it (a task straddling two
    // periods counts in each by its overlap).
    const PERIOD = 16_667;
    const cpu: number[] = [];
    let k = 0;
    for (const f of frameStarts) {
      while (k < tasks.length && (tasks[k]?.ts as number) + (tasks[k]?.dur ?? 0) < f) k++;
      let sum = 0;
      for (let q = k; q < tasks.length && (tasks[q]?.ts as number) < f + PERIOD; q++) {
        const t = tasks[q] as { ts?: number; dur?: number; tdur?: number };
        const a = Math.max(f, t.ts as number);
        const b = Math.min(f + PERIOD, (t.ts as number) + (t.dur ?? 0));
        if (b > a && t.dur) sum += ((b - a) / t.dur) * (t.tdur as number);
      }
      cpu.push(sum / 1000);
    }
    const longest = tasks.reduce((m, e) => ((e.tdur as number) > (m.tdur as number) ? e : m));
    test.info().annotations.push({
      type: "main-thread CPU per frame while editing (trace)",
      description: `p50 ${pct(cpu, 0.5).toFixed(2)} · p95 ${pct(cpu, 0.95).toFixed(2)} · max ${Math.max(...cpu).toFixed(2)} ms over ${cpu.length} frames; longest task ${((longest.tdur as number) / 1000).toFixed(1)} ms CPU / ${((longest.dur ?? 0) / 1000).toFixed(1)} ms wall`,
    });
    expect(Math.max(...cpu), "main-thread CPU in the worst frame, ms").toBeLessThan(16);
  });
});
