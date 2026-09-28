import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devHostAllowed } from "../http/app.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const fsPath = (abs: string) => `/@fs/${abs.replaceAll("\\", "/")}`;

function get(port: number, path: string, host = "localhost"): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host: `${host}:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("the development server serves nothing it shouldn't (SPEC §22)", () => {
  let t: TestServer;
  // The data directory inside the served web tree: only the deny rules stand between it and a request.
  const dataDir = join(repo, "packages", "web", `.devtest-${process.pid}-${Date.now()}`);

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    t = await startTestServer({
      dataDir,
      env: { NODE_ENV: "development" },
      config: { devHmrPort: 30_000 + Math.floor(Math.random() * 20_000) },
    });
  }, 120_000);
  afterAll(async () => {
    await t?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-web`, { recursive: true, force: true }); // the harness's stand-in build folder
  });

  it("serves the web and shared sources to this machine, but never the data directory, the server's code or the repository's other files, and answers only to its own names", async () => {
    const port = Number(new URL(t.url).port);
    // The app and its shared code: served (so the refusals below aren't a broken path format).
    expect((await get(port, "/")).status).toBe(200);
    const shared = await get(port, fsPath(join(repo, "packages", "shared", "src", "constants.ts")));
    expect(shared.status).toBe(200);
    // The data directory: the secret key and the database, never.
    const key = join(dataDir, "secret.key");
    expect(existsSync(key)).toBe(true);
    const secret = readFileSync(key);
    for (const f of ["secret.key", "gloam.db"]) {
      const r = await get(port, fsPath(join(dataDir, f)));
      expect([f, r.status]).toEqual([f, 403]);
      expect(r.body.includes(secret.toString("base64"))).toBe(false);
      expect(r.body.includes(secret.toString("hex"))).toBe(false);
    }
    // The server's code and the repository root's files: outside what the dev server may serve.
    for (const p of [join(repo, "packages", "server", "src", "config.ts"), join(repo, "package.json")]) {
      const r = await get(port, fsPath(p));
      expect([p, r.status]).toEqual([p, 403]);
    }
    // A name someone else's DNS points here (DNS rebinding): refused before Vite sees it.
    const rebound = await get(
      port,
      fsPath(join(repo, "packages", "shared", "src", "constants.ts")),
      "evil.example",
    );
    expect(rebound.status).toBe(403);
    expect((await get(port, "/", "evil.example")).status).toBe(403);
  });

  it("devHostAllowed: localhost, loopback, the LAN address and the doorway's hostname only", () => {
    const doorway = "https://gloam-table.trycloudflare.com";
    expect(devHostAllowed("localhost:4747", null, null)).toBe(true);
    expect(devHostAllowed("127.0.0.1:4747", null, null)).toBe(true);
    expect(devHostAllowed("[::1]:4747", null, null)).toBe(true);
    expect(devHostAllowed("192.168.1.20:4747", null, "192.168.1.20")).toBe(true);
    expect(devHostAllowed("gloam-table.trycloudflare.com", doorway, null)).toBe(true);
    expect(devHostAllowed("evil.example:4747", doorway, "192.168.1.20")).toBe(false);
    expect(devHostAllowed("localhost.evil.example", null, null)).toBe(false);
    expect(devHostAllowed("127.0.0.1.nip.io", null, null)).toBe(false);
    expect(devHostAllowed("192.168.1.21", null, "192.168.1.20")).toBe(false);
    expect(devHostAllowed("", null, null)).toBe(false);
    expect(devHostAllowed(undefined, null, null)).toBe(false);
  });
});
