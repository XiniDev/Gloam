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

## 2026-09-28 — P3 critic round 2 fixes; P4 begins (vision engine and server vision service)

- P3 fixes: a pathfinder cache bug (a drag's kept start edges also kept the direct start→goal edge, so a clear line
  to the drag's first spot ran through a wall behind it — regression test replays a drag); a new camera (O) now put
  in place in the commit that creates it (a click right after O picked the wrong spot; `inSync` probe); the camera
  rig no longer "restores" its last live view when a scene patch re-renders it (it undid camera moves); P3 shots at
  all three viewports run every step. Full E2E green (30 + 6 timing) before the P4 work.
- P4 shared (`@gloam/shared/geometry`, `/vision`): visibility polygons by rotational sweep over prepared segment
  sets (property test: 2 000 scenes × 500 points vs a brute-force caster), light levels, `perceive` and creature
  perception per §15.3–15.4 (darkvision greyscale, blindsight, truesight, invisibility, tremorsense, magical
  darkness, obscurement, 3-D ranges), fog rasters with scanline fill and RLE, the light raster, explored marking.
- P4 server: `VisionService` — per-player perceived tokens, carried-light glow, tremorsense markers (`sensed`), painted
  layers and explored memory (5-s flush, `fog_masks`), `fog.snapshot`, `vision.viewAs`, moves clipped per viewer
  (§15.6); `fog.paint` (brush/rect/polygon/room/all, for all or one player, undoable), `fog.resetExplored`,
  `light.create/update/delete/toggle/carry` with §34.3 presets, `shareVisionWith`, party vision. 9 server vision tests
  (VIS-01/03/05/09/10/11/13/14 server sides, SCN-07, WAL-03 vision) incl. raw-frame checks and a restart.
- Next: the client — fog/light render targets and composite (§15.7), war fog, explored memory, DM hatched overlay and
  View as, Fog and Light tools, the token Light slice, sensed markers, partial-move animation; then P4 journeys,
  shots and the bench (VIS-12).
- P4 client: the fog/light composite in every board material, vision and light targets drawn from the shared
  visibility code, the war fog, explored memory (the server's raster, held while one's own token still glides), the
  300-ms reveal, the DM's hatch and View as, the Fog tool (brush/rect/polygon/room, reveal/hide, for all or one
  player, fog mode and ambient, reset explored) and the Lights tool (presets, gizmos, editor), the token menu's Light
  ring (light, douse, hood, put away), tremorsense markers, moves seen partway (ghosts that fade). Three journeys
  (p4-vision, p4-light-fog, p4-dm-view) pass: VIS-01/02/03/04/05/09/10/11/13/14 and SCN-07, WAL-03 (vision), VIS-12's
  client half. P3 critic round 2 fixed (12 important items) and verified in the re-rendered shots.

## 2026-09-28 — P4: the server vision budget (VIS-12), exact light reach, `pnpm bench`

- The server vision service recomputes incrementally and exactly: polygons kept across wall/door changes unless a
  changed segment comes near them, the light raster redrawn by scanline only where lights (or their lit areas)
  changed, explored marking skipped or clipped to re-lit cells, light reach remembered per polygon pair. Bench on the
  §37-sized scene: p95 135 ms → ≈ 5 ms (doors ≈ 7 ms p50). An equivalence test (160 mixed events vs a from-scratch
  service after each) guards it and catches three planted bugs.
- Carried-light glow round corners is now an exact area overlap (fan triangles, separating axes; cones cut) — fixes
  a missed glow seen through a gap and a bullseye-lantern hidden-position leak. Geometry tests: wall-touching regions
  never overlap (400 random), the slit case, cones incl. > 180° and the ±π seam, 600 random pairs vs sampling.
- A DM-locked token's light is locked too (server + menu), matching the P2 lock rule.
- `pnpm bench` (tools/bench.mjs) runs the vision part and writes artifacts/bench/report.json with host details.
- Last full E2E (before these fixes) had 6 failures: stone program key (now includes the fog variant), a fog noise
  texture uploaded on the first scene (now with the renderer), the Light slice on a locked token (now hidden); the
  reconnect and two P4 journeys are being re-run.

## 2026-09-28 — P4 closed: reviews fixed, ACs proven; P5 under way

- End-of-P4 security review (2 HIGH, 3 MEDIUM, 5 LOW) and rules audit (12 items): all fixed with tests — the dev
  server lockdown, bounded move clipping, per-viewer preview clipping, glow stand-ins, re-authorised undo, cached fog
  snapshots, scanline brush; blindsight/tremorsense/obscurement/explored/emanation/swimming/flight fixes, 3-D light
  spheres, no light in magical darkness (details in DECISIONS).
- A board-wide bug found through four "flaky" journeys: a suspension in the canvas (the first label per font) hid the
  whole board; now contained, and every journey fails if the board is ever hidden.
- Full E2E green (31 + 9 timing, the token crossfade journey moved to the timing part), `pnpm check` 277 tests,
  `pnpm bench` p95 ≈ 5 ms. FEATURES: P4 12/12 and WAL-03 marked with evidence (89/224 overall).
- P5 (dice): the formula grammar, evaluator and seeded generator (shared); dice solids with their rotation groups and
  the symmetry remap; deterministic Rapier throws (1.1–1.8 s to rest, always showing the server's number); the
  server dice service and the client worker, store and face atlas in progress.

## 2026-09-28 — P4 visual review: two critic rounds, fixes in; P5 dice continuing

- Critic round 1 (4/10) and round 2 (5/10) on the 30 P4 screens. Fixed: pillars as solid prisms; the cutaway lowers
  wall geometry (closed stubs, no insides, lintels go) on a real slope, and cuts walls hiding any token in view;
  plates move to a free spot with a brass leader instead of vanishing and slide back onto the screen at its edge;
  wall faces graded from the room they face; phone HUD (a corner tools button, bottom sheets at 30/60/95 %, 44-px
  controls, framing in the clear area, radial menus inside it); toolbar states per §27.4; the DM seal; HP digits ink
  over the fill; door handles; masonry filtering; overlapping bases ordered; fog panel regrouped; light-menu icons;
  darkvision rings. Left with reasons (DECISIONS): the first-use shader stall behind the toolbar capture (AC-PERF-05,
  P15), plate size at phone zoom, the light edge over the floor's mottling.
- New tests: e2e/journeys/p4-phone.spec.ts (the phone HUD: corner tools, sheets and their snaps, 44-px controls, no
  HUD overlaps, the token menu in the clear area); pillar detection, prism geometry and declutter unit tests; the
  walls-in-3D journey checks a pillar; the overlay-layout journey checks moved plates.
- Bugs found through "flaky" journeys under load: a held drag's preview vanished for other viewers after 1.5 s (now a
  500 ms heartbeat); the Spotlight toast claimed success when the server refused (now it says so).
- P5: dice sound recipes (per-material clacks for tray and die contacts, the settle tick, natural 20 and 1) with the
  test sound log recording each clack's gain; the 3D dice overlay is next.

## 2026-09-28 — P5 dice: ACs proven

- The 3D dice overlay (DiceOverlay.tsx): recorded deterministic throws played back with the symmetry remap, landing on
  the server's numbers for everyone; per-skin materials; clacks from the recorded contacts (tray or die, per skin
  material, gain from the impulse), settle ticks, natural 20 / 1 flourishes; a camera that frames the dice; the card's
  total at rest; fade after 2.5 s; reduced motion shows them at rest; renders only while something moves.
- Dice skins: Settings → Your dice (body, material, numbers; a live d20), saved to the profile and presence
  (`profile.diceSkin`), everyone's view of that player's dice.
- Tests: e2e/journeys/p5-dice.spec.ts (2 journeys), server dice tests (skins, limits on the server), §18.3 visibility
  rows (blind included) as unit tests; key screens in artifacts/screens/p5. FEATURES: DICE-01/02/03/04/05/07/08/09/10
  marked (DICE-06 → P6, DICE-11 → P7).
- E2E note: under the machine's current load (open browser tabs ~2.3 cores) the token-crossfade timing journey can't
  catch two frames inside 200 ms (frames ~110 ms on software GL, the same on the last commit); everything else passes
  run on its own. The full run is repeated when the machine is quieter.

## 2026-09-28 — P5 visual review, round 1 (critic 5/10)

- Fixed every BLOCKING and IMPORTANT item and the NICEs (details and reasons in DECISIONS, "Critic round 1 (P5)"):
  masked rolls no longer carry their label to other players (a §13.4 leak) and read "The DM" under the seal; dice
  come to rest clear of the feed, the action bar and a tray kept open (HUD obstacles + the largest clear rectangle, one
  throw in the tray at a time, re-framed when the HUD moves); trays sized by the dice so a pair on a phone is ≥ 48 px;
  a steeper dice camera; rolling closes the tray (draft kept; "keep open" pin); the phone tray and feed are bottom
  sheets with Roll always in view; custom d20 and spark glyphs, a round dice button; roller portraits, empty chips
  until the dice settle, the turning d20 while pending, private tags, a fading top edge on the open feed;
  `--danger-text` for small danger text app-wide; contact shadows; metal, resin, gem and bone that look different
  (per-material reflections of a lantern-lit room, enamel numbers on metal); a live die in the skin picker; balanced
  d8/d12/d20 numbering; the Settings popover clear of the dock.
- Tests: new journey "dice come to rest where they're seen" (desktop feed/action bar/kept-open tray, phone size ≥ 48 px,
  the dice button uncovered), masked-label unit test and journey checks, `largestClear` against brute force, trays
  (release clear of the walls for 1–20 dice), dice numbering against every arrangement, `countOf`. `pnpm check` 326
  tests; p5-dice, p4-phone, p1-lobby journeys pass. Key screens re-shot (transitions finish before each capture).
