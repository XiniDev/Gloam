import { ImageUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadAsset } from "../../net/upload.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { Slider } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { CUTOUT_DEFAULTS, type CutoutOptions } from "./cutout.ts";

type Result = { width: number; height: number; data: Uint8ClampedArray };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: Result | { error: string }) => void>();
function run(bitmap: ImageBitmap, max: number, options: CutoutOptions): Promise<Result> {
  if (!worker) {
    worker = new Worker(new URL("./cutout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number } & (Result | { error: string })>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) => ("error" in r ? reject(new Error(r.error)) : resolve(r)));
    worker?.postMessage({ id, bitmap, max, options });
  });
}

/** Pixels onto a canvas. */
function paint(canvas: HTMLCanvasElement, r: Result): void {
  canvas.width = r.width;
  canvas.height = r.height;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
}

/**
 * Paper cutout (SPEC §8.10 Character art, AC-SHEET-11): a phone photo of a drawing on paper becomes a sticker — the
 * paper taken away, a white outline and a soft shadow added — with a live preview while the tolerance and outline
 * are adjusted. The sticker goes through the usual upload (a player's waits for the DM's approval), then becomes the
 * portrait or the token.
 */
export function PaperCutout({
  open,
  onClose,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  onUse: (assetId: string, as: "portrait" | "token") => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [opts, setOpts] = useState<CutoutOptions>(CUTOUT_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(async (f: File) => {
    try {
      setBitmap(await createImageBitmap(f, { imageOrientation: "from-image" }));
    } catch {
      toast.danger("Couldn't open that photo", "Try a JPEG or PNG.");
    }
  }, []);
  // The live preview, at a size that keeps up with the sliders.
  useEffect(() => {
    if (!bitmap) return;
    let cancelled = false;
    setWorking(true);
    const t = window.setTimeout(() => {
      void run(bitmap, 900, opts)
        .then((r) => {
          if (!cancelled && preview.current) paint(preview.current, r);
        })
        .catch((e) => toast.danger("Couldn't cut it out", (e as Error).message))
        .finally(() => !cancelled && setWorking(false));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [bitmap, opts]);
  useEffect(() => {
    if (!open) return;
    // Test builds: a journey hands in a photo (no file dialog to drive).
    provideTestHook("cutoutPhoto", async (b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      await load(new File([bytes], "photo.png", { type: "image/png" }));
    });
  }, [open, load]);
  const use = async (as: "portrait" | "token") => {
    if (!bitmap) return;
    setBusy(true);
    try {
      const r = await run(bitmap, 2048, opts);
      const canvas = document.createElement("canvas");
      paint(canvas, r);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("The sticker couldn't be saved.");
      const asset = await uploadAsset(new File([blob], "sticker.png", { type: "image/png" }), as, {
        name: "Sticker",
      });
      if (asset.status === "approved") {
        onUse(asset.id, as);
        toast.success(as === "portrait" ? "Your new portrait" : "Your new token");
      } else toast.info("Sent to the DM", "It becomes yours to use once they approve it.");
      setBitmap(null);
      onClose();
    } catch (e) {
      toast.danger("Couldn't save the sticker", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="From a photo of paper"
      description="Draw on paper, photograph it on a plain background, and the paper is taken away."
      width={620}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" loading={busy} disabled={!bitmap} onClick={() => void use("token")}>
            Use as token
          </Button>
          <Button variant="primary" loading={busy} disabled={!bitmap} onClick={() => void use("portrait")}>
            Use as portrait
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="paper-cutout">
        <input
          ref={file}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(f);
            e.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          size="S"
          icon={<ImageUp size={15} />}
          onClick={() => file.current?.click()}
        >
          {bitmap ? "Choose another photo…" : "Choose a photo…"}
        </Button>
        <div
          className="grid min-h-48 place-items-center rounded-[var(--radius-control)] border border-line p-2"
          // A checkerboard shows what's transparent.
          style={{
            backgroundImage:
              "linear-gradient(45deg, var(--ink-800) 25%, transparent 25%), linear-gradient(-45deg, var(--ink-800) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--ink-800) 75%), linear-gradient(-45deg, transparent 75%, var(--ink-800) 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
          }}
        >
          {bitmap ? (
            <canvas
              ref={preview}
              data-testid="cutout-preview"
              className="max-h-80 max-w-full"
              aria-label="The sticker"
            />
          ) : (
            <p className="text-14 text-muted">No photo yet.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Slider
            label="Paper tolerance"
            value={opts.tolerance}
            min={4}
            max={40}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(tolerance) => setOpts((o) => ({ ...o, tolerance }))}
          />
          <Slider
            label="Outline"
            value={opts.outline}
            min={0}
            max={24}
            step={1}
            format={(v) => `${Math.round(v)} px`}
            onChange={(outline) => setOpts((o) => ({ ...o, outline }))}
          />
        </div>
        {working ? <p className="text-12 text-muted">Cutting out…</p> : null}
      </div>
    </Dialog>
  );
}
