import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

export type { Logger };

/**
 * Keys that must never reach a log line (SPEC §22.7): cookies, tokens, codes, PINs, passwords, the tunnel
 * token and auth request bodies. pino's redaction censors them wherever they appear in a logged object.
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "headers.cookie",
  "headers.authorization",
  "cookie",
  "authorization",
  "password",
  "pin",
  "token",
  "code",
  "secret",
  "tunnelToken",
  "*.password",
  "*.pin",
  "*.token",
  "*.code",
  "*.secret",
  "*.tunnelToken",
  "*.cookie",
  "body",
  "*.body",
];

const KEEP_DAYS = 14;

/** A write stream that appends to data/logs/gloam-YYYY-MM-DD.log, rolls over at midnight, keeps 14 files. */
export class DailyFileStream extends Writable {
  private fd: number | null = null;
  private day = "";
  private readonly dir: string;
  constructor(dir: string) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private today(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  private ensureFile(): number {
    const day = this.today();
    if (this.fd !== null && day === this.day) return this.fd;
    if (this.fd !== null) closeSync(this.fd);
    this.day = day;
    this.fd = openSync(join(this.dir, `gloam-${day}.log`), "a", 0o600);
    this.prune();
    return this.fd;
  }
  private prune(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => /^gloam-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS)))
        rmSync(join(this.dir, f), { force: true });
    } catch {
      // pruning is best-effort
    }
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      writeSync(this.ensureFile(), chunk);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
  override _final(cb: (err?: Error | null) => void): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    cb();
  }
}

export interface LoggerOptions {
  level: string;
  logDir: string;
  console: boolean;
  pretty: boolean;
}

export async function createLogger(opts: LoggerOptions): Promise<Logger> {
  const streams: pino.StreamEntry[] = [{ level: "trace", stream: new DailyFileStream(opts.logDir) }];
  if (opts.console) {
    if (opts.pretty) {
      try {
        const pretty = (await import("pino-pretty")).default;
        streams.push({
          level: "trace",
          stream: pretty({ colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" }),
        });
      } catch {
        streams.push({ level: "trace", stream: process.stdout });
      }
    } else {
      streams.push({ level: "trace", stream: process.stdout });
    }
  }
  return pino(
    {
      level: opts.level,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}
