import {
  AlertTriangle,
  Copy,
  DoorOpen,
  Link2,
  Lock,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { IDENTITY_TEXT, waited } from "../hud/KnockCards.tsx";
import { ApiError, get, post } from "../net/http.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { copyText } from "../ui/clipboard.ts";
import { Segmented, Select, Toggle } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { TextInput } from "../ui/Field.tsx";
import { Divider } from "../ui/ornaments.tsx";
import { toast } from "../ui/Toast.tsx";
import { decideKnock, type TableStatusDto, useAdminLive } from "./realtime.ts";

type Mode = "quick" | "named" | "lan" | "local";

const MODE_LABEL: Record<Mode, string> = {
  quick: "Quick tunnel",
  named: "Named tunnel",
  lan: "LAN",
  local: "Local only",
};

const MODE_HINT: Record<Mode, string> = {
  quick:
    "A free, temporary https address from Cloudflare — no account. It changes every time you open the table.",
  named: "Your own stable address through a Cloudflare named tunnel (set the token in Settings).",
  lan: "Players in your home join at your PC's network address. Anyone on your network can reach the join page.",
  local: "No doorway: only this PC (useful for testing or players sharing this machine).",
};

const STATUS_TEXT: Record<TableStatusDto["status"], string> = {
  closed: "Closed",
  opening: "Opening…",
  open: "Open",
  closing: "Closing…",
  reconnecting: "Doorway reconnecting…",
};

const STATUS_TONE: Record<TableStatusDto["status"], string> = {
  closed: "var(--fog-400)",
  opening: "var(--brass-400)",
  open: "var(--verdigris-400)",
  closing: "var(--brass-400)",
  reconnecting: "var(--ember-400)",
};

async function copy(text: string, what: string) {
  if (await copyText(text)) toast.success(`${what} copied`);
  else toast.warning("Couldn't copy", "Select the text and copy it by hand.");
}

/** Admin → Table (SPEC §8.1, §29.6). */
export function TablePage() {
  const live = useAdminLive((s) => s.status);
  const knocks = useAdminLive((s) => s.knocks);
  const [mode, setMode] = useState<Mode>("quick");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLan, setConfirmLan] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string; selected: boolean }[] | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void get<TableStatusDto>("/api/admin/table").then((s) => {
      useAdminLive.getState().set({ status: s });
      if (s.mode) setMode(s.mode);
    });
    void get<{ id: string; name: string; selected: boolean }[]>("/api/admin/campaigns").then(setCampaigns);
    void post<TableStatusDto>("/api/admin/table/cloudflared/recheck").then((s) =>
      useAdminLive.getState().set({ status: s }),
    );
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function loadCampaigns() {
    setCampaigns(await get<{ id: string; name: string; selected: boolean }[]>("/api/admin/campaigns"));
  }

  const s = live;
  const open = s?.status === "open" || s?.status === "reconnecting";
  const cf = s?.cloudflared;
  const needsCf = (mode === "quick" || mode === "named") && cf !== null && cf !== undefined && !cf.installed;

  async function act<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      toast.danger("Something went wrong", e instanceof ApiError ? e.message : (e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function openTable(confirm = false) {
    if (mode === "lan" && !confirm) {
      setConfirmLan(true);
      return;
    }
    const r = await act("open", () =>
      post<TableStatusDto>("/api/admin/table/open", {
        mode,
        ...(mode === "lan" ? { confirmLan: true } : {}),
      }),
    );
    if (r) {
      useAdminLive.getState().set({ status: r });
      toast.success("The table is open", r.publicUrl ?? undefined);
    }
  }

  async function update(path: string, body: unknown = {}) {
    const r = await act(path, () => post<TableStatusDto>(path, body));
    if (r) useAdminLive.getState().set({ status: r });
    return r;
  }

  if (!s || !campaigns) {
    return (
      <div className="max-w-[880px] space-y-4">
        <div className="skeleton h-9 w-40" />
        <div className="skeleton h-56 w-full" />
      </div>
    );
  }

  const selected = campaigns.find((c) => c.selected);

  return (
    <div className="max-w-[880px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-36 text-bone">Table</h1>
          <p className="mt-1 text-14 text-muted">
            Open the doorway, share the code, and let your friends in.
          </p>
        </div>
      </header>

      <FirstRunChecklist
        refresh={`${s.status}|${s.cloudflared?.installed ?? ""}|${campaigns.length}|${selected?.id ?? ""}`}
      />
      {!selected ? <FirstCampaign onCreated={() => void loadCampaigns()} /> : null}

      <section className="panel mt-6 p-5 sm:p-6" aria-labelledby="table-status">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: STATUS_TONE[s.status], boxShadow: `0 0 10px ${STATUS_TONE[s.status]}` }}
            aria-hidden
          />
          <h2 id="table-status" className="text-22 text-bone" aria-live="polite">
            {STATUS_TEXT[s.status]}
          </h2>
          {open ? (
            <span className="text-14 text-muted">
              · {MODE_LABEL[(s.mode ?? mode) as Mode]}
              {s.sessionNo ? ` · session ${s.sessionNo}` : ""} · {s.counts.admitted + s.counts.spectators} at
              the table
            </span>
          ) : selected ? (
            <span className="text-14 text-muted">· {selected.name}</span>
          ) : null}
          {s.lanActive ? (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] border border-[var(--warning)] bg-[var(--warning-soft)] px-2 py-0.5 text-12 font-bold text-[var(--ember-400)]">
              <ShieldAlert size={14} aria-hidden /> LAN: anyone on your network can reach the join page
            </span>
          ) : null}
        </div>

        {!open ? (
          <>
            <div className="mt-5">
              <Segmented<Mode>
                label="Doorway"
                phoneColumns={2}
                value={mode}
                onChange={setMode}
                options={(["quick", "named", "lan", "local"] as Mode[]).map((m) => ({
                  value: m,
                  label: MODE_LABEL[m],
                }))}
              />
              <p className="mt-2 max-w-[62ch] text-14 text-muted">{MODE_HINT[mode]}</p>
            </div>
            {needsCf && cf ? (
              <InstallCard
                os={cf.os}
                onRecheck={() => void update("/api/admin/table/cloudflared/recheck")}
                busy={busy === "/api/admin/table/cloudflared/recheck"}
              />
            ) : null}
            {mode === "quick" && cf?.configYaml ? (
              <Notice tone="warning" icon={<AlertTriangle size={16} />}>
                Quick tunnels won't start while{" "}
                <code className="mono text-13">~/.cloudflared/config.yaml</code> exists. Rename that file, or
                use a Named tunnel.
              </Notice>
            ) : null}
            {s.error ? (
              <Notice tone="danger" icon={<XCircle size={16} />}>
                {s.error}
              </Notice>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="L"
                icon={<DoorOpen size={18} />}
                loading={busy === "open" || s.status === "opening"}
                disabled={!selected || needsCf || (mode === "quick" && cf?.configYaml === true)}
                onClick={() => void openTable()}
              >
                Open table
              </Button>
            </div>
          </>
        ) : (
          <>
            {s.status === "reconnecting" ? (
              <Notice
                tone="warning"
                icon={<RefreshCw size={16} className="animate-[d20-spin_1.4s_linear_infinite]" />}
              >
                The doorway dropped — reconnecting (attempt {s.doorway.restarts} of 3). Players already inside
                stay connected.
              </Notice>
            ) : null}
            {s.doorway.status === "failed" ? (
              <Notice tone="danger" icon={<XCircle size={16} />}>
                {s.doorway.error ?? "The doorway stopped."} Close and reopen the table to try again.
              </Notice>
            ) : null}
            <div className="mt-5 grid gap-5">
              <div>
                <p className="caps mb-1.5 text-12 text-fog">Public address</p>
                <div
                  className={`flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 ${
                    s.doorway.hostnameChanged
                      ? "border-[var(--warning)] bg-[var(--warning-soft)]"
                      : "border-line bg-ink-900"
                  }`}
                >
                  <Link2 size={16} className="shrink-0 text-brass" aria-hidden />
                  <a
                    href={s.publicUrl ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="min-w-0 flex-1 truncate text-16 text-bone"
                  >
                    {s.publicUrl}
                  </a>
                  <IconButton label="Copy address" onClick={() => void copy(s.publicUrl ?? "", "Address")}>
                    <Copy size={16} />
                  </IconButton>
                </div>
                {s.doorway.hostnameChanged ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-14 text-[var(--ember-400)]">
                    The address changed after a reconnect — share it again.
                    <Button
                      size="S"
                      variant="secondary"
                      onClick={() => void update("/api/admin/table/doorway/ack")}
                    >
                      Got it
                    </Button>
                  </div>
                ) : null}
              </div>
              <div>
                <p className="caps mb-1.5 text-12 text-fog">Invite code</p>
                {s.invite ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="mono select-all whitespace-nowrap rounded-[var(--radius-control)] border border-brass-deep bg-ink-900 px-4 py-2 text-28 font-semibold tracking-[0.14em] text-brass-bright sm:text-36">
                      {s.invite.display}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        size="S"
                        icon={<Copy size={14} />}
                        onClick={() => void copy(s.invite?.display ?? "", "Code")}
                      >
                        Copy
                      </Button>
                      <Button
                        size="S"
                        icon={<RotateCw size={14} />}
                        loading={busy === "/api/admin/table/invite/rotate"}
                        onClick={() => void update("/api/admin/table/invite/rotate")}
                      >
                        Rotate
                      </Button>
                      <Button
                        size="S"
                        variant="danger"
                        icon={<XCircle size={14} />}
                        onClick={() => void update("/api/admin/table/invite/revoke")}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-14 text-muted">No active code — new knocks can't get in.</span>
                    <Button
                      size="S"
                      variant="secondary"
                      onClick={() => void update("/api/admin/table/invite/rotate")}
                    >
                      New code
                    </Button>
                  </div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Select
                  label="Code expires"
                  value={expiryValue(s)}
                  onChange={(v) => void update("/api/admin/table/invite/policy", { expiry: v })}
                  options={[
                    { value: "close", label: "When the table closes" },
                    { value: "2h", label: "In 2 hours" },
                    { value: "4h", label: "In 4 hours" },
                    { value: "8h", label: "In 8 hours" },
                  ]}
                />
                <Select
                  label="Max uses"
                  value={s.invite?.maxUses ? String(s.invite.maxUses) : "unlimited"}
                  onChange={(v) =>
                    void update("/api/admin/table/invite/policy", {
                      maxUses: v === "unlimited" ? null : Number(v),
                    })
                  }
                  options={[
                    { value: "unlimited", label: "Unlimited" },
                    ...[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({
                      value: String(n),
                      label: `${n} use${n === 1 ? "" : "s"}`,
                    })),
                  ]}
                />
                <div className="pt-5">
                  <Toggle
                    checked={s.locked}
                    onChange={(v) => void update("/api/admin/table/lock", { locked: v })}
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        <Lock size={14} aria-hidden /> Lock the door
                      </span>
                    }
                    description="Valid codes can't knock while locked."
                  />
                </div>
              </div>
              <Divider />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-4 text-14 text-muted">
                  <span>
                    <strong className="tabular text-bone">{s.counts.lobby}</strong> in the lobby
                  </span>
                  <span>
                    <strong className="tabular text-bone">{s.counts.admitted}</strong> admitted
                  </span>
                  <span>
                    <strong className="tabular text-bone">{s.counts.spectators}</strong> spectator
                    {s.counts.spectators === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={!s.discordMessage}
                    onClick={() => void copy(s.discordMessage ?? "", "Discord message")}
                  >
                    Copy Discord message
                  </Button>
                  <Button
                    variant="danger"
                    loading={busy === "close" || s.status === "closing"}
                    onClick={() => setConfirmClose(true)}
                  >
                    Close table
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="mt-6" aria-labelledby="lobby-title">
        <h2 id="lobby-title" className="text-22 text-bone">
          In the lobby <span className="tabular text-muted">({knocks.length})</span>
        </h2>
        <div className="panel mt-3">
          {knocks.length === 0 ? (
            <EmptyState
              art="door"
              title={
                open
                  ? "Nobody is knocking right now. Knocks appear here and as a card with a knock sound."
                  : "When the table is open, people who knock wait here for you."
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {knocks.map((k) => (
                <li key={k.sessionId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full"
                    style={{ background: k.color }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-16 font-bold text-bone">{k.name}</p>
                    <p className="text-13 text-muted">
                      <span className={k.identity === "unverified" ? "text-[var(--ember-400)]" : ""}>
                        {IDENTITY_TEXT[k.identity]}
                      </span>{" "}
                      · {k.deviceLabel} · waiting <span className="tabular">{waited(k.knockedAt, now)}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="S"
                      variant="primary"
                      onClick={() => void decideKnock(k.sessionId, "admitPlayer")}
                    >
                      Admit
                    </Button>
                    <Button size="S" onClick={() => void decideKnock(k.sessionId, "admitSpectator")}>
                      As spectator
                    </Button>
                    <Button size="S" variant="ghost" onClick={() => void decideKnock(k.sessionId, "deny")}>
                      Deny
                    </Button>
                    <Button size="S" variant="danger" onClick={() => void decideKnock(k.sessionId, "ban")}>
                      Ban
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <Dialog
        open={confirmLan}
        onClose={() => setConfirmLan(false)}
        title="Open the table on your network?"
        description="LAN mode listens on every network interface of this PC."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLan(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-autofocus
              onClick={() => {
                setConfirmLan(false);
                void openTable(true);
              }}
            >
              Open on the network
            </Button>
          </>
        }
      >
        <p className="text-14 text-muted">
          Anyone on the same Wi-Fi or network can reach the join page at your PC's address. They still need
          the invite code and your approval, and Admin pages stay limited to this PC. The address is plain
          http, so use it only on a network you trust.
        </p>
      </Dialog>
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Close the table?"
        description="Everyone sees the closed screen, invite codes stop working, and the doorway shuts. Everything is already saved."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              Keep it open
            </Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                setConfirmClose(false);
                void act("close", () => post<TableStatusDto>("/api/admin/table/close")).then((r) => {
                  if (r) useAdminLive.getState().set({ status: r });
                });
              }}
            >
              Close table
            </Button>
          </>
        }
      />
    </div>
  );
}

function expiryValue(s: TableStatusDto): "close" | "2h" | "4h" | "8h" {
  const exp = s.invite?.expiresAt;
  if (!exp) return "close";
  const h = (exp - Date.now()) / 3600_000;
  return h > 6 ? "8h" : h > 3 ? "4h" : "2h";
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "danger" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "border-danger bg-[var(--danger-soft)] text-bone"
      : tone === "warning"
        ? "border-[var(--warning)] bg-[var(--warning-soft)] text-bone"
        : "border-[var(--magic)] bg-[var(--magic-soft)] text-bone";
  return (
    <div
      role="status"
      className={`mt-4 flex items-start gap-2.5 rounded-[var(--radius-control)] border px-3.5 py-2.5 text-14 ${cls}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

/** Install card for the detected OS (SPEC §8.1, AC-HOST-06). */
function InstallCard({ os, onRecheck, busy }: { os: string; onRecheck: () => void; busy: boolean }) {
  const cmds: { label: string; cmd: string }[] =
    os === "darwin"
      ? [{ label: "macOS (Homebrew)", cmd: "brew install cloudflared" }]
      : os === "win32"
        ? [{ label: "Windows (winget)", cmd: "winget install --id Cloudflare.cloudflared" }]
        : [
            {
              label: "1. Add Cloudflare's signing key",
              cmd: "sudo mkdir -p --mode=0755 /usr/share/keyrings && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
            },
            {
              label: "2. Add the package repository",
              cmd: "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list",
            },
            { label: "3. Install", cmd: "sudo apt-get update && sudo apt-get install cloudflared" },
          ];
  return (
    <div className="mt-5 rounded-[var(--radius-panel)] border border-brass-deep/60 bg-raised p-4">
      <h3 className="text-18 text-bone">Install cloudflared to open a doorway</h3>
      <p className="mt-1 text-14 text-muted">
        cloudflared is Cloudflare's small helper that makes the tunnel. Install it once, then press Re-check.
        Local and LAN modes work without it.
      </p>
      <div className="mt-3 grid gap-2">
        {cmds.map((c) => (
          <div key={c.label}>
            <p className="text-13 text-muted">{c.label}</p>
            <div className="mt-1 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2">
              <code className="mono min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-13 text-brass-bright">
                {c.cmd}
              </code>
              <IconButton label={`Copy: ${c.label}`} onClick={() => void copy(c.cmd, "Command")}>
                <Copy size={15} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
      {os !== "darwin" && os !== "win32" ? (
        <p className="mt-2 text-13 text-muted">
          Other distributions: see{" "}
          <a href="https://pkg.cloudflare.com/index.html" target="_blank" rel="noopener noreferrer nofollow">
            Cloudflare's package repository
          </a>
          .
        </p>
      ) : null}
      <Button className="mt-3" size="S" icon={<RefreshCw size={14} />} loading={busy} onClick={onRecheck}>
        Re-check
      </Button>
    </div>
  );
}

function FirstCampaign({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const demo = async () => {
    setDemoBusy(true);
    try {
      await post("/api/admin/campaigns/demo", {});
      toast.success(
        "The Lantern Crypt is ready",
        "A small dungeon with lights, fog, goblins and a secret door.",
      );
      onCreated();
    } catch (err) {
      toast.danger("Couldn't make the demo", (err as Error).message);
    } finally {
      setDemoBusy(false);
    }
  };
  return (
    <form
      className="panel mt-6 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          await post("/api/admin/campaigns", { name: name.trim(), select: true });
          toast.success("Campaign created");
          onCreated();
        } catch (err) {
          toast.danger("Couldn't create it", (err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-22 text-bone">Start your first campaign</h2>
      <p className="mt-1 text-14 text-muted">
        The table runs one campaign at a time. You can rename it later.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <TextInput
          className="min-w-[240px] flex-1"
          label="Campaign name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. The Lantern Crypt"
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
          Create campaign
        </Button>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <div className="min-w-[220px] flex-1">
          <p className="text-16 font-bold text-bone">Or try the demo first</p>
          <p className="text-13 text-muted">
            The Lantern Crypt: a torchlit dungeon with fog of war, a secret door, goblins and a warden — ready
            to open and play in a minute.
          </p>
        </div>
        <Button type="button" variant="secondary" loading={demoBusy} onClick={() => void demo()}>
          Start with the demo
        </Button>
      </div>
    </form>
  );
}

interface Checklist {
  steps: { password: boolean; cloudflared: boolean; campaign: boolean; map: boolean; tableOpened: boolean };
  done: boolean;
}

const STEPS: { key: keyof Checklist["steps"]; label: string; how: string }[] = [
  { key: "password", label: "Set the Admin password", how: "Done when you first opened the console." },
  {
    key: "cloudflared",
    label: "Install cloudflared",
    how: "For friends outside your home — see the doorway card below. Playing on one network? Skip it with LAN.",
  },
  {
    key: "campaign",
    label: "Create or import a campaign",
    how: "Below, or on Campaigns — or start with the demo.",
  },
  { key: "map", label: "Add a map", how: "At the table: DM panel → Scenes → New scene." },
  {
    key: "tableOpened",
    label: "Open the table",
    how: "Choose how friends reach you below, then Open table.",
  },
];

/**
 * The first-run checklist (SPEC §8.20; AC-ADM-06): the five steps to a first game, ticked as they're done, on top of
 * the console until all are — then gone.
 */
function FirstRunChecklist({ refresh }: { refresh: string }) {
  const [c, setC] = useState<Checklist | null>(null);
  useEffect(() => {
    void refresh;
    void get<Checklist>("/api/admin/checklist").then(setC, () => {});
  }, [refresh]);
  if (!c || c.done) return null;
  const left = STEPS.filter((x) => !c.steps[x.key]).length;
  return (
    <section
      className="panel relative mt-6 p-5 sm:p-6"
      aria-labelledby="first-run"
      data-testid="first-run-checklist"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="first-run" className="text-22 text-bone">
          Getting started
        </h2>
        <span className="tabular text-13 text-muted">
          {STEPS.length - left} of {STEPS.length} done
        </span>
      </div>
      <ol className="mt-4 flex flex-col gap-3">
        {STEPS.map((x, i) => {
          const done = c.steps[x.key];
          return (
            <li key={x.key} className="flex items-start gap-3" data-step={x.key} data-done={done ? "1" : "0"}>
              <span
                className={`tabular mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-13 font-bold ${
                  done ? "bg-verdigris text-ink-950" : "border border-line text-muted"
                }`}
                aria-hidden
              >
                {done ? "✓" : i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={`text-16 ${done ? "text-muted line-through decoration-1" : "font-bold text-bone"}`}
                >
                  {x.label}
                  <span className="sr-only">{done ? " — done" : " — to do"}</span>
                </span>
                {done ? null : <span className="text-13 text-muted">{x.how}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
