/**
 * Network inspection for tests (AC-SCN-03, AC-TOK-08): replaces the global WebSocket with a subclass that records
 * every frame each socket receives, from the handshake on. Installed through vitest `setupFiles` so it always runs
 * before the Colyseus SDK loads (the SDK captures `globalThis.WebSocket` when it first loads). Recording is off
 * until a test calls `recordFrames(true)`, so long suites don't hold every frame in memory.
 */

const Base: typeof WebSocket = globalThis.WebSocket;
const sockets: RecordingWebSocket[] = [];
let recording = false;

export function recordFrames(on: boolean): void {
  recording = on;
}

export class RecordingWebSocket extends Base {
  readonly frames: Uint8Array[] = [];
  constructor(url: string | URL, init?: string | string[] | Record<string, unknown>) {
    super(url, init as never);
    if (!recording) return;
    sockets.push(this);
    this.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as ArrayBuffer | string | Blob;
      if (typeof d === "string") this.frames.push(new TextEncoder().encode(d));
      else if (d instanceof ArrayBuffer) this.frames.push(new Uint8Array(d.slice(0)));
    });
  }

  /** Every received byte, concatenated (for substring searches). */
  bytes(): Buffer {
    return Buffer.concat(this.frames.map((f) => Buffer.from(f)));
  }

  /** Whether a frame received after the first `from` frames contains `needle` as UTF-8. */
  receivedSince(from: number, needle: string): boolean {
    return Buffer.concat(this.frames.slice(from).map((f) => Buffer.from(f))).includes(
      Buffer.from(needle, "utf8"),
    );
  }

  /** Whether any received frame contains `needle` as UTF-8 (how schema/msgpack encode strings). */
  received(needle: string): boolean {
    return this.bytes().includes(Buffer.from(needle, "utf8"));
  }
}

globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;

/** Sockets opened since `mark` (a count from `socketCount()`), e.g. the one a room join just created. */
export function socketsSince(mark: number): RecordingWebSocket[] {
  return sockets.slice(mark);
}
export function socketCount(): number {
  return sockets.length;
}
