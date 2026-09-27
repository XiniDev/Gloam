import { type ReactNode, useEffect, useState } from "react";
import { ApiError, get, patch } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { Toggle } from "../ui/controls.tsx";
import { TextInput } from "../ui/Field.tsx";
import { Divider } from "../ui/ornaments.tsx";
import { toast } from "../ui/Toast.tsx";

interface SettingsDto {
  tunnelMode: "quick" | "named" | "lan" | "local";
  tunnelToken: string | null;
  publicHostname: string | null;
  cloudflaredPath: string | null;
  autoAdmitReturning: boolean;
  dmsCanAdmit: boolean;
  allowAdminThroughDoorway: boolean;
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
  const [s, setS] = useState<SettingsDto | null>(null);
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [cfPath, setCfPath] = useState("");

  useEffect(() => {
    void get<SettingsDto>("/api/admin/settings").then((r) => {
      setS(r);
      setHost(r.publicHostname ?? "");
      setCfPath(r.cloudflaredPath ?? "");
    });
  }, []);

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
        <div className="grid gap-4 sm:grid-cols-[1fr_13rem] sm:items-end">
          <TextInput
            label="Tunnel token"
            type="password"
            autoComplete="off"
            placeholder={s.tunnelToken ? `Saved: ${s.tunnelToken}` : "Paste the token from Cloudflare"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={hostOnly}
            help="Stored encrypted on this PC; never shown in full again."
          />
          <div className="flex gap-2 sm:pb-6">
            <Button
              className="flex-1"
              variant="primary"
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
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_13rem] sm:items-end">
          <TextInput
            label="Public hostname"
            placeholder="table.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value.trim())}
            disabled={hostOnly}
          />
          <Button
            className="w-full sm:mb-0.5"
            disabled={hostOnly || host === (s.publicHostname ?? "")}
            onClick={() => void save({ publicHostname: host || null })}
          >
            Save hostname
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_13rem] sm:items-end">
          <TextInput
            label="cloudflared path"
            placeholder="cloudflared (found on PATH)"
            value={cfPath}
            onChange={(e) => setCfPath(e.target.value)}
            disabled={hostOnly}
            help="Only needed if cloudflared isn't on your PATH. Takes effect after a restart."
          />
          <Button
            className="w-full sm:mb-6"
            disabled={hostOnly || cfPath === (s.cloudflaredPath ?? "")}
            onClick={() => void save({ cloudflaredPath: cfPath || null })}
          >
            Save path
          </Button>
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
      </Section>

      <Section title="Admin sign-in" description="By default the Admin console only opens on this PC.">
        <Toggle
          checked={s.allowAdminThroughDoorway}
          onChange={(v) => void save({ allowAdminThroughDoorway: v })}
          label="Allow Admin sign-in through the doorway"
          description="Lets you sign in with your password from another device over the tunnel. Doorway, port and LAN settings still only change here."
        />
      </Section>
    </div>
  );
}
