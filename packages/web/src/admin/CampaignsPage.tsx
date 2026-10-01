import { Archive, ArchiveRestore, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { get, patch, post } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { TextInput } from "../ui/Field.tsx";
import { LoadGate, useLoad } from "../ui/Loadable.tsx";
import { Menu } from "../ui/Menu.tsx";
import { Sparkle } from "../ui/ornaments.tsx";
import { toast } from "../ui/Toast.tsx";

interface CampaignItem {
  id: string;
  name: string;
  rulesPack: string;
  sessionNo: number;
  archived: boolean;
  selected: boolean;
  createdAt: number;
  updatedAt: number;
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * Admin → Campaigns (SPEC §8.20): every campaign — make one (or the demo), rename, archive and bring back, delete
 * (typing its name), choose the one the table runs. Moving one between machines is on Saves.
 */
export function CampaignsPage() {
  const navigate = useNavigate();
  const loaded = useLoad(() => get<CampaignItem[]>("/api/admin/campaigns"), []);
  const list = loaded.data;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<CampaignItem | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<CampaignItem | null>(null);
  const [confirm, setConfirm] = useState("");
  const load = loaded.reload;
  const run = async (key: string, f: () => Promise<unknown>, done: string | null, fail: string) => {
    setBusy(key);
    try {
      await f();
      if (done) toast.success(done);
      await load();
      return true;
    } catch (e) {
      toast.danger(fail, (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void run(
      "create",
      () => post("/api/admin/campaigns", { name: n }),
      `${n} is ready`,
      "Couldn't make it",
    ).then((ok) => ok && setName(""));
  };
  const live = (list ?? []).filter((c) => !c.archived);
  const archived = (list ?? []).filter((c) => c.archived);
  const rename = (c: CampaignItem) => {
    setRenaming(c);
    setNewName(c.name);
  };
  const archive = (c: CampaignItem) =>
    void run(
      `archive:${c.id}`,
      () => patch(`/api/admin/campaigns/${c.id}`, { archived: !c.archived }),
      c.archived ? `${c.name} is back` : `${c.name} is archived`,
      "Couldn't do that",
    );
  const remove = (c: CampaignItem) => {
    setDeleting(c);
    setConfirm("");
  };
  const row = (c: CampaignItem) => (
    <li
      key={c.id}
      className="flex flex-wrap items-center gap-3 py-3"
      data-testid="campaign-row"
      data-campaign={c.id}
    >
      {/* Who it is takes the row's width on a phone, its menu at its top right and "Use at the table" below (squeezed
          beside the actions, the name went; the menu on a row of its own left a gap — critic RSP-01 r2). */}
      <span className="flex min-w-0 flex-[1_1_16rem] flex-col max-sm:flex-[1_1_0]">
        {/* A phone keeps the whole name, wrapping, its "At the table" under it when there's no room beside it — cut
            beside the menu, "The Lantern C…" lost what it was. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 text-16 font-bold text-bone [overflow-wrap:anywhere] sm:truncate">
            {c.name}
          </span>
          {c.selected ? (
            <span className="caps inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-12 text-brass">
              <Star size={12} aria-hidden /> At the table
            </span>
          ) : null}
        </span>
        <span className="text-13 text-muted">
          {c.sessionNo ? `${c.sessionNo} ${c.sessionNo === 1 ? "session" : "sessions"}` : "Not played yet"} ·
          made <span className="whitespace-nowrap">{day(c.createdAt)}</span>
        </span>
      </span>
      <span className="shrink-0 self-start sm:hidden">
        <Menu
          label={`${c.name}: more`}
          items={[
            { label: "Rename", icon: <Pencil size={15} />, onSelect: () => rename(c) },
            {
              label: c.archived ? "Bring back" : "Archive",
              icon: c.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
              onSelect: () => archive(c),
            },
            { label: "Delete…", icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(c) },
          ]}
        />
      </span>
      <span
        className={`flex flex-wrap items-center gap-1 max-sm:basis-full ${c.selected || c.archived ? "max-sm:hidden" : ""}`}
      >
        {!c.selected && !c.archived ? (
          <Button
            size="S"
            variant="secondary"
            loading={busy === `select:${c.id}`}
            onClick={() =>
              void run(
                `select:${c.id}`,
                () => post(`/api/admin/campaigns/${c.id}/select`),
                `${c.name} is the table's campaign`,
                "Couldn't choose it",
              )
            }
          >
            Use at the table
          </Button>
        ) : null}
        {/* Wide: each at hand. A phone: one menu of them. */}
        <span className="contents max-sm:hidden">
          <Button size="S" variant="ghost" icon={<Pencil size={14} />} onClick={() => rename(c)}>
            Rename
          </Button>
          <Button
            size="S"
            variant="ghost"
            icon={c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            loading={busy === `archive:${c.id}`}
            onClick={() => archive(c)}
          >
            {c.archived ? "Bring back" : "Archive"}
          </Button>
          <Button size="S" variant="danger" icon={<Trash2 size={14} />} onClick={() => remove(c)}>
            Delete
          </Button>
        </span>
      </span>
    </li>
  );
  return (
    <div className="max-w-[880px]" data-testid="campaigns-page">
      <header>
        <h1 className="text-36 text-bone">Campaigns</h1>
        <p className="mt-1 text-14 text-muted">
          Each campaign keeps its own scenes, characters, library and log. The table runs one at a time.
        </p>
      </header>
      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label="New campaign">
        <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
          <TextInput
            className="min-w-[220px] flex-1"
            label="A new campaign"
            placeholder="e.g. The Sunless Road"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={16} />}
            loading={busy === "create"}
            disabled={!name.trim()}
          >
            Make it
          </Button>
          <Button
            variant="ghost"
            icon={<Sparkle size={16} />}
            loading={busy === "demo"}
            onClick={() =>
              void run(
                "demo",
                () => post("/api/admin/campaigns/demo"),
                "The Lantern Crypt is ready",
                "Couldn't make the demo",
              )
            }
          >
            Add the demo
          </Button>
        </form>
      </section>
      <section className="panel mt-6 flex flex-col gap-2 p-5 sm:p-6" aria-label="Campaigns">
        <LoadGate load={loaded} what="the campaigns">
          {() =>
            live.length === 0 ? (
              <EmptyState
                art="door"
                title="No campaigns yet. Make one above, or add the demo to look around."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-line/60">{live.map(row)}</ul>
            )
          }
        </LoadGate>
      </section>
      {archived.length ? (
        <section className="panel mt-6 flex flex-col gap-2 p-5 sm:p-6" aria-label="Archived">
          <h2 className="text-22 text-bone">Archived</h2>
          <ul className="flex flex-col divide-y divide-line/60">{archived.map(row)}</ul>
        </section>
      ) : null}
      <p className="mt-4 text-13 text-muted">
        To move a campaign to another machine, export it from{" "}
        <button
          type="button"
          className="font-bold text-brass hover:text-brass-bright"
          onClick={() => navigate("/admin/saves")}
        >
          Saves
        </button>
        .
      </p>
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename the campaign"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "rename"}
              disabled={!newName.trim()}
              onClick={() =>
                renaming &&
                void run(
                  "rename",
                  () => patch(`/api/admin/campaigns/${renaming.id}`, { name: newName.trim() }),
                  "Renamed",
                  "Couldn't rename it",
                ).then((ok) => ok && setRenaming(null))
              }
            >
              Rename
            </Button>
          </>
        }
      >
        <TextInput
          label="Name"
          value={newName}
          maxLength={80}
          onChange={(e) => setNewName(e.target.value)}
          data-autofocus
        />
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        description="Everything in it goes — scenes, characters, handouts, its log and its snapshots. The server's daily backups still hold it until they roll over."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy === "delete"}
              disabled={!deleting || confirm.trim() !== deleting.name}
              onClick={() =>
                deleting &&
                void run(
                  "delete",
                  () => post(`/api/admin/campaigns/${deleting.id}/delete`, { confirm }),
                  `${deleting.name} is deleted`,
                  "Couldn't delete it",
                ).then((ok) => ok && setDeleting(null))
              }
            >
              Delete for good
            </Button>
          </>
        }
      >
        <TextInput
          label={deleting ? `Type "${deleting.name}" to delete it` : ""}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          data-autofocus
        />
      </Dialog>
    </div>
  );
}
