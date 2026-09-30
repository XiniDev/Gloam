import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { get } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/controls.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { LoadGate, useLoad } from "../ui/Loadable.tsx";
import { toast } from "../ui/Toast.tsx";
import { detailText } from "./securityDetail.ts";

interface Entry {
  id: number;
  event: string;
  userId: string | null;
  userName: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
}

/** Each event in words (SPEC §8.20 Security log; AC-ADM-04). */
export const EVENT: Record<string, string> = {
  "admin.setup": "Admin password set",
  "admin.login": "Admin signed in",
  "admin.login.failed": "Failed admin sign-in",
  "admin.magic": "Admin signed in (host link)",
  "admin.logout": "Admin signed out",
  "admin.password.reset": "Admin password reset",
  "join.code.ok": "Invite code accepted",
  "join.code.failed": "Wrong invite code",
  "join.ratelimited": "Too many join attempts",
  "join.pin.failed": "Wrong PIN",
  "join.pin.locked": "PIN locked after failures",
  knock: "Knocked",
  "knock.autoadmit": "Let in automatically",
  "knock.autodeny": "Turned away automatically",
  admit: "Let in",
  deny: "Turned away",
  kick: "Sent back to the waiting room",
  ban: "Banned",
  unban: "Unbanned",
  "invite.create": "Invite code made",
  "invite.rotate": "Invite code changed",
  "invite.revoke": "Invite code revoked",
  "invite.lock": "Door locked or unlocked",
  "table.open": "Table opened",
  "table.close": "Table closed",
  "api.token.create": "API token made",
  "api.token.revoke": "API token revoked",
  "api.token.use": "API token used",
  "api.token.refused": "API token refused",
  "upload.rejected": "Upload refused",
  "csp.violation": "Blocked content on a page",
  "ws.ratelimited": "Table connection slowed down",
  "localonly.refused": "Host-only page refused",
  "settings.change": "Settings changed",
  "profile.update": "Profile changed",
  "profile.delete": "Profile deleted",
};

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/**
 * Admin → Security log (SPEC §8.20; AC-ADM-04): sign-ins and failed ones, knocks, who was let in or turned away,
 * kicks, bans, invite changes, API token use, refused uploads — each with its time and the client's IP. Newest first,
 * filtered by kind, 200 at a time.
 */
export function SecurityPage() {
  const [event, setEvent] = useState("");
  // The newest 200 of the kind shown (its loading and failed states), then older pages as asked for.
  const first = useLoad(() => page(event), [event]);
  const [older, setOlder] = useState<{ event: string; rows: Entry[]; more: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const extra = older?.event === event ? older : null;
  const rows = first.data ? [...first.data, ...(extra?.rows ?? [])] : null;
  const more = extra ? extra.more : first.data?.length === 200;
  const loadOlder = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const list = await page(event, rows[rows.length - 1]?.id);
      setOlder({ event, rows: [...(extra?.rows ?? []), ...list], more: list.length === 200 });
    } catch (e) {
      toast.danger("Couldn't load older events", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-[880px]" data-testid="security-page">
      <header>
        <h1 className="text-36 text-bone">Security log</h1>
        <p className="mt-1 text-14 text-muted">
          Who came to the door and what happened — for checking now and then, and for when something looks
          wrong.
        </p>
      </header>
      <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label="Events">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-22 text-bone">
            <ShieldCheck size={20} aria-hidden /> Events
          </h2>
          <div className="w-full sm:w-64">
            <Select
              label="Show"
              value={event}
              onChange={setEvent}
              options={[
                { value: "", label: "Everything" },
                ...Object.entries(EVENT).map(([value, label]) => ({ value, label })),
              ]}
            />
          </div>
        </div>
        <LoadGate load={first} what="the log">
          {() =>
            !rows?.length ? (
              <EmptyState art="door" title="Nothing logged of this kind yet." />
            ) : (
              // By the list's own width: when, what and where in three columns where there's room; else when and where on
              // a line, what under them the whole width (critic RSP-01 r1: at 768 px the event had 70 px, a word a line).
              <ol className="@container flex flex-col divide-y divide-line/60" aria-label="Security events">
                {(rows ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2.5 text-14 [grid-template-areas:'when_ip'_'what_what'] @[600px]:grid-cols-[176px_minmax(0,1fr)_132px] @[600px]:[grid-template-areas:'when_what_ip']"
                    data-testid="security-row"
                    data-event={r.event}
                  >
                    <span className="tabular whitespace-nowrap text-13 text-muted [grid-area:when]">
                      {when(r.createdAt)}
                    </span>
                    <span className="min-w-0 [grid-area:what]">
                      <span className="text-bone">{EVENT[r.event] ?? r.event}</span>
                      {r.userName ? <span className="text-muted"> · {r.userName}</span> : null}
                      {detailText(r.detail) ? (
                        <span className="block truncate text-12 text-faint">{detailText(r.detail)}</span>
                      ) : null}
                    </span>
                    <span
                      className="tabular truncate text-right text-13 text-muted [grid-area:ip]"
                      title="Client IP"
                    >
                      {r.ip ?? "—"}
                    </span>
                  </li>
                ))}
              </ol>
            )
          }
        </LoadGate>
        {more && rows?.length ? (
          <Button variant="ghost" className="self-center" loading={busy} onClick={() => void loadOlder()}>
            Older
          </Button>
        ) : null}
      </section>
    </div>
  );
}

/** A page of the log: the newest 200 of a kind (all kinds when empty), or the 200 before an entry. */
function page(kind: string, before?: number): Promise<Entry[]> {
  const q = new URLSearchParams();
  if (kind) q.set("event", kind);
  if (before) q.set("before", String(before));
  return get<Entry[]>(`/api/admin/security-log${q.size ? `?${q}` : ""}`);
}
