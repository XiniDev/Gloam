import type { Room } from "@colyseus/sdk";
import { LogOut, Settings as SettingsIcon, Swords, Table2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { leaveRoom } from "../net/colyseus.ts";
import { ApiError, post } from "../net/http.ts";
import { useSession } from "../state/session.ts";
import { Button } from "../ui/Button.tsx";
import { TextInput } from "../ui/Field.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { Filigree, Sparkle } from "../ui/ornaments.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";
import { useAdminLive, watchLobby } from "./realtime.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { TablePage } from "./TablePage.tsx";

/** `/admin/*` — the Admin console (SPEC §8.20, §29.6). */
export default function AdminApp() {
  const me = useSession((s) => s.me);
  const loading = useSession((s) => s.loading);
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (loading && !me) return <FullScreenLoader />;
  if (!me?.authenticated || me.session?.kind !== "admin")
    return <AdminLogin local={me?.local ?? false} onDone={() => void refresh()} />;
  return <Console />;
}

function AdminLogin({ local, onDone }: { local: boolean; onDone: () => void }) {
  const [params] = useSearchParams();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(
    params.get("magic") === "expired" ? "That admin link has expired or was already used." : null,
  );
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/admin/login", { password: pw });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="relative grid min-h-[100dvh] place-items-center bg-bg p-4">
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden />
      <form onSubmit={submit} className="panel relative w-full max-w-[420px] px-7 pb-8 pt-9">
        <Filigree />
        <div className="flex items-center gap-2">
          <Sparkle size={20} />
          <span className="display text-22 font-semibold tracking-[0.04em] text-bone">GLOAM</span>
          <span className="caps ml-1 text-12 text-brass">Admin</span>
        </div>
        <h1 className="mt-5 text-28 text-bone">Sign in to run the table</h1>
        <p className="mt-2 text-14 text-muted">
          {local
            ? "Use your Admin password, or the one-time admin link printed in the terminal."
            : "Admin sign-in normally works only on the host PC. Your host can allow it through the doorway in Settings."}
        </p>
        <TextInput
          className="mt-6"
          label="Admin password"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          error={error}
        />
        <Button
          type="submit"
          variant="primary"
          size="L"
          className="mt-6 w-full"
          loading={busy}
          disabled={!pw}
        >
          Sign in
        </Button>
      </form>
    </main>
  );
}

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-14 font-bold transition-colors ${
          isActive
            ? "bg-raised text-brass-bright shadow-[inset_2px_0_0_var(--brass-400)]"
            : "text-muted hover:bg-raised hover:text-bone"
        }`
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

function Console() {
  const navigate = useNavigate();
  const connected = useAdminLive((s) => s.connected);
  useEffect(() => {
    let room: Room | null = null;
    let cancelled = false;
    void watchLobby()
      .then((r) => {
        if (cancelled) leaveRoom(r);
        else room = r;
      })
      .catch(() => useAdminLive.getState().set({ connected: false }));
    return () => {
      cancelled = true;
      leaveRoom(room);
    };
  }, []);
  async function logout() {
    await post("/api/session/logout").catch(() => {});
    navigate("/", { replace: true });
    window.location.reload();
  }
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg md:flex-row">
      <aside className="flex shrink-0 flex-col gap-1 border-b border-line bg-surface p-3 md:w-[232px] md:border-b-0 md:border-r">
        <div className="mb-3 flex items-center gap-2 px-2 pt-1">
          <Sparkle size={18} />
          <span className="display text-18 font-semibold tracking-[0.04em] text-bone">GLOAM</span>
          <span className="caps text-12 text-brass">Admin</span>
          <span className="ml-auto md:hidden">
            <SoundChip />
          </span>
        </div>
        <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto md:flex-col">
          <NavItem to="/admin" icon={<Table2 size={17} />}>
            Table
          </NavItem>
          <NavItem to="/admin/settings" icon={<SettingsIcon size={17} />}>
            Settings
          </NavItem>
        </nav>
        <div className="mt-auto hidden flex-col gap-1 pt-4 md:flex">
          <Button variant="secondary" icon={<Swords size={16} />} onClick={() => navigate("/table")}>
            Go to the table
          </Button>
          <Button variant="ghost" icon={<LogOut size={16} />} onClick={() => void logout()}>
            Sign out
          </Button>
          <div className="mt-2 flex items-center justify-between px-1 text-12 text-faint">
            <span className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: connected ? "var(--verdigris-400)" : "var(--ember-400)" }}
                aria-hidden
              />
              {connected ? "Live" : "Reconnecting…"}
            </span>
            <SoundChip />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <Routes>
          <Route index element={<TablePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<TablePage />} />
        </Routes>
      </main>
    </div>
  );
}
