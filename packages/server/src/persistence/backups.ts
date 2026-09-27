import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Sqlite } from "../db/client.ts";
import type { Logger } from "../logger.ts";

export const BACKUPS_KEPT = 14;

function stamp(d: Date, withTime: boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` : day;
}

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: number;
}

/**
 * Online SQLite backups (SPEC §20.4): daily at the first opportunity after 04:00 local time, plus Backup now.
 * better-sqlite3's backup API copies pages incrementally, so play continues during a backup. Keeps 14.
 */
export class BackupService {
  private readonly sqlite: Sqlite;
  private readonly dir: string;
  private readonly log: Logger;
  private running: Promise<BackupInfo> | null = null;
  constructor(sqlite: Sqlite, dir: string, log: Logger) {
    this.sqlite = sqlite;
    this.dir = dir;
    this.log = log;
  }

  async backupNow(kind: "daily" | "manual" = "manual", now = new Date()): Promise<BackupInfo> {
    if (this.running) return this.running;
    const file = join(this.dir, `gloam-${stamp(now, kind === "manual")}.db`);
    this.running = (async () => {
      try {
        await this.sqlite.backup(file, { progress: () => 200 });
        const bytes = statSync(file).size;
        this.prune();
        this.log.info({ file, bytes }, "database backup written");
        return { file, bytes, createdAt: now.getTime() };
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Called by the scheduler; returns true when a daily backup was taken. */
  async maybeDaily(lastDay: string | null, now = new Date()): Promise<string | null> {
    const today = stamp(now, false);
    if (now.getHours() < 4 || lastDay === today) return null;
    await this.backupNow("daily", now);
    return today;
  }

  list(): BackupInfo[] {
    return readdirSync(this.dir)
      .filter((f) => /^gloam-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/.test(f))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { file: join(this.dir, f), bytes: st.size, createdAt: st.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private prune(): void {
    for (const b of this.list().slice(BACKUPS_KEPT)) rmSync(b.file, { force: true });
  }
}
