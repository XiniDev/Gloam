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

## 2026-09-28 — P5 visual review, round 2 (critic 6.5/10, final round)

- Fixed the BLOCKING and IMPORTANT items and most NICEs (DECISIONS, "Critic round 2 (P5)"): the dice numerals now in
  Fraunces (they were Georgia), outlined and on metal with a sheen; 13-px text on touch; custom glyphs for physical
  rolls and pins, a labelled Keep-open switch; tighter trays so a handful of dice on a phone is ≥ 48 px; a pinned tray
  beside the dock; the DM's cards under one seal; a whole-card feed with an expanded breakdown; an explicit tray
  layout; Settings as a phone bottom sheet and a dice obstacle; sheets and popovers rendered on the page (a backdrop
  filter had captured them); new players on an unused colour; contact shadows with a core, cast from the key light.
- Tests: the HUD-clear journey now checks 2, 3 and 7 dice ≥ 48 px on a phone; tumbling captures hold the throw
  mid-air (`diceFreeze`); key screen 09 shows every chip treatment and the breakdown. p5-dice (3), p4-phone pass.

## 2026-09-28 — P6 character sheets: every AC proven (14/14)

- Web sheet (committed 80b0514): the dock's parchment sheet with nine sections, locks with propose-on-edit, quick
  create, JSON/AI import with preview and diff, templates, drawing pad, paper cutout; the DM's Requests (form and
  live board) and players' request cards; sheet proposals in Approvals; pinned counters on tokens.
- Journeys, each proving its ACs in the browser: `p6-sheets.spec.ts` (SHEET-01/02/08 — quick create with an
  approved portrait, overrides, rollables with Alt/Ctrl and a touch long press, the tray rolling for a token;
  SHEET-06/07 — export, import errors/preview/diff, round trip, the AI prompt; SHEET-03/04/05, TOK-13 — seven block
  kinds and a pinned bar, templates, Core/Full locks with proposals approved and declined, linked tokens across
  scenes, unlinked goblins, relink asking), `p6-art.spec.ts` (SHEET-10/11 with a real pressure pen and a synthetic
  paper photo, approvals applied automatically), `p6-requests.spec.ts` (DICE-06: hidden DC, roll/enter/set/close,
  a blind check from the radial menu, NPCs in one click).
- Found and fixed on the way (DECISIONS): sheet rolls never got advantage (`\bd20\b` vs "1d20"); Ctrl+Z in the
  drawing pad undid the table's last action (making the character) — modal dialogs now keep their keys; a player's
  pending art never reached the character; plates pushed aside onto other tokens, plates buried neighbours, plates
  under the HUD; the sheet's tabs cut through; the drawing canvas off screen and dark ink on a dark board; slider
  labels missing; raw JSON paths in diffs; tokens at the origin before their first frame (a flaky P2 journey).
- Unit tests added: `rollMode.test.ts`, `names.test.ts`, declutter (bodies, burying, fallback, HUD covers).
- Next: full `pnpm check` and commit; P6 key-screen shots and the visual critic (≤ 2 rounds); then P7.

```
Phase  Pass  Disp  Fail  Total
P1       28     0     0     28
P2       32     0     0     32
P3       16     0     1     17   (AC-WAL-05 waits for P8's fog persistence)
P4       12     0     0     12
P5        9     0     0      9
P6       14     0     0     14
PASSING 112/224
```

## 2026-09-28 — P6 visual review, round 1 (critic 5/10): fixes in

- The critic's 11 BLOCKING and 22 IMPORTANT items worked through (DECISIONS, "P6 critic round 1"): phone panels are
  pages; request cards and the phone feed never over a panel; nothing scrolls sideways; tooltips on keyboard focus
  only; the banned dice glyph gone; parchment themes the ink components on it; a new sheet header; tabs, spells,
  attacks, inventory, custom blocks, party rows, proposals, request form, import errors, radial DM ring, plates
  (temp HP beside the bar, lighter pinned gauges, a visible leader), the drawing pad on a phone.
- New tests: `p6-phone.spec.ts` (the sheet on a 390×844 phone: a full-width page, no sideways scroll in any section,
  every control ≥ 44 px, a roll from the page shows the dice) — it found 40-odd small targets and an invisible ruler
  that let the page slide sideways, all fixed; unit tests for `summarizeFormula`, `issueText`, the conditions and
  damage rules (P7 groundwork: 37 + 5), the palette mirror, declutter covers.
- P7 groundwork already in: the SRD damage pipeline (`applyDamage`, 30 table cases + overflow, massive damage, death
  saves, concentration), condition and marker metadata with roll hints and speed (§19.3–19.4), the Appendix G icons
  extracted into `@gloam/shared/icons` (checked against the spec by `pnpm lint`) with the `StatusIcon` component and
  the WebGL atlas.
- Journeys after the fixes: p2-tokens (6), p2-camera, p4-phone, p5-dice (3), p6-sheets (3), p6-requests, p6-art,
  p6-phone pass. Flaky under a loaded machine, to look at: `wallGen.test.ts` "stays fast on a large map" (1.7 s vs a
  1.5-s budget once) and `assets.test.ts` AC-AST-03 (a socket closed once); both pass on reruns.

## 2026-09-28 — P6 visual review, round 2 (critic 6/10): fixes in; P7 groundwork committed

- The critic's 7 BLOCKING and 14 IMPORTANT items fixed, most NICE ones too (DECISIONS, "P6 critic round 2"): the sheet
  is one scrolling page with sticky tabs (a phone now shows the section, not the header); request cards are one per
  request with a line per creature, and a one-line strip inside a phone's panel; inventory rows split on a narrow
  page; the cutout keeps both sliders in view and dialogs shade a scrollable edge; touch targets on the request form
  and proposals; the waiting-proposal line; caps digits in the UI face (Cinzel's 1 read as an I), lining figures, one
  select caret; spells rhythm, Cast, abilities table; plates — refused on another token's face, brought down onto
  the free board rather than dropped, under the base when the head is crowded, a leader into the token.
- Found on the way: the plate layout could swap two plates for ever at a far zoom (ordered by where a plate had been
  moved to) — fixed and pinned by the p2-tokens journey; an answered request card's 6-s timer restarted on every
  re-render (never stepped aside on a phone) — counted once now.
- Tests: declutter 13 unit tests (+4: another token's face, under the base, nudged under the base, brought down from
  the top); `visibleTabs` (3); p2-tokens' plate rule restated for the new spots; p6-requests for the grouped card; the
  P6 shots gained step 21 (a request over the board, no panel) and wait for plates to finish fading; all 21 steps
  render at 1440×900, 1024×768 and 390×844. Journeys: p2-tokens (5), p6-sheets (3), p6-requests, p6-phone, p6-art
  pass (p6-art's drawing upload got the sticker's 30-s wait: server-side processing is slow with the suite running).
  `pnpm check`: 430 unit/integration tests pass. Two critic rounds done for P6 (the cap).
- P7 groundwork committed (3e16633): consequences of damage and healing and the death-save machine (pure rules, 8
  tests), the HP / condition / prompt command schemas, the `dm_prompts` table; AC-HP-01 passes (30 table cases).
- Next: P7 server (`hp.apply`, `status.change`, DM prompts, concentration and death-save requests, rests), then its UI.

```
PASSING 113/224 · DISPUTED 0 · FAILING 111
P1 28/28 · P2 32/32 · P3 16/17 · P4 12/12 · P5 9/9 · P6 14/14 · P7 1/17 · P9 1/16
```

## 2026-09-29 — P7: HP, conditions and death — server, UI, journeys

- Server: `hp.apply` / `hp.preview` / `status.change` / `health.consequences`, the DM's prompts (stored), player damage via the
  DM, concentration and death saves as requests with their outcomes, Exhaustion's penalty and condition hints on rolls,
  speed after conditions, custom markers to clients, a token dead only when marked (DECISIONS, 2026-09-29).
- UI: the damage / heal / temp-HP dialog with the server's preview and the DM's decisions; the condition picker (token menu,
  sheet, DM panel → Health); the DM's prompt cards; request cards with hints, auto-fail notes and death-save pips; sheet
  rolls with hints; floating numbers, shake / flash / glow, the fall and sounds; the hover card; the DM panel's Health tab.
- Tests: `health.test.ts` (16 server tests), vision AC-VIS-15, `d20tests.test.ts`, consequences (+3), `HpNumbers.test.ts`,
  rollMode (+2); `p7-health.spec.ts` (2 journeys: the DM's tools; players). p2-tokens' radial expectations now include HP and
  Conditions; p6-sheets adds conditions through the picker. Found on the way: an Unconscious creature didn't lie down; a
  fast first keystroke in the damage dialog could be wiped (each opening is a fresh form now); a selected token kept the
  board rendering flat out (paced now) — under software GL, pages starved each other until dialogs never closed.
- `pnpm check`: 455 tests. Journeys run together (p7-health, p6-sheets, p6-requests, p2-tokens): 11 pass.
- ACs: HP-01/02/03/04/05/06/07/09/10/11/12, TOK-04, TOK-12, VIS-15, DICE-11 pass. Left in P7: HP-13 (rests), DS-03.

## 2026-09-29 — P7 complete (17/17); key screens and own review

- Rests (AC-HP-13) and the icon sheet (AC-DS-03) committed (e093f30): P7 17/17.
- Key screens: `e2e/shots/p7.shots.ts` — 18 screens at 1440 × 900, 1024 × 768 and 390 × 844 (`artifacts/screens/p7/`).
- Own review of them, fixed before the critic (61fa016; DECISIONS 2026-09-29): plates pushed onto their own token's face by a
  card now go under the base; Exhaustion's level in a corner notch on the board and in the DOM (the old digit was 10 px and
  spilled off the tile); the sheet showed conditions only — now Exhaustion, concentration and markers; custom markers drew
  a generic glyph on the board — now their own glyph and colour, the glyph's ink by contrast (bone on Citrine was ~1.2:1),
  and the form's default colour wasn't a palette colour; a two-type hit's numbers ran together ("−6−4"); request cards
  showed "1d20 − 4" under disadvantage (now "2d20kl1 − 4"); the roll feed cut the roller to "Y…"; the DM's Health rows cut
  names to "Mir…"; the hover card sat over its own plate; switches sat low beside one-line labels (every dialog).
- Tests added: `normalizeFormula` (shared), `glyphInk` (every player colour ≥ 3:1), declutter (under the base before
  clamping; the clamp when under the base is taken); journey checks for number spacing, the as-rolled formula, the hover
  card clear of the plate, a custom marker's own atlas cell and ink glyph, the sheet's Exhaustion chip and the plate's notch.
- `pnpm check`: 465 tests. p7-health (3 journeys) and p7-icons (2) pass.
- Next: the visual critic, round 1 (running), its fixes; round 2; then P8 (walls & lights round 2 — AC-WAL-05 first).

## 2026-09-29 — P7 visual critic, rounds 1 and 2; P8 server and groundwork

- Critic round 1 (5/10): fixes committed (a7f7002; DECISIONS). Round 2 (5/10, the last for P7): the board's layout
  rebuilt as one pass that knows every obstacle — plates in four strengths with a compact bar-only form, spots beside a
  token at mid-height, leaders that cross nothing, the visible-fraction rule, toasts as HUD; the HP numbers beside a slim
  bar in bone; floating numbers ≥ 24 px from other plates and ≤ 10 px from their own; one floating card stack (a phone's
  paged, the feed out from behind it; two cards under 1200 px; at the board's foot when its top would bury the creatures
  they're about); toasts under the cards; the hover card weighing plates; dialog scroll edges, "e.g." placeholders, the
  sheet's effective speed, measured DM panel tabs, bevelled bases, the notch inside its badge, Hit Dice left, hyphenated
  names kept whole, Exhaustion in search results, the Concentrate button's height. Two findings kept with reasons (#4,
  #16). DECISIONS 2026-09-29.
- Tests: declutter 21 unit tests (the critic's cases each: a neighbour's footprint, a standee behind a lying creature,
  nearer another creature, a token mostly showing with its centre under the HUD, the compact forms, the geometry);
  `keepHyphenated`; journeys: the P2 overlay layout (tier-0 plates and leaders against every token and plate, four
  views), P6 cards over the board (phone pager and feed, two then more / fewer, a toast under the cards, top vs foot),
  P7 number spacing rules, effective speed, Hit Dice left, Exhaustion in search. `pnpm check`: 512 tests.
- P8 so far: combat rules (12 tests), creature spaces (5), opportunity marks (5), the movement range field (4), the
  combat commands and the room's combat flow wired (e083d2d; 11 integration tests: CMB-01…09/11, MOV-04/05/07/09/16/18,
  HP-08, WAL-05); the client's tracker, Start dialog, DM Combat section, turn controls and keys.
- Next: commit; P8's range overlay (G), turn banner and chime, combat tally, the remaining server tests, the P8 journeys
  and key screens, its critic (≤ 2 rounds), and its ACs marked with evidence.

## 2026-09-29 — P8: combat and movement budgets — 21/21

- Committed: P7 critic round 2 (54f450f); the movement range overlay with its worker, bench part and journey (39d4c7e).
- Now: a turn's start (bell, banner, camera focus setting, the tracker's swell and ring), the combat tally in `hp.apply`,
  "Count as movement" and app-attack pip tests, the P8 journeys — p8-combat (the start dialog, initiative cards and
  hints, the tracker and what players perceive, a turn's start, pips, End turn, the DM's controls and drag to reorder,
  Stop, Quick start; a drag in combat: routed path, verdigris/ember split, the exact reach mark, the label,
  opportunity attacks and Disengaged, bonus movement) and p8-range. Test hooks read the board's drawing buffer.
- ACs: all 21 of P8 pass with evidence (MOV-01/04/05/07/09/10/15/16/18, CMB-01…11, HP-08, WAL-05).
- `pnpm bench`: vision p95 4.5 ms (10), range p95 7.5 ms (30).
- Next: P8 key screens and the visual critic (≤ 2 rounds); then P9.


## 2026-09-29 — P8 visual critic, rounds 1 and 2 (4/10 → 6/10, final round): fixes in; P9 under way

- Round 1's blockers and most majors fixed (tracker fit and "+n", layering of the path past the reach, the feed
  above the action bar, phone menus — a Tooltip that dropped its child's ref —, phone HUD compaction, monograms,
  numbered namesakes, the combat summary, the start dialog, the DM's Combat list). Round 2's: the action bar centred in
  the board's clear width and fitted there in steps (never over the DM panel), the turn banner's settled box as a
  cover, the path past the budget in --path-over with a still hatch (the journey checks stripes, gaps and stillness),
  the start dialog's Surprised column, 12-px monograms from one shared `initialsOf`, "Can't move — Grappled" projected by
  the server and shown in the meter (a stuck drag refused at once, a warning), toasts below whatever HUD is in their
  column, HP numbers on the bar, custom Begin/Stop/boot/range glyphs, the "+n" disc, dead tokens drained to grey, the
  range line smoothed and clipped to reachable ground (unit-tested against the geodesic), Settings' Camera first, the
  phone's newest roll folding to a line, one roll-label grammar. Disputed with reasons (DECISIONS): the focus ring on
  the Settings gear after Escape; Stand up on the phone bar's second row. The 04 shot's plate under the banner was a
  software-GL frame caught mid-glide (instrumented: at rest the plate is below its token) — the shot now waits for the
  glide to settle.
- P9 so far: shared aoe/rules/protocol for spells; the server's casts (slots, areas with a clear line, the resolution
  card per reader, NPC saves, damage and apply with resistances, conditions, concentration with its cleanup in the same
  undo step, triggers as DM cards, effect moves and drift, homebrew and import); the browser's spell browser, cast
  dialog, targeting, resolution cards, homebrew builder, import dialog, effects and VFX layers; slowing effects in both
  movement worlds (Web/Spike Growth difficult, Spirit Guardians' halved Speed as doubled cost, spared creatures).
  Server tests: spells.test.ts (Fireball targets and walls, the views per reader, the DM's add/remove, NPC saves,
  apply with a save and resistance, cancel/undo refunds, rituals, concentration, the web's cost) and spellVision.test.ts
  (Darkness, Fog Cloud, See Invisibility, Faerie Fire in the vision engine). Found and fixed on the way: undoing a cast
  crashed the card push; self-centred areas demanded a placement.
- ACs: AC-VIS-06, AC-VIS-08, AC-SPL-06 marked. PASSING 154/224.
- Next: commit P8 round 2 with the P9 work so far once the P8 journeys and shots pass; then P9's journeys (browser
  filters, a Fireball cast end to end, self spells, the concentration prompt, the 16 effects, 12 VFX presets, the
  homebrew builder, import, a weapon attack, the cover hint), its key screens, critic, rules-auditor and security review.

## 2026-09-29 — P9: spells, effects and VFX — 16/16

- The named effects as SRD 5.2.1 has them (a rules pass: which save when they appear, once a turn, Wall of Fire's
  burning side, Flaming Sphere's sphere and ram, Call Lightning's cloud and strikes, Sleet Storm's lost Concentration,
  Stinking Cloud's end-of-turn Poisoned, Silence's Deafened, dispels ending Concentration); effect handles on the board
  (drag within the caster's reach, Strike again, End), the chip; the targeting bar in the clear area; picks refused
  with their reason (range, total cover); the caster's card says hit or miss; sheet attack ranges ("20/60"); players
  propose homebrew from their sheet; the clouds, Wall of Fire's curtain, a haze for light obscurement, a reworked
  runic ring. Found by the new tests and journeys: an undo crash in the card push, self-centred areas needing a
  placement, the spell list collapsing when its filters opened, the caster unable to roll a hit's damage.
- Tests: server spells (5), spellVision (3), spellEffects (15), homebrew (4), rules units (range parser, castArea,
  halved cost, the drawn range limit); journeys p9-spells (7: browser, Fireball end to end, darts/self/line of
  effect/concentration, attack/cover/card controls, saves/healing/handles, VFX and the 16 effects, builder/import).
- ACs: SPL-02…13, VIS-06/07/08 — P9 16/16. PASSING 166/224. `pnpm check`: 558 tests.
- Next: P9 key screens, the visual critic (≤ 2 rounds), the rules-auditor and security review; then P10.

## 2026-09-29 — P9 reviews: security (4 HIGH, 7 MEDIUM, 9 LOW) and rules audit (1 BLOCKER, 13 IMPORTANT, 13 MINOR) — all fixed

- Security: effects reach a player only where their area meets what they see or have explored, an unseen creature's
  area as a per-viewer stand-in (no id, its centre to the foot), no token ids in public effect props (spared creatures
  on the spared token for its controllers); `spell.cast` checks what it's put on, the scene in play, the area's size,
  free casts; a cast's line only to those who perceive the caster, counting what each perceives; trigger cards name
  only perceived creatures; effect moves by the turn, in range with a clear line; Call Lightning once a turn; the
  import route gated (admitted DM at this sitting, before its 4 MB body is read); card attacks entered by their d20;
  roll labels without names; familiars save on their player's card; bounded proposals and cards; homebrew as
  patches; proposals hold no id; DM-only homebrew; a DM-hidden Silence stays hidden.
- Rules: every attack, ray and dart is its own damage (death saves, massive damage, Concentration saves); attack hints
  from both creatures (and Exhaustion), crits within 5 ft of the Paralyzed, the DM's crit, "max plus a roll"; cover
  counted in hits and Dex saves; incapacitating conditions end Concentration; trigger conditions end with their
  spell; Thunder does nothing in Silence; Light and Darkness dispel both ways; choice, staged and judged conditions;
  next-turn durations; round 3D spheres and emanations; Ice Knife's burst; Light cast from the table; Spirit
  Guardians' designated creatures; the entered damage split by type; rituals at their level.
- VFX: floor pieces follow cones, lines, cubes and walls; Flaming Sphere a burning orb; Wall of Fire as tall as the
  wall, panes for the others; soft clouds; the DM's darkness thinner.
- Tests: spellSecurity (16), spellAudit (10), presets (7), homebrew (+2), conditions/aoe/spellRules units.
  `pnpm check`: 597 tests.
- Next: the P9 journeys and key screens again, the visual critic (≤ 2 rounds); then P10.

## 2026-09-29 — P9 visual critic, round 1 (5/10): fixes in (d6208d7)

- Key screens: 15 steps × 3 viewports; the critic's 30 findings answered (DECISIONS 2026-09-29, "P9 critic round 1"
  and the five entries after it). Its #1 (a leak) checked: not one — a new scene's fog is off; step 10 now runs under
  dynamic fog as evidence.
- Cards, the targeting bar (concentration asked inline, picks counter, ×N badges, touch wording), spell browser,
  homebrew builder (status, VFX from the damage type), import report (Will import, outcomes, plain-words errors),
  plates by zoom, leaders to the rim, VFX fading at the scene's edge, phones (aim framing, 30 % card sheet).
- Found by the full E2E run (53/56 passed): menus closed when their panel scrolled as they opened — a P8 regression
  (p2 Library Rename, p6 Sheet actions); menus now follow their button and close only once it's out of view. The P5
  dice-rest check failed once under the full run's load and passes alone.
- Tests: castHide, aimFrame, rimEntry, zoom-out plates, VFX edge fade (every material), import `spells[]`, the
  Library menu follow/close journey step. `pnpm check`: 607 tests.
- Next: P9 journeys and key screens again, visual critic round 2 (the last), the full E2E run and bench; then P10.

## 2026-09-29 — P10: undo and history — History panel in (a33530a)

- Server: `history.list` / `history.revert` / `history.restore` (DM, dry-run plans), `history.changed` to DMs; an
  entry's scene from its ops when its plan names none.
- DM panel → History: filters (person, kind, scene), one-click Revert (a confirmation only over later changes),
  Restore to here with its list; struck-through undone entries. Journey p10-undo (J8: doubled damage, deleted token,
  fog wipe; redo keys).
- ACs: AC-MOV-06, AC-UNDO-01, -02, -03, -04 passing. AC-UNDO-05 open until emotes and music exist (DECISIONS).
- Open in P10: AC-PER-02 (SIGKILL mid-session), AC-PER-05 (.gloam export/import), AC-PER-06 (banner and resync
  after a server restart), AC-PER-07 (crash recovery end to end). `pnpm check`: 611 tests.
- P9: key screens re-shot (18 steps × 3 viewports, all ran); visual critic round 2 under way; full E2E run under way.

## 2026-09-29 — P9 visual critic round 2 (6/10, the last round): findings to fix (open)

Verified from round 1: typed chips, stepper, disabled Apply, eye-slash DC, cover chip, hints, middots, inline
concentration, darts counter + ×2, Tap wording, storm rim, toggle rows, one scroller, ‹ Results, builder status and
Edit/Preview, import sections, bar-only plates, rim leaders. Open (critic's numbering):
- B1 NPC-cast DM cards lack the DC (08-cover-card ~1005,633; vfx-casts Fireball/Lightning Bolt): always show the DC to the
  DM (eye-slash), "DC — [set]" when the caster has none.
- B2 A "Couldn't cast Web" toast on the board repeats the bar's inline "No clear path there" (web-blocked.png): drop it.
- B3 Toggle thumbs grey (02 ~943,284/343; 12 ~713,397): §28 brass thumb on an ink track.
- I4 Web VFX a white noise slab with hard edges (1024 07): bone strands (radial + chords), soft rim, to the footprint.
- I5 Cloud looks spiky/faceted with a bright outline (10, haze.png): radial alpha falloff, clamp noise contrast.
- I6 Darkness body and the dashed outlines still run onto the table (15, 09, 10): clip/fade them at the bounds too.
- I7 Wall of Fire curtain's hard rectangular foot (09b): fade alpha over its bottom 15 %.
- I8 Nine identical dashed rings (09): tint each outline by its damage-type colour.
- I9 Flaming Sphere drawn over the unseen fog wedge (10): effects under the fog composite; a blacked-out Cantor 3's plate
  still shows (1024 10 ~743,580).
- I10 Phone aim framing frames 150 ft reach > scene (03/06: board 190 px of 844): frame reach ∩ scene into the space
  above the bar, steeper pitch.
- I11 Phone card-sheet handle floats above the sheet (04/05/08/14 ~195,487): inside the sheet's top edge.
- I12 1024: the targeting bar covers the feed header (06/07); phone feed card covers the board: collapse the feed
  while aiming.
- I13 Phone inline concentration ask squeezed (07): stack the buttons full-width under the text.
- I14 Builder: no inline error on the bad field ("8d6 +"); at 1024 "1 problem" scrolls to nothing (box below the
  fold): ember border + message on the field; status scrolls to it.
- I15 Phone import report cut after "Will import" (13): report scrollable/visible above the footer.
- I16 Caster card: rows empty on the right; Hide as a bare X — label it "Hide"; a per-row state.
- I17 Several open cards stack centred, off-screen, dice button over the third (vfx-casts): column, others collapsed.
- I18 Phone cover chip truncates "½ cover · +2…" (14): let it wrap.
- Minor: 01 filigree over the list corners + bottom gap 8 vs 24 px, top fade; "The DM rolled (hidden)"; dagger roll card
  "1d4 + 2 [piercing]" raw bracket → chip; "DEX / save" widow; ×2 badge radius 4 px; "Poison · from the damage";
  builder School/Unit alignment; phone builder status into the footer; phone 11 chip gap, Light handle on the MV rim;
  1024 11 chip over the toolbar/plate, 06 hover card over DA's plate; mono ids in the import report → decide in
  DECISIONS; lasting-effects.png Adept 8's plate over a handle.
- Staging: step 15 not captured (wait for the dialog to settle); step 11 DEX save vs her own storm; Poison Ball text.

Full E2E run (a33530a + rejoin loop): new failures so far p3-movement AC-WAL-03/04 (door handles) and p3-tools
AC-MOV-11/12 — to investigate (possibly the zoom-out plates or the handles' board marks).
Uncommitted: packages/web/src/routes/Table.tsx — the table rejoins with backoff after a lost connection (AC-PER-06
groundwork; its restart test still to write: spawnServer({ dataDir, env: { PORT } }) reuses the port).
- FIRST (Xini's report, 390x844 step 15): the Cast Light dialog is captured see-through over the open Sheet — the sheet's
  rows, the Web row's brass Cast and the dialog's own Cast/Cancel all overlap. At 1440/1024 the same step shows only the
  sheet (the dialog never in the capture). Find out whether the dialog is fading out or closing (a real bug: e.g. the
  dock page or a focus/outside-press closing it when it opens from the sheet on a phone) or only caught mid-fade
  (motion's JS animations escape the shot's document.getAnimations() wait). Fix the cause, make the shot wait for the
  dialog's computed opacity to reach 1, and add a journey assertion that the dialog stays open and opaque.
- Done for Xini's report (uncommitted, not yet re-shot): the cast dialog is owned by the table screen
  (`useCastRequest` + `CastDialogHost` in routes/Table.tsx) instead of the sheet's Spells section, whose mount on a
  phone's one-page sheet can come and go; step 15 now waits for the dialog to be fully opaque and still open 600 ms
  later. Next: re-run `pnpm shots e2e/shots/p9.shots.ts` after the full E2E run and look at 15-light-dialog at all three
  viewports; add a journey assertion (the dialog stays open while the sheet scrolls).
- Full E2E run (in progress when written): failures p3-movement AC-WAL-03/04, p3-tools AC-MOV-11/12, p5-dice rest —
  p5 failed in two full runs now (passes alone): treat as a real load-sensitive issue, not a flake.
- Full E2E run finished: 54 passed, 3 failed (33.4 min) — p3-movement AC-WAL-03/04 (door handles), p3-tools
  AC-MOV-11/12, p5-dice rest (third full-run failure). Next: investigate each from artifacts/logs/e2e-all.log and its
  traces (likely suspects: the zoom-out compact plates and the effect handles' board marks from d6208d7), then re-run
  the P9 shots for step 15, commit, rerun everything, bench.

## 2026-09-29 — P10: persistence and recovery (PER-02, -05, -06, -07 passing)

- `.gloam` export/import (gloamZip.ts, gloamPort.ts, routes/gloam.ts; tests gloamZip.test.ts, gloamPort.test.ts): a
  fresh install imports row for row with new ids; tampered files, unsafe paths and fake assets refused, nothing left.
- Admin → Saves page: snapshots, move a campaign, backups.
- Recovery: test hooks `blackout`/`kill`/`restart`; journey p10-recovery (70 s outage: banners on both screens, no
  reload, live again; SIGKILL mid-session: board, combat, effects, fog intact; old code refused; session 1 "ended
  unexpectedly"; returning player by PIN gets the same character, sheet, place and dice).
- Real bugs found by them: session number reused after a crash (whole-row writes → changed columns only); a returning
  player's sheet never arriving (per-kind event replay + `sheets.sync`); toasts stacking over the board; the first
  load crash from a replayed "left" event.
- `cast.setDc` (DM sets an NPC card's DC; rolled saves re-judged, hand verdicts kept).
- Open: AC-UNDO-05 (emotes and music, later phase); P10 key screens + visual critic for Saves and History; full E2E run
  (p3-tools ERR_NO_BUFFER_SPACE source, p4-light-fog timing); P9 round-2 leftovers (effects over unseen fog in the
  player view, blacked-out token plates); SPEC §24.9 `compileAsync` warm-up.
