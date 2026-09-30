import { Copy, KeyRound, Plug, Terminal } from "lucide-react";
import { useState } from "react";
import { get, patch, post } from "../net/http.ts";
import { Breakable } from "../ui/Breakable.tsx";
import { Button } from "../ui/Button.tsx";
import { copyText } from "../ui/clipboard.ts";
import { Toggle } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { TextInput } from "../ui/Field.tsx";
import { LoadPanel, useLoad } from "../ui/Loadable.tsx";
import { FIELD_LABEL } from "../ui/labels.ts";
import { toast } from "../ui/Toast.tsx";

interface TokenInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
interface ApiInfo {
  tokens: TokenInfo[];
  scopes: string[];
  allowRemoteApi: boolean;
  url: string;
  repoPath: string;
  mcpEntry: string;
  local: boolean;
}

/** Each scope in words (SPEC §8.23). */
const SCOPE_TEXT: Record<string, string> = {
  "campaign:read": "See the campaigns and their parties",
  "content:read": "Search spells",
  "content:write": "Import spells and monsters",
  "sheets:read": "Read character sheets",
  "sheets:write": "Import characters",
  "log:read": "Read the campaign log",
  "log:write": "Write recaps into the log",
};

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function copy(text: string, what: string) {
  if (await copyText(text)) toast.success(`${what} copied`);
  else toast.warning("Couldn't copy", "Select the text and copy it by hand.");
}

/** The two setups §26.2 gives, with this computer's address, the real path to the MCP server, and the token. */
export function setupLines(info: Pick<ApiInfo, "url" | "mcpEntry">, token: string) {
  const code = `claude mcp add gloam --env GLOAM_URL=${info.url} --env GLOAM_TOKEN=${token} -- node ${info.mcpEntry}`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        gloam: { command: "node", args: [info.mcpEntry], env: { GLOAM_URL: info.url, GLOAM_TOKEN: token } },
      },
    },
    null,
    2,
  );
  return { code, desktop };
}

/**
 * Admin → API & MCP (SPEC §8.20, §8.23; AC-API-01/05): the API tokens — made with a name and scopes, the secret shown
 * once (only its hash is kept), revoked here — whether they work from other computers, and Connect Claude: the setup
 * for Claude Code and Claude Desktop with this computer's address, the MCP server's real path in this repository, and
 * a token just made filled in.
 */
export function ApiPage() {
  const loaded = useLoad(() => get<ApiInfo>("/api/admin/api"), []);
  const info = loaded.data ?? null;
  const [making, setMaking] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  const load = loaded.reload;
  if (!info && loaded.status === "error")
    return (
      <div className="max-w-[880px]">
        <h1 className="text-36 text-bone">API &amp; MCP</h1>
        <LoadPanel load={loaded} what="the API settings" />
      </div>
    );
  if (!info)
    return (
      <div className="max-w-[880px] space-y-4">
        <div className="skeleton h-9 w-44" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  const live = info.tokens.filter((t) => !t.revokedAt);
  const gone = info.tokens.filter((t) => t.revokedAt);
  const lines = setupLines(info, fresh?.token ?? "<your token>");
  return (
    <div className="max-w-[880px]" data-testid="api-page">
      <header>
        <h1 className="text-36 text-bone">API &amp; MCP</h1>
        <p className="mt-1 text-14 text-muted">
          Let Claude, on this computer, import spell lists, monsters and characters, and read and write the
          campaign log. Gloam itself adds no AI: it's your Claude, with a token you make here.
        </p>
      </header>

      {fresh ? (
        <section
          className="panel mt-6 flex flex-col gap-3 p-5 shadow-[inset_0_0_0_1px_var(--brass-600)] sm:p-6"
          aria-label="Your new token"
          data-testid="fresh-token"
        >
          <h2 className="flex items-center gap-2 text-22 text-bone">
            <KeyRound size={20} className="text-brass" aria-hidden /> {fresh.name}: copy it now
          </h2>
          <p className="text-14 text-muted">
            It's shown this once — Gloam keeps only a fingerprint of it. Lost, make another and revoke this
            one.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="mono min-w-0 flex-1 select-all break-all rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2 text-13 text-bone">
              {fresh.token}
            </code>
            <Button
              variant="primary"
              icon={<Copy size={16} />}
              onClick={() => void copy(fresh.token, "Token")}
            >
              Copy
            </Button>
          </div>
          <p className="text-13 text-muted">It's filled into the setup below.</p>
        </section>
      ) : null}

      <section className="panel mt-6 flex flex-col gap-3 p-5 sm:p-6" aria-label="Tokens">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-22 text-bone">
            <KeyRound size={20} aria-hidden /> Tokens
          </h2>
          <Button variant={live.length ? "secondary" : "primary"} onClick={() => setMaking(true)}>
            Make a token
          </Button>
        </div>
        {live.length === 0 ? (
          <EmptyState art="door" title="No tokens yet. Make one for Claude, then connect it below." />
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            {live.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="api-token-row">
                <span className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1">
                  <span className="truncate text-16 font-bold text-bone">{t.name}</span>
                  <span className="text-13 text-muted">
                    Made {day(t.createdAt)} · last used{" "}
                    <span className="whitespace-nowrap">{t.lastUsedAt ? when(t.lastUsedAt) : "never"}</span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded-chip border border-line px-1.5 text-12 text-muted"
                        title={SCOPE_TEXT[s] ?? s}
                      >
                        {s}
                      </span>
                    ))}
                  </span>
                </span>
                <Button size="S" variant="danger" onClick={() => setRevoking(t)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {gone.length ? (
          <p className="text-13 text-faint">
            Revoked: {gone.map((t) => t.name).join(", ")} — they no longer open anything.
          </p>
        ) : null}
        <Toggle
          checked={info.allowRemoteApi}
          disabled={!info.local}
          onChange={(v) =>
            void patch("/api/admin/settings", { allowRemoteApi: v }).then(
              () => load(),
              (e: Error) => toast.danger("Couldn't change it", e.message),
            )
          }
          label="Allow remote API"
          description={
            info.local
              ? "Off, tokens only work on this computer — a request through the doorway or the LAN is refused."
              : "Tokens only work on this computer. This can only be changed there."
          }
        />
      </section>

      <section
        className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6"
        aria-label="Connect Claude"
        data-testid="connect-claude"
      >
        <h2 className="flex items-center gap-2 text-22 text-bone">
          <Plug size={20} aria-hidden /> Connect Claude
        </h2>
        <p className="text-14 text-muted">
          Gloam's MCP server is in this copy of Gloam, at{" "}
          <code className="mono text-bone [overflow-wrap:anywhere]">
            <Breakable text={info.mcpEntry} />
          </code>
          . Claude starts it and it talks to Gloam at{" "}
          <code className="mono text-bone [overflow-wrap:anywhere]">
            <Breakable text={info.url} />
          </code>{" "}
          with your token.
          {fresh ? null : " Make a token above and it's filled in here."}
        </p>
        <SetupBlock
          title="Claude Code"
          hint="Run this once in a terminal."
          text={lines.code}
          testId="setup-claude-code"
        />
        <SetupBlock
          title="Claude Desktop"
          hint="Settings → Developer → Edit config: add this to claude_desktop_config.json, then restart Claude."
          text={lines.desktop}
          testId="setup-claude-desktop"
        />
        <p className="text-13 text-muted">
          Then ask Claude something like “list my Gloam campaigns”, or “import these spells into The Lantern
          Crypt — a dry run first”. It reads Gloam's import schemas before it writes anything.
        </p>
      </section>

      {making ? (
        <MakeToken
          scopes={info.scopes}
          onClose={() => setMaking(false)}
          onMade={(token, name) => {
            setFresh({ token, name });
            setMaking(false);
            void load();
          }}
        />
      ) : null}
      {revoking ? (
        <Dialog
          open
          onClose={() => setRevoking(null)}
          title={`Revoke ${revoking.name}?`}
          description="Whatever uses it stops working at once. You can make another."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  void post(`/api/admin/api/tokens/${revoking.id}/revoke`).then(
                    () => {
                      toast.success(`${revoking.name} is revoked`);
                      setRevoking(null);
                      if (fresh?.name === revoking.name) setFresh(null);
                      void load();
                    },
                    (e: Error) => toast.danger("Couldn't revoke it", e.message),
                  )
                }
              >
                Revoke
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function SetupBlock({
  title,
  hint,
  text,
  testId,
}: {
  title: string;
  hint: string;
  text: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-16 font-bold text-bone">
          <Terminal size={16} className="text-brass" aria-hidden /> {title}
        </span>
        <Button
          size="S"
          variant="secondary"
          icon={<Copy size={14} />}
          onClick={() => void copy(text, `${title} setup`)}
        >
          Copy
        </Button>
      </div>
      <p className="text-13 text-muted">{hint}</p>
      {/* It scrolls when long: focusable, so the keyboard can scroll it too (and a screen reader names it). */}
      <pre
        className="mono max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2.5 text-13 text-bone [overflow-wrap:anywhere]"
        data-testid={testId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (WCAG 2.1.1)
        tabIndex={0}
        role="region"
        aria-label={`${title} setup`}
      >
        <Breakable text={text} />
      </pre>
    </div>
  );
}

function MakeToken({
  scopes,
  onClose,
  onMade,
}: {
  scopes: string[];
  onClose: () => void;
  onMade: (token: string, name: string) => void;
}) {
  const [name, setName] = useState("Claude");
  const [chosen, setChosen] = useState<string[]>(scopes);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await post<{ token: string; info: { name: string } }>("/api/admin/api/tokens", {
        name: name.trim(),
        scopes: chosen,
      });
      onMade(r.token, r.info.name);
    } catch (e) {
      toast.danger("Couldn't make it", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Make a token"
      description="Name it for what uses it. It can do only what you tick."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || chosen.length === 0}
            onClick={() => void make()}
          >
            Make it
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextInput
          label="Name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          data-autofocus
        />
        <fieldset className="flex flex-col gap-1">
          <legend className={`mb-1.5 ${FIELD_LABEL}`}>It may</legend>
          {scopes.map((s) => (
            <label
              key={s}
              className="flex min-h-[var(--touch-min)] cursor-pointer items-center gap-3 text-14 text-bone"
            >
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-[var(--brass-500)]"
                checked={chosen.includes(s)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, s] : c.filter((x) => x !== s)))}
              />
              <span className="flex min-w-0 flex-col">
                <span>{SCOPE_TEXT[s] ?? s}</span>
                <span className="mono text-12 text-faint">{s}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}
