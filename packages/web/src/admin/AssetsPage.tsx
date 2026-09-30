import { HardDrive, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { toast } from "../ui/Toast.tsx";

interface Overview {
  campaigns: { campaignId: string; name: string; assets: number; bytes: number; pending: number }[];
  files: number;
  fileBytes: number;
  diskBytes: number;
  orphans: { files: number; bytes: number; rejected: number };
}

/** Bytes as people read them. */
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Admin → Assets (SPEC §8.20): every campaign's uploads — how many, how much room they take, how many wait for a DM —
 * the storage on disk, and a clean-up of what nothing uses any more (files no upload refers to, uploads turned down a
 * day ago).
 */
export function AssetsPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setO(await get<Overview>("/api/admin/assets")), []);
  useEffect(() => {
    void load().catch((e: Error) => toast.danger("Couldn't load the assets", e.message));
  }, [load]);
  const cleanup = async () => {
    setBusy(true);
    try {
      const r = await post<{ references: number; files: number; freedBytes: number }>(
        "/api/admin/assets/cleanup",
      );
      toast.success(
        r.files || r.references ? `Cleaned up ${size(r.freedBytes)}` : "Nothing to clean up",
        r.files || r.references
          ? `${r.files} unused ${r.files === 1 ? "file" : "files"}, ${r.references} turned-down ${r.references === 1 ? "upload" : "uploads"}.`
          : undefined,
      );
      await load();
    } catch (e) {
      toast.danger("Couldn't clean up", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const orphans = o ? o.orphans.files + o.orphans.rejected : 0;
  return (
    <div className="max-w-[880px]" data-testid="assets-page">
      <header>
        <h1 className="text-36 text-bone">Assets</h1>
        <p className="mt-1 text-14 text-muted">
          The maps, art, minis and music uploaded to your campaigns. The same file used twice is stored once.
        </p>
      </header>
      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label="Storage">
        <h2 className="flex items-center gap-2 text-22 text-bone">
          <HardDrive size={20} aria-hidden /> Storage
        </h2>
        {o ? (
          <dl className="tabular grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="caps text-12 text-fog">On disk</dt>
              <dd className="text-22 text-bone">{size(o.diskBytes)}</dd>
            </div>
            <div>
              <dt className="caps text-12 text-fog">Files</dt>
              <dd className="text-22 text-bone">{o.files}</dd>
            </div>
            <div>
              <dt className="caps text-12 text-fog">Unused</dt>
              <dd className="text-22 text-bone" data-testid="orphans">
                {orphans ? `${orphans} · ${size(o.orphans.bytes)}` : "none"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon={<Sparkles size={16} />}
            loading={busy}
            onClick={() => void cleanup()}
          >
            Clean up unused files
          </Button>
          <p className="text-13 text-muted">
            Only files no upload uses, and uploads turned down more than a day ago.
          </p>
        </div>
      </section>
      <section className="panel mt-6 flex flex-col gap-2 p-5 sm:p-6" aria-label="By campaign">
        <h2 className="text-22 text-bone">By campaign</h2>
        {o && o.campaigns.length === 0 ? (
          <EmptyState art="candle" title="Nothing uploaded yet." />
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            {(o?.campaigns ?? []).map((c) => (
              <li
                key={c.campaignId}
                className="flex flex-wrap items-center gap-3 py-2.5"
                data-testid="asset-campaign"
              >
                <span className="min-w-0 flex-1 truncate text-16 text-bone">{c.name}</span>
                <span className="tabular text-14 text-muted">
                  {c.assets} {c.assets === 1 ? "upload" : "uploads"} · {size(c.bytes)}
                  {c.pending ? <span className="text-brass"> · {c.pending} waiting for a DM</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
