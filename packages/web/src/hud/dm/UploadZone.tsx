import { UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { type UploadPurpose, uploadAsset } from "../../net/upload.ts";
import type { AssetItem } from "../../state/library.ts";
import { Button } from "../../ui/Button.tsx";

const ACCEPT: Partial<Record<UploadPurpose, string>> = {
  map: "image/png,image/jpeg,image/webp,image/gif,image/avif,.glb",
  mini: ".glb",
  token: "image/png,image/jpeg,image/webp,image/gif,image/avif",
  portrait: "image/png,image/jpeg,image/webp,image/gif,image/avif",
  art: "image/png,image/jpeg,image/webp,image/gif,image/avif",
  handout: "image/png,image/jpeg,image/webp,image/gif,image/avif",
  audio: "audio/*,.mp3,.ogg,.wav,.m4a,.flac",
};

/**
 * A drop zone + file picker with a parchment progress bar (SPEC §21.1). The server decides the type by content;
 * errors stay inline, in plain words.
 */
export function UploadZone({
  purpose,
  hint,
  accept,
  onUploaded,
}: {
  purpose: UploadPurpose;
  hint: string;
  accept?: string;
  onUploaded: (a: AssetItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<{ name: string; f: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (file: File) => {
    setError(null);
    setProgress({ name: file.name, f: 0 });
    try {
      const a = await uploadAsset(file, purpose, { onProgress: (f) => setProgress({ name: file.name, f }) });
      setProgress(null);
      onUploaded(a);
    } catch (e) {
      setProgress(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void send(f);
        }}
        className={`flex flex-col items-center gap-3 rounded-[var(--radius-panel)] border border-dashed px-6 py-8 text-center transition-colors duration-[var(--dur-fast)] ${
          over ? "border-brass bg-[var(--glow-brass-soft)]" : "border-line"
        }`}
      >
        <UploadCloud size={28} className="text-brass" aria-hidden />
        <p className="max-w-[40ch] text-14 text-muted">{hint}</p>
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={Boolean(progress)}>
          Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label="File to upload"
          accept={accept ?? ACCEPT[purpose]}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void send(f);
          }}
        />
      </div>
      {progress ? (
        <div
          role="progressbar"
          aria-label={`Uploading ${progress.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.f * 100)}
        >
          <div className="mb-1 flex justify-between text-12 text-fog">
            <span className="truncate">{progress.name}</span>
            <span className="tabular">
              {progress.f >= 1 ? "Processing…" : `${Math.round(progress.f * 100)}%`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-[2px] bg-[var(--parchment-400)]/25">
            <div
              className="h-full bg-[var(--parchment-200)] transition-[width] duration-[var(--dur-fast)]"
              style={{ width: `${progress.f * 100}%` }}
            />
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-13 text-[var(--ember-400)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
