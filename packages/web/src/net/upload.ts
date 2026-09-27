import type { AssetItem } from "../state/library.ts";
import { useLibrary } from "../state/library.ts";

export type UploadPurpose = AssetItem["purpose"];

const MB = 1024 * 1024;
/** Client-side mirror of the server's caps (SPEC §8.16), so an oversized file is refused before it's sent. */
const CAP: Record<UploadPurpose, { bytes: number; what: string }> = {
  map: { bytes: 80 * MB, what: "Maps" },
  mini: { bytes: 60 * MB, what: "3D minis" },
  token: { bytes: 25 * MB, what: "Token images" },
  portrait: { bytes: 25 * MB, what: "Portraits" },
  art: { bytes: 25 * MB, what: "Drawings" },
  handout: { bytes: 25 * MB, what: "Handouts" },
  audio: { bytes: 50 * MB, what: "Audio files" },
};

export class UploadError extends Error {}

/** Readable reason for a file the server would refuse by name alone (it still checks the content). */
export function precheck(file: File, purpose: UploadPurpose): string | null {
  const cap = CAP[purpose];
  if (file.size > cap.bytes)
    return `${cap.what} can be at most ${cap.bytes / MB} MB — this file is ${(file.size / MB).toFixed(1)} MB.`;
  if (/\.svg$/i.test(file.name))
    return "SVG images aren't accepted (they can contain scripts) — export it as PNG or WebP.";
  if (/\.(fbx|obj|stl|gltf)$/i.test(file.name) && (purpose === "mini" || purpose === "map"))
    return "Only single-file .glb models are accepted — export it as .glb from Blender (File → Export → glTF 2.0, Format: glTF Binary).";
  return null;
}

function csrf(): string {
  const m = /(?:^|;\s*)gloam_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1] as string) : "";
}

/**
 * Uploads one file (SPEC §21.1) with progress. XHR rather than fetch: fetch can't report upload progress. The
 * server detects the type from the content; the purpose picks size limits and variants.
 */
export function uploadAsset(
  file: File,
  purpose: UploadPurpose,
  opts: { name?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<AssetItem> {
  const pre = precheck(file, purpose);
  if (pre) return Promise.reject(new UploadError(pre));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ purpose, ...(opts.name ? { name: opts.name } : {}) });
    xhr.open("POST", `/api/assets?${q}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-gloam-csrf", csrf());
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { data?: { asset: AssetItem }; error?: { message: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.data) {
        useLibrary.getState().upsert([body.data.asset]);
        resolve(body.data.asset);
      } else reject(new UploadError(body?.error?.message ?? `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(new UploadError("The upload was interrupted — check your connection and try again."));
    xhr.onabort = () => reject(new UploadError("Upload cancelled."));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}
