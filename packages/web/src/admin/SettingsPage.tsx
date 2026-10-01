import { type ReactNode, useEffect, useState } from "react";
import { ApiError, get, patch } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { Select, Toggle } from "../ui/controls.tsx";
import { TextInput } from "../ui/Field.tsx";
import { LoadPanel, useLoad } from "../ui/Loadable.tsx";
import { Divider } from "../ui/ornaments.tsx";
import { toast } from "../ui/Toast.tsx";

interface SettingsDto {
  tunnelMode: "quick" | "named" | "lan" | "local";
  tunnelToken: string | null;
  publicHostname: string | null;
  cloudflaredPath: string | null;
  autoAdmitReturning: boolean;
  dmsCanAdmit: boolean;
  autoApproveImages: boolean;
  allowAdminThroughDoorway: boolean;
  allowRemoteApi: boolean;
  port: number | null;
  newCampaignDefaults: { rulesPack: "srd-5.2.1" | "srd-5.1"; units: "ft" | "m" };
  local: boolean;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel mt-6 p-5 sm:p-6">
      <h2 className="text-22 text-bone">{title}</h2>
      {description ? <p className="mt-1 max-w-[64ch] text-14 text-muted">{description}</p> : null}
      <Divider className="my-5" />
      <div className="grid gap-5">{children}</div>
    </section>
  );
}

/** Admin → Settings (SPEC §8.20; port/LAN/tunnel/cloudflared-path only from the host PC, §22.3). */
export function SettingsPage() {
  const loaded = useLoad(() => get<SettingsDto>("/api/admin/settings"), []);
  const [s, setS] = useState<SettingsDto | null>(null);
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [cfPath, setCfPath] = useState("");
  const [port, setPort] = useState("");

  useEffect(() => {
    const r = loaded.data;
    if (!r) return;
    setS(r);
    setHost(r.publicHostname ?? "");
    setCfPath(r.cloudflaredPath ?? "");
    setPort(r.port ? String(r.port) : "");
  }, [loaded.data]);

  async function save(p: Record<string, unknown>, ok = "Saved") {
    try {
      const r = await patch<Omit<SettingsDto, "local">>("/api/admin/settings", p);
      setS((cur) => (cur ? { ...cur, ...r } : cur));
      toast.success(ok);
      return true;
    } catch (e) {
      toast.danger("Couldn't save", e instanceof ApiError ? e.message : (e as Error).message);
      return false;
    }
  }

  if (!s && loaded.status === "error")
    return (
      <div className="max-w-[880px]">
        <h1 className="text-36 text-bone">Settings</h1>
        <LoadPanel load={loaded} what="the settings" />
      </div>
    );
  if (!s) {
    return (
      <div className="max-w-[880px] space-y-4">
        <div className="skeleton h-9 w-44" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }
  const hostOnly = !s.local;

  return (
    <div className="max-w-[880px]">
      <h1 className="text-36 text-bone">Settings</h1>
      <p className="mt-1 text-14 text-muted">How the doorway works and who gets in.</p>

      <Section
        title="Named tunnel"
        description="For a stable address like table.example.com: create a tunnel in your Cloudflare dashboard (Zero Trust → Networks → Tunnels) with a public hostname pointing to http://127.0.0.1:4747, then paste its token here."
      >
        {hostOnly ? (
          <p className="text-14 text-[var(--ember-400)]">
            These settings can only be changed on the host PC.
          </p>
        ) : null}
        <TextInput
          label="Tunnel token"
          type="password"
          autoComplete="off"
          placeholder={s.tunnelToken ? `Saved: ${s.tunnelToken}` : "Paste the token from Cloudflare"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={hostOnly}
          help="Stored encrypted on this PC; never shown in full again."
          action={
            <>
              {/* (A field's Save as every field's: one weight for them all — critic RSP-01 r2.) */}
              <Button
                className="flex-1"
                disabled={hostOnly || token.length < 20}
                onClick={async () => (await save({ tunnelToken: token }, "Token saved")) && setToken("")}
              >
                Save token
              </Button>
              {s.tunnelToken ? (
                <Button
                  variant="ghost"
                  disabled={hostOnly}
                  onClick={() => void save({ tunnelToken: null }, "Token removed")}
                >
                  Remove
                </Button>
              ) : null}
            </>
          }
        />
        <TextInput
          label="Public hostname"
          placeholder="e.g. table.example.com"
          value={host}
          onChange={(e) => setHost(e.target.value.trim())}
          disabled={hostOnly}
          action={
            <Button
              className="flex-1"
              disabled={hostOnly || host === (s.publicHostname ?? "")}
              onClick={() => void save({ publicHostname: host || null })}
            >
              Save hostname
            </Button>
          }
        />
        <TextInput
          label="cloudflared path"
          placeholder="cloudflared (found on PATH)"
          value={cfPath}
          onChange={(e) => setCfPath(e.target.value)}
          disabled={hostOnly}
          help="Only needed if cloudflared isn't on your PATH. Takes effect after a restart."
          action={
            <Button
              className="flex-1"
              disabled={hostOnly || cfPath === (s.cloudflaredPath ?? "")}
              onClick={() => void save({ cloudflaredPath: cfPath || null })}
            >
              Save path
            </Button>
          }
        />
      </Section>

      <Section
        title="This computer"
        description="Where Gloam listens. The address changes when Gloam restarts; open the new one then (an invite link or bookmark with the old port stops working)."
      >
        {hostOnly ? (
          <p className="text-14 text-[var(--ember-400)]">This can only be changed on the host PC.</p>
        ) : null}
        <TextInput
          label="Port"
          inputMode="numeric"
          placeholder="4747 (the default)"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))}
          disabled={hostOnly}
          help="1024–65535. Takes effect when Gloam restarts."
          action={
            <Button
              className="flex-1"
              disabled={
                hostOnly ||
                port === (s.port ? String(s.port) : "") ||
                (port !== "" && (Number(port) < 1024 || Number(port) > 65535))
              }
              onClick={() =>
                void save({ port: port ? Number(port) : null }, "Port saved — restart Gloam to use it")
              }
            >
              Save port
            </Button>
          }
        />
      </Section>

      <Section
        title="New campaigns"
        description="What a campaign made from now on starts with (each can change its own)."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Rules"
            value={s.newCampaignDefaults.rulesPack}
            onChange={(v) => void save({ newCampaignDefaults: { ...s.newCampaignDefaults, rulesPack: v } })}
            options={[
              { value: "srd-5.2.1", label: "SRD 5.2.1 (the 2024 rules)" },
              { value: "srd-5.1", label: "SRD 5.1 (the 2014 rules)" },
            ]}
          />
          <Select
            label="Distances in"
            value={s.newCampaignDefaults.units}
            onChange={(v) => void save({ newCampaignDefaults: { ...s.newCampaignDefaults, units: v } })}
            options={[
              { value: "ft", label: "Feet" },
              { value: "m", label: "Metres" },
            ]}
          />
        </div>
      </Section>

      <Section
        title="Admission"
        description="Knocks always reach you with a card and a sound; these rules decide who can answer them."
      >
        <Toggle
          checked={s.autoAdmitReturning}
          onChange={(v) => void save({ autoAdmitReturning: v })}
          label="Auto-admit returning players"
          description="Players who enter their PIN, or whose browser is recognised, skip the knock. Each knock is still recorded."
        />
        <Toggle
          checked={s.dmsCanAdmit}
          onChange={(v) => void save({ dmsCanAdmit: v })}
          label="DMs can admit"
          description="Let appointed DMs admit, deny and kick people, not just you."
        />
        <Toggle
          checked={s.autoApproveImages}
          onChange={(v) => void save({ autoApproveImages: v })}
          label="Auto-approve players' images"
          description="Pictures players upload go straight into use instead of waiting in Approvals. Models and sounds still wait."
        />
      </Section>

      <Section title="Admin sign-in" description="By default the Admin console only opens on this PC.">
        <Toggle
          checked={s.allowAdminThroughDoorway}
          onChange={(v) => void save({ allowAdminThroughDoorway: v })}
          label="Allow Admin sign-in through the doorway"
          description="Lets you sign in with your password from another device over the tunnel. Doorway, port and LAN settings still only change here."
        />
      </Section>

      <Section
        title="Local API"
        description="API tokens (Admin → API & MCP) let tools on this computer — like Claude — use Gloam."
      >
        <Toggle
          checked={s.allowRemoteApi}
          onChange={(v) => void save({ allowRemoteApi: v })}
          disabled={hostOnly}
          label="Allow remote API"
          description="Let API tokens work from other computers too, through the doorway or the LAN. Off, they only work here."
        />
      </Section>
    </div>
  );
}
