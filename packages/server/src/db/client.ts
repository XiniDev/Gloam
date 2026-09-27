import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Logger } from "../logger.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "..", "..", "drizzle");

/** Number of journal entries not yet recorded in __drizzle_migrations. */
function pendingMigrations(sqlite: Sqlite): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (!hasTable) return journal.entries.length;
  const row = sqlite.prepare("SELECT count(*) AS c FROM __drizzle_migrations").get() as { c: number };
  return Math.max(0, journal.entries.length - row.c);
}

export interface OpenedDb {
  sqlite: Sqlite;
  db: Db;
  migrated: number;
}

/**
 * Opens SQLite with the §20.1 pragmas. If migrations are pending on an existing database, a backup is taken
 * first (`db.backup()`), then migrations run before anything else touches the database.
 */
export async function openDatabase(path: string, backupsDir: string, log: Logger): Promise<OpenedDb> {
  const existed = existsSync(path);
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("temp_store = MEMORY");
  const pending = pendingMigrations(sqlite);
  if (pending > 0 && existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupsDir, `gloam-premigrate-${stamp}.db`);
    await sqlite.backup(dest);
    log.info({ dest, pending }, "database backed up before migrations");
  }
  const db = drizzle(sqlite, { schema });
  if (pending > 0) {
    // drizzle-kit table rebuilds would cascade-delete child rows with foreign keys on (R3 deviation 18).
    sqlite.pragma("foreign_keys = OFF");
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      const violations = sqlite.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) throw new Error(`foreign key check failed after migration (${violations.length} rows)`);
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
  }
  return { sqlite, db, migrated: pending };
}
