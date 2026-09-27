import { Box, Image as ImageIcon, Layers, Library, Square } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { FLOOR_LABELS } from "../../board/floors.ts";
import type { FloorStyle } from "../../board/scene.ts";
import { assetMeta } from "../../net/assets.ts";
import { openPrep, request } from "../../net/table.ts";
import type { AssetItem } from "../../state/library.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { TextInput } from "../../ui/Field.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { CalibrationEditor } from "./CalibrationEditor.tsx";
import { FloorPicker } from "./FloorPicker.tsx";
import { UploadZone } from "./UploadZone.tsx";

type Source = "image" | "model" | "library" | "procedural" | "blank";
type Step = "source" | "upload" | "library" | "floor" | "calibrate" | "name";
type Ambient = "bright" | "dim" | "dark";

const SOURCES: { id: Source; title: string; body: string; icon: ReactElement }[] = [
  {
    id: "image",
    title: "Upload a map image",
    body: "A battle map: PNG, JPEG, WebP, GIF or AVIF, up to 16 384 px a side.",
    icon: <ImageIcon size={22} />,
  },
  {
    id: "model",
    title: "Upload a 3D map",
    body: "A single .glb file. You'll align it on the table and can generate its walls.",
    icon: <Box size={22} />,
  },
  {
    id: "library",
    title: "From the Library",
    body: "A map you or your players uploaded before.",
    icon: <Library size={22} />,
  },
  {
    id: "procedural",
    title: "Procedural floor",
    body: "Stone, planks, grass, sand, parchment or cavern rock — no image needed.",
    icon: <Layers size={22} />,
  },
  {
    id: "blank",
    title: "Blank table",
    body: "A plain parchment sheet to sketch on.",
    icon: <Square size={22} />,
  },
];

function LibraryMaps({ onPick }: { onPick: (a: AssetItem) => void }) {
  const [items, setItems] = useState<AssetItem[] | null>(null);
  useEffect(() => {
    void request<AssetItem[]>("asset.list", { tab: "maps" }).then(setItems, () => setItems([]));
  }, []);
  if (!items) return <p className="text-14 text-muted">Opening the Library…</p>;
  if (!items.length)
    return <p className="text-14 text-muted">No maps in the Library yet — upload one instead.</p>;
  return (
    <ul className="grid max-h-[360px] grid-cols-3 gap-2 overflow-y-auto">
      {items.map((a) => (
        <li key={a.id}>
          <MapTile a={a} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

function MapTile({ a, onPick }: { a: AssetItem; onPick: (a: AssetItem) => void }) {
  const src = useAssetImage(a.cls === "image" ? a.id : null, 256);
  return (
    <button
      type="button"
      onClick={() => onPick(a)}
      className="flex w-full flex-col overflow-hidden rounded-[var(--radius-control)] border border-line text-left hover:border-brass focus-visible:border-brass"
    >
      <span className="grid aspect-[4/3] place-items-center bg-ink-900 text-brass">
        {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <Box size={22} />}
      </span>
      <span className="truncate px-2 py-1 text-13 text-bone">{a.name}</span>
    </button>
  );
}

/**
 * New scene wizard (SPEC §8.3): source → upload or choose → calibrate (image maps) → name. The new scene opens in
 * prep view, so players see nothing of it until the DM activates it.
 */
export function NewSceneWizard({
  open,
  onClose,
  initialAssetId,
}: {
  open: boolean;
  onClose: () => void;
  /** A map dropped from the Library onto the board: start at its calibration (or naming). */
  initialAssetId?: string;
}) {
  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<Source>("image");
  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [floor, setFloor] = useState<FloorStyle>("stone");
  const [widthFt, setWidthFt] = useState("60");
  const [heightFt, setHeightFt] = useState("40");
  const [ftPerPx, setFtPerPx] = useState(5 / 70);
  const [name, setName] = useState("");
  const [ambient, setAmbient] = useState<Ambient>("bright");
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time the wizard opens
  useEffect(() => {
    if (!open) return;
    setStep("source");
    setAsset(null);
    setName("");
    setFtPerPx(5 / 70);
    if (initialAssetId) {
      setSource("library");
      void assetMeta(initialAssetId).then((a) => {
        if (a) picked(a);
      });
    }
  }, [open, initialAssetId]);

  const picked = (a: AssetItem) => {
    setAsset(a);
    setName((n) => n || a.name);
    setStep(a.cls === "image" ? "calibrate" : "name");
  };

  const back = () => {
    const prev: Record<Step, Step> = {
      source: "source",
      upload: "source",
      library: "source",
      floor: "source",
      calibrate: source === "library" ? "library" : "upload",
      name:
        source === "procedural" || source === "blank"
          ? "floor"
          : asset?.cls === "image"
            ? "calibrate"
            : source === "library"
              ? "library"
              : "upload",
    };
    setStep(prev[step]);
  };

  const create = async () => {
    setBusy(true);
    try {
      const w = Number(widthFt);
      const h = Number(heightFt);
      const base = { name: name.trim() || "Untitled scene", ambient };
      const payload =
        asset?.cls === "image"
          ? { ...base, mapKind: "image", mapAssetId: asset.id, pxPer5ft: 5 / ftPerPx }
          : asset?.cls === "model"
            ? { ...base, mapKind: "model", mapAssetId: asset.id }
            : {
                ...base,
                mapKind: source === "blank" ? "blank" : "procedural",
                floorStyle: source === "blank" ? "parchment" : floor,
                widthFt: w,
                heightFt: h,
              };
      const { sceneId } = await request<{ sceneId: string }>("scene.create", payload);
      await openPrep(sceneId);
      toast.success("Scene created", "You're preparing it — players can't see it until you activate it.");
      onClose();
    } catch (e) {
      toast.danger("Couldn't create the scene", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dimsValid =
    Number(widthFt) >= 10 && Number(widthFt) <= 5000 && Number(heightFt) >= 10 && Number(heightFt) <= 5000;
  const titles: Record<Step, string> = {
    source: "New scene",
    upload: source === "model" ? "Upload a 3D map" : "Upload a map image",
    library: "Choose a map",
    floor: source === "blank" ? "Blank table" : "Procedural floor",
    calibrate: "Calibrate the map",
    name: "Name the scene",
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={step === "calibrate" ? 780 : 640}
      title={titles[step]}
      footer={
        <>
          {step !== "source" ? (
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === "floor" ? (
            <Button
              variant="primary"
              disabled={!dimsValid}
              onClick={() => {
                setName((n) => n || (source === "blank" ? "Blank table" : FLOOR_LABELS[floor]));
                setStep("name");
              }}
            >
              Next
            </Button>
          ) : step === "calibrate" ? (
            <Button variant="primary" onClick={() => setStep("name")}>
              Next
            </Button>
          ) : step === "name" ? (
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              Create scene
            </Button>
          ) : null}
        </>
      }
    >
      {step === "source" ? (
        <ul className="grid gap-2">
          {SOURCES.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  setSource(s.id);
                  setAsset(null);
                  setStep(
                    s.id === "image" || s.id === "model"
                      ? "upload"
                      : s.id === "library"
                        ? "library"
                        : "floor",
                  );
                }}
                className="flex w-full items-start gap-3 rounded-[var(--radius-panel)] border border-line px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:border-brass hover:bg-raised focus-visible:border-brass"
              >
                <span className="mt-0.5 text-brass">{s.icon}</span>
                <span>
                  <span className="block text-16 font-bold text-bone">{s.title}</span>
                  <span className="block text-13 text-muted">{s.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {step === "upload" ? (
        <UploadZone
          purpose="map"
          accept={source === "model" ? ".glb" : "image/png,image/jpeg,image/webp,image/gif,image/avif"}
          hint={
            source === "model"
              ? "Drop a .glb here. Export from Blender with File → Export → glTF 2.0 (Format: glTF Binary)."
              : "Drop a map image here. Large maps are fine — each device loads the size it can handle."
          }
          onUploaded={picked}
        />
      ) : null}
      {step === "library" ? <LibraryMaps onPick={picked} /> : null}
      {step === "floor" ? (
        <div className="flex flex-col gap-4">
          {source === "procedural" ? <FloorPicker value={floor} onChange={setFloor} /> : null}
          <div className="flex gap-3">
            <TextInput
              label="Width (ft)"
              inputMode="numeric"
              value={widthFt}
              onChange={(e) => setWidthFt(e.target.value)}
              className="w-32"
            />
            <TextInput
              label="Depth (ft)"
              inputMode="numeric"
              value={heightFt}
              onChange={(e) => setHeightFt(e.target.value)}
              className="w-32"
            />
          </div>
          {!dimsValid ? <p className="text-13 text-[var(--ember-400)]">Sizes are 10 – 5000 ft.</p> : null}
        </div>
      ) : null}
      {step === "calibrate" && asset ? (
        <CalibrationEditor
          assetId={asset.id}
          imageW={asset.width ?? 1}
          imageH={asset.height ?? 1}
          ftPerPx={ftPerPx}
          onChange={setFtPerPx}
        />
      ) : null}
      {step === "name" ? (
        <div className="flex flex-col gap-4">
          <TextInput
            label="Scene name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <div>
            <p className="caps mb-1.5 text-12 text-fog">Light</p>
            <Segmented<Ambient>
              label="Ambient light"
              value={ambient}
              onChange={setAmbient}
              options={[
                { value: "bright", label: "Daylight" },
                { value: "dim", label: "Dusk" },
                { value: "dark", label: "Underground" },
              ]}
            />
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
