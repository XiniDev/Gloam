import type { Room } from "@colyseus/sdk";
import { PLAYER_COLORS } from "@gloam/shared";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { audio } from "../audio/engine.ts";
import { ShaderCanvas } from "../board/ambient/ShaderCanvas.tsx";
import { CANDLE_FLAME, FLAME_UNIFORMS } from "../board/ambient/shaders.ts";
import { joinErrorCode, leaveRoom } from "../net/colyseus.ts";
import { post } from "../net/http.ts";
import { joinLobby, type KnockView } from "../net/lobby.ts";
import { tableReady } from "../net/table.ts";
import { useSession } from "../state/session.ts";
import { Button } from "../ui/Button.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";
import { toast } from "../ui/Toast.tsx";

const IDENTITY_LABEL: Record<string, string> = {
  new: "new",
  pin: "returning ✓",
  device: "returning",
  unverified: "returning (unverified)",
};

function colourName(hex: string): string {
  return PLAYER_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name.toLowerCase() ?? "";
}

type Outcome = { kind: "denied" | "banned"; message: string } | null;

/** The waiting room's dissolve into the board (J2). */
const DISSOLVE_MS = 450;
/** Longest the dissolve holds for the table connection before handing over to the table screen anyway. */
const TABLE_READY_MAX_MS = 4000;
/** The table's code, fetched while the player waits so admission doesn't wait on the network. */
const loadTableRoute = () => import("./Table.tsx");

/** The waiting room (SPEC §8.2, §29.2): pending users see nothing about the table. */
export default function Wait() {
  const navigate = useNavigate();
  const refresh = useSession((s) => s.refresh);
  const me = useSession((s) => s.me);
  const [knock, setKnock] = useState<KnockView | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [connection, setConnection] = useState<"connecting" | "open" | "dropped">("connecting");
  const [entering, setEntering] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const enterRef = useRef<() => Promise<void>>(async () => {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: connect to the waiting room once, on mount
  useEffect(() => {
    let cancelled = false;
    void loadTableRoute().catch(() => {});
    void (async () => {
      const m = await refresh();
      if (cancelled) return;
      if (!m?.authenticated || m.session?.kind !== "player") {
        navigate("/join", { replace: true });
        return;
      }
      if (!m.table.open) {
        navigate("/closed", { replace: true });
        return;
      }
      try {
        const room = await joinLobby({
          onKnocks: (ks) => setKnock(ks[0] ?? null),
          onMessage: (type, payload) => {
            const p = payload as { message?: string };
            if (type === "admitted") void enterRef.current();
            else if (type === "denied")
              setOutcome({ kind: "denied", message: p.message ?? "The DM couldn't let you in right now" });
            else if (type === "banned")
              setOutcome({ kind: "banned", message: p.message ?? "You can't join this table" });
            else if (type === "table.closing") navigate("/closed", { replace: true });
          },
          onDrop: () => setConnection("dropped"),
          onReconnect: () => setConnection("open"),
        });
        if (cancelled) {
          leaveRoom(room);
          return;
        }
        roomRef.current = room;
        setConnection("open");
      } catch (err) {
        const code = joinErrorCode(err);
        if (code === "TABLE_CLOSED") navigate("/closed", { replace: true });
        else if (code === "FORBIDDEN")
          setOutcome({ kind: "denied", message: "The DM couldn't let you in right now" });
        else navigate("/join", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
      leaveRoom(roomRef.current);
    };
  }, []);

  /**
   * Admitted (AC-AUTH-03, ≤ 1 s): the door sound and the dissolve start at once and run alongside the enter
   * request, the table connection and the (already prefetched) table code; the table appears, fully formed, as
   * soon as all of them are done.
   */
  async function enter() {
    setEntering(true);
    audio.play("admitted");
    const dissolve = new Promise((r) => setTimeout(r, DISSOLVE_MS));
    try {
      // The table connection starts as soon as the server confirms entry, inside the dissolve.
      const ready = post<{ campaignId: string }>("/api/join/enter").then((r) =>
        tableReady(r.campaignId, TABLE_READY_MAX_MS),
      );
      await Promise.all([ready, dissolve, loadTableRoute()]);
      leaveRoom(roomRef.current);
      roomRef.current = null;
      navigate("/table", { replace: true });
    } catch {
      setEntering(false);
      toast.danger("Couldn't enter the table", "Please try again in a moment.");
    }
  }

  enterRef.current = enter;

  async function leave() {
    await post("/api/join/leave").catch(() => {});
    leaveRoom(roomRef.current);
    navigate("/join", { replace: true });
  }

  if (!me) return <FullScreenLoader />;
  const name = me.user?.name ?? knock?.name ?? "";
  const color = me.user?.color ?? knock?.color ?? "";

  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-bg px-4 py-10">
      <div className="absolute right-3 top-3">
        <SoundChip />
      </div>
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse at 50% 58%, var(--glow-candle), transparent 55%)" }}
        aria-hidden
      />
      <AnimatePresence>
        {entering ? (
          <motion.div
            className="fixed inset-0 z-50 bg-bg"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: DISSOLVE_MS / 1000, ease: [0.6, 0, 0.2, 1] }}
          />
        ) : null}
      </AnimatePresence>

      <div className="relative flex w-full max-w-[560px] flex-col items-center">
        <DoorScene />
        {outcome ? (
          <div className="mt-6 text-center">
            <h1 className="text-28 text-bone">{outcome.message}</h1>
            <p className="mt-2 text-14 text-muted">
              {outcome.kind === "denied"
                ? "You can ask your DM and knock again."
                : "If you think this is a mistake, talk to the host."}
            </p>
            {outcome.kind === "denied" ? (
              <Button
                className="mt-6"
                variant="secondary"
                onClick={() => navigate("/join", { replace: true })}
              >
                Knock again
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 text-center">
            <h1 className="text-28 text-bone" aria-live="polite">
              {entering ? "The door opens…" : "Waiting for the DM to let you in…"}
            </h1>
            <p className="caps mt-3 text-13 text-fog">
              {name}
              {color ? ` · ${colourName(color)}` : ""}
              {knock ? ` · ${IDENTITY_LABEL[knock.identity] ?? knock.identity}` : ""}
            </p>
            {connection === "dropped" ? (
              <p className="mt-3 text-14 text-[var(--ember-400)]">Connection lost — reconnecting…</p>
            ) : null}
            <div className="mt-8 flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  await audio.resume();
                  audio.play("chime");
                  toast.info("Sound check", "If you heard a soft chime, you're all set.");
                }}
              >
                ♪ Test sound
              </Button>
            </div>
            <button
              type="button"
              onClick={() => void leave()}
              className="mt-8 text-14 text-muted underline-offset-4 hover:text-bone hover:underline"
            >
              Leave the lobby
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/** A heavy wooden door lit by a single animated candle (shader flame). */
function DoorScene() {
  return (
    <div className="relative h-[300px] w-[260px] sm:h-[340px] sm:w-[300px]" aria-hidden>
      <svg viewBox="0 0 300 340" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id="doorlight" cx="0.28" cy="0.92" r="0.95">
            <stop offset="0" stopColor="var(--brass-300)" stopOpacity=".55" />
            <stop offset=".45" stopColor="var(--brass-600)" stopOpacity=".18" />
            <stop offset="1" stopColor="var(--ink-950)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="plank" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ink-800)" />
            <stop offset="1" stopColor="var(--brass-800)" />
          </linearGradient>
        </defs>
        <path
          d="M40 330V120a110 110 0 0 1 220 0v210z"
          fill="var(--ink-900)"
          stroke="var(--ink-700)"
          strokeWidth="3"
        />
        <path d="M58 326V124a92 92 0 0 1 184 0v202z" fill="url(#plank)" />
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M${58 + i * 36.8} 60v266`}
            stroke="var(--ink-950)"
            strokeOpacity=".55"
            strokeWidth="2"
          />
        ))}
        {[132, 262].map((y) => (
          <g key={y}>
            <rect x="58" y={y} width="184" height="12" fill="var(--ink-700)" />
            {[72, 108, 150, 192, 228].map((x) => (
              <circle key={x} cx={x} cy={y + 6} r="2.4" fill="var(--ink-500)" />
            ))}
          </g>
        ))}
        <circle cx="206" cy="212" r="13" fill="none" stroke="var(--brass-600)" strokeWidth="4" />
        <circle cx="206" cy="196" r="4" fill="var(--brass-600)" />
        <path d="M58 326V124a92 92 0 0 1 184 0v202z" fill="url(#doorlight)" />
        <path d="M18 332h264" stroke="var(--ink-700)" strokeWidth="4" strokeLinecap="round" />
        <rect x="52" y="292" width="22" height="36" rx="3" fill="var(--parchment-200)" />
        <ellipse cx="63" cy="292" rx="11" ry="3" fill="var(--parchment-100)" />
        <path d="M63 292v-7" stroke="var(--ink-950)" strokeWidth="1.5" />
      </svg>
      <ShaderCanvas
        frag={CANDLE_FLAME}
        uniforms={FLAME_UNIFORMS}
        scale={1}
        className="absolute left-[10.5%] top-[62%] h-[28%] w-[21%]"
        label="A candle flame"
      />
    </div>
  );
}
