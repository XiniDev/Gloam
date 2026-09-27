# Phase 0 integration spikes — findings (builder)

Run on 2026-09-27, Windows 11, Node 22.18.0 (system) with the workspace installed by pnpm 12.6.0. Spike code
lived in `packages/server/spikes/` and `packages/web/spikes/` (inside the packages so it resolves their
dependencies without a throwaway workspace package) and is deleted at the end of Phase 0. These findings are
also copied into `docs/research/stack.md` § "Spike findings (builder)".

## S1 — Colyseus 0.18 + Express 5 + Vite middleware on one origin — PASS

- `defineServer({ transport: new WebSocketTransport({ maxPayload }), rooms: { x: defineRoom(Room) }, express: (app) => … , greet: false })`
  then `await server.listen(port, "127.0.0.1")` works; the `express` callback receives an Express 5 app and
  Vite's `createServer({ server: { middlewareMode: true, hmr: { port } }, appType: "spa" })` middlewares mount
  on it. One origin for REST, WebSocket and the SPA.
- `matchMaker.controller.exposedMethods = ["joinById", "reconnect"]` and `matchMaker.createRoom(name, {})`
  work; `this.roomId = "<fixed>"` inside `onCreate` sets the id; `this.autoDispose = false` keeps it alive.
- `static onAuth(token, options, context)`: `context.headers` is a WHATWG `Headers`; the `gloam_sid` cookie
  set by a REST response **is** sent by real Chromium with the SDK's matchmaking request (the SDK uses
  `credentials: "include"`). `context.ip` was `undefined` for a direct loopback connection — Colyseus derives
  `ip` from proxy headers when present, so Gloam must compute the client IP itself (AC-AUTH-01 rule) from the
  raw socket + `cf-connecting-ip`, never trust `context.ip`.
- The value returned by `onAuth` becomes `client.auth`.
- **Request/response exists**: server `messages = { name: (client, payload, ctx) => value }` — returning a
  value resolves the client's `await room.request(name, payload)`; `return ctx.reject(reason)` rejects it.
  Client error: `err.name === "rejected"`, `err.reason` = the reason object (e.g. `{ code, message }`).
- `StateView`: `client.view = new StateView()` in `onJoin`; `view.add(item)` makes a `.view()` map item appear
  without tagged fields (`hp` undefined on the client); `view.add(item, TAG)` later delivers the tagged field;
  `view.remove(item)` fires `onRemove` on the client; updates to tagged fields stream afterwards.
- Client: `Callbacks.get(room)` with `onAdd("items", (item, key) => …)`, `listen(item, "hp", cb)`,
  `onRemove(...)` all work; `client.joinById(id, {}, RootSchemaClass)` gives typed state.
- Zero requests left the origin.

## S2 — R3F at the pinned versions, render-target composite, local font — PASS

- React 19.3 + R3F 9.8.1 + drei 10.7.9 + three 0.186.1 render in Chromium. `useFBO` render target filled
  from a portal scene in a `useFrame(…, -1)` pass and sampled in a `ShaderMaterial` on the map plane gives the
  fog pattern (mask reveals the map, elsewhere a fog colour). Screenshot: artifacts/logs/s2.png (not
  committed).
- drei `<Text font={url}>` with `import url from "@fontsource/cinzel/files/cinzel-latin-600-normal.woff?url"`
  renders Cinzel with **no** CDN request (zero off-origin requests in the network log).
- `gl.compileAsync` exists (for the shader warm-up in §24.7).
- Harmless warning: `THREE.Clock: This module has been deprecated` (from R3F internals).
- `preserveDrawingBuffer: true` needed for canvas screenshots (G9 confirmed).

## S3 — Rapier deterministic-compat in a Web Worker in a Vite production build — PASS

- `import RAPIER from "@dimforge/rapier3d-deterministic-compat"; await RAPIER.init()` inside a module worker
  created with `new Worker(new URL("./physics.worker.ts", import.meta.url), { type: "module" })`; the
  production build emits the worker as its own 4.37 MB chunk (WASM inlined as base64 → needs
  `'wasm-unsafe-eval'` in CSP, which §22.4 has).
- Same seed on two separate page loads → byte-identical recorded frames (SHA-256 of the Float32Array equal).
- API: `new RAPIER.World({x,y,z})`, `world.timestep = 1/120`, `ColliderDesc.cuboid/convexHull(Float32Array)`,
  `.setRestitution/.setFriction/.setDensity/.setActiveEvents(ActiveEvents.CONTACT_FORCE_EVENTS)
  .setContactForceEventThreshold`, `RigidBodyDesc.dynamic().setTranslation/.setRotation/.setLinvel/.setAngvel
  /.setLinearDamping/.setAngularDamping/.setCanSleep`, `world.step(eventQueue)`,
  `eventQueue.drainContactForceEvents(cb)`, `body.isSleeping()`.
- Symmetry remap: the rotation group computed as "all rotations mapping a reference (face, neighbour-face)
  frame onto every congruent frame that preserve the vertex set" has exactly 60 elements for the d20 (the
  same group the spec's generator-closure yields); for every desired face j there is S with S·n_j = n_landed
  and rendering `q_body·S` puts face j on top (checked for all 20 faces).
- Timing: one d20 slept after 138 steps (1.15 s simulated) — throw speeds need tuning into the 1.2–2.5 s
  window; the simulation loop took ~80 ms in headless Chromium for one die with naive `Array.push`
  recording → preallocate the Float32Array and measure the 10-dice budget (§37: < 60 ms) in the real worker.

## S4 — Asset processor in a forked child under pnpm 12 — PASS

- `fork(url-of-child.ts, [], { execArgv: ["--max-old-space-size=768", "--disable-warning=ExperimentalWarning"] })`
  runs a type-stripped TS child; IPC messages both ways.
- sharp 0.35.4 (`failOn: "error"`, `limitInputPixels`, `.rotate()`, WebP), file-type 22 `fileTypeFromBuffer`,
  gltf-validator `validateBytes(bytes, { format: "glb", maxIssues: 100, writeTimestamp: false })` →
  `report.issues.numErrors`, gltf-transform 4.5 `NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder", "meshopt.encoder", "draco3d.decoder":
  await draco3dgltf.createDecoderModule() })`, `readBinary`, `prune/dedup/weld/textureCompress({ encoder: sharp,
  targetFormat: "webp", resize })/meshopt({ encoder: MeshoptEncoder, level: "medium" })`, `writeBinary`,
  re-validation with 0 errors — all work.
- A Draco-compressed GLB is decoded server-side and re-encoded with meshopt (output uses only
  `KHR_mesh_quantization` + `EXT_meshopt_compression`).
- A zip renamed to `.glb` is detected as `application/zip` and the validator reports `GLB_INVALID_MAGIC`.
- A hung job hits the parent's timeout, the child is killed with SIGKILL and a fresh child serves the next job.
- gltf-transform logs to stdout by default ("prune: Removed types…") → set a silent `Logger` on the IO/document.
- Peak child RSS for these small jobs: 86 MB.

## S5 — better-sqlite3 + Drizzle migrations under type stripping; online backup — PASS

- `drizzle-kit generate --config <ts config>` works (it bundles its own TS loader via esbuild, allowed in
  `allowBuilds`).
- `drizzle(new Database(path))` + `migrate(db, { migrationsFolder })` from `drizzle-orm/better-sqlite3/migrator`
  run under Node's type stripping.
- Pragmas apply: `journal_mode` → `wal`, `synchronous` → `2` (FULL), `foreign_keys`, `busy_timeout`,
  `temp_store`.
- `await sqlite.backup(dest, { progress: () => 50 })` completes while the same process keeps writing (1 250
  rows written during a 2.1 s backup of a 4.7 MB database) and the backup is consistent.

## S6 — Tunnel manager against a fake cloudflared — PASS (no real binary on this machine)

- Fixture: `packages/server/src/test/fixtures/fake-cloudflared.mjs` (kept: it is the test double required by
  §36.2). It prints the quick-tunnel banner to stderr, serves `/quicktunnel` (`{"hostname": …}`) and `/ready`
  (503 → 200) on the `--metrics` port, supports `--version`, `tunnel run` with `TUNNEL_TOKEN`, crash
  injection and an argv log.
- Spawning with fixed args (`spawn(file, args, { shell: false, windowsHide: true })`), polling `/quicktunnel`
  with the stderr regex as fallback, then polling `/ready`: hostname + ready in ~0.8 s.
- **Windows:** `child.kill("SIGTERM")` is an immediate TerminateProcess (exit code `null`); the "SIGTERM, then
  SIGKILL after 5 s" sequence degenerates to one step on Windows. Spawning a `.cmd`/`.bat` without a shell is
  refused by Node (CVE-2024-27980 hardening), so the manager takes `{ file, args }` and tests launch the
  fixture as `process.execPath fake-cloudflared.mjs …`; real `cloudflared.exe` resolves through PATH.
- `cloudflared` is not installed on this host, so the optional real run was skipped (opening a public tunnel
  is an outward-facing action the host hasn't asked for yet).
