import { Archive, Download, HardDriveDownload, History, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { del, get, post } from "../net/http.ts";
import { UploadError, uploadTo } from "../net/upload.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Select } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { TextInput } from "../ui/Field.tsx";
import { toast } from "../ui/Toast.tsx";

interface CampaignItem {
  id: string;
  name: string;
  selected: boolean;
}
interface Snapshot {
  id: string;
  name: string;
  kind: "auto" | "manual" | "scene" | "close" | "shutdown" | "pre-restore";
  bytes: number;
  createdAt: number;
}
interface Backup {
  name: string;
  bytes: number;
  createdAt: number;
}

const KIND: Record<Snapshot["kind"], string> = {
  auto: "Autosave",
  manual: "Saved by you",
  scene: "Scene change",
  close: "Table closed",
  shutdown: "Server stopped",
  "pre-restore": "Before a restore",
};

const size = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Admin console → Saves (SPEC §8.15, §20; P10): a campaign's snapshots — every autosave, scene change and closing,
 * and those saved by hand — each restorable (after a confirmation; a "Before a restore" snapshot is taken first);
 * the whole server's daily backups and Backup now; and moving a campaign to another machine: export it as a `.gloam`
 * (downloaded at once), import one as a new campaign.
 */
export function SavesPage() {
  const [campaigns, setCampaigns] = useState<CampaignItem[] | null>(null);
  const [campaignId, setCampaignId] = useState<string>("");
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [backups, setBackups] = useState<{ backups: Backup[]; dataDirBytes: number } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [restore, setRestore] = useState<Snapshot | null>(null);
  const [importing, setImporting] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadCampaigns = useCallback(async () => {
    const list = await get<CampaignItem[]>("/api/admin/campaigns");
    setCampaigns(list);
    setCampaignId((cur) => cur || list.find((c) => c.selected)?.id || list[0]?.id || "");
  }, []);
  const loadSnaps = useCallback(async (id: string) => {
    if (!id) return setSnaps([]);
    setSnaps(await get<Snapshot[]>(`/api/admin/campaigns/${id}/snapshots`));
  }, []);
  const loadBackups = useCallback(async () => {
    setBackups(await get<{ backups: Backup[]; dataDirBytes: number }>("/api/admin/backups"));
  }, []);
  useEffect(() => {
    void loadCampaigns().catch((e: Error) => toast.danger("Couldn't load the campaigns", e.message));
    void loadBackups().catch(() => {});
  }, [loadCampaigns, loadBackups]);
  useEffect(() => {
    void loadSnaps(campaignId).catch((e: Error) => toast.danger("Couldn't load the saves", e.message));
  }, [campaignId, loadSnaps]);

  const run = async (key: string, f: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      toast.danger(fail, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const campaign = campaigns?.find((c) => c.id === campaignId);

  const saveNow = (e: FormEvent) => {
    e.preventDefault();
    void run(
      "save",
      async () => {
        await post(`/api/admin/campaigns/${campaignId}/snapshots`, name.trim() ? { name: name.trim() } : {});
        setName("");
        toast.success("Saved", `${campaign?.name ?? "The campaign"} as it is now.`);
        await loadSnaps(campaignId);
      },
      "Couldn't save",
    );
  };
  const doRestore = (s: Snapshot) =>
    run(
      `restore:${s.id}`,
      async () => {
        await post(`/api/admin/snapshots/${s.id}/restore`);
        setRestore(null);
        toast.success("Restored", `${campaign?.name ?? "The campaign"} is back to ${when(s.createdAt)}.`);
        await loadSnaps(campaignId);
      },
      "Couldn't restore",
    );
  const doExport = () =>
    run(
      "export",
      async () => {
        const r = await post<{ file: string; bytes: number }>(`/api/admin/campaigns/${campaignId}/export`);
        // Downloaded at once (the file also stays in the data folder's exports).
        const a = document.createElement("a");
        a.href = `/api/admin/exports/${encodeURIComponent(r.file)}`;
        a.download = r.file;
        document.body.append(a);
        a.click();
        a.remove();
        toast.success("Exported", `${r.file} · ${size(r.bytes)}`);
      },
      "Couldn't export",
    );
  const doImport = async (file: File) => {
    setImporting(0);
    try {
      const r = await uploadTo<{ campaignId: string; name: string }>(
        "/api/admin/campaigns/import",
        file,
        (f) => setImporting(f),
      );
      toast.success(`Imported “${r.name}”`, "It's a new campaign — choose it on the Table page to play it.");
      await loadCampaigns();
      setCampaignId(r.campaignId);
    } catch (e) {
      toast.danger("Couldn't import it", e instanceof UploadError ? e.message : (e as Error).message);
    } finally {
      setImporting(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="max-w-[880px]" data-testid="saves-page">
      <header>
        <h1 className="text-36 text-bone">Saves</h1>
        <p className="mt-1 text-14 text-muted">
          Every change is saved as it happens. These are the points you can go back to, the server's backups,
          and moving a campaign to another machine.
        </p>
      </header>

      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="saves-snapshots">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="saves-snapshots" className="flex items-center gap-2 text-22 text-bone">
            <History size={20} aria-hidden /> Snapshots
          </h2>
          {campaigns && campaigns.length > 1 ? (
            <div className="w-64">
              <Select
                label="Campaign"
                value={campaignId}
                onChange={setCampaignId}
                options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
              />
            </div>
          ) : null}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={saveNow}>
          <TextInput
            label="Save now, as"
            placeholder="e.g. Before the dragon"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="min-w-[14rem] flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            icon={<Save size={16} />}
            loading={busy === "save"}
            disabled={!campaignId}
          >
            Save now
          </Button>
        </form>
        {snaps && !snaps.length ? (
          <EmptyState art="scroll" title="No snapshots of this campaign yet." />
        ) : null}
        <ol
          className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line"
          aria-label="Snapshots"
        >
          {(snaps ?? []).map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="snapshot-row"
              data-kind={s.kind}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-14 text-bone">{s.name}</span>
                <span className="text-12 text-muted">
                  {KIND[s.kind]} · <span className="whitespace-nowrap">{when(s.createdAt)}</span> ·{" "}
                  {size(s.bytes)}
                </span>
              </span>
              <Button size="S" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setRestore(s)}>
                Restore…
              </Button>
              {s.kind === "manual" ? (
                <IconButton
                  label={`Delete ${s.name}`}
                  onClick={() =>
                    void run(
                      `del:${s.id}`,
                      async () => {
                        await del(`/api/admin/snapshots/${s.id}`);
                        await loadSnaps(campaignId);
                      },
                      "Couldn't delete it",
                    )
                  }
                >
                  <Trash2 size={15} />
                </IconButton>
              ) : (
                // (An automatic snapshot can't be deleted: its slot kept, so every row's Restore lines up.)
                <span className="hit shrink-0" aria-hidden />
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="saves-move">
        <h2 id="saves-move" className="flex items-center gap-2 text-22 text-bone">
          <Archive size={20} aria-hidden /> Move a campaign
        </h2>
        <p className="max-w-[62ch] text-14 text-muted">
          A <span className="font-bold text-bone">.gloam</span> file holds a whole campaign — its scenes,
          characters and library. Import one on another machine: it becomes a new campaign there, and every
          file in it is checked again as it comes in.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Download size={16} />}
            loading={busy === "export"}
            disabled={!campaignId}
            onClick={() => void doExport()}
          >
            Export {campaign ? `“${campaign.name}”` : "campaign"}
          </Button>
          <label className="inline-flex">
            <input
              ref={fileInput}
              type="file"
              accept=".gloam,application/zip"
              className="sr-only"
              aria-label="Import a campaign file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
              }}
            />
            <Button
              variant="ghost"
              icon={<Upload size={16} />}
              loading={importing !== null}
              onClick={() => fileInput.current?.click()}
            >
              {importing !== null && importing < 1
                ? `Uploading ${Math.round(importing * 100)} %`
                : "Import a campaign…"}
            </Button>
          </label>
        </div>
      </section>

      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="saves-backups">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="saves-backups" className="flex items-center gap-2 text-22 text-bone">
            <HardDriveDownload size={20} aria-hidden /> Backups
          </h2>
          <Button
            variant="secondary"
            loading={busy === "backup"}
            onClick={() =>
              void run(
                "backup",
                async () => {
                  const b = await post<Backup>("/api/admin/backups");
                  toast.success("Backed up", `${b.name} · ${size(b.bytes)}`);
                  await loadBackups();
                },
                "Couldn't back up",
              )
            }
          >
            Back up now
          </Button>
        </div>
        <p className="text-14 text-muted">
          The whole server, once a day (the last 14 kept) — copy the data folder somewhere else now and then
          too.
          {backups ? ` The data folder is ${size(backups.dataDirBytes)}.` : ""}
        </p>
        {backups && backups.backups.length === 0 ? (
          <p
            className="rounded-[var(--radius-control)] border border-dashed border-line px-4 py-3 text-14 text-muted"
            data-testid="backups-empty"
          >
            No backups yet — the first is made tonight, or now with Back up now.
          </p>
        ) : null}
        {backups?.backups.length ? (
          <ul
            className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line"
            aria-label="Backups"
          >
            {backups.backups.map((b) => (
              <li key={b.name} className="flex items-center gap-3 px-3 py-2 text-14" data-testid="backup-row">
                <span className="tabular min-w-0 flex-1 truncate text-bone">{b.name}</span>
                <span className="text-12 text-muted">
                  {when(b.createdAt)} · {size(b.bytes)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Dialog
        open={restore !== null}
        onClose={() => setRestore(null)}
        title="Restore this snapshot?"
        description={
          restore
            ? `${campaign?.name ?? "The campaign"} goes back to ${when(restore.createdAt)} (${restore.name}). Everything since is replaced — a "Before a restore" snapshot is taken first, so you can come back.`
            : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRestore(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={restore !== null && busy === `restore:${restore.id}`}
              onClick={() => restore && void doRestore(restore)}
            >
              Restore
            </Button>
          </div>
        }
      />
    </div>
  );
}
