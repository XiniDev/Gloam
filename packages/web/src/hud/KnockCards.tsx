import type { KnockCard } from "@gloam/shared/protocol";
import { audio } from "../audio/engine.ts";
import { useToasts } from "../ui/Toast.tsx";

export const IDENTITY_TEXT: Record<KnockCard["identity"], string> = {
  new: "new",
  pin: "returning ✓ PIN verified",
  device: "returning (device)",
  unverified: "returning (unverified)",
};

export type Decide = (
  sessionId: string,
  decision: "admitPlayer" | "admitSpectator" | "deny" | "ban",
) => Promise<void> | void;

/**
 * Knock card (SPEC §8.2): toast + door-knock sound for the Admin and DMs, with Admit as Player / Admit as
 * Spectator / Deny, and Ban for the Admin only. The visual card doubles as the sound's visual equivalent.
 */
export function showKnockCard(k: KnockCard, decide: Decide, isAdmin: boolean): void {
  audio.play("knock");
  useToasts.getState().push({
    key: `knock:${k.sessionId}`,
    kind: "knock",
    title: (
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: k.color }} aria-hidden />
        {k.name} is knocking
      </span>
    ),
    body: (
      <span>
        <span className={k.identity === "unverified" ? "text-[var(--ember-400)]" : ""}>
          {IDENTITY_TEXT[k.identity]}
        </span>
        {" · "}
        {k.deviceLabel}
      </span>
    ),
    actions: [
      { label: "Admit", variant: "primary", onClick: () => void decide(k.sessionId, "admitPlayer") },
      { label: "As spectator", onClick: () => void decide(k.sessionId, "admitSpectator") },
      { label: "Deny", onClick: () => void decide(k.sessionId, "deny") },
      ...(isAdmin
        ? [{ label: "Ban", variant: "danger" as const, onClick: () => void decide(k.sessionId, "ban") }]
        : []),
    ],
  });
}

export function dismissKnockCard(sessionId: string): void {
  useToasts.getState().dismissKey(`knock:${sessionId}`);
}

/** "0:42" since the knock. */
export function waited(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}
