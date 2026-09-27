# Stack verification (Phase 0 · R3)

Verified 2026-09-27 against SPEC §9 (every row, G1–G11), §11, §13.2/13.3/13.6, §18.4, §21, §22.4, §23.3, §24, §25.2, §26.

**Method.** Read each package's shipped source, types, README and changelog in the repo's pnpm store (read only). Ran minimal scripts on **Node 22.18.0** and **Node 24.21.0** in scratch dirs outside the repo (`%TEMP%\gloam-r3\{colyseus,forkA,forkB,forkC,forkD}`, installed with npm, exact versions). Browser behaviour was checked in Playwright 1.63's Chromium 1243, serving the §22.4 production CSP. Where something was checked only from source or types, the text says so.

**Path aliases** used in the citations:
- `NM` = `D:\Github\Gloam\node_modules\.pnpm`
- `CORE` = `NM\@colyseus+core@0.18.17_…\node_modules\@colyseus\core\src`
- `WST` = `NM\@colyseus+ws-transport@0.18_…\node_modules\@colyseus\ws-transport\src`
- `TOOLS` = `NM\@colyseus+tools@0.18.4_…\node_modules\@colyseus\tools\src`
- `SDK` = `NM\@colyseus+sdk@0.18.4_…\node_modules\@colyseus\sdk\src`
- `SCH` = `NM\@colyseus+schema@5.0.34_…\node_modules\@colyseus\schema\src`

---

## 1. Version table

Every spec version is the current npm `latest` (from `npm view <pkg> dist-tags` on 2026-09-27), with two exceptions: a patch release came out today, and one package has a newer major that the spec deliberately excludes.

| Package | Spec | npm latest | Note |
|---|---|---|---|
| Node.js | 24 LTS (24.21.x) | — | Host runs 22.18.0; `engines >=22.18` is already in DECISIONS. Both versions were verified. |
| pnpm | 12.6.0 | 12.6.0 | `next` is 12.7.0 |
| typescript | 7.0.2 | 7.0.2 | |
| vite | 8.3.1 | 8.3.1 | |
| @vitejs/plugin-react | latest for Vite 8 | 6.1.1 | Babel is gone; uses oxc |
| @biomejs/biome | 2.5.14 | 2.5.14 | |
| vitest | 5.0.2 | 5.0.2 | |
| @playwright/test | 1.63.0 | 1.63.0 | Chromium 1243 is already installed |
| @axe-core/playwright | (add) | 4.13.0 | |
| react, react-dom | ~19.3.0 | 19.3.0 | R3F peer `>=19 <19.4` |
| three / @types/three | ~0.186.1 / 0.186.0 | 0.186.1 / 0.186.0 | postprocessing peer `<0.187` |
| @react-three/fiber | 9.8.1 | 9.8.1 | |
| @react-three/drei | 10.7.9 | 10.7.9 | |
| postprocessing | 6.39.5 | 6.39.5 | |
| @react-three/postprocessing | 3.1.2 | **3.1.3** | 3.1.3 was published 2026-09-27 10:39 UTC. pnpm's `minimumReleaseAge` blocks it for 24 h. Peers are unchanged. **Keep 3.1.2.** |
| @dimforge/rapier3d-deterministic-compat | 0.21.0 | 0.21.0 | |
| three-mesh-bvh | 0.9.15 | 0.9.15 | drei also pulls 0.8.3 transitively |
| troika-three-text | 0.52.5 | 0.52.5 | |
| zustand | 5.0.15 | 5.0.15 | |
| @tanstack/react-query | 5.104.0 | 5.104.0 | |
| zod | 4.6.5 | 4.6.5 | Single copy in the lockfile |
| motion | 13.4.4 | 13.4.4 | |
| tailwindcss, @tailwindcss/vite | 4.3.3 | 4.3.3 | |
| @use-gesture/react | 10.3.1 | 10.3.1 | Last published 2024-03, but works on React 19.3 |
| @colyseus/sdk | 0.18.4 | 0.18.4 | |
| @colyseus/react | 0.18.2 | 0.18.2 | Optional; not used |
| zzfx | 1.3.2 | 1.3.2 | See deviation 45 |
| react-router | latest 7.x | 7.18.4 (latest is 8.4.0) | Stays on 7.x per spec |
| react-markdown / remark-gfm / lucide-react | latest | 10.1.0 / 4.0.1 / 1.48.0 | |
| @fontsource* (4 packages) | 5.3.0 | 5.3.0 | |
| @colyseus/core | 0.18.17 | 0.18.17 | |
| @colyseus/ws-transport | 0.18.x | 0.18.4 | |
| @colyseus/tools | 0.18.4 | 0.18.4 | **Recommend removing it** (deviation 5) |
| @colyseus/schema | 5.0.34 | 5.0.34 | |
| express | 5.2.1 | 5.2.1 | |
| helmet | 8.3.0 | 8.3.0 | |
| pino / pino-pretty | 10.3.1 / — | 10.3.1 / 13.1.3 | |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | 0.45.3 / 0.31.11 | 1.0 is still in rc |
| better-sqlite3 | 13.0.3 | 13.0.3 | Bundles SQLite 3.53.4 |
| @node-rs/argon2 | 2.2.1 | 2.2.1 | |
| sharp | 0.35.4 | 0.35.4 | |
| file-type | 22.1.1 | 22.1.1 | |
| gltf-validator | 2.0.0-dev.3.10 | 2.0.0-dev.3.10 | |
| draco3dgltf | latest | 1.5.7 | |
| @gltf-transform/* | 4.5.0 | 4.5.0 | |
| meshoptimizer | 1.3.0 | 1.3.0 | |
| busboy / fflate | latest | 1.6.0 / 0.8.3 | |
| nanoid / p-limit | 6.0.1 / 7.3.3 | 6.0.1 / 7.3.3 | |
| @modelcontextprotocol/server, /client | 2.1.0 | 2.1.0 | Both depend on `@modelcontextprotocol/core@2.1.0` |

---

## 2. Verified, by area

### 2.1 Colyseus 0.18 server (`@colyseus/core` 0.18.17, `@colyseus/ws-transport` 0.18.4)

End-to-end test (`%TEMP%\gloam-r3\colyseus\client.ts` + `server.ts`): identical results on Node 22.18 and 24.21. The server was also driven from Chromium, both with the SDK's UMD bundle and with a Vite 8 ESM build that used the shared schema classes.

**Bootstrap (verified):**

```ts
import { defineServer, defineRoom, matchMaker, ServerError, type AuthContext } from "@colyseus/core";
import { StateView } from "@colyseus/schema";              // NOT exported by @colyseus/core
import { WebSocketTransport } from "@colyseus/ws-transport";

// before listen():
matchMaker.controller.DEFAULT_CORS_HEADERS = {} as never;  // stops Origin reflection on EVERY response (deviation 1)
matchMaker.controller.getCorsHeaders = () => ({});
matchMaker.controller.exposedMethods = ["joinById", "reconnect"];

const server = defineServer({
  transport: new WebSocketTransport({
    maxPayload: 256 * 1024,                                 // default is 4 KB (WST\WebSocketTransport.ts:97)
    beforeUpgrade: (_req, ctx) => (isSameOrigin(ctx.headers) ? undefined : new Response(null, { status: 403 })),
  }),
  rooms: { lobby: defineRoom(LobbyRoom), table: defineRoom(TableRoom) },
  express: async (app) => { await buildHttpApp(app); },     // app = express() created by ws-transport; Express 5.2.1 in this repo
  greet: false,                                             // no Colyseus banner
  gracefullyShutdown: false,                                // no Colyseus SIGINT/SIGTERM/uncaughtException → process.exit
  logger: log.child({ mod: "colyseus" }),                   // any {debug,info,warn,error,trace}; default is console (not run with pino)
});
await server.listen(config.port, config.host);              // Server.listen(port, hostname?, backlog?, cb?)
await matchMaker.createRoom("lobby", {});
if (!matchMaker.getLocalRoomById(campaignId)) await matchMaker.createRoom("table", { campaignId });
```

**What each part of the bootstrap does:**
- **`defineServer` options.** `express?: (app) => Promise<void>|void`, `greet`, `gracefullyShutdown`, `logger`, `transport`, and `rooms` (a record of `defineRoom(Klass, defaults?)`). Source: `CORE\Server.ts:22-100, 667-699`.
- **When the `express` callback runs.** It is awaited during `listen()`, so an async Vite `createServer` inside it is fine (`CORE\Server.ts:472-489`).
- **Routing order: Colyseus first, Express second.** `/matchmake/:method/:roomName` and `/__healthcheck` are served by Colyseus's own router. Everything else goes to the Express app (`CORE\router\index.ts:78-90`).
- **CORS headers on every response.** A listener registered with `prependListener('request')` adds CORS headers to every response and answers every `OPTIONS` with 204 before Express sees it (`CORE\router\index.ts:98-113`).
- **Fixed room ids.** Set `this.roomId = options.campaignId` in `onCreate`; the setter is allowed only during creation (`CORE\Room.ts:614`).
  - Room ids must match `[A-Za-z0-9_-]+`, because that is the WebSocket path regex (`WST\WebSocketTransport.ts:287`).
  - A room id containing `.` is created fine, but clients can never connect to it (verified).
- **`autoDispose = false`** is a plain class field (`CORE\Room.ts:270`). Verified: the room survives every client leaving.
- **`matchMaker.controller.exposedMethods`** is a plain array (`CORE\matchmaker\controller.ts:22`). Verified: `POST /matchmake/create/table` returned 520 `invalid method "create"`.

**Authentication (verified; `onAuth` is static and called during the HTTP matchmaking request):**

```ts
static async onAuth(_token: string | undefined, _options: unknown, context: AuthContext) {
  if (!isSameOrigin(context.headers)) throw new ServerError(403, "FORBIDDEN");   // Express guards don't run here
  const sid = parseCookie(context.headers.get("cookie") ?? "")["gloam_sid"];
  const session = sid ? await sessions.verify(sid) : undefined;
  if (!session) throw new ServerError(401, "UNAUTHENTICATED");                    // client gets MatchMakeError{code:401}
  return { userId: session.userId, authSessionId: session.id, role: resolveRole(session) }; // never a key named `sessionId`
}
```

- **The `AuthContext` shape** is `{ token?: string; ip: string | undefined; headers: Headers; req?: Request }`, where `req` is the Fetch `Request` of the matchmaking POST (`CORE\Transport.ts:168-175`, `CORE\router\default_routes.ts:23`).
- **Where `ip` comes from.** `ip` is the first of `x-real-ip`, `x-forwarded-for` and `x-client-ip`, falling back to the socket address (`CORE\Transport.ts:156-166`).
  - On the matchmaking request no socket address is passed at all, so `ip` is either `undefined` or whatever header the client sent.
  - Verified: sending `x-forwarded-for: 6.6.6.6` made `context.ip` equal `"6.6.6.6"`.
- **Return value → `client.auth`.** The value returned becomes `client.auth`. Returning `false`, `null` or `undefined` means `AUTH_FAILED` (`CORE\MatchMaker.ts:1075-1104`).
- **A returned `sessionId` field becomes the Colyseus `client.sessionId`** (`reserveSeatFor`: `authData?.sessionId || generateId()`, `CORE\MatchMaker.ts:955`).
  - Verified: two clients received the same sessionId.
  - After renaming the field to `authSessionId`, the sessionId became random (`2CsCWt2ob`).
- **`onAuth` does not run on reconnect.** It runs for `joinById`, but reconnection uses the reconnection token only (`CORE\MatchMaker.ts:272-300`).
- **Cookies from a real browser (§13.2's open question): confirmed in Chromium.** An `HttpOnly; SameSite=Lax` cookie, set by a same-origin page, arrived on both the matchmaking POST and the WebSocket upgrade.
  - `Origin` was present on both.
  - The SDK sends `credentials: "include"` by default (`SDK\HTTP.ts:511`), and the browser attaches cookies to same-origin WebSocket handshakes.
  - **No join ticket is needed.**

**Room lifecycle (verified):**

```ts
onJoin(client: Client) { client.view = new StateView(); client.view.add(token); client.view.add(token, TAG_HP | TAG_DM); }
async onDrop(client: Client, code?: number) {            // non-consented close (1006, 4002, 1009…)
  try { await this.allowReconnection(client, 20); } catch { /* window expired → onLeave follows */ }
}
onReconnect(client: Client) { /* same Client: client.view and client.auth are preserved (CORE\Room.ts:1978) — re-check session revocation here */ }
onLeave(client: Client, code?: number) { client.view?.dispose(); }   // core never disposes views
```

**Request/response: `room.request()` exists in 0.18** (https://docs.colyseus.io/room#responding-to-a-message-requestresponse; `CORE\RoomMessages.ts:215-290`; `SDK\Room.ts:321-356`). Verified outcomes:

```ts
// server: an ordinary onMessage handler; its return value (or awaited Promise) is the response
this.onMessage("dice.roll", async (client, raw, ctx) => {
  const p = DiceRollReq.safeParse(raw);
  if (!p.success) return ctx.reject({ code: "INVALID", message: p.error.issues[0]?.message });
  return rollDice(client.auth, p.data);
});
// client
try { const res = await room.request("dice.roll", { formula: "1d20+5" }, { timeout: 8000 }); }
catch (e: any) { if (e.name === "rejected") showToast(e.reason.code); else /* fault | timeout | closed */ }
```

| Server handler does | Client promise |
|---|---|
| returns a value, or a Promise | resolves with the value |
| `ctx.reject(reason)` | rejects with `Error{ name: "rejected", reason }` |
| throws | rejects with `Error{ name, message, code? }`. A non-`ServerError` stack trace is logged at error level (`CORE\Debug.ts:29-37`). |
| no handler registered | rejects with `Error{ name: "no_handler" }` |
| no reply within the timeout (default 10 s, `SDK\Room.ts:97`) | rejects "timed out" |
| socket closes first | rejects "connection closed before a response was received." |
| called while the socket is not open | rejects immediately (`SDK\Room.ts:333`) |

**Other behaviour verified in the run:**
- **Validators passed to `onMessage`.** When a zod/StandardSchema validator is given as `onMessage(type, schema, handler)`:
  - An invalid fire-and-forget message disconnects the client with `client.leave(4002)`. The client sees `onLeave(4002)`.
  - An invalid request replies ERROR, with the full zod issue JSON as the message.
  - Either way the full stack is printed (`CORE\RoomMessages.ts:194-195, 234-238`).
- **Unknown message types.** In production (non-dev mode) an unknown message type also disconnects the client (`CORE\RoomMessages.ts:334-341`).
- **Oversized frames.** A 300 KB frame against `maxPayload` 256 KB closes the socket with 1009.
- **Built-in rate limit.** `maxMessagesPerSecond` (default ∞) disconnects the client when exceeded (`CORE\Room.ts:327`).
- **Creating a room whose fixed `roomId` already exists** silently returns the existing room. `onCreate` still runs, on an instance that is then discarded (`CORE\MatchMaker.ts:668-672`). Verified: `creates=2`, one room.
- **Recreating after a close.** `await matchMaker.getLocalRoomById(id).disconnect()` disposes the room, and it can then be recreated with the same id (verified).
- **Colyseus's own shutdown handler (default on).** Unless `gracefullyShutdown: false` is set, Colyseus registers `SIGINT`/`SIGTERM`/`SIGUSR2` and `uncaughtException` handlers that call `process.exit` (`CORE\Server.ts:180`, `CORE\utils\Utils.ts:75-86`).
  - With it off, `await server.gracefullyShutdown(false)` locks the rooms, calls each room's `onBeforeShutdown()` (which by default disconnects everyone), waits for disposal, then closes the transport and HTTP server (`CORE\Server.ts:387-414`).
- **WebSocket upgrades on the HTTP server.** The ws-transport takes every `upgrade` event on its HTTP server, with no filter (`WST\WebSocketTransport.ts:207-245`). Vite HMR therefore has to stay on its own port.

### 2.2 `@colyseus/sdk` 0.18.4 (client)

```ts
import { Client, Callbacks } from "@colyseus/sdk";
import { Table } from "@gloam/shared/state";
const client = new Client(window.location.origin);            // wss when https (SDK\Client.ts:477)
const room = await client.joinById(campaignId, {}, Table);     // 3rd arg = root schema class → room.state instanceof Table (verified)
const cb = Callbacks.get<InstanceType<typeof Table>>(room);    // explicit generic: inference yields `unknown` under TS 7 (verified)
cb.onAdd("tokens", (tok, id) => {                              // fires for existing items too
  cb.listen(tok, "hpFrac", (cur, prev) => …);
  cb.listen(tok, "hp", (ref) => …);                            // tagged ref appears/disappears as tags are granted/revoked
  cb.onChange(tok.pos, () => …);                               // fires when x/y change on this V2 instance
});
cb.onRemove("tokens", (_tok, id) => …);
room.onStateChange(() => commitBatchedStoreWrites());
room.onDrop((code, reason) => …); room.onReconnect(() => …); room.onLeave((code, reason) => …);
```

- **Callback signatures.** `listen(instance, prop, (cur, prev) => …, immediate = true)`; `onAdd`/`onRemove(prop | instance, prop, (value, key) => …)`; `onChange(instance, () => …)` (`SCH\decoder\strategy\Callbacks.ts:122-300`). Call `Callbacks.get` once per room: each call rebinds `decoder.triggerChanges`.
- **Verified event order:**
  - initial `add t1`
  - grant `TAG_HP` → `listen hp ref=7`
  - move → `onChange pos` and `listen hpFrac`
  - revoke `TAG_HP` → `listen hp ref=undef`
  - `view.remove(token)` → `remove t1`
  - `view.add(token)` → a new `add t1`, delivered as a new object
- **Automatic reconnection.** It triggers only on close codes 1001, 1005, 1006 and 4010; any other code goes to `onLeave` (`SDK\Room.ts:166-176`).
  - Defaults: 15 retries, 100 ms–5 s backoff, and `minUptime` 5000 ms, meaning a room joined less than 5 s ago won't auto-reconnect (`SDK\Reconnection.ts:70-80`).
  - Verified: after a server-side `terminate()` the client got `onDrop(1006)` → `onReconnect`, and later requests worked.
- **Messages sent while reconnecting.** `room.send()` during a reconnect is buffered (max 10) and flushed once reconnected (`SDK\Reconnection.ts:78`, `SDK\Room.ts:300`).
- **Browser build.** The ESM build statically imports `ws` (`SDK\transport\WebSocketTransport.ts:1`). Vite resolves that to `ws`'s browser stub, which is never called because `globalThis.WebSocket` exists.
  - Verified: a Vite 8 build of 171 kB ran in Chromium, with the `Table` state and shared classes decoded and no errors.
  - Don't use `dist/colyseus.js`: it bundles `@colyseus/schema` 5.0.8.

### 2.3 `@colyseus/schema` 5.0.34

- **`schema()` builder.** `schema(fieldsAndMethods, name?, inherits?)`; exported `t.*`: `string number boolean int8 uint8 int16 uint16 int32 uint32 int64 uint64 float32 float64 bigint64 biguint64 ref array map set collection stream quantized angle` (`SCH\types\builder.ts:415-465`).
  - Modifiers: `.view(tag?)`, `.default(v | () => v)`, `.optional()`, `.noSync()`, `.unreliable()`, `.patchOnly()`, `.fullStateOnly()`, `.deprecated()`.
  - A bare Schema class as a field (`pos: V2`) is shorthand for `t.ref(V2)`. Methods written inline (`label() {…}`) survive onto the client-side instances (verified).
  - Collections take a class or a primitive type name: `t.array("string")`. Passing a builder, as in `t.array(t.string())`, throws.
- **Field limit is 63** (`MAX_FIELDS = 63`, index 63 reserved; `SCH\Metadata.ts:18`). Verified: 63 fields OK; 64 throws; 63 inherited + 1 via `.extend()` throws.
- **`.extend({...}, "Name")`** keeps the subclass type on the client (verified).
  - A plain `class Sub extends Token {}` prints `Class "Sub" is not registered on TypeRegistry` and arrives on the client as `Token` (G5 confirmed).
- **`StateView`** comes from `@colyseus/schema` (`SCH\index.ts`).
  - `add(obj, tag = DEFAULT_VIEW_TAG)` and `remove(obj, tag?)`.
  - Custom tags are bit masks, and `add(x, TAG_HP | TAG_DM)` grants both (verified).
  - Adding an object that isn't attached to the state is refused (`SCH\encoder\StateView.ts:342`).
  - Call `dispose()` on final leave (`:169`). Otherwise the view's slot is only reclaimed at GC.
- **G4 refined.** If the client passes the root class to `joinById`, `.view()` collections exist client-side as empty placeholders, not `undefined`: the class constructor pre-instantiates them.
  - Verified: a player with nothing from `walls` in view got an empty `MapSchema`.
  - They are `undefined` only for reflection-decoded state (no root class).
  - `Callbacks.onAdd` waits for the server's real collection (`Callbacks.ts:87-116`), so never hold on to `room.state.tokens` references.
- **Typing.** The constructor's init-props type requires every field that has no `.default()`. So `new Token({ id, name })` fails `tsc` unless the other primitives have `.default(…)`.

### 2.4 zod 4.6.5

- **`z.toJSONSchema(s, { target, io })`.** `target` is one of `"draft-2020-12"` (default), `"draft-07"`, `"draft-04"` or `"openapi-3.0"`. Any other string is accepted without error and simply drops `$schema`. `io` defaults to `"output"` (`NM\zod@4.6.5\…\v4\core\to-json-schema.d.ts:24-42`).
- **What it emits:**
  - A `.strict()` object gives `additionalProperties:false` in both modes.
  - A plain `z.object` gives `additionalProperties:false` only with `io:"output"`, even though parsing strips unknown keys.
  - `.default()` fields are `required` with `io:"output"` and optional with `io:"input"`.
  - `discriminatedUnion` becomes `oneOf` with a `const` discriminator.
  - `.meta({ id })` puts the schema in `$defs`.
- **`.strict()` is not deprecated.** Its JSDoc suggests `z.strictObject`. `.passthrough()` and `.merge()` are the deprecated ones (`v4\classic\schemas.d.ts:494-499`).
- Verified snippet: `z.toJSONSchema(SpellImport /* z.strictObject */, { target: "draft-2020-12", io: "input" })`.

### 2.5 drizzle-orm 0.45.3, better-sqlite3 13.0.3, drizzle-kit 0.31.11

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";   // synchronous, returns void
const sqlite = new Database(file); sqlite.pragma("journal_mode = WAL");
const db = drizzle({ client: sqlite, schema });                    // drizzle(sqlite) also works
sqlite.pragma("foreign_keys = OFF");                               // deviation 18
migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
if (sqlite.pragma("foreign_key_check").length) throw new Error("FK violations after migrate");
sqlite.pragma("foreign_keys = ON");
```

- **Runtime.** Verified on both Node versions: migrate, CRUD, `db.query.*.findFirst().sync()`, synchronous transactions and `sqlite.backup()`. `db.transaction(async …)` throws "Transaction function cannot return a promise".
- **Migration bookkeeping.** The migrator keeps `__drizzle_migrations(id, hash, created_at)` and runs every folder newer than the latest `created_at`, all in one transaction (`NM\drizzle-orm@0.45.3_…\sqlite-core\dialect.js:643-676`). There is no "pending?" API; the helper is in deviation 19.
- **drizzle-kit config** (verified; `.ts` imports inside the schema work, and drizzle-kit ships its own esbuild/tsx):
  ```ts
  export default defineConfig({ dialect: "sqlite", schema: "packages/server/src/db/schema.ts", out: "packages/server/drizzle" });
  ```
  - Paths are relative to the current directory, not the config file, and absolute Windows paths fail.
- **Table rebuilds** are emitted as `PRAGMA foreign_keys=OFF; …; PRAGMA foreign_keys=ON`, and SQLite ignores those pragmas inside the migrator's transaction.
- **Audit noise.** drizzle-kit pulls in `@esbuild-kit/*` and esbuild 0.18.20. This is dev-only; `pnpm audit` may flag GHSA-67mh-4wv8-2f99.

### 2.6 MCP 2.1.0 (`@modelcontextprotocol/server`, `/client`)

Verified end to end on both Node versions: the client spawned `node server.ts`, which ran via type stripping.

```ts
// packages/mcp/src/index.ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
serveStdio(() => {
  const server = new McpServer({ name: "gloam", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.registerTool("search_spells", {
    description: "Search spells",
    inputSchema: z.strictObject({ query: z.string().max(100).optional(), level: z.number().int().min(0).max(9).optional() }),
  }, async ({ query, level }) => ({ content: [{ type: "text", text: JSON.stringify(await api.searchSpells(query, level)) }] }));
  return server;
});
```

```ts
// test
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
  env: { ...getDefaultEnvironment(), GLOAM_URL: url, GLOAM_TOKEN: token }, stderr: "pipe" });
const client = new Client({ name: "gloam-test", version: "0.0.0" });
await client.connect(transport);
const res = await client.callTool({ name: "search_spells", arguments: { query: "fire" } }); // { content, structuredContent?, isError? }
await client.close();
```

- **Input schemas.** `registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations? }, handler)`. Pass a zod object; a bare field map is `@deprecated`. The SDK converts `inputSchema` with `io:"input"`.
- **zod requirement.** zod ≥ 4.2 is required: the SDK uses zod's `~standard.jsonSchema` (`createMcpHandler-*.d.mts:3359-3381`, `mcp-*.mjs:1724-1730`).
- **Errors come back as results.** Validation errors and handler throws return `isError: true` results, with the message passed through word for word; nothing is thrown to the client.
- **Protocol versions.** `serveStdio` serves both the 2025 and 2026-07-28 protocols, while `server.connect(new StdioServerTransport())` serves 2025 only. The client defaults to the legacy handshake (`client\dist\index.d.mts:1778-1797`).
- **Stdout.** A JSON log line on the server's stdout triggers `client.onerror`. Stdout is the protocol channel.

### 2.7 Asset pipeline (file-type 22.1.1, gltf-validator, @gltf-transform 4.5.0, meshoptimizer 1.3.0, draco3dgltf 1.5.7, sharp 0.35.4)

Verified pipeline on an 80k-triangle GLB with a 2048² PNG texture, run on Node 22 and 24: 0 errors, 80,000 → 19,999 triangles, 13.3 MB → 376 kB, about 500 ms. The same GLB Draco-compressed also went through to meshopt with 0 errors.

```ts
import { validateBytes } from "gltf-validator";                         // CJS, no typings → local .d.ts
import { NodeIO, Logger } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune, dedup, weld, simplify, textureCompress, meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";
import sharp from "sharp";
const report = await validateBytes(new Uint8Array(buf), { format: "glb", maxIssues: 100, writeTimestamp: false });
if (report.issues.numErrors > 0 || report.info.resources.some((r) => r.storage === "external")) reject();
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder,
                          "draco3d.decoder": await draco3d.createDecoderModule() });
const doc = await io.readBinary(bytes);   // never touches fs/network; throws on external URIs / unknown required ext
for (const ext of doc.getRoot().listExtensionsUsed()) if (!ALLOWED.has(ext.extensionName)) ext.dispose();
await doc.transform(prune(), dedup(), weld(),
  ...(tris > budget ? [simplify({ simplifier: MeshoptSimplifier, ratio: budget / tris, error: 0.01 })] : []),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [1024, 1024] }),
  meshopt({ encoder: MeshoptEncoder, level: "medium" }), prune());
const out = await io.writeBinary(doc);
```

- **file-type API** (`NM\file-type@22.1.1\…\source\index.d.ts`):
  - Functions: `fileTypeFromBuffer(Uint8Array|ArrayBuffer)`, `fileTypeFromFile(path)`, `fileTypeFromStream(webStream)`.
  - A Node stream throws `stream.pipeThrough is not a function`; wrap it with `Readable.toWeb()`.
- **What file-type detected:**

  | Input | Result |
  |---|---|
  | GLB | `model/gltf-binary` |
  | MP3 | `audio/mpeg` |
  | Ogg Vorbis | `audio/ogg` |
  | Ogg Opus | `audio/ogg; codecs=opus` |
  | WAV | `audio/wav` |
  | FLAC | `audio/flac` |
  | M4A (`ftyp M4A `) | `audio/x-m4a` |
  | `ftyp isom` | `video/mp4` |
  | SVG | `undefined` |

- **gltf-validator report shape.**
  - `{ mimeType, validatorVersion, issues: { numErrors, numWarnings, numInfos, numHints, messages[{ code, message, severity, pointer|offset }], truncated }, info: { resources[{ pointer, mimeType, storage, uri? }], extensionsUsed, totalTriangleCount, … } }`.
  - Garbage input resolves (it doesn't reject) with `GLB_INVALID_MAGIC`.
  - Its supported-extension list **excludes** `KHR_draco_mesh_compression` and `EXT_meshopt_compression`, so compressed data is never validated.
- **gltf-transform:**
  - `NodeIO.setAllowNetwork` defaults to false.
  - The dependency keys are `meshopt.decoder|encoder` and `draco3d.decoder|encoder`.
  - `KHRONOS_EXTENSIONS` covers KHR_* only; `ALL_EXTENSIONS` adds the EXT_* set (`NM\@gltf-transform+extensions@4.5.0\…\dist\index.js:6613-6647`).
  - `meshopt()` defaults to `level:'high'` and adds `EXT_meshopt_compression` and `KHR_mesh_quantization` as *required*.
- **meshoptimizer 1.3.0:** ESM; `MeshoptEncoder`, `MeshoptDecoder` and `MeshoptSimplifier` each have `{ supported, ready }`.
- **draco3dgltf:** CommonJS `{ createDecoderModule, createEncoderModule }` with local WASM. Types come from `@types/draco3dgltf@1.4.3`.

### 2.8 Rapier (`@dimforge/rapier3d-deterministic-compat` 0.21.0)

Verified on Node 22, Node 24, and in a Chromium module worker under the spec CSP. Seeded three-dice runs produced identical hashes (`7ea509c7`, `94bf901d`) on all three. The dice slept after 118 and 128 steps.

```ts
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
await RAPIER.init();                                   // WASM embedded as base64: no fetch; needs only 'wasm-unsafe-eval'; ~25 ms
const world = new RAPIER.World({ x: 0, y: -981, z: 0 });
world.timestep = 1 / 120; world.lengthUnit = 100;      // 1 unit = 1 cm
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(q)
  .setLinvel(vx, vy, vz).setAngvel(w).setLinearDamping(0.1).setAngularDamping(0.1).setCanSleep(true).setCcdEnabled(true));
const desc = RAPIER.ColliderDesc.convexHull(verts);    // ColliderDesc | null
desc!.setRestitution(0.3).setFriction(0.6).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
  .setContactForceEventThreshold(3 * mass * 981);
world.createCollider(desc!, body);
const q = new RAPIER.EventQueue(true);
world.step(q);
q.drainContactForceEvents((e) => { e.collider1(); e.collider2(); e.totalForceMagnitude(); e.maxForceMagnitude(); });
body.isSleeping(); q.free(); world.free();
```

Sources: `convexHull` is at `…\dist\geometry\collider.d.ts:824`; `EventQueue` is in `…\dist\pipeline\event_queue.d.ts`; `lengthUnit` is at `…\dist\pipeline\world.d.ts:108-128`.

### 2.9 three 0.186.1, R3F 9.8.1, drei 10.7.9, postprocessing 6.39.5, @react-three/postprocessing 3.1.2, troika 0.52.5

- **Peer ranges.** R3F needs react `>=19 <19.4`. postprocessing needs three `>=0.168 <0.187`. r3pp needs postprocessing `^6.36` and fiber `>=9.7`. A strict npm install produced no peer errors.
- **Addon paths.** Both `three/addons/libs/meshopt_decoder.module.js` and `three/examples/jsm/…` resolve through three's `./addons/*` export, and so do `RoomEnvironment` and `SkeletonUtils`.
  - `await MeshoptDecoder.ready` works under the CSP; its blob workers are allowed by `worker-src blob:`.
- **`gl.compileAsync(scene, camera, targetScene?)`** exists (`NM\three@0.186.1\…\src\renderers\WebGLRenderer.js:1515`).
- **AgX.** `ToneMappingMode.AGX` = 7 in postprocessing (`build\index.js:8238`); use it as `<ToneMapping mode={ToneMappingMode.AGX}/>`.
  - r3pp's `EffectComposer` defaults to `renderPriority 1` and `multisampling 8`, and forces `gl.toneMapping = NoToneMapping` (`@react-three+postprocessing…\dist\index.js:332,444`).
- **`<Hud renderPriority>`.** At 1 it clears the screen and draws the main scene. At 2 it only calls `clearDepth()` and draws the HUD (`drei\core\Hud.js`).
- **`<PerformanceMonitor>`.** Callbacks: `onIncline`, `onDecline`, `onChange`, `onFallback`. Defaults: `ms 250, iterations 10, threshold 0.75, step 0.1, factor 0.5, flipflops Infinity`. With `flipflops = Infinity`, `onFallback` never fires.
- **`<CameraControls>`** wraps camera-controls 3.1.2. It supports `makeDefault`, `onChange`/`onRest`/`onSleep`/`onControlStart`/`onControlEnd`, `setLookAt(…, true)`, `setBoundary(Box3)` and `smoothTime`.
- **`<Text font>`** takes one URL. `.woff` works; `.woff2` throws `woff2 fonts not supported` (`troika-three-text.esm.js:430`). G8 confirmed.
- **drei helpers that fetch remote URLs by default:**
  - `useGLTF`/`Gltf` (Draco on by default, gstatic)
  - `Environment` presets (githack)
  - `Cloud` default texture
  - `MatcapTexture`/`useMatcapTexture`
  - `NormalTexture`/`useNormalTexture`
  - `Ktx2`/`useKTX2`
  - `DetectGPU`/`useDetectGPU`
  - `FaceLandmarker`
  - `Text` (troika fallback fonts from jsdelivr)
- **Local-only drei helpers:** `Stats`, `StatsGl`, `Sparkles`, `Stars`, `Hud`, `PerformanceMonitor` and `CameraControls`.

### 2.10 Vite 8.3.1, Tailwind 4.3.3, Vitest 5.0.2, Playwright 1.63.0

Dev server inside Express 5 (verified in Chromium under the spec CSP plus a nonce; React rendered with no violations):

```ts
const PH = "__GLOAM_NONCE__";
const vite = await createServer({ root: "packages/web", appType: "custom", html: { cspNonce: PH },
  server: { middlewareMode: true, ws: { port: 24678, host: "127.0.0.1" } } });
app.use((req, res, next) => { res.locals.nonce = randomBytes(16).toString("base64"); next(); });
app.use("/api", apiRouter, (_q, r) => r.status(404).json({ code: "NOT_FOUND" }));
app.use(vite.middlewares);
app.get("/{*splat}", async (req, res, next) => {
  try { const raw = await fs.readFile("packages/web/index.html", "utf8");
        res.type("html").send((await vite.transformIndexHtml(req.originalUrl, raw)).replaceAll(PH, res.locals.nonce)); }
  catch (e) { next(e); }
});
```

```ts
// packages/web/vite.config.ts (verified)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },                                        // Rapier becomes its own 4.36 MB (1.66 MB gz) chunk
  optimizeDeps: { include: ["@dimforge/rapier3d-deterministic-compat"] },
  build: { assetsInlineLimit: (f) => (/\.(woff2?|ttf|otf)$/.test(f) ? false : undefined) },
});
```

- **plugin-react 6.1.1** has no Babel; its options are `include`, `exclude`, `jsxImportSource`, `jsxRuntime`, `reactRefreshHost` and `compiler`. In dev it still injects an inline Fast-Refresh preamble, which needs the nonce.
- **Workers and WASM.** `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })` builds to `assets/x.worker-<hash>.js`. Rapier needs no WASM plugin.
- **Tailwind.** `@import "tailwindcss"; @theme { --color-ember: … }` generates `bg-ember` and friends. Unused variables are dropped unless you write `@theme static`.
- **Vitest.** `test.workspace` was removed and fails with a migration error; use `test.projects`, which accepts globs, inline configs or `defineProject` files. `.ts` tests with `.ts` imports pass on 22.18 and 24.21.
- **Playwright WebSocket inspection.** `page.on("websocket", ws => ws.on("framereceived", ({ payload }) => …))` gives `payload: string | Buffer`; Colyseus frames are binary `Buffer`s (verified).
  - `page.routeWebSocket(url, (route) => { const server = route.connectToServer(); route.onMessage(…); server.onMessage(…); })` works (`playwright-core\types\types.d.ts:4557, 18513+, 23487-23510`).
  - In dev, filter out Vite's HMR socket.

### 2.11 express 5.2.1, helmet 8.3.0, pino 10.3.1, busboy 1.6.0, @node-rs/argon2 2.2.1

- **helmet's CSP directive functions** have the type `(req, res) => string`. At runtime they receive Express's `req`/`res`. An invalid return value calls `next(err)` (`NM\helmet@8.3.0\…\index.d.mts:3`; CHANGELOG 8.3.0).
- **helmet defaults that conflict with §22.4** (all verified):
  - The CSP adds `upgrade-insecure-requests` (breaks LAN HTTP), `https:` in `font-src`/`style-src`, and `frame-ancestors 'self'`.
  - HSTS `includeSubDomains` is sent **on HTTP responses too**.
  - There is **no Permissions-Policy**.
  - COEP is off.
- **Verified header setup:**
  ```ts
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...(dev ? [(_q, res) => `'nonce-${(res as any).locals.nonce}'`] : [])],
      styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "blob:", "data:"], mediaSrc: ["'self'", "blob:"], fontSrc: ["'self'"],
      connectSrc: ["'self'", wsSelf /* ws(s)://<validated Host> */, ...(dev ? ["ws://127.0.0.1:24678"] : [])],
      workerSrc: ["'self'", "blob:"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      reportUri: ["/api/csp-report"] } },
    strictTransportSecurity: false, xFrameOptions: { action: "deny" }, referrerPolicy: { policy: "no-referrer" },
    crossOriginOpenerPolicy: { policy: "same-origin" }, crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use((req, res, next) => { res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000"); next(); });
  ```
  helmet does **not** apply to Colyseus's `/matchmake/*` and `/__healthcheck` responses (§2.1).
- **Express 5.**
  - `app.get("*")` throws at startup; use `"/{*splat}"`.
  - `res.sendFile(p, { headers, etag: false, lastModified: false })` serves Range requests with 206.
- **pino.**
  - There is no built-in rotation.
  - `pino.transport({ targets })` runs in a worker thread, and logs are lost if the process exits before it is ready (`NM\pino@10.3.1\…\docs\transports.md:49, 476-497`).
  - pino-roll 4.0.0 names files `gloam.2026-09-27.1.log`, keeps `limit.count` files *in addition to* the active one, and prunes only when it rolls.
  - Verified in-process alternative: `pino.multistream([{ stream: pretty({ sync: true }) }, { stream: pino.destination({ dest, mkdir: true }) }])` plus `dest.reopen(next)` at midnight.
- **busboy 1.x.** The file event is `(name, stream, { filename, encoding, mimeType })`.
  - Limits: `fileSize`, `files`, `fields`, `parts`, `fieldSize`, `headerPairs`.
  - Events: `filesLimit`, `fieldsLimit` and `partsLimit` on busboy; `'limit'` on the file stream.
  - **`'limit'` fires while `stream.truncated` is still `false`** (verified).
  - Filenames are basename-only (`../../evil.png` → `evil.png`).
- **argon2 defaults** (verified): `hash()` produces `$argon2id$v=19$m=19456,t=2,p=1$…`, which matches §22.2.
  - `verify()` **throws** on a malformed stored hash.
  - `Algorithm` and `Version` are ambient `const enum`s: importing them is TS2748 under `verbatimModuleSyntax`.

### 2.12 zzfx 1.3.2, motion 13.4.4, react-router 7.18.4, @use-gesture/react 10.3.1

- **zzfx exports only `zzfx`, `ZZFX` and `ZZFXSound`.** `zzfxG`, `zzfxR`, `zzfxP`, `zzfxV` and `zzfxX` exist only as globals in `ZzFXMicro.js`.
  - `ZZFX.buildSamples(volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo, filter)` returns a mono `number[]` at `ZZFX.sampleRate` (44100), scaled by `ZZFX.volume` (0.3).
  - Importing the module creates `new AudioContext`, so it throws in Node/Vitest.
  - It has no types (`NM\zzfx@1.3.2\…\ZzFX.js:49-222`).
- **motion.** `motion/react` exports `motion`, `m`, `AnimatePresence`, `useReducedMotion`, `MotionConfig`, `LazyMotion` and `useAnimate`. Peers are react `^18 || ^19`. It rendered on 19.3.
- **react-router (declarative mode).** `BrowserRouter`, `Routes`, `Route`, `Navigate`, `Outlet` and `useNavigate` all import from `"react-router"`; `react-router-dom` isn't needed. `React.lazy` + `<Suspense>` for `/admin/*` rendered.
- **@use-gesture/react.** Peer is `react >=16.8`. `useDrag` works on 19.3. Drag targets need `touch-action: none`.

### 2.13 Node type stripping and TypeScript 7

- **Type stripping.** It is on by default in 22.18 and 24.21 (`process.features.typescript === "strip"`), and **neither version prints a warning**, with or without `--disable-warning=ExperimentalWarning` (https://nodejs.org/api/typescript.html).
  - `--experimental-transform-types` warns and is removed in Node 26.
  - Failures on both versions: `enum` and constructor parameter properties give `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`; a type imported without `type` is a runtime SyntaxError; an extensionless relative import gives `ERR_MODULE_NOT_FOUND`.
- **Workspace packages whose `exports` point at `.ts`:**

  | How the package is linked | Result |
  |---|---|
  | pnpm symlink or junction | Works |
  | Real copy inside `node_modules` | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
  | `--preserve-symlinks` | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |

  `child_process.fork(new URL("./child.ts", import.meta.url), [], { execArgv: [...] })` and `new Worker(new URL("./w.ts", …))` run `.ts` directly. Note that `execArgv` *replaces* the parent's flags.
- **TypeScript 7.0.2 (G6, verified).**
  - `strict` is on by default.
  - `types` defaults to `[]`: an installed `@types/node` is ignored until it is listed.
  - `baseUrl` is TS5102 (removed), and `moduleResolution: node10` is TS5108 (removed).
  - `@colyseus/sdk` types resolve under `moduleResolution: bundler`.

### 2.14 Gotchas G1–G11

| # | Status | Note |
|---|---|---|
| G1 | Holds | Established by the builder (install passes with `allowBuilds`) |
| G2 | Holds | Not re-tested. Also drop `@colyseus/tools`, which pulls in `@pm2/io` and `dotenv` (deviation 5). |
| G3 | Holds, incomplete | Add: `StateView` comes from `@colyseus/schema`; `room.request()` exists; `onAuth`'s `sessionId` key is special; CORS reflection. See deviations 1–15. |
| G4 | Holds, refined | Collections are empty placeholders (not `undefined`) when the root class is passed; new object on every re-add (verified) |
| G5 | Holds | Verified: a warning, then it decodes as the base class |
| G6 | Holds | Verified with tsc 7.0.2 |
| G7 | Holds, refined | No warning is printed, so the flag is harmless but unnecessary. Requires symlinked workspace packages. Vitest doesn't enforce erasable syntax. |
| G8 | Holds, incomplete | Also: troika's worker is blocked by the CSP, troika's unicode-fallback CDN, and 7 more drei helpers (deviations 43, 44, 51) |
| G9 | Not re-tested | Standard WebGL semantics (`preserveDrawingBuffer` defaults to false, https://registry.khronos.org/webgl/specs/latest/1.0/#5.2) |
| G10 | Holds | "Quick Tunnels do not support Server-Sent Events" and "this limit is 200 in-flight requests" (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) |
| G11 | Holds, weaker than it reads | No typings. Compressed data and unknown required extensions don't count as errors (deviations 26–27). |

---

## 3. Deviations the builder must know

`[SEC]` marks a security control; `[DATA]` marks a data-loss risk.

### Colyseus and realtime (§9.3, §11, §13)

1. **[SEC] CORS reflection on every HTTP response.**
   - What happens: Colyseus sets `Access-Control-Allow-Origin: <request Origin>` + `Access-Control-Allow-Credentials: true` on *all* responses, including Express `/api/*`, and answers every `OPTIONS` with 204 (`CORE\matchmaker\controller.ts:13-43`, `CORE\router\index.ts:98-113`; verified with `Origin: https://evil.example`).
   - Fix: before `listen()`, set `matchMaker.controller.DEFAULT_CORS_HEADERS = {}` and `matchMaker.controller.getCorsHeaders = () => ({})`. Verified: no CORS headers remain.
   - Add an E2E assertion for this.
2. **[SEC] Express middleware doesn't run for `/matchmake/*` or `/__healthcheck`.** Colyseus's router answers those first, so helmet, rate limits and CSRF/Origin guards never see them. Fix:
   - Check `Origin` against `Host` inside every static `onAuth`, and throw `ServerError(403)` on a mismatch.
   - Rate-limit matchmaking per session inside `onAuth`.
   - Add `beforeUpgrade` on `WebSocketTransport` to reject a foreign `Origin` with 403 (verified).
3. **[SEC] A `sessionId` field in `onAuth`'s return value becomes Colyseus's `client.sessionId`** (`CORE\MatchMaker.ts:955`).
   - Effect: the DB session id is exposed as `room.sessionId`, and two tabs of one browser collide (verified: both clients got the same id).
   - Fix, §13.2: return `{ userId, authSessionId, role }`. No key may be named `sessionId`.
4. **[SEC] `context.ip` is spoofable.** It is taken from `x-real-ip`/`x-forwarded-for`/`x-client-ip`, and on matchmaking requests it is otherwise `undefined` (`CORE\Transport.ts:156-175`; verified spoofed).
   - §13.2 types it as `ip: string`; the correct type is `AuthContext` from `@colyseus/core` (`ip: string | undefined`, plus `token?` and `req?`).
   - Never use it for bans or limits. Key those on the session, user or device.
5. **§11 `await listen(server)` from `@colyseus/tools` is wrong for this app.**
   - The signature is `listen(server, port = Number(process.env.PORT || 2567))`, and it calls `server.listen(port)` with **no host**, so it binds every interface. That contradicts §22.1's "bind 127.0.0.1" (`TOOLS\index.ts:102, 151`).
   - Importing it loads `.env`, `.env.<NODE_ENV>` and `/etc/environment` (override) through dotenv (`TOOLS\loadenv.ts:45-67`), and it pulls in `@pm2/io`.
   - Fix: **remove the `@colyseus/tools` dependency.** Use `await server.listen(config.port, config.host)`, with `PORT` read by our own config.
6. **`StateView` is not exported by `@colyseus/core`** (§9.3 row). Fix: `import { StateView } from "@colyseus/schema"` (`CORE\index.ts`, `SCH\index.ts`).
7. **Colyseus's default shutdown handling conflicts with §11 `shutdown()`.** It installs `SIGINT`/`SIGTERM`/`SIGUSR2` and `uncaughtException` handlers that call `process.exit`, and prints a banner.
   - Fix: pass `gracefullyShutdown: false, greet: false, logger: <pino child>`.
   - Call `await server.gracefullyShutdown(false)` inside our `shutdown()`, after the shutdown snapshot is written. It disconnects the clients, disposes the rooms and closes the HTTP server.
8. **§11 sets `exposedMethods` after `listen()`**, which leaves a window where `create` is allowed. Fix: set `exposedMethods` and the CORS overrides before `server.listen()`.
9. **`createRoom("table", { campaignId })` when that `roomId` already exists** returns the existing room silently, and `onCreate` side effects run on a discarded instance (verified).
   - Fix: guard with `matchMaker.getLocalRoomById(id)`; `closeTable()` must `await room.disconnect()` before the room is recreated.
   - Also assert `/^[A-Za-z0-9_-]+$/` on campaign ids; nanoid's default alphabet already complies.
10. **[SEC] Don't pass zod schemas to `onMessage(type, schema, handler)`.**
    - An invalid fire-and-forget message **disconnects** the client (4002).
    - An invalid request sends back the raw issue dump.
    - Both log a full stack trace, so any client can flood the log.
    - Unknown message types also disconnect the client in production.
    - Fix: `safeParse` inside the handler and `return ctx.reject({ code: "INVALID", message })`. Throw only `ServerError`, which isn't logged. Register every catalogue name.
11. **Request semantics for §13.5 and §23.3.** `room.request()` exists (see §2.1).
    - The spec's rejection `{ code, message }` is sent with `ctx.reject({ code, message })` and read on the client as `err.name === "rejected"`, `err.reason.code`. A fault is a plain `Error`; a timeout is 10 s by default.
    - A `request()` in flight is **rejected when the socket drops**, and a new call fails immediately while offline. The typed `request()` wrapper should wait for `onReconnect` and retry with the **same `cid`**.
    - `room.send()` commands made while reconnecting are buffered (up to 10) and replayed, so `cid` de-duplication must also cover `send`.
12. **[SEC] Reconnects skip `onAuth`.**
    - In `onReconnect`, re-check the session, using `client.auth.authSessionId`, and call `client.leave(4401)` if it was revoked or banned.
    - Kick and ban with `client.leave(<4000-4999, but not 4010>)` and never call `allowReconnection` for those clients. The SDK then calls `onLeave` instead of retrying.
    - SDK auto-reconnect needs 5 s of uptime (`room.reconnection.minUptime`).
13. **G4 and §13.4 client sync.** The collections are empty placeholders until the server sends them. Only subscribe through `Callbacks`; never keep `room.state.tokens`-style references, which are replaced when the real collection arrives.
14. **Typing (TS 7):**
    - Use `Callbacks.get<InstanceType<typeof Table>>(room)`; without the explicit generic, items are typed `unknown`.
    - Give primitive fields `.default(…)`, or construct with no arguments and then assign; otherwise `new Token({ id, name })` fails `tsc`.
15. **Views.** Call `client.view?.dispose()` in `onLeave`; core never disposes views. Attach an item to the state *before* `view.add(item)`, because adding a detached item is refused.

### zod, MCP, drizzle, Node (§12, §20, §26, G7)

16. **§26.1 published JSON Schemas.** Use `z.toJSONSchema(s, { target: "draft-2020-12", io: "input" })`, with every published schema built from `z.strictObject`.
    - The default `io:"output"` marks fields with defaults as required, and a plain `z.object` in `io:"input"` loses `additionalProperties:false`.
    - Only pass one of the four valid `target` strings; any other value is accepted silently.
17. **§26.2 MCP:**
    - Use `serveStdio(() => new McpServer(…))`, not `server.connect(new StdioServerTransport())`.
    - Use `z.strictObject` input schemas.
    - Log to **stderr only** (`pino(opts, pino.destination(2))`).
    - Catch errors in every tool and return a cleaned-up `isError` result that never contains the token or headers.
    - In tests, pass `env: { ...getDefaultEnvironment(), … }`; `env` replaces the whole environment rather than adding to it.
18. **[DATA] §11/§20.1 migrations with `foreign_keys=ON` cascade-delete child rows during drizzle-kit table rebuilds** (verified: 1 row → 0). Fix: `PRAGMA foreign_keys=OFF` → `migrate()` → `PRAGMA foreign_key_check`; if it returns rows, abort and restore the backup; then `PRAGMA foreign_keys=ON`.
19. **§11 "if migrations are pending, back up first."** drizzle has no pending API. Compare `readMigrationFiles({ migrationsFolder })` (from `drizzle-orm/migrator`) against `max(created_at)` in `__drizzle_migrations`, then `await sqlite.backup(path)`.
20. **The command bus can't await inside a transaction.** better-sqlite3 transactions are synchronous only. Do all awaiting (I/O, validation) first, then run `db.transaction(tx => { … })` synchronously.
21. **`drizzle.config.ts` paths are relative to the current directory.** Use repo-root-relative forward-slash paths: `schema: "packages/server/src/db/schema.ts"`, `out: "packages/server/drizzle"`. Build `migrationsFolder` from `import.meta.url` at runtime.
22. **G7: `.ts` workspace packages must stay symlinked.**
    - Never use `nodeLinker: hoisted`, `injectWorkspacePackages`, `dependenciesMeta.*.injected` or `--preserve-symlinks`. They produce `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
    - The `packages/mcp` `bin` works only from a checkout; document that in HOSTING.
23. **G7: the flag.** `--disable-warning=ExperimentalWarning` isn't needed on 22.18 or 24.21; keeping it is harmless.
    - Never use `--experimental-transform-types`, which is removed in Node 26.
    - Vitest (oxc) accepts enums and parameter properties, so `tsc` with `erasableSyntaxOnly` is the only gate. Keep it in `pnpm check`.

### Assets (§21)

24. **§21.1 step 4, "file-type on the first 4 KB":** use `fileTypeFromFile(tmpPath)` after busboy finishes. A 4 KB slice labels `ID3`-prefixed junk as `audio/mpeg` (verified).
25. **§8.16/§21.5 audio allow-list.** Allow `audio/mpeg`, `audio/ogg`, `audio/ogg; codecs=opus`, `audio/wav`, `audio/flac` and `audio/x-m4a`. AAC files with `isom`/`mp42` brands detect as `video/mp4`: accept those only for purpose `audio` after the §21.5 header parse confirms an audio-only `moov`.
26. **G11 / §21.4.1 gltf-validator.**
    - Write a local `gltf-validator.d.ts`; no `@types` package exists.
    - Detect external resources with `report.info.resources.some(r => r.storage === "external")`.
    - Never pass `externalResourceFunction`.
27. **§21.4.5 "re-validate (0 errors)" doesn't check meshopt or Draco payloads, or unknown required extensions**; those only get severity-2 `UNSUPPORTED_EXTENSION`. Fix:
    - Treat a throw from `io.readBinary()` as a rejection.
    - Reject any `extensionsRequired` entry outside what gltf-transform can decode.
    - Output gate: `readBinary(out)` succeeds, and the validator reports 0 errors and 0 external resources.
28. **§21.4.3 Draco.** Register `"draco3d.decoder": await draco3d.createDecoderModule()` and then `dispose()` `KHR_draco_mesh_compression`, or `writeBinary` throws for lack of an encoder. Add `@types/draco3dgltf@1.4.3`.
29. **§21.4.3 allow-list "KHR_materials_*" is too broad for three 0.186's GLTFLoader.**
    - Convert `KHR_materials_pbrSpecularGlossiness` with `metalRough()` first, then strip it.
    - Strip `KHR_materials_diffuse_transmission`.
    - Run the strip loop *before* `textureCompress`/`meshopt`.
30. **§21.4.4 `textureCompress` silently skips formats it doesn't support (ktx2), and its `limitInputPixels` is only a boolean.**
    - Reject `KHR_texture_basisu`.
    - Check each image with `ImageUtils.getSize` and reject anything over 8192².
    - After the transform, assert every texture is `image/webp`.
31. **§21.4.4 simplify.** Use `simplify({ simplifier: MeshoptSimplifier, ratio: budget / tris, error: 0.01 })` after `weld()`. With the default `error: 1e-4` it stops well short of the budget.

### Server HTTP (§11, §21.1, §22)

32. **[SEC] §22.4 with helmet:**
    - Set `contentSecurityPolicy.useDefaults: false`, so no `upgrade-insecure-requests` and no `https:` sources.
    - Set `strictTransportSecurity: false` and add HSTS manually on HTTPS requests only.
    - Add `Permissions-Policy` with custom middleware.
    - Set `xFrameOptions: { action: "deny" }`.
    - Validate `Host` (`/^[A-Za-z0-9.\-:\[\]]+$/`) before echoing it into `connect-src`.
    - Leave `trust proxy` off.
33. **§11/§22.7 "rotated daily, 14 kept."** pino can't do this on its own, and pino-roll doesn't match the naming or pruning. Write a small in-process rotator:
    - `pino.destination({ dest: logs/gloam-YYYY-MM-DD.log, mkdir: true })`.
    - An unref'd timer at local midnight calls `reopen(next)`.
    - Prune to the newest 14 at startup and on every roll.
    - `pino.multistream` adds pino-pretty in dev.
    - `flushSync()` on crash.
34. **§21.1 upload `purpose` as a form field.** busboy's limits are fixed when it is constructed, so move `purpose` to the query string (`POST /api/assets?purpose=map`). On the file stream's `'limit'` event:
    - `req.unpipe(bb)`.
    - Reply 413 with `Connection: close`, and destroy the socket after `finish`.
    - Delete the temp file.
    - Don't read `truncated` inside the `'limit'` handler; it is still false there.
    - Use `limits: { files: 1, fields: 4, parts: 5 }`.
    - The client must pre-check `File.size`.
35. **§22.2 argon2.** Call `hash(pw)` with its defaults, which equal the spec's parameters. Never import `Algorithm`/`Version`. Treat a `verify()` throw as `false`. Use `parseOptions()` for the needs-rehash check.
36. **Express 5 SPA fallback.** Use `app.get("/{*splat}", …)`; `app.get("*")` throws at startup.

### Vite dev and build (§11, §22.4, §23)

37. **§11 dev `appType: "spa"` + `html.cspNonce` can't produce a per-request nonce.** It also returns `index.html` for unknown `/api` GETs that accept HTML.
    - Fix: `appType: "custom"`, a placeholder nonce, and an Express catch-all that calls `transformIndexHtml` and then `replaceAll(placeholder, perRequestNonce)` (§2.10).
    - Set `html.cspNonce` only in the dev `createServer`, never in `vite.config.ts`.
    - Put the nonce in `script-src` only.
38. **§11 `hmr: { port: 24678 }`** → `server: { ws: { port: 24678, host: "127.0.0.1" } }`.
    - `hmr.port` is deprecated, and the default binds `0.0.0.0` and `[::]`.
    - The dev CSP then needs `ws://127.0.0.1:24678`, not `localhost`.
    - Never share the app's HTTP server with HMR: Colyseus owns every `upgrade` on it.
39. **Rapier worker.** Set `worker: { format: "es" }` so Rapier becomes a separate lazy chunk, and `optimizeDeps.include: ["@dimforge/rapier3d-deterministic-compat"]` to avoid a mid-session dev reload. No WASM plugin is needed.
40. **[SEC] `font-src 'self'`.** Vite inlines fonts under 4 KB as `data:`, which the CSP blocks. Set `build.assetsInlineLimit` to the function in §2.10. Don't add `data:` to `font-src`.
41. **§27 tokens.** Use `@theme static { … }`; otherwise any token not referenced in the source is dropped.
42. **Dev access through a tunnel or LAN hostname.** Vite answers 403 unless `server.allowedHosts` lists the host, and HMR won't work through a tunnel regardless. Mount `/api`, the asset routes and the `/api` 404 handler before `vite.middlewares`, and the SPA catch-all after it.

### Client rendering and audio (§18.4, §24, §25)

43. **[SEC/CSP] §24.4 drei `<Text>`: troika's typesetting worker is blocked by `script-src 'self'`.** It calls `importScripts(blob:)`, so text never syncs and `<Text>` suspends forever (verified).
    - Fix: call `configureTextBuilder({ useWorker: false })` from `troika-three-text` once, before the first `<Text>`.
    - Don't add `blob:` to `script-src`.
44. **[P1] troika fetches fallback fonts from cdn.jsdelivr.net for characters the font lacks** (for example `Ł`, CJK or emoji), and the whole string fails. Fix:
    - Call `configureTextBuilder({ useWorker: false, defaultFontURL: "/fonts/cinzel-latin-ext-400-normal.woff", unicodeFontsURL: "/fonts/ufr" })`.
    - Add these same-origin routes, which must never fail (if one errors, troika retries the CDN):
      - `GET /fonts/ufr/codepoint-index/*` → `[1,{}]`
      - `GET /fonts/ufr/font-meta/latin.json` → `[1,{"id":"latin","typeforms":{"sans-serif":{"normal":[400]}},"ranges":""}]`
      - `GET /fonts/ufr/font-files/latin/*` → a local `.woff`
    - Verified: 0 violations.
45. **§25.2 `zzfxG(...params)` doesn't exist in the npm module**, and importing zzfx creates an `AudioContext`, which breaks Vitest.
    - Fix: vendor `ZZFX.buildSamples` (MIT, keep the header) into `packages/web/src/audio/zzfx.ts` as `buildSamples(params, sampleRate): Float32Array`, and drop the dependency.
    - Pass `randomness = 0` for cached buffers, and apply the ±4% through `playbackRate`.
    - Record this in DECISIONS.
46. **§24.1 `<Hud renderPriority={2}>` with AgX.** drei's `Hud` can't switch tone mapping, and r3pp holds `NoToneMapping`. Write a custom `DiceHud` using `useFrame(…, 2)`:
    - save `gl.toneMapping`
    - set `AgXToneMapping`
    - `autoClear = false; clearDepth(); render(hudScene, hudCam)`
    - restore the saved value
47. **r3pp `EffectComposer`.** Pass `multisampling={0}`; the default is 8× MSAA, and §24.6 uses SMAA per tier.
48. **§24.7 warm-up compiles the wrong program variant when no render target is bound.** Use `gl.setRenderTarget(composer.inputBuffer); const p = gl.compileAsync(scene, camera); gl.setRenderTarget(null); await p;`. Warm up the HUD dice separately, with no target and AgX.
49. **§21.4.6 / G8 `useGLTF`.** It enables Draco by default and uses three-stdlib's loader.
    - Fix: `useLoader(GLTFLoader, url, (l) => l.setMeshoptDecoder(MeshoptDecoder))` with three's addons.
    - If drei is used anyway, call `useGLTF(url, false, true)`.
50. **§18.4 Rapier:**
    - Set `world.lengthUnit = 100` (1 unit = 1 cm); without it, metre-scale tolerances and sleep thresholds change the result.
    - Resting dice emit a force event every step, so use `setContactForceEventThreshold(≈3·m·981)` or trigger sounds on rising edges only.
    - Handle a `null` return from `convexHull`.
    - Call `.free()` on the `EventQueue` and the `World`.
51. **§24.9 forbidden list is incomplete.** Add:
    - `Cloud` without a `texture` prop
    - `MatcapTexture` / `useMatcapTexture`
    - `NormalTexture` / `useNormalTexture`
    - `Ktx2` / `useKTX2`
    - `DetectGPU` / `useDetectGPU`
    - `FaceLandmarker` / `Facemesh`
    - drei `Bvh`: it pulls three-mesh-bvh 0.8.3 next to the app's 0.9.15, so patch prototypes from 0.9.15 only
52. **Style.** Prefer `three/addons/...` import paths; `three/examples/jsm/...` also resolves.

---

## 4. Recommended pins

- **Pin everything exactly** (no `^`/`~`), including the spec's "latest" rows:
  - `react-router@7.18.4`, `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `lucide-react@1.48.0`
  - `@vitejs/plugin-react@6.1.1`, `@axe-core/playwright@4.13.0`
  - `draco3dgltf@1.5.7`, `busboy@1.6.0`, `fflate@0.8.3`, `pino-pretty@13.1.3`
  - The repo's `package.json` files already do this.
- **Keep `@react-three/postprocessing@3.1.2`.** 3.1.3 (2026-09-27, peers unchanged) is still inside pnpm's `minimumReleaseAge`; re-check it next week.
- **Remove** `@colyseus/tools` (deviation 5). That also drops `@pm2/io` and `dotenv` from the runtime tree.
- **Add** dev dependency `@types/draco3dgltf@1.4.3`, and local declaration files for `gltf-validator` (and for `zzfx` if it isn't vendored).
- **Don't add** `pino-roll` (deviation 33; if it's chosen anyway, pin `4.0.0`), `vite-plugin-wasm` or `vite-plugin-top-level-await`.
- **Upgrade together:**
  - `@colyseus/core` + `ws-transport` + `sdk` + `schema`. Keep exactly one `@colyseus/schema` in the tree (`pnpm why @colyseus/schema`) so both sides share one TypeContext.
  - `drizzle-orm` + `drizzle-kit`.
  - `@modelcontextprotocol/server` + `/client`.
  - `react` + `react-dom` + `@types/react*` (R3F peer `<19.4`).
  - `three` + `@types/three` (postprocessing peer `<0.187`).
- **Rapier:** keep `@dimforge/rapier3d-deterministic-compat@0.21.0` exact. Identical tumbles on every client depend on identical engine builds.
- **Engines:** `node >=22.18` (stripping is on by default only from 22.18). Test on both 22.18 and 24.21. Use only erasable syntax so it runs on Node 26.

## Spike findings (builder)

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
