import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * net/colyseus.ts replaces the SDK's WebSocketTransport.connect with its browser half (the Node attempt throws in
 * browsers, and WebKit reports that as a page error). The replacement copies the SDK's own lines: this test fails if
 * an SDK update changes them, so the copy is looked at again rather than silently drifting.
 */
describe("the Colyseus socket, opened the browser's way", () => {
  it("the SDK's connect still does what the replacement copies", () => {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@colyseus/sdk/package.json");
    const src = readFileSync(join(dirname(pkg), "build", "transport", "WebSocketTransport.mjs"), "utf8");
    const body = src.slice(src.indexOf("connect(url, headers)"), src.indexOf("close(code, reason)"));
    for (const line of [
      "this.ws = new WebSocket(url, this.protocols);",
      "this.ws.binaryType = 'arraybuffer';",
      "this.ws.onopen = (event) => this.events.onopen?.(event);",
      "this.ws.onmessage = (event) => this.events.onmessage?.(event);",
      "this.ws.onclose = (event) => this.events.onclose?.(event);",
      "this.ws.onerror = (event) => this.events.onerror?.(event);",
    ])
      expect(body, line).toContain(line);
    expect(body.match(/this\.ws\.\w+ = /g), "nothing else set on the socket").toHaveLength(5);
  });
});
