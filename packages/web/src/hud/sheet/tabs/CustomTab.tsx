import { CUSTOM_BLOCK_TYPES, type CustomBlock } from "@gloam/shared/schemas";
import { ArrowDown, ArrowUp, Pin, Plus } from "lucide-react";
import { useState } from "react";
import { useAssetImage } from "../../useAssetImage.ts";
import { AssetPicker } from "../AssetPicker.tsx";
import type { SheetCtx } from "../context.ts";
import { NumberField, SectionTitle, Stepper, TextField } from "../primitives.tsx";
import { RemoveButton } from "./OverviewTab.tsx";

const TYPE_LABEL: Record<CustomBlock["type"], string> = {
  text: "Text",
  number: "Number",
  counter: "Counter",
  checklist: "Checklist",
  table: "Table",
  keyValue: "List of pairs",
  image: "Image",
};

/** A fresh block of a kind (its id unique on this sheet). */
function newBlock(type: CustomBlock["type"], taken: Set<string>): CustomBlock {
  let n = taken.size + 1;
  while (taken.has(`b${n}`)) n++;
  const base = { id: `b${n}`, title: TYPE_LABEL[type] };
  switch (type) {
    case "text":
      return { ...base, type, markdown: "" };
    case "number":
      return { ...base, type, value: 0 };
    case "counter":
      return { ...base, type, value: 0, max: 10, pinToToken: false };
    case "checklist":
      return { ...base, type, items: [] };
    case "table":
      return { ...base, type, columns: ["Name", "Notes"], rows: [] };
    case "keyValue":
      return { ...base, type, entries: [] };
    case "image":
      return { ...base, type };
  }
}

/**
 * Custom blocks (§8.10 Structure 2, AC-SHEET-03): whatever doesn't fit D&D's shape — text, a number, a counter (which
 * can be pinned to the token as a thin bar under its HP), a checklist, a table, a list of pairs, an image. Added,
 * renamed, moved up and down, removed. They never feed the rules.
 */
export function CustomTab({ ctx }: { ctx: SheetCtx }) {
  const blocks = ctx.sheet.custom;
  const ro = !ctx.canEdit;
  const [kind, setKind] = useState<CustomBlock["type"]>("counter");
  const setBlocks = (next: CustomBlock[]) => void ctx.set(["custom"], next);
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j] as CustomBlock, next[i] as CustomBlock];
    setBlocks(next);
  };
  return (
    <div className="flex flex-col gap-2 text-14 text-paper-ink" data-testid="sheet-custom">
      <SectionTitle>Custom blocks</SectionTitle>
      {blocks.length === 0 ? (
        <p className="text-13 italic text-paper-muted">
          Nothing here yet. Custom blocks hold whatever your game adds — a Sanity counter, an oath, a table of
          contacts.
        </p>
      ) : null}
      {blocks.map((b, i) => (
        <section
          key={b.id}
          className="rounded-[var(--radius-control)] border border-parchment-edge/60 p-2"
          data-testid="custom-block"
          data-type={b.type}
        >
          <div className="flex items-center gap-1">
            <TextField
              label={`${TYPE_LABEL[b.type]} block title`}
              value={b.title}
              disabled={ro}
              onCommit={(v) => void ctx.set(["custom", i, "title"], v)}
              className="font-bold"
            />
            <span className="caps shrink-0 text-12 text-paper-muted">{TYPE_LABEL[b.type]}</span>
            {ro ? null : (
              <>
                <button
                  type="button"
                  aria-label={`Move ${b.title} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="grid h-7 min-h-[var(--touch-min)] w-7 place-items-center text-paper-muted hover:text-wax disabled:opacity-30"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${b.title} down`}
                  disabled={i === blocks.length - 1}
                  onClick={() => move(i, 1)}
                  className="grid h-7 min-h-[var(--touch-min)] w-7 place-items-center text-paper-muted hover:text-wax disabled:opacity-30"
                >
                  <ArrowDown size={14} />
                </button>
                <RemoveButton
                  label={`Remove ${b.title}`}
                  onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                />
              </>
            )}
          </div>
          <div className="mt-1.5">
            <BlockBody block={b} index={i} ctx={ctx} />
          </div>
        </section>
      ))}
      {ro ? null : (
        <div className="flex items-center gap-1.5">
          <select
            aria-label="Kind of block"
            value={kind}
            onChange={(e) => setKind(e.target.value as CustomBlock["type"])}
            className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-14 text-paper-ink"
          >
            {CUSTOM_BLOCK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setBlocks([...blocks, newBlock(kind, new Set(blocks.map((b) => b.id)))])}
            className="inline-flex h-8 min-h-[var(--touch-min)] items-center gap-1 rounded-[var(--radius-control)] border border-paper-ink/40 px-3 text-13 font-bold text-paper-ink hover:bg-parchment-deep"
          >
            <Plus size={14} /> Add block
          </button>
        </div>
      )}
    </div>
  );
}

function BlockBody({ block: b, index: i, ctx }: { block: CustomBlock; index: number; ctx: SheetCtx }) {
  const ro = !ctx.canEdit;
  const set = (key: string, v: unknown) => void ctx.set(["custom", i, key], v);
  switch (b.type) {
    case "text":
      return (
        <TextField
          label={`${b.title} text`}
          value={b.markdown}
          multiline
          disabled={ro}
          placeholder="Write anything (Markdown)"
          onCommit={(v) => set("markdown", v)}
        />
      );
    case "number":
      return (
        <input
          // A change from elsewhere (the DM, another tab) shows at once: a new value is a fresh field.
          key={String(b.value)}
          aria-label={`${b.title} value`}
          inputMode="decimal"
          disabled={ro}
          defaultValue={String(b.value)}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n !== b.value) set("value", n);
            else e.target.value = String(b.value);
          }}
          className="tabular h-8 w-24 rounded-[var(--radius-control)] border border-parchment-edge/60 bg-parchment/60 px-2 text-center text-14 font-bold text-paper-ink focus:border-wax focus:outline-none"
        />
      );
    case "counter":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Stepper
            label={`${b.title} value`}
            value={b.value}
            min={-99_999}
            max={99_999}
            disabled={ro}
            onChange={(v) => set("value", v)}
          />
          <span className="text-paper-muted">of</span>
          <NumberField
            label={`${b.title} maximum`}
            value={b.max}
            min={0}
            max={99_999}
            disabled={ro}
            onCommit={(v) => set("max", v)}
          />
          <label
            className="ml-auto inline-flex items-center gap-1 text-13"
            title="Shown on the token as a thin bar under its HP"
          >
            <input
              type="checkbox"
              checked={b.pinToToken}
              disabled={ro}
              onChange={(e) => set("pinToToken", e.target.checked)}
              className="accent-[var(--wax-500)]"
            />
            <Pin size={12} aria-hidden /> On the token
          </label>
        </div>
      );
    case "checklist":
      return (
        <ul className="flex flex-col gap-0.5">
          {b.items.map((it, k) => (
            <li key={k} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                aria-label={`${it.label} done`}
                checked={it.done}
                disabled={ro}
                onChange={(e) => void ctx.set(["custom", i, "items", k, "done"], e.target.checked)}
                className="accent-[var(--wax-500)]"
              />
              <TextField
                label={`${b.title} item ${k + 1}`}
                value={it.label}
                disabled={ro}
                onCommit={(v) => v.trim() && void ctx.set(["custom", i, "items", k, "label"], v.trim())}
              />
              {ro ? null : (
                <RemoveButton
                  label={`Remove ${it.label}`}
                  onClick={() =>
                    set(
                      "items",
                      b.items.filter((_, j) => j !== k),
                    )
                  }
                />
              )}
            </li>
          ))}
          {ro ? null : (
            <li>
              <button
                type="button"
                onClick={() =>
                  set("items", [...b.items, { label: `Item ${b.items.length + 1}`, done: false }])
                }
                className="text-13 text-paper-muted underline decoration-dotted hover:text-wax"
              >
                Add an item
              </button>
            </li>
          )}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-13">
            <thead>
              <tr>
                {b.columns.map((col, c) => (
                  <th key={c} className="border-b border-parchment-edge p-0.5 text-left">
                    <TextField
                      label={`${b.title} column ${c + 1}`}
                      value={col}
                      disabled={ro}
                      onCommit={(v) => void ctx.set(["custom", i, "columns", c], v)}
                      className="caps text-12"
                    />
                  </th>
                ))}
                {ro ? null : (
                  <th className="w-8">
                    <button
                      type="button"
                      aria-label={`${b.title}: add a column`}
                      disabled={b.columns.length >= 12}
                      onClick={() =>
                        void ctx.edit([
                          {
                            path: ["custom", i, "columns"],
                            after: [...b.columns, `Column ${b.columns.length + 1}`],
                          },
                          { path: ["custom", i, "rows"], after: b.rows.map((r) => [...r, ""]) },
                        ])
                      }
                      className="text-paper-muted hover:text-wax"
                    >
                      <Plus size={14} />
                    </button>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {b.columns.map((_, c) => (
                    <td key={c} className="p-0.5">
                      <TextField
                        label={`${b.title} row ${r + 1} column ${c + 1}`}
                        value={row[c] ?? ""}
                        disabled={ro}
                        onCommit={(v) => void ctx.set(["custom", i, "rows", r, c], v)}
                      />
                    </td>
                  ))}
                  {ro ? null : (
                    <td>
                      <RemoveButton
                        label={`${b.title}: remove row ${r + 1}`}
                        onClick={() =>
                          set(
                            "rows",
                            b.rows.filter((_, j) => j !== r),
                          )
                        }
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {ro ? null : (
            <button
              type="button"
              onClick={() => set("rows", [...b.rows, b.columns.map(() => "")])}
              className="mt-1 text-13 text-paper-muted underline decoration-dotted hover:text-wax"
            >
              Add a row
            </button>
          )}
        </div>
      );
    case "keyValue":
      return (
        <div className="flex flex-col gap-0.5">
          {b.entries.map((e, k) => (
            <div key={k} className="flex items-center gap-1">
              <TextField
                label={`${b.title} key ${k + 1}`}
                value={e.key}
                disabled={ro}
                onCommit={(v) => v.trim() && void ctx.set(["custom", i, "entries", k, "key"], v.trim())}
                className="font-bold"
              />
              <TextField
                label={`${b.title} value ${k + 1}`}
                value={e.value}
                disabled={ro}
                onCommit={(v) => void ctx.set(["custom", i, "entries", k, "value"], v)}
              />
              {ro ? null : (
                <RemoveButton
                  label={`Remove ${e.key}`}
                  onClick={() =>
                    set(
                      "entries",
                      b.entries.filter((_, j) => j !== k),
                    )
                  }
                />
              )}
            </div>
          ))}
          {ro ? null : (
            <button
              type="button"
              onClick={() =>
                set("entries", [...b.entries, { key: `Key ${b.entries.length + 1}`, value: "" }])
              }
              className="self-start text-13 text-paper-muted underline decoration-dotted hover:text-wax"
            >
              Add a pair
            </button>
          )}
        </div>
      );
    case "image":
      return ro ? (
        <ImageView assetId={b.assetId} />
      ) : (
        <AssetPicker label="Picture" purpose="art" value={b.assetId} onChange={(id) => set("assetId", id)} />
      );
  }
}

function ImageView({ assetId }: { assetId: string | undefined }) {
  const src = useAssetImage(assetId, 320);
  if (!assetId) return <p className="text-13 italic text-paper-muted">No picture.</p>;
  return src ? (
    <img src={src} alt="" className="max-h-64 rounded-[var(--radius-control)] object-contain" />
  ) : null;
}
