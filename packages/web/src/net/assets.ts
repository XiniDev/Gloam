import type { AssetItem, AssetRender } from "../state/library.ts";
import { useLibrary } from "../state/library.ts";

/**
 * Asset access for the board (SPEC §21.6): same-origin URLs, at most 6 downloads at a time (a quick tunnel limit),
 * and the HTTP cache for everything else (assets are immutable). Metadata comes from `GET /api/assets/:id`.
 */

export const assetUrl = (id: string, variant: string) => `/assets/${id}/${variant}`;

const MAX_CONCURRENT = 6;
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** A same-origin, credentialed fetch through the download queue. */
export function fetchAsset(url: string, signal?: AbortSignal): Promise<Response> {
  return slot(async () => {
    const res = await fetch(url, { credentials: "same-origin", cache: "force-cache", signal });
    if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
    return res;
  });
}

const metaCache = new Map<string, Promise<AssetRender | null>>();

/**
 * The asset's render view (variants, sizes, mini bounds, overrides); null if it's gone or not readable. DMs and a
 * player's own uploads come back as the full record, which also lands in the Library.
 */
export function assetMeta(id: string): Promise<AssetRender | null> {
  const known = useLibrary.getState().renders.get(id);
  if (known) return Promise.resolve(known);
  let p = metaCache.get(id);
  if (!p) {
    p = fetch(`/api/assets/${id}`, { credentials: "same-origin" })
      .then(async (r) => (r.ok ? ((await r.json()) as { data: AssetRender | AssetItem }).data : null))
      .catch(() => null);
    metaCache.set(id, p);
    void p.then((a) => {
      if (!a) metaCache.delete(id);
      else if ("name" in a) useLibrary.getState().upsert([a as AssetItem]);
      else useLibrary.getState().upsertRenders([a]);
    });
  }
  return p;
}

/** The full record (DM tools): the Library's copy, or a fresh fetch. */
export async function assetDetails(id: string): Promise<AssetItem | null> {
  const known = useLibrary.getState().assets.get(id);
  if (known) return known;
  const a = await assetMeta(id);
  return a && "name" in a ? (a as AssetItem) : null;
}

/**
 * The largest image variant that fits `maxSize` on its long edge (the device's MAX_TEXTURE_SIZE and the tier's
 * cap, AC-BRD-06); the smallest one if none fits.
 */
export function pickImageVariant(asset: Pick<AssetRender, "variants">, maxSize: number) {
  const sized = asset.variants
    .filter((v) => v.width && v.height)
    .sort((a, b) => Math.max(b.width ?? 0, b.height ?? 0) - Math.max(a.width ?? 0, a.height ?? 0));
  return (
    sized.find((v) => Math.max(v.width ?? 0, v.height ?? 0) <= maxSize) ?? sized.at(-1) ?? asset.variants[0]
  );
}

/** Warms the HTTP cache with the variants the board will use (SPEC §8.3 Preload). */
export async function preloadAssets(ids: string[], maxTexture = 4096): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      const meta = await assetMeta(id);
      if (!meta) return;
      const v = meta.cls === "model" ? meta.variants[0] : pickImageVariant(meta, maxTexture);
      if (v)
        await fetchAsset(assetUrl(id, v.name))
          .then((r) => r.arrayBuffer())
          .catch(() => {});
    }),
  );
}
