import { useEffect, useState } from "react";
import { assetMeta, assetUrl, pickImageVariant } from "../net/assets.ts";

/** A same-origin URL for an image asset's variant that fits `maxSize` (thumbnails, previews); null until known. */
export function useAssetImage(assetId: string | null | undefined, maxSize: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void assetMeta(assetId).then((m) => {
      if (cancelled || !m || m.cls !== "image") return;
      const v = pickImageVariant(m, maxSize);
      if (v) setUrl(assetUrl(assetId, v.name));
    });
    return () => {
      cancelled = true;
    };
  }, [assetId, maxSize]);
  return url;
}
