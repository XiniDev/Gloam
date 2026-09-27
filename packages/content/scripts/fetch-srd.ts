/**
 * Step 1 of the content pipeline (SPEC §33.2): fetch and verify every pinned source into .cache/.
 *
 * - SRD 5.2.1 PDF: verified by SHA-256 and size; the download is skipped when the cached file matches.
 * - Foundry dnd5e: shallow, sparse git fetch of the exact pinned commit (only packs/_source/spells24),
 *   verified with `git rev-parse HEAD`; the tag → commit mapping is checked with `git ls-remote` on fetch.
 * - Open5e / 5e-bits (cross-check only): the pinned branch is resolved to a commit once, files are cached
 *   under that commit with their SHA-256, and later builds reuse the cache (`--refresh` re-resolves).
 *
 * Usage: node --disable-warning=ExperimentalWarning scripts/fetch-srd.ts [--refresh]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CACHE_DIR, CROSS_CHECK, FOUNDRY, SRD_PDF } from "./lib/pins.ts";
import { isEntryPoint, readJson, sha256, sha256File, toJson } from "./lib/util.ts";

export interface PdfSource {
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  downloaded: boolean;
}

export interface FoundrySource {
  repo: string;
  tag: string;
  commit: string;
  dir: string;
  spellsDir: string;
  /** Git tree id of packs/_source/spells24 at the pinned commit (content fingerprint). */
  spellsTree: string;
  tagVerified: boolean | "not-checked";
}

export interface CachedFile {
  path: string;
  url: string;
  localPath: string;
  sha256: string;
  bytes: number;
}

export interface CrossCheckSource {
  owner: string;
  repo: string;
  branch: string;
  commit: string;
  resolvedAt: string;
  files: Record<string, CachedFile>;
}

export interface Sources {
  pdf: PdfSource;
  foundry: FoundrySource;
  open5e: CrossCheckSource;
  fiveEBits: CrossCheckSource;
}

export interface FetchOptions {
  refresh?: boolean;
  log?: (msg: string) => void;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchPdf(log: (m: string) => void): Promise<PdfSource> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, SRD_PDF.fileName);
  if (existsSync(path)) {
    const size = statSync(path).size;
    const hash = sha256File(path);
    if (size === SRD_PDF.bytes && hash === SRD_PDF.sha256) {
      log(`PDF cached and verified (${size} bytes, sha256 ${hash.slice(0, 12)}…)`);
      return { path, url: SRD_PDF.url, sha256: hash, bytes: size, downloaded: false };
    }
    log(`Cached PDF does not match the pin (size ${size}, sha256 ${hash}); re-downloading`);
  }
  log(`Downloading ${SRD_PDF.url}`);
  const bytes = await download(SRD_PDF.url);
  const hash = sha256(bytes);
  if (bytes.byteLength !== SRD_PDF.bytes || hash !== SRD_PDF.sha256) {
    throw new Error(
      `SRD PDF verification failed: got ${bytes.byteLength} bytes, sha256 ${hash}; ` +
        `expected ${SRD_PDF.bytes} bytes, sha256 ${SRD_PDF.sha256}`,
    );
  }
  writeFileSync(path, bytes);
  return { path, url: SRD_PDF.url, sha256: hash, bytes: bytes.byteLength, downloaded: true };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function foundryCheckoutOk(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  try {
    if (git(dir, ["rev-parse", "HEAD"]) !== FOUNDRY.commit) return false;
  } catch {
    return false;
  }
  const spellsDir = join(dir, FOUNDRY.spellsPath);
  return FOUNDRY.levelDirs.every(
    (d) => existsSync(join(spellsDir, d)) && readdirSync(join(spellsDir, d)).length > 1,
  );
}

export function fetchFoundry(log: (m: string) => void, refresh = false): FoundrySource {
  const dir = join(CACHE_DIR, "foundry-dnd5e");
  const markerPath = join(dir, ".git", "gloam-pin.json");
  let tagVerified: boolean | "not-checked" = "not-checked";
  if (refresh || !foundryCheckoutOk(dir)) {
    log(`Fetching Foundry dnd5e ${FOUNDRY.tag} (${FOUNDRY.commit}) — sparse: ${FOUNDRY.spellsPath}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", FOUNDRY.repo]);
    git(dir, ["sparse-checkout", "init", "--no-cone"]);
    git(dir, ["sparse-checkout", "set", "--no-cone", `/${FOUNDRY.spellsPath}/`]);
    git(dir, ["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", FOUNDRY.commit]);
    git(dir, ["checkout", "-q", "FETCH_HEAD"]);
    const tagLine = git(dir, ["ls-remote", "--tags", "origin", `refs/tags/${FOUNDRY.tag}`]);
    const tagCommit = tagLine.split(/\s+/)[0] ?? "";
    tagVerified = tagCommit === FOUNDRY.commit;
    if (!tagVerified) {
      // Annotated tags resolve through ^{}; check that form before failing.
      const peeled = git(dir, ["ls-remote", "--tags", "origin", `refs/tags/${FOUNDRY.tag}^{}`]);
      tagVerified = (peeled.split(/\s+/)[0] ?? "") === FOUNDRY.commit;
    }
    if (!tagVerified) throw new Error(`Tag ${FOUNDRY.tag} does not point at ${FOUNDRY.commit} (${tagLine})`);
    writeFileSync(markerPath, toJson({ tag: FOUNDRY.tag, commit: FOUNDRY.commit, tagVerified: true }));
  } else {
    log(`Foundry dnd5e checkout cached at ${FOUNDRY.commit}`);
    // The tag → commit check ran when this checkout was fetched; its record lives inside .git.
    if (existsSync(markerPath)) {
      const marker = readJson<{ tag: string; commit: string; tagVerified: boolean }>(markerPath);
      if (marker.tag === FOUNDRY.tag && marker.commit === FOUNDRY.commit) tagVerified = marker.tagVerified;
    }
  }
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head !== FOUNDRY.commit) throw new Error(`Foundry checkout is at ${head}, expected ${FOUNDRY.commit}`);
  const spellsTree = git(dir, ["rev-parse", `HEAD:${FOUNDRY.spellsPath}`]);
  return {
    repo: FOUNDRY.repo,
    tag: FOUNDRY.tag,
    commit: head,
    dir,
    spellsDir: join(dir, FOUNDRY.spellsPath),
    spellsTree,
    tagVerified,
  };
}

async function resolveBranch(owner: string, repo: string, branch: string): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.sha", "User-Agent": "gloam-content-pipeline" },
  });
  if (!res.ok) throw new Error(`Could not resolve ${owner}/${repo}@${branch}: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`Unexpected commit id for ${owner}/${repo}@${branch}: ${sha}`);
  return sha;
}

async function fetchCrossCheck(
  key: "open5e" | "fiveEBits",
  log: (m: string) => void,
  refresh: boolean,
): Promise<CrossCheckSource> {
  const spec = CROSS_CHECK[key];
  const dir = join(CACHE_DIR, "crosscheck");
  const metaPath = join(dir, `${spec.repo}.json`);
  mkdirSync(dir, { recursive: true });
  if (!refresh && existsSync(metaPath)) {
    const meta = readJson<CrossCheckSource>(metaPath);
    const ok =
      meta.branch === spec.branch &&
      Object.keys(spec.files).every((name) => {
        const f = meta.files[name];
        return f !== undefined && existsSync(f.localPath) && sha256File(f.localPath) === f.sha256;
      });
    if (ok) {
      log(`${spec.owner}/${spec.repo} cached at ${meta.commit.slice(0, 12)} (${spec.branch})`);
      return meta;
    }
  }
  const commit = await resolveBranch(spec.owner, spec.repo, spec.branch);
  log(`${spec.owner}/${spec.repo}@${spec.branch} resolved to ${commit}`);
  const files: Record<string, CachedFile> = {};
  for (const [name, path] of Object.entries(spec.files)) {
    const url = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${commit}/${path}`;
    const bytes = await download(url);
    JSON.parse(new TextDecoder().decode(bytes)); // must be valid JSON before it is cached
    const localPath = join(dir, `${spec.repo}-${commit.slice(0, 12)}-${basename(path)}`);
    writeFileSync(localPath, bytes);
    files[name] = { path, url, localPath, sha256: sha256(bytes), bytes: bytes.byteLength };
  }
  const meta: CrossCheckSource = {
    owner: spec.owner,
    repo: spec.repo,
    branch: spec.branch,
    commit,
    resolvedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(metaPath, toJson(meta));
  return meta;
}

export async function fetchSources(opts: FetchOptions = {}): Promise<Sources> {
  const log = opts.log ?? ((m: string) => console.log(`[fetch] ${m}`));
  const refresh = opts.refresh ?? false;
  const pdf = await fetchPdf(log);
  const foundry = fetchFoundry(log, refresh);
  const open5e = await fetchCrossCheck("open5e", log, refresh);
  const fiveEBits = await fetchCrossCheck("fiveEBits", log, refresh);
  return { pdf, foundry, open5e, fiveEBits };
}

/** Reads a cached cross-check file as JSON. */
export function readCached<T>(src: CrossCheckSource, name: string): T {
  const f = src.files[name];
  if (!f) throw new Error(`No cached file "${name}" for ${src.repo}`);
  return JSON.parse(readFileSync(f.localPath, "utf8")) as T;
}

if (isEntryPoint(import.meta.url)) {
  const sources = await fetchSources({ refresh: process.argv.includes("--refresh") });
  console.log(toJson(sources));
}
