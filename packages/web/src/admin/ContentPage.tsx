import { BookOpen } from "lucide-react";
import { get, post } from "../net/http.ts";
import { Toggle } from "../ui/controls.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { LoadPanel, useLoad } from "../ui/Loadable.tsx";
import { toast } from "../ui/Toast.tsx";

interface ContentDto {
  packs: { id: string; name: string; spells: number; conditions: number; lightSources: number }[];
  campaigns: {
    id: string;
    name: string;
    archived: boolean;
    packs: string[];
    homebrew: { active: number; proposed: number; rejected: number };
  }[];
}

/**
 * Admin → Content (SPEC §8.20): the content packs Gloam ships, which campaigns play with each (off, a pack's spells
 * aren't offered or cast there), and every campaign's homebrew at a glance — in use, waiting for approval, turned down.
 */
export function ContentPage() {
  const loaded = useLoad(() => get<ContentDto>("/api/admin/content"), []);
  const c = loaded.data ?? null;
  const load = loaded.reload;
  const toggle = async (campaignId: string, packs: string[], pack: string, on: boolean) => {
    try {
      await post(`/api/admin/campaigns/${campaignId}/packs`, {
        packs: on ? [...new Set([...packs, pack])] : packs.filter((p) => p !== pack),
      });
      await load();
    } catch (e) {
      toast.danger("Couldn't change it", (e as Error).message);
    }
  };
  return (
    <div className="max-w-[880px]" data-testid="content-page">
      <header>
        <h1 className="text-36 text-bone">Content</h1>
        <p className="mt-1 text-14 text-muted">
          The rules content your campaigns play with, and the spells your tables made.
        </p>
      </header>
      <LoadPanel load={loaded} what="the content" />
      {(c?.packs ?? []).map((p) => (
        <section key={p.id} className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label={p.name}>
          <h2 className="flex items-center gap-2 text-22 text-bone">
            <BookOpen size={20} aria-hidden /> {p.name}
          </h2>
          <p className="tabular text-14 text-muted">
            {p.spells} spells · {p.conditions} conditions · {p.lightSources} light sources · CC-BY-4.0 (see
            About &amp; Credits)
          </p>
          {c?.campaigns.length === 0 ? (
            <p className="text-14 text-muted">No campaigns yet — each one you make plays with it.</p>
          ) : null}
          <div className="flex flex-col divide-y divide-line/60">
            {(c?.campaigns ?? []).map((k) => (
              <div key={k.id} className="py-2.5" data-testid="pack-campaign" data-campaign={k.id}>
                <Toggle
                  checked={k.packs.includes(p.id)}
                  onChange={(on) => void toggle(k.id, k.packs, p.id, on)}
                  label={`${k.name}${k.archived ? " (archived)" : ""}`}
                  description={k.packs.includes(p.id) ? "In play" : "Its spells aren't offered or cast here."}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
      {c ? (
        <section className="panel mt-6 flex flex-col gap-2 p-5 sm:p-6" aria-label="Homebrew">
          <h2 className="text-22 text-bone">Homebrew</h2>
          {c.campaigns.every((k) => !k.homebrew.active && !k.homebrew.proposed && !k.homebrew.rejected) ? (
            <EmptyState
              art="candle"
              title="No homebrew spells yet. A DM makes them in DM panel → Spells; players propose theirs."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line/60">
              {c.campaigns.map((k) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center gap-3 py-2.5"
                  data-testid="homebrew-campaign"
                >
                  <span className="min-w-0 flex-1 truncate text-16 text-bone">{k.name}</span>
                  <span className="tabular text-14 text-muted">
                    {k.homebrew.active} in use
                    {k.homebrew.proposed ? (
                      <span className="text-brass"> · {k.homebrew.proposed} proposed</span>
                    ) : null}
                    {k.homebrew.rejected ? ` · ${k.homebrew.rejected} turned down` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
