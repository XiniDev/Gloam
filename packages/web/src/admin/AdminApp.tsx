import type { Room } from "@colyseus/sdk";
import {
  Archive,
  BookOpen,
  ChevronDown,
  FolderOpen,
  Images,
  Info,
  LogOut,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  Swords,
  Table2,
  Users,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { leaveRoom } from "../net/colyseus.ts";
import { ApiError, post } from "../net/http.ts";
import { useSession } from "../state/session.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { TextInput } from "../ui/Field.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { Filigree, Sparkle } from "../ui/ornaments.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";
import { AboutPage } from "./AboutPage.tsx";
import { ApiPage } from "./ApiPage.tsx";
import { AssetsPage } from "./AssetsPage.tsx";
import { CampaignsPage } from "./CampaignsPage.tsx";
import { ContentPage } from "./ContentPage.tsx";
import { PeoplePage } from "./PeoplePage.tsx";
import { useAdminLive, watchLobby } from "./realtime.ts";
import { SavesPage } from "./SavesPage.tsx";
import { SecurityPage } from "./SecurityPage.tsx";
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

function NavItem({
  to,
  icon,
  children,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      className={({ isActive }) =>
        `flex h-10 shrink-0 items-center gap-3 whitespace-nowrap rounded-[var(--radius-control)] px-3 text-14 font-bold transition-colors ${
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

/** The console's pages, in the order the sidebar lists them. */
const SECTIONS: { to: string; label: string; Icon: typeof Table2 }[] = [
  { to: "/admin", label: "Table", Icon: Table2 },
  { to: "/admin/people", label: "People", Icon: Users },
  { to: "/admin/campaigns", label: "Campaigns", Icon: FolderOpen },
  { to: "/admin/saves", label: "Saves", Icon: Archive },
  { to: "/admin/assets", label: "Assets", Icon: Images },
  { to: "/admin/content", label: "Content", Icon: BookOpen },
  { to: "/admin/api", label: "API & MCP", Icon: Plug },
  { to: "/admin/settings", label: "Settings", Icon: SettingsIcon },
  { to: "/admin/security", label: "Security log", Icon: ShieldCheck },
  { to: "/admin/about", label: "About", Icon: Info },
];

/**
 * A phone's (or a short landscape screen's) way round the console: the page you're on as a button that opens every
 * page in a grid under it; choosing one, pressing elsewhere or Escape closes it.
 */
function SectionPicker() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current =
    SECTIONS.find((x) => x.to === location.pathname) ??
    SECTIONS.find((x) => x.to !== "/admin" && location.pathname.startsWith(`${x.to}/`)) ??
    (SECTIONS[0] as (typeof SECTIONS)[number]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page changing is the cue
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <nav ref={ref} aria-label="Admin sections" className="relative side:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-full items-center gap-3 rounded-[var(--radius-control)] border border-line bg-raised px-3 text-14 font-bold text-brass-bright hover:border-line-strong"
      >
        <current.Icon size={17} aria-hidden />
        <span className="min-w-0 truncate">{current.label}</span>
        <span className="ml-auto text-12 font-normal text-muted">All sections</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={`shrink-0 text-muted transition-transform duration-[var(--dur-fast)] ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          id={listId}
          className="panel absolute inset-x-0 top-full z-40 mt-1 grid grid-cols-2 gap-1 p-1.5 short:grid-cols-3"
        >
          {/* (Chosen — the page you're on too — it closes.) */}
          {SECTIONS.map((x) => (
            <NavItem key={x.to} to={x.to} icon={<x.Icon size={17} />} onClick={() => setOpen(false)}>
              {x.label}
            </NavItem>
          ))}
        </div>
      ) : null}
    </nav>
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
    <div className="flex min-h-[100dvh] flex-col bg-bg side:flex-row">
      {/* On wide screens the sidebar is exactly the screen's height and stays put while the page scrolls, so its
          bottom actions are always reachable; on phones it's a header row. */}
      <aside className="flex shrink-0 flex-col gap-1 border-b border-line bg-surface p-3 side:sticky side:top-0 side:h-[100dvh] side:w-[232px] side:overflow-y-auto side:border-b-0 side:border-r">
        <div className="mb-3 flex items-center gap-2 px-2 pt-1">
          <Sparkle size={18} />
          <span className="display text-18 font-semibold tracking-[0.04em] text-bone">GLOAM</span>
          <span className="caps text-12 text-brass">Admin</span>
          <span className="ml-auto flex items-center gap-1 side:hidden">
            <IconButton label="Go to the table" onClick={() => navigate("/table")}>
              <Swords size={17} />
            </IconButton>
            <IconButton label="Sign out" onClick={() => void logout()}>
              <LogOut size={17} />
            </IconButton>
            <SoundChip />
          </span>
        </div>
        {/* A phone, or a short screen on its side: the page you're on, which opens the whole list (a strip scrolling
            sideways cut its labels at both edges — critic RSP-01 r1). Wide and tall enough: the sidebar's column. */}
        <SectionPicker />
        <nav aria-label="Admin sections" className="hidden flex-col gap-1 side:flex">
          {SECTIONS.map((x) => (
            <NavItem key={x.to} to={x.to} icon={<x.Icon size={17} />}>
              {x.label}
            </NavItem>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-1 pt-4 side:flex">
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
      {/* A very wide screen: the page's column in the middle of what's left (it sat at the left with ~770 px of empty
          ink beside it at 1920 — critic RSP-01 r1). */}
      <main className="min-w-0 flex-1 px-4 py-6 side:px-10 side:py-8 min-[1600px]:[&>*]:mx-auto">
        <Routes>
          <Route index element={<TablePage />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="saves" element={<SavesPage />} />
          <Route path="assets" element={<AssetsPage />} />
          <Route path="content" element={<ContentPage />} />
          <Route path="api" element={<ApiPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="*" element={<TablePage />} />
        </Routes>
      </main>
    </div>
  );
}
