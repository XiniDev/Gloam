#!/usr/bin/env node
// Test fixture (SPEC §32 S6, §36.2): behaves like `cloudflared` for the tunnel manager.
// Supports: `--version`; `tunnel --no-autoupdate --url <u> --metrics <host:port>` (quick tunnel: prints the
// banner with the trycloudflare URL to stderr, serves /quicktunnel and /ready on the metrics port);
// `tunnel --no-autoupdate run` (named tunnel: requires TUNNEL_TOKEN in env, never in argv).
// Env knobs for tests: FAKE_CF_HOSTNAME, FAKE_CF_READY_DELAY_MS, FAKE_CF_CRASH_AFTER_MS, FAKE_CF_LOG (append
// argv/env summary to this file), FAKE_CF_NO_METRICS_HOSTNAME=1 (forces the stderr-parsing fallback).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("cloudflared version 2026.9.0 (built 2026-09-01-0000 UTC)\n");
  process.exit(0);
}
if (process.env.FAKE_CF_LOG) {
  appendFileSync(
    process.env.FAKE_CF_LOG,
    `${JSON.stringify({ argv, hasTunnelToken: typeof process.env.TUNNEL_TOKEN === "string", pid: process.pid })}\n`,
  );
}
const hostname = process.env.FAKE_CF_HOSTNAME_RANDOM
  ? `quiet-ember-${process.pid}.trycloudflare.com`
  : (process.env.FAKE_CF_HOSTNAME ?? "calm-river-1234.trycloudflare.com");
const readyDelay = Number(process.env.FAKE_CF_READY_DELAY_MS ?? 600);
const crashAfter = process.env.FAKE_CF_CRASH_AFTER_MS ? Number(process.env.FAKE_CF_CRASH_AFTER_MS) : null;
const metricsArg = argv[argv.indexOf("--metrics") + 1];
const isRun = argv.includes("run");
if (isRun && !process.env.TUNNEL_TOKEN) {
  process.stderr.write("ERR Provide a tunnel token with TUNNEL_TOKEN\n");
  process.exit(1);
}
const started = Date.now();
if (metricsArg) {
  const [host, port] = metricsArg.split(":");
  createServer((req, res) => {
    if (req.url === "/quicktunnel" && !isRun) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hostname: process.env.FAKE_CF_NO_METRICS_HOSTNAME ? "" : hostname }));
      return;
    }
    if (req.url === "/ready") {
      const ok = Date.now() - started >= readyDelay;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ok ? 200 : 503, readyConnections: ok ? 4 : 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(Number(port), host);
}
setTimeout(() => {
  if (!isRun) {
    process.stderr.write(
      "INF Requesting new quick Tunnel on trycloudflare.com...\n" +
        "INF +--------------------------------------------------------------------------------------------+\n" +
        "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
        `INF |  https://${hostname}                                            |\n` +
        "INF +--------------------------------------------------------------------------------------------+\n",
    );
  } else {
    process.stderr.write("INF Registered tunnel connection connIndex=0\n");
  }
}, 200);
if (crashAfter !== null) setTimeout(() => process.exit(3), crashAfter);
const stop = () => process.exit(0);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1 << 30);
