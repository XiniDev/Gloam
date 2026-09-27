import { SIZE_BASE_FT } from "@gloam/shared/constants";
import { Box } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { request, useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { type AssetItem, useLibrary } from "../state/library.ts";
import { useUi } from "../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Segmented, Select, Toggle } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { TextInput } from "../ui/Field.tsx";
import { toast } from "../ui/Toast.tsx";
import { UploadZone } from "./dm/UploadZone.tsx";
import { useAssetImage } from "./useAssetImage.ts";

type Size = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan" | "custom";
type Disposition = "hostile" | "neutral" | "friendly" | "party";
type Look = "none" | "image" | "model";

const SPEEDS = ["walk", "fly", "swim", "climb", "burrow"] as const;
const SENSES = ["darkvision", "blindsight", "tremorsense", "truesight"] as const;
const LABEL: Record<string, string> = {
  walk: "Walk",
  fly: "Fly",
  swim: "Swim",
  climb: "Climb",
  burrow: "Burrow",
  darkvision: "Darkvision",
  blindsight: "Blindsight",
  tremorsense: "Tremorsense",
  truesight: "Truesight",
};

interface Form {
  name: string;
  size: Size;
  customFt: string;
  hp: string;
  hpMax: string;
  ac: string;
  speeds: Record<(typeof SPEEDS)[number], string>;
  hover: boolean;
  senses: Record<(typeof SENSES)[number], string>;
  disposition: Disposition;
  look: Look;
  assetId: string | null;
  hidden: boolean;
}

const blank = (): Form => ({
  name: "",
  size: "medium",
  customFt: "5",
  hp: "",
  hpMax: "10",
  ac: "12",
  speeds: { walk: "30", fly: "0", swim: "0", climb: "0", burrow: "0" },
  hover: false,
  senses: { darkvision: "0", blindsight: "0", tremorsense: "0", truesight: "0" },
  disposition: "hostile",
  look: "none",
  assetId: null,
  hidden: false,
});

/** Parses a whole number field; null when it isn't one or is outside [min, max]. */
function int(v: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

function Num({
  label,
  value,
  onChange,
  error,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: boolean;
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="caps mb-1 block text-12 text-fog">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          inputMode="numeric"
          value={value}
          aria-invalid={error || undefined}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => e.target.select()}
          className={`h-9 w-full rounded-[var(--radius-control)] border bg-ink-900 px-2 text-15 text-bone tabular-nums focus:border-brass ${
            error ? "border-danger" : "border-line hover:border-line-strong"
          } ${suffix ? "pr-7" : ""}`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-12 text-faint">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ArtTile({ a, chosen, onPick }: { a: AssetItem; chosen: boolean; onPick: () => void }) {
  const src = useAssetImage(a.cls === "image" ? a.id : null, 128);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={chosen}
      title={a.name}
      className={`flex flex-col overflow-hidden rounded-[var(--radius-control)] border text-left ${
        chosen ? "border-brass shadow-[var(--ring-focus)]" : "border-line hover:border-[var(--brass-600)]"
      }`}
    >
      <span className="grid aspect-square place-items-center bg-ink-900 text-brass">
        {src ? <img src={src} alt="" className="h-full w-full object-contain" /> : <Box size={20} />}
      </span>
      <span className="truncate px-1.5 py-0.5 text-12 text-bone">{a.name}</span>
    </button>
  );
}

/** Library art for the unit: approved token/portrait images or minis, plus an upload. */
function ArtPicker({
  look,
  value,
  onPick,
}: {
  look: "image" | "model";
  value: string | null;
  onPick: (id: string) => void;
}) {
  const assets = useLibrary((s) => s.assets);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    void request<AssetItem[]>("asset.list", { tab: look === "model" ? "minis" : "tokens" }).then(
      (l) => useLibrary.getState().upsert(l),
      () => {},
    );
  }, [look]);
  const items = [...assets.values()]
    .filter(
      (a) =>
        !a.deleted &&
        a.status === "approved" &&
        (look === "model"
          ? a.purpose === "mini"
          : a.cls === "image" && ["token", "portrait", "art"].includes(a.purpose)),
    )
    .sort((x, y) => y.createdAt - x.createdAt);
  return (
    <div className="flex flex-col gap-2">
      {items.length ? (
        <ul className="grid max-h-[180px] grid-cols-5 gap-1.5 overflow-y-auto" aria-label="Library art">
          {items.map((a) => (
            <li key={a.id}>
              <ArtTile a={a} chosen={value === a.id} onPick={() => onPick(a.id)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-13 text-muted">
          {look === "model" ? "No minis in the Library yet." : "No token art in the Library yet."}
        </p>
      )}
      {uploading ? (
        <UploadZone
          purpose={look === "model" ? "mini" : "token"}
          hint={
            look === "model" ? "Drop a .glb mini here." : "Drop token art here (PNG, JPEG, WebP, GIF, AVIF)."
          }
          onUploaded={(a) => {
            setUploading(false);
            onPick(a.id);
          }}
        />
      ) : (
        <Button size="S" variant="ghost" onClick={() => setUploading(true)}>
          Upload new…
        </Button>
      )}
    </div>
  );
}

/**
 * Quick Unit (SPEC §8.5 Creation; AC-TOK-09): "any unit with any values" in one submit — a sheetless, unlinked token
 * with its own stats, placed where the DM's cursor was (or the view's centre).
 */
export function QuickUnitDialog() {
  const at = useUi((s) => s.quickUnit);
  const sceneId = useEntities((s) => boardData(s).scene?.id ?? null);
  const role = useTable((s) => s.me?.role);
  const [f, setF] = useState<Form>(blank);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh form each time the dialog opens
  useEffect(() => {
    if (!at) return;
    setF((prev) => ({ ...blank(), disposition: prev.disposition, look: prev.look }));
    setTried(false);
  }, [at === null]);

  const close = () => useUi.getState().set({ quickUnit: null });
  const up = (p: Partial<Form>) => setF((cur) => ({ ...cur, ...p }));

  const hpMax = int(f.hpMax, 0, 99_999);
  const hp = f.hp.trim() === "" ? hpMax : int(f.hp, -9999, 99_999);
  const ac = int(f.ac, 0, 99);
  const customFt = int(f.customFt, 1, 200);
  const speeds = Object.fromEntries(SPEEDS.map((k) => [k, int(f.speeds[k], 0, 5000)])) as Record<
    (typeof SPEEDS)[number],
    number | null
  >;
  const senses = Object.fromEntries(SENSES.map((k) => [k, int(f.senses[k], 0, 5000)])) as Record<
    (typeof SENSES)[number],
    number | null
  >;
  const errors = {
    name: !f.name.trim() ? "Give it a name." : null,
    hpMax: hpMax === null,
    hp: hp === null,
    ac: ac === null,
    customFt: f.size === "custom" && customFt === null,
    speeds: SPEEDS.filter((k) => speeds[k] === null),
    senses: SENSES.filter((k) => senses[k] === null),
    art: f.look !== "none" && !f.assetId,
  };
  const valid =
    !errors.name &&
    !errors.hpMax &&
    !errors.hp &&
    !errors.ac &&
    !errors.customFt &&
    !errors.speeds.length &&
    !errors.senses.length &&
    !errors.art;

  const submit = async () => {
    setTried(true);
    if (!valid || !sceneId || !at) return;
    setBusy(true);
    const size = f.size === "custom" ? "medium" : f.size;
    try {
      const r = await request<{ tokenId: string }>("token.create", {
        sceneId,
        name: f.name.trim(),
        pos: at,
        size,
        ...(f.size === "custom" ? { sizeFt: customFt } : {}),
        disposition: f.disposition,
        link: "unlinked",
        hidden: f.hidden,
        appearance: {
          mode: f.look === "model" ? "model" : "auto",
          ...(f.assetId && f.look !== "none" ? { assetId: f.assetId } : {}),
          scale: 1,
          offsetY: 0,
          rotationOffsetDeg: 0,
        },
        stats: {
          hp: hp as number,
          hpMax: hpMax as number,
          ac: ac as number,
          speeds: { ...(speeds as Record<string, number>), hover: f.hover },
          senses,
          size,
        },
      });
      useUi.getState().select([r.tokenId]);
      toast.success(`${f.name.trim()} is on the table`);
      close();
    } catch (e) {
      toast.danger("Couldn't create the unit", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dm = role === "dm" || role === "admin";
  return (
    <Dialog
      open={Boolean(at) && dm}
      onClose={close}
      width={600}
      title="Quick unit"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!sceneId} onClick={() => void submit()}>
            Place unit
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!sceneId ? (
          <p className="text-14 text-[var(--ember-400)]">There's no scene to place it in yet.</p>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <TextInput
            label="Name"
            value={f.name}
            maxLength={80}
            autoFocus
            error={tried ? errors.name : null}
            onChange={(e) => up({ name: e.target.value })}
          />
          <Select<Disposition>
            label="Disposition"
            value={f.disposition}
            onChange={(disposition) => up({ disposition })}
            options={[
              { value: "hostile", label: "Hostile" },
              { value: "neutral", label: "Neutral" },
              { value: "friendly", label: "Friendly" },
              { value: "party", label: "Party" },
            ]}
          />
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Select<Size>
            label="Size"
            value={f.size}
            onChange={(size) => up({ size })}
            options={[
              ...(["tiny", "small", "medium", "large", "huge", "gargantuan"] as const).map((s) => ({
                value: s,
                label: `${s[0]?.toUpperCase()}${s.slice(1)} · ${SIZE_BASE_FT[s]} ft`,
              })),
              { value: "custom", label: "Custom…" },
            ]}
          />
          {f.size === "custom" ? (
            <div className="w-28">
              <Num
                label="Space"
                suffix="ft"
                value={f.customFt}
                error={tried && errors.customFt}
                onChange={(customFt) => up({ customFt })}
              />
            </div>
          ) : (
            <span className="w-28" />
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Num label="HP" value={f.hp} error={tried && errors.hp} onChange={(v) => up({ hp: v })} />
          <Num
            label="Max HP"
            value={f.hpMax}
            error={tried && errors.hpMax}
            onChange={(v) => up({ hpMax: v })}
          />
          <Num label="AC" value={f.ac} error={tried && errors.ac} onChange={(v) => up({ ac: v })} />
        </div>
        <fieldset className="grid grid-cols-5 gap-2">
          <legend className="caps mb-1.5 text-12 text-brass">Speed</legend>
          {SPEEDS.map((k) => (
            <Num
              key={k}
              label={LABEL[k] as string}
              suffix="ft"
              value={f.speeds[k]}
              error={tried && errors.speeds.includes(k)}
              onChange={(v) => up({ speeds: { ...f.speeds, [k]: v } })}
            />
          ))}
        </fieldset>
        {Number(f.speeds.fly) > 0 ? (
          <Toggle label="Hovers" checked={f.hover} onChange={(hover) => up({ hover })} />
        ) : null}
        <fieldset className="grid grid-cols-4 gap-2">
          <legend className="caps mb-1.5 text-12 text-brass">Senses</legend>
          {SENSES.map((k) => (
            <Num
              key={k}
              label={LABEL[k] as string}
              suffix="ft"
              value={f.senses[k]}
              error={tried && errors.senses.includes(k)}
              onChange={(v) => up({ senses: { ...f.senses, [k]: v } })}
            />
          ))}
        </fieldset>
        <div className="flex flex-col gap-2">
          <Segmented<Look>
            label="Appearance"
            size="S"
            value={f.look}
            onChange={(look) => up({ look, assetId: null })}
            options={[
              { value: "none", label: "Initials" },
              { value: "image", label: "Image" },
              { value: "model", label: "3D model" },
            ]}
          />
          {f.look !== "none" ? (
            <ArtPicker look={f.look} value={f.assetId} onPick={(assetId) => up({ assetId })} />
          ) : null}
          {tried && errors.art ? (
            <p role="alert" className="text-13 text-[var(--ember-400)]">
              Choose the art, or switch to Initials.
            </p>
          ) : null}
        </div>
        <Toggle
          label="Place hidden"
          description="Only DMs see it until you reveal it"
          checked={f.hidden}
          onChange={(hidden) => up({ hidden })}
        />
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
