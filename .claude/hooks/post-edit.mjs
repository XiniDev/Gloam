#!/usr/bin/env node
// PostToolUse hook (SPEC Appendix D): formats an edited .ts/.tsx/.json/.css file inside the repo (not under
// docs/) with Biome. Formatting only — it never blocks, so it always exits 0.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function readStdin() {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", () => res(data));
  });
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const file = input?.tool_input?.file_path;
  if (typeof file === "string" && file.length > 0) {
    const abs = isAbsolute(file) ? file : resolve(root, file);
    const rel = relative(root, abs);
    const inside = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
    const underDocs = rel === "docs" || rel.startsWith(`docs${sep}`) || rel.startsWith("docs/");
    const underModules = rel.split(/[\\/]/).includes("node_modules");
    if (inside && !underDocs && !underModules && /\.(ts|tsx|json|css)$/.test(abs) && existsSync(abs)) {
      const isWin = process.platform === "win32";
      spawnSync(isWin ? "pnpm.cmd" : "pnpm", ["exec", "biome", "format", "--write", JSON.stringify(abs)], {
        cwd: root,
        stdio: "ignore",
        shell: isWin,
        timeout: 25_000,
      });
    }
  }
} catch {
  // Formatting is best-effort.
}
process.exit(0);
