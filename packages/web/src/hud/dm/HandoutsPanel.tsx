import type { HandoutView } from "@gloam/shared/protocol";
import { ImageOff, Pencil, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { createHandout, deleteHandout, sendNote, showHandout, updateHandout, useFun } from "../../net/fun.ts";
import { type PresenceView, useTable } from "../../net/table.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Select } from "../../ui/controls.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { UploadZone } from "./UploadZone.tsx";

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

const FIELD =
  "w-full rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none";

/** Who has it, in words. */
function heldBy(h: HandoutView, players: PresenceView[]): string {
  if (h.recipients === "all") return "Shown to everyone";
  const ids = h.recipients ?? [];
  if (!ids.length) return "A draft: nobody has it yet";
  const names = ids.map((id) => players.find((p) => p.userId === id)?.name ?? "a player");
  return `${h.kind === "note" ? "For" : "Shown to"} ${names.join(", ")}`;
}

function Picture({ id, onClear }: { id: string; onClear: () => void }) {
  const src = useAssetImage(id, 256);
  return (
    <div className="flex items-center gap-3">
      {src ? (
        <img src={src} alt="" className="h-16 w-16 rounded-[var(--radius-control)] object-cover" />
      ) : null}
      <Button variant="ghost" size="S" onClick={onClear} icon={<ImageOff size={14} aria-hidden />}>
        No picture
      </Button>
    </div>
  );
}

/** A handout's fields (new, or being edited). */
function HandoutForm({ start, onDone }: { start?: HandoutView; onDone: () => void }) {
  const [title, setTitle] = useState(start?.title ?? "");
  const [body, setBody] = useState(start?.bodyMd ?? "");
  const [image, setImage] = useState<string | null>(start?.imageAssetId ?? null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (start)
        await updateHandout({ handoutId: start.id, title: title.trim(), bodyMd: body, imageAssetId: image });
      else await createHandout({ title: title.trim(), bodyMd: body, imageAssetId: image });
      onDone();
    } catch (e) {
      toast.danger("Couldn't save the handout", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2.5"
      aria-label={start ? `Edit ${start.title}` : "New handout"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        aria-label="Title"
        placeholder="Title (a torn map, a letter, a riddle)"
        maxLength={120}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className={`${FIELD} h-10`}
      />
      <textarea
        aria-label="Text"
        placeholder="What it says — Markdown: **bold**, *italic*, lists"
        rows={5}
        maxLength={20000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={`${FIELD} min-h-[110px] resize-y py-2`}
      />
      {image ? (
        <Picture id={image} onClear={() => setImage(null)} />
      ) : (
        <UploadZone purpose="handout" hint="A picture for it (optional)" onUploaded={(a) => setImage(a.id)} />
      )}
      <div className="flex justify-end gap-2">
        {start ? (
          <Button type="button" variant="ghost" size="S" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="secondary" size="S" loading={busy} disabled={!title.trim()}>
          {start ? "Save" : "Save the handout"}
        </Button>
      </div>
    </form>
  );
}

function HandoutRow({ h, players }: { h: HandoutView; players: PresenceView[] }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <HandoutForm start={h} onDone={() => setEditing(false)} />;
  const note = h.kind === "note";
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5" data-testid="dm-handout" data-id={h.id}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-14 text-bone">{note ? `“${h.bodyMd}”` : h.title}</p>
          <p className="truncate text-12 text-muted">{heldBy(h, players)}</p>
        </div>
        {note ? null : (
          <>
            <Menu
              label={`Show ${h.title}`}
              text="Show"
              items={[
                { label: "To everyone", onSelect: () => act(showHandout(h.id, "all"), "Couldn't show it") },
                ...players.map((p) => ({
                  label: `To ${p.name}`,
                  onSelect: () => act(showHandout(h.id, [p.userId]), "Couldn't show it"),
                })),
              ]}
            />
            <IconButton label={`Edit ${h.title}`} onClick={() => setEditing(true)}>
              <Pencil size={15} />
            </IconButton>
          </>
        )}
        <IconButton
          label={note ? "Delete the note" : `Delete ${h.title}`}
          tone="danger"
          onClick={() => act(deleteHandout(h.id), "Couldn't delete it")}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </li>
  );
}

function SecretNote({ players }: { players: PresenceView[] }) {
  const [to, setTo] = useState<string>("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const target = to || players[0]?.userId || "";
  const send = async () => {
    setBusy(true);
    try {
      await sendNote(target, text.trim());
      setText("");
      toast.success(
        "Note sent",
        `Only ${players.find((p) => p.userId === target)?.name ?? "they"} will see it.`,
      );
    } catch (e) {
      toast.danger("Couldn't send the note", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!players.length)
    return <p className="text-13 text-muted">A secret note goes to one player; none is at the table yet.</p>;
  return (
    <form
      className="flex flex-col gap-2.5"
      aria-label="Secret note"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Select
        label="For"
        value={target}
        onChange={setTo}
        options={players.map((p) => ({ value: p.userId, label: p.name }))}
      />
      <textarea
        aria-label="The note"
        placeholder="Only you notice the glyph glowing…"
        rows={3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={`${FIELD} min-h-[76px] resize-y py-2`}
      />
      <Button
        type="submit"
        variant="secondary"
        size="S"
        className="self-end"
        loading={busy}
        disabled={!text.trim()}
        icon={<Send size={14} aria-hidden />}
      >
        Send the note
      </Button>
    </form>
  );
}

/**
 * DM panel → Handouts & Notes (SPEC §8.18, §8.19): handouts written here (a title, Markdown, a picture), shown to
 * everyone or to one player at a time (it unfurls on their screens and stays in their Journal), edited, deleted;
 * secret notes to one player alone. Each row says who has it.
 */
export function HandoutsPanel() {
  const handouts = useFun((s) => s.handouts);
  const presence = useTable((s) => s.presence);
  const players = presence.filter((p) => p.role === "player");
  const [adding, setAdding] = useState(false);
  const list = handouts.filter((h) => h.kind === "handout");
  const notes = handouts.filter((h) => h.kind === "note");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="handouts-panel">
      <section className="flex flex-col gap-2" aria-label="Handouts">
        <div className="flex items-center justify-between">
          <h3 className="caps text-12 text-brass">Handouts</h3>
          {adding ? null : (
            <Button variant="ghost" size="S" onClick={() => setAdding(true)}>
              New handout
            </Button>
          )}
        </div>
        {adding ? <HandoutForm onDone={() => setAdding(false)} /> : null}
        {list.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {list.map((h) => (
              <HandoutRow key={h.id} h={h} players={players} />
            ))}
          </ul>
        ) : adding ? null : (
          <p className="text-13 text-muted">
            Write a map, a letter or a riddle, then show it when the moment comes.
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-label="Secret notes">
        <h3 className="caps text-12 text-brass">Secret note</h3>
        <SecretNote players={players} />
        {notes.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {notes.map((h) => (
              <HandoutRow key={h.id} h={h} players={players} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
