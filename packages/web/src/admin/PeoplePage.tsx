import { Ban, KeyRound, Pencil, Trash2, Users, UserX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, patch, post } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { TextInput } from "../ui/Field.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { toast } from "../ui/Toast.tsx";

interface Person {
  id: string;
  name: string;
  color: string;
  isAdmin: boolean;
  hasPin: boolean;
  banned: boolean;
  banReason: string | null;
  lastSeenAt: number | null;
  role: string | null;
  online: boolean;
  devices: { id: string; label: string; lastSeenAt: number | null }[];
}
interface CampaignItem {
  id: string;
  name: string;
  selected: boolean;
  archived: boolean;
}

const ROLE: Record<string, string> = { admin: "Host", dm: "DM", player: "Player", spectator: "Spectator" };

const seen = (at: number | null) =>
  at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

type Edit =
  | { kind: "rename"; p: Person }
  | { kind: "pin"; p: Person }
  | { kind: "role"; p: Person }
  | { kind: "ban"; p: Person }
  | { kind: "delete"; p: Person };

/**
 * Admin → People (SPEC §8.20; AC-ADM-02): every profile — status, last seen, their role in the table's campaign — with
 * rename, set or clear a PIN, their role per campaign (make a DM), kick, ban and unban, and delete with their
 * characters handed to someone else.
 */
export function PeoplePage() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      get<Person[]>("/api/admin/people"),
      get<CampaignItem[]>("/api/admin/campaigns"),
    ]);
    setPeople(p);
    setCampaigns(c);
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => toast.danger("Couldn't load people", e.message));
  }, [load]);
  const act = async (f: () => Promise<unknown>, done: string, fail: string) => {
    try {
      await f();
      toast.success(done);
      setEdit(null);
      await load();
    } catch (e) {
      toast.danger(fail, (e as Error).message);
    }
  };
  const list = (people ?? []).filter((p) => !p.isAdmin);
  return (
    <div className="max-w-[880px]" data-testid="people-page">
      <header>
        <h1 className="text-36 text-bone">People</h1>
        <p className="mt-1 text-14 text-muted">
          Everyone who has knocked on your door. Rename them, give them a PIN, make one a DM, send someone
          back to the waiting room — or ban and remove them.
        </p>
      </header>
      <section className="panel mt-6 flex flex-col gap-2 p-5 sm:p-6" aria-label="Profiles">
        {people && list.length === 0 ? (
          <EmptyState art="door" title="No one yet. When friends join with your invite code, they're here." />
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            {list.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid="person-row"
                data-user={p.id}
              >
                <Portrait name={p.name} color={p.color} size={36} dim={!p.online} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-16 font-bold text-bone">{p.name}</span>
                    {p.banned ? (
                      <span className="caps rounded-chip border border-danger px-1.5 text-12 text-danger-text">
                        Banned
                      </span>
                    ) : p.online ? (
                      <span className="caps text-12 text-verdigris">At the table</span>
                    ) : null}
                  </span>
                  <span className="text-13 text-muted">
                    {p.role ? ROLE[p.role] : "Not in this campaign"} · {p.hasPin ? "PIN set" : "no PIN"} ·
                    last seen <span className="whitespace-nowrap">{seen(p.lastSeenAt)}</span>
                    {p.devices.length
                      ? ` · ${p.devices.length} ${p.devices.length === 1 ? "device" : "devices"}`
                      : ""}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<Pencil size={14} />}
                    onClick={() => setEdit({ kind: "rename", p })}
                  >
                    Rename
                  </Button>
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<KeyRound size={14} />}
                    onClick={() => setEdit({ kind: "pin", p })}
                  >
                    PIN
                  </Button>
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<Users size={14} />}
                    onClick={() => setEdit({ kind: "role", p })}
                  >
                    Role
                  </Button>
                  {p.online ? (
                    <Button
                      size="S"
                      variant="ghost"
                      icon={<UserX size={14} />}
                      onClick={() =>
                        void act(
                          () => post(`/api/admin/people/${p.id}/kick`),
                          `${p.name} is back in the waiting room`,
                          "Couldn't kick them",
                        )
                      }
                    >
                      Kick
                    </Button>
                  ) : null}
                  {p.banned ? (
                    <Button
                      size="S"
                      variant="ghost"
                      onClick={() =>
                        void act(
                          () => post(`/api/admin/people/${p.id}/unban`),
                          `${p.name} may knock again`,
                          "Couldn't unban them",
                        )
                      }
                    >
                      Unban
                    </Button>
                  ) : (
                    <Button
                      size="S"
                      variant="ghost"
                      icon={<Ban size={14} />}
                      onClick={() => setEdit({ kind: "ban", p })}
                    >
                      Ban
                    </Button>
                  )}
                  <Button
                    size="S"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    onClick={() => setEdit({ kind: "delete", p })}
                  >
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {edit ? (
        <EditDialog edit={edit} people={list} campaigns={campaigns} onClose={() => setEdit(null)} act={act} />
      ) : null}
    </div>
  );
}

function EditDialog({
  edit,
  people,
  campaigns,
  onClose,
  act,
}: {
  edit: Edit;
  people: Person[];
  campaigns: CampaignItem[];
  onClose: () => void;
  act: (f: () => Promise<unknown>, done: string, fail: string) => Promise<void>;
}) {
  const p = edit.p;
  const [name, setName] = useState(p.name);
  const [pin, setPin] = useState("");
  const [campaignId, setCampaignId] = useState(
    campaigns.find((c) => c.selected)?.id ?? campaigns[0]?.id ?? "",
  );
  const [role, setRole] = useState<string>(p.role && p.role !== "admin" ? p.role : "player");
  const [reason, setReason] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, done: string, fail: string) => {
    setBusy(true);
    await act(f, done, fail);
    setBusy(false);
  };
  const footer = (label: string, go: () => void, danger = false, disabled = false) => (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant={danger ? "danger" : "primary"} loading={busy} disabled={disabled} onClick={go}>
        {label}
      </Button>
    </>
  );
  if (edit.kind === "rename")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`Rename ${p.name}`}
        footer={footer(
          "Rename",
          () =>
            void run(() => patch(`/api/admin/people/${p.id}`, { name }), "Renamed", "Couldn't rename them"),
          false,
          !name.trim(),
        )}
      >
        <TextInput
          label="Name at the table"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          data-autofocus
        />
      </Dialog>
    );
  if (edit.kind === "pin")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${p.name}'s PIN`}
        description="A returning player proves who they are with it, from any device. 4–8 digits."
        footer={
          <>
            {p.hasPin ? (
              <Button
                variant="ghost"
                loading={busy}
                onClick={() =>
                  void run(
                    () => post(`/api/admin/people/${p.id}/pin`, { pin: null }),
                    "PIN cleared",
                    "Couldn't clear it",
                  )
                }
              >
                Clear the PIN
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={busy}
              disabled={!/^\d{4,8}$/.test(pin)}
              onClick={() =>
                void run(() => post(`/api/admin/people/${p.id}/pin`, { pin }), "PIN set", "Couldn't set it")
              }
            >
              Set PIN
            </Button>
          </>
        }
      >
        <TextInput
          label={p.hasPin ? "A new PIN" : "PIN"}
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          data-autofocus
        />
      </Dialog>
    );
  if (edit.kind === "role")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${p.name}'s role`}
        description="A DM runs the table with you; a player plays; a spectator watches. At the table now, they rejoin with it at once."
        footer={footer(
          "Save",
          () =>
            void run(
              () =>
                post(`/api/admin/people/${p.id}/role`, { campaignId, role: role === "none" ? null : role }),
              "Role saved",
              "Couldn't change it",
            ),
          false,
          !campaignId,
        )}
      >
        <div className="grid gap-4">
          <Select
            label="In the campaign"
            value={campaignId}
            onChange={setCampaignId}
            options={campaigns.map((c) => ({
              value: c.id,
              label: `${c.name}${c.archived ? " (archived)" : ""}`,
            }))}
          />
          <Select
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: "dm", label: "DM" },
              { value: "player", label: "Player" },
              { value: "spectator", label: "Spectator" },
              { value: "none", label: "Not in this campaign" },
            ]}
          />
        </div>
      </Dialog>
    );
  if (edit.kind === "ban")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`Ban ${p.name}?`}
        description="They're sent away now, and every device they've used is refused from then on. You can unban them later."
        footer={footer(
          "Ban",
          () =>
            void run(
              () => post(`/api/admin/people/${p.id}/ban`, reason.trim() ? { reason: reason.trim() } : {}),
              `${p.name} is banned`,
              "Couldn't ban them",
            ),
          true,
        )}
      >
        <TextInput
          label="Why (for you)"
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    );
  const others = people.filter((x) => x.id !== p.id && !x.banned);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${p.name}?`}
      description="Their profile goes for good. Their characters — and their tokens — go to whoever you choose, or stay with the DMs."
      footer={footer(
        "Delete",
        () =>
          void run(
            () => post(`/api/admin/people/${p.id}/delete`, { reassignTo: to || null }),
            `${p.name} is deleted`,
            "Couldn't delete them",
          ),
        true,
      )}
    >
      <Select
        label="Their characters go to"
        value={to}
        onChange={setTo}
        options={[
          { value: "", label: "No one — the DMs keep them" },
          ...others.map((x) => ({ value: x.id, label: x.name })),
        ]}
      />
    </Dialog>
  );
}
