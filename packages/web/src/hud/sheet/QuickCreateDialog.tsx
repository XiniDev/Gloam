import { useMemo, useState } from "react";
import { request, useTable } from "../../net/table.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { TextInput } from "../../ui/Field.tsx";
import { LoadFailed, useLoad } from "../../ui/Loadable.tsx";
import { toast } from "../../ui/Toast.tsx";
import { AssetPicker } from "./AssetPicker.tsx";
import { isDmRole } from "./sheetActions.ts";

interface TemplateItem {
  id: string;
  name: string;
  blocks: number;
}

/**
 * Quick create (SPEC §8.10, AC-SHEET-01): a playable character in one dialog — name, class and level, max HP, AC,
 * speed, darkvision and art; the rest can be filled in later. Optionally from a template's custom blocks. A DM can
 * make one for a player. Made for someone at the table, it's placed at the party spawn at once.
 */
export function QuickCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useTable((s) => s.me);
  const dm = isDmRole(me?.role);
  const presence = useTable((s) => s.presence);
  const players = useMemo(() => presence.filter((p) => p.role === "player"), [presence]);
  const [f, setF] = useState({
    name: "",
    classLevel: "",
    hpMax: "10",
    ac: "10",
    speed: "30",
    darkvision: "0",
    ownerUserId: "",
    templateId: "",
    portraitAssetId: undefined as string | undefined,
    tokenAssetId: undefined as string | undefined,
  });
  // The campaign's templates (optional: none, and the choice isn't offered; a failure says so, with Try again).
  const loadedTemplates = useLoad(
    () => (open ? request<TemplateItem[]>("template.list", {}) : Promise.resolve([])),
    [open],
  );
  const templates = loadedTemplates.data ?? [];
  const [busy, setBusy] = useState(false);
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  const valid = f.name.trim().length > 0 && num(f.hpMax) >= 1;
  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const { actorId } = await request<{ actorId: string }>("actor.quickCreate", {
        name: f.name.trim(),
        classLevel: f.classLevel.trim(),
        hpMax: num(f.hpMax),
        ac: num(f.ac),
        speed: num(f.speed),
        darkvision: num(f.darkvision),
        ...(f.portraitAssetId ? { portraitAssetId: f.portraitAssetId } : {}),
        ...(f.tokenAssetId ? { tokenAssetId: f.tokenAssetId } : {}),
        ...(dm && f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
        ...(f.templateId ? { templateId: f.templateId } : {}),
      });
      useUi.getState().set({ sheetActor: actorId, dock: "sheet", sheetTab: "overview" });
      toast.success(`${f.name.trim()} is ready`, "Fill in the rest of the sheet whenever you like.");
      setF((x) => ({ ...x, name: "", classLevel: "" }));
      onClose();
    } catch (e) {
      toast.danger("Couldn't make the character", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (
    key: keyof typeof f,
    label: string,
    opts: { inputMode?: "numeric"; placeholder?: string; first?: boolean } = {},
  ) => (
    <TextInput
      label={label}
      value={f[key] as string}
      inputMode={opts.inputMode}
      placeholder={opts.placeholder}
      data-autofocus={opts.first || undefined}
      onChange={(e) =>
        setF((x) => ({ ...x, [key]: opts.inputMode ? e.target.value.replace(/\D/g, "") : e.target.value }))
      }
      onKeyDown={(e) => e.key === "Enter" && void create()}
    />
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Quick create"
      description="Enough to play: the rest of the sheet can wait."
      width={560}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void create()}>
            Create character
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3" data-testid="quick-create">
        <div className="col-span-2">
          {field("name", "Name", { placeholder: "Thorin Emberhand", first: true })}
        </div>
        <div className="col-span-2">
          {field("classLevel", "Class and level", { placeholder: "Fighter 3 / Wizard 2" })}
        </div>
        {field("hpMax", "Max HP", { inputMode: "numeric" })}
        {field("ac", "AC", { inputMode: "numeric" })}
        {field("speed", "Speed (ft)", { inputMode: "numeric" })}
        {field("darkvision", "Darkvision (ft)", { inputMode: "numeric" })}
        {dm ? (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">For</span>
            <select
              value={f.ownerUserId}
              onChange={(e) => setF((x) => ({ ...x, ownerUserId: e.target.value }))}
              className="h-11 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-16 text-bone"
            >
              <option value="">No one yet (the DM's)</option>
              {players.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {loadedTemplates.status === "error" ? (
          <div className="col-span-2">
            <LoadFailed
              what="the templates"
              error={loadedTemplates.error}
              retry={loadedTemplates.retry}
              compact
            />
          </div>
        ) : null}
        {templates.length ? (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">Custom blocks from a template</span>
            <select
              value={f.templateId}
              onChange={(e) => setF((x) => ({ ...x, templateId: e.target.value }))}
              className="h-11 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-16 text-bone"
            >
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.blocks} block{t.blocks === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="col-span-2 grid grid-cols-2 gap-3 rounded-[var(--radius-control)] border border-dashed border-brass-deep/50 p-3">
          <AssetPicker
            label="Portrait"
            purpose="portrait"
            value={f.portraitAssetId}
            onChange={(id) => setF((x) => ({ ...x, portraitAssetId: id }))}
          />
          <AssetPicker
            label="Token image"
            purpose="token"
            value={f.tokenAssetId}
            onChange={(id) => setF((x) => ({ ...x, tokenAssetId: id }))}
          />
        </div>
      </div>
    </Dialog>
  );
}
