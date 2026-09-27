import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** Layout of the data directory (SPEC §11). */
export interface DataPaths {
  root: string;
  db: string;
  secretKey: string;
  assets: string;
  tmp: string;
  snapshots: string;
  backups: string;
  exports: string;
  logs: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    db: join(root, "gloam.db"),
    secretKey: join(root, "secret.key"),
    assets: join(root, "assets"),
    tmp: join(root, "tmp"),
    snapshots: join(root, "snapshots"),
    backups: join(root, "backups"),
    exports: join(root, "exports"),
    logs: join(root, "logs"),
  };
}

/**
 * Restricts a path to the current user (SPEC §11, AC-SEC-08). POSIX: chmod. Windows: replace the inherited ACL
 * with a single full-control grant for the current user via icacls (fixed arguments, no shell).
 */
export function restrictToOwner(path: string, kind: "dir" | "file"): { ok: boolean; detail: string } {
  if (process.platform !== "win32") {
    try {
      chmodSync(path, kind === "dir" ? 0o700 : 0o600);
      return { ok: true, detail: kind === "dir" ? "0700" : "0600" };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${userInfo().username}`
    : userInfo().username;
  const grant = kind === "dir" ? `${user}:(OI)(CI)F` : `${user}:F`;
  const r = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { ok: r.status === 0, detail: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Creates the data directory tree with owner-only permissions and clears the upload staging folder. */
export function ensureDataDir(paths: DataPaths): { created: boolean } {
  const created = !existsSync(paths.root);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  // Always (re)apply: a pre-existing folder may carry inherited access for other accounts.
  restrictToOwner(paths.root, "dir");
  void created;
  for (const dir of [paths.assets, paths.tmp, paths.snapshots, paths.backups, paths.exports, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // tmp/ is upload staging: anything left there is from an interrupted upload (SPEC §11).
  for (const f of readdirSync(paths.tmp)) rmSync(join(paths.tmp, f), { recursive: true, force: true });
  return { created };
}

/** Recursive byte size (for Admin → Saves & Backups). */
export function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) total += dirSize(join(path, name));
  return total;
}
