# Progress log

Append after every work block: what was done, what's next, blockers, and the output of
`pnpm features:status`.

## 2026-09-27 — Phase 0 started

- Read docs/SPEC.md in full.
- Environment: host has Node 22.18.0 (not 24); pnpm 12.6.0 via corepack (needed a cache fix, see
  DECISIONS); no cloudflared installed; Windows 11, 16 logical CPUs. Portable Node 24.21.0 downloaded to
  `%LOCALAPPDATA%\gloam-tools` for cross-version verification (not on PATH, system untouched).
- All §9 package versions exist on npm exactly as pinned (react-router: 7.18.4, the latest 7.x).
- Scaffolded the monorepo, installed dependencies (454 packages). Native modules (better-sqlite3 N-API
  prebuilds, sharp, argon2) load on Node 22 and 24 with `allowBuilds` as in §9.4.
- `tools/extract-features.mjs` → docs/FEATURES.json: 224 acceptance criteria.

## 2026-09-27 — Phase 0 complete; P1 server done

- Research R1–R5 done (docs/research/*.md). R1 corrections and R5 protocol traps logged in DECISIONS.md;
  R3's 52 deviations applied where they touch built code (CORS reflection off, Express bypass on /matchmake
  guarded in onAuth + beforeUpgrade, `authSessionId`, no @colyseus/tools, FK-off migrations, helmet config…).
- Spikes S1–S6 all passed; findings in docs/research/stack.md § "Spike findings (builder)"; spike code deleted.
- SRD 5.2.1 pack built by `pnpm content:build` (R2): 339 spells 27/57/57/42/34/38/31/20/17/16, conditions,
  light sources, MANIFEST, ATTRIBUTION; reproducible; 15 content tests. Server loads and asserts it at startup.
- P1 server: auth/lobby/table rooms, command bus + history + undo, snapshots/backups, tunnel manager, all with
  integration tests (host/auth/persistence/security suites). Found and fixed: Colyseus ignores instance-level
  onAuth (moved to static, campaign id from matchmaking URL); fog undo keys broke on ":" in layer names;
  Windows data-dir ACL only applied to new folders.
- Next: P1 web screens (setup, admin Table/Settings, join, waiting room, closed, table shell) + Playwright
  E2E for the UI halves of HOST-02/03/04/05/06/09 and AUTH-02/03; PER-03 needs scene activation (P2).

```
PASSING 20/224 · DISPUTED 0 · FAILING 204
```

## 2026-09-27 — paused by Xini (resume notes)

- Committed: bfac96f (P0 complete, P1 server). Uncommitted WIP: P1 web screens (setup, admin Table/Settings,
  join, waiting room, closed, table shell, audio engine, UI kit), e2e harness (e2e/fixtures, journeys p1-*),
  P2 server start (engine/plan.ts, engine/commands/scene.ts, shared/protocol/commands.ts — not yet registered).
- P1 E2E run: HOST-02 and HOST-06 journeys pass. Failures found:
  1. HOST-03 test selector: URL text also appears in a toast → use getByRole("link").
  2. Join flow: the code auto-submits on the 10th character (onComplete) AND the test clicks "Knock on the
     door"; the button is gone by then, so the click times out. Fix knockAsNew (don't click after auto-submit)
     and debounce the double submit in Join.tsx.
- Next on resume: fix the above, rerun `node tools/e2e.mjs`, mark HOST-02/03/04/05/06/09 + AUTH-02/03 with
  evidence, run `pnpm check`, commit P1 web, then continue P2 (scene/token commands, projector + views, asset
  pipeline, R3F board).

## 2026-09-27 — P1 complete (web + E2E); P2 started

- P1 web: setup, Admin Table/Settings, join (code → identity), waiting room, closed screen, table shell, audio
  engine (ZzFX + Web Audio graph), UI kit. Playwright harness (spawned server per test, fake cloudflared, software
  GL, real autoplay policy) with 9 journeys for HOST-02/03/04/05/06/09 and AUTH-01/02/03/04 — all pass.
- The stricter guard and in-page latency measurement found and fixed real problems: a 2.3 s main-thread stall per
  screen change on software GL (shader backdrops moved to an OffscreenCanvas worker), a 1.4 s startup stall
  (noise texture now a static asset), a CSP eval violation on every page (zod jitless), double `room.leave()`,
  a mis-placed candle flame, and a serial admit path (the table now connects during the dissolve).
  Measured: identity → waiting room 132 ms; admit → table 513 ms.
- P1 is 27/28: AC-PER-03 needs scene activation (P2) for its "snapshot on activation" clause.
- P2 groundwork (compiles, not yet registered): scene and token command definitions, plan helpers,
  shared protocol schemas for them.
- Next: register scene/token commands; state projector + per-client views; prep view; asset pipeline; R3F board.

```
PASSING 28/224 · DISPUTED 0 · FAILING 196
```

## 2026-09-27 — P2 in progress: server done, board + HUD being built

- Committed: P2 server core (scenes, tokens, state projector, per-client views, prep view) and the asset pipeline
  (uploads, processor child, serving, library). 35/224 passing (P1 28/28; AST-01/02/03/04/05/07; PER-03).
- Board (uncommitted, renders cleanly under software GL): table environment, image/GLB/procedural maps, camera
  rig (presets, Spotlight, memory), performance tiers + governor, post-FX, tokens (model/standee/coin/auto,
  bases, overlays, HP ghost bar, selection, hidden badge).
- HUD (uncommitted, typechecks): left toolbar, dock (Party, DM: Scenes / Library / Approvals), new-scene wizard
  with calibration, radial menu, Quick Unit, settings popover (volumes, graphics pin, UI size, motion, colour-blind,
  DM camera opt-out), prep banner, scene travel transition (old scene held while fading to black), parchment
  loading bar, first-load intro with staggered HUD, Library → board drag and drop, Pan tool.
- Dev server: `pnpm dev` now runs on 4747 for live watching. It watches only server/shared sources; `--watch`
  on the whole import graph restart-looped because Vite writes temporary modules. Tests keep to random ports.
- Next: 3D map alignment + Generate walls (SCN-04), DM walls overlay, then P2 E2E journeys and marking ACs.
- Later the same day: wall generation (slice → union → RDP, 13 unit tests), grouped undo (tests), Ctrl+Z/Ctrl+Y
  keys, 3D map alignment gizmo + map tools panel, DM walls overlay; SCN-08 server test. First P2 journeys:
  first-load intro (36 composited frames, no flash, zero layout shift, exact stagger, once per load, reduced
  motion), 1 unit = 1 ft, self-hosted fonts. Found and fixed two multi-second software-GL stalls (context release;
  first composite under an opaque overlay). Marked SCN-03, SCN-08, DS-04, BRD-01, DS-06 → 40/224.

## 2026-09-27 — P2 complete: 32/32

- All P2 criteria pass with evidence (61/224 overall). 27 E2E journeys (22 parallel + 5 timing-isolated), 115 unit/
  integration tests. P2 journeys: first load, camera/Spotlight, tiers/huge maps, scene travel/floors, tokens,
  DM tools (calibration, 3D map alignment + Generate walls, Library), reconnection.
- Bugs the journeys and screenshot review found and fixed along the way: software-GL stalls (context release,
  opaque-overlay first composite), idle boards redrawing (now on demand), shader programs recompiled per scene
  travel, slow-device frames not measured by the tier governor, GLB textures blocked by CSP, mini overrides never
  applied, asset names leaking to players, dialogs taller than the screen, pan drifting from the pointer,
  selection lost on a quick click, lost sessionStorage saves, map-tool edit race, invite code overflowing the Join
  card, unreachable admin actions on phones, overlapping token overlays.
- Next: `pnpm shots` review round + visual-critic (≤ 2 rounds), then P3 (walls and movement).

## 2026-09-27 — Screenshot review round 2; P3 pathfinder engine

- Visual fixes from reviewing `pnpm shots` (and Xini's report of a glitched Stone Guardian): the "glitch" was an
  inside-out, noise-textured test box — the renderer drew bad input faithfully. The GLB pipeline now repairs
  inside-out minis (closed shells, inconsistent winding; unit + server tests), and screenshots use an illustrated
  portrait set, a drawn dungeon map and a modelled stone-guardian mini.
- Name plates: a fade bug dipped settled plates and auto coins on every redraw (flicker; plates caught half-faded);
  plates floated far above tall minis onto the token behind; lying minis were thrown off their base and flat
  standees stood upright from side views; a board going idle right after a camera change could keep a one-frame-
  stale layout. All fixed; new journey "overlay layout" checks plate placement at 90/55/30° and at a distance,
  including tipped-over minis and flat standees, no plate overlaps, and stability across redraws.
- Phones: admin invite code on one line, dock panel fits beside its rail, Quick Unit fields reflow (labels no
  longer run together), compact admin button.
- P3 (started): shared movement engine — wall blocking matrix, clearance, visibility-graph pathfinder with cached
  per-scene structures and a connectivity grid (≈ 0.2–0.3 ms per warm query on 500 walls; matches brute force on
  120 random scenes), cost integration (difficult terrain, crawl), server validation (collision truncation,
  clamp/reject budgets), cramped-start rule. 22 unit tests.
- Next: `move.commit` server command and client drag preview (P3 MOV criteria), then walls editor, doors, zones.

## 2026-09-27 — P3: moving tokens, doors, measuring, elevation, pings

- Server: `move.commit` (routed and freehand, player truncation at true obstacles with the "unseen" toast, DMs
  ignore blocking, crawl when prone, auto-facing), `move.preview` relay to the token's other viewers, room events,
  `door.toggle` (reach, locks, secret doors revealed only when the DM opens them), zones (create/update/delete,
  impassable, water, hidden zones out of players' state) and hazard prompts to DMs. 13 server tests.
- Client: drag and click-to-move with waypoints, routed preview once per frame, re-route at once when a door
  changes (door → new path 16–36 ms end-to-end), remote ghosts, gliding committed moves with footsteps, door
  handles with rattle/sounds, zones rendering, measuring (ruler/radius/cone/line/cube, shared 3 s, units),
  elevation (stepper, Alt+wheel, stem/ring/label, 3-D distances), pings and the DM's Spotlight ping.
- Passing now (73/224): MOV-03, MOV-08, MOV-11, MOV-12, MOV-13, MOV-14, MOV-17, TOK-07, FUN-02, WAL-04 (plus
  WAL-01, MOV-02 earlier). Journeys: p3-movement (2), p3-tools (1).
- Held: WAL-03 (paths proven; vision is P4), WAL-05 (needs the Zones tool; turn-start/end triggers arrive with
  combat in P8 — the engine side is tested).
- Next: Zones tool (WAL-05), walls editor (WAL-02), 3D walls with swinging doors (WAL-06), 1 000-wall editing perf
  (WAL-07), then P3 shots and the critic round.

## 2026-09-27 — P3: walls editor, zones tool, walls in 3D, editing performance

- Walls tool (WAL-02): chains with 1-ft end snapping (+ on-wall snapping), Shift 15°, Ctrl free, Backspace; Room tool
  (rectangle or polygon); select, box-select, joint drags (Alt detaches), move with stretching neighbours, split,
  join, bulk kind/hidden, delete — each edit one command, one undo step. Server: batched `wall.update`, `wall.split`,
  `wall.join` (5 server tests), geometry unit tests.
- Zones tool (WAL-05 UI): rectangle/circle/polygon drawing, selection of the smallest zone, move/reshape handles, panel
  for label, colour, visibility, DM note and hazard triggers (save + damage).
- Walls in 3D (WAL-06): instanced masonry, swinging door leaves (300 ms), glass windows, cloth curtains, DM-only
  ghosts; camera cutaway so rooms stay visible at low angles.
- Editing performance (WAL-07): traced journey — every frame of a 1 000-wall joint drag and a 1 000-wall move under
  16 ms of main-thread CPU (p95 ≈ 5 ms). Fixed on the way: shader programs recompiled on every selection, grown line
  overlays drawing only their first 500 segments, forced layouts in pointer handlers, and a store sync that re-read
  every entity on every patch (now incremental, audited against a full re-read after every patch in test builds).
- Held: WAL-03 (vision part, P4), WAL-05 (start/end-of-turn triggers need the combat tracker, P8).
