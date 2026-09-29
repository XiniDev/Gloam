/**
 * HP, conditions and death on the client (SPEC §8.11): the DM's open prompts, the feedback a token's HP change plays
 * for everyone who can see it (`hp.fx`), the notices that follow a decision ("Back on your feet!", the DM's answer to
 * a player's damage), and the actions — every one a server command or request.
 */
import type { DamageType } from "@gloam/shared";
import type { DmPromptView, HpFx, HpPreviewRow } from "@gloam/shared/protocol";
import { create } from "zustand";
import { provideTestHook } from "../test/hooks.ts";
import { toast, useToasts } from "../ui/Toast.tsx";
import { request, tableEvents, useTable } from "./table.ts";

/** The toast a player sees while their damage waits on the DM (the DM's answer replaces it). */
export const PLAYER_DAMAGE_SENT = "player-damage";

interface HealthStore {
  /** DMs: the open prompts, oldest first. */
  prompts: Map<string, DmPromptView>;
  set(p: Partial<Omit<HealthStore, "set">>): void;
}

export const useHealth = create<HealthStore>((set) => ({
  prompts: new Map(),
  set: (p) => set(p),
}));

/** A token's HP changed (the board plays it: numbers, a shake and flash, a glow, a fall). */
export const hpFx = {
  listeners: new Set<(f: HpFx) => void>(),
  log: [] as (HpFx & { at: number })[],
  on(f: (fx: HpFx) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  },
  fire(f: HpFx): void {
    if (__GLOAM_TEST__) {
      this.log.push({ ...f, at: performance.now() });
      if (this.log.length > 200) this.log.shift();
    }
    for (const l of this.listeners) l(f);
  },
};

/** A new prompt for the DM (the HUD brings it forward with a chime). */
export const promptArrived = {
  listeners: new Set<(p: DmPromptView) => void>(),
  on(f: (p: DmPromptView) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  },
  fire(p: DmPromptView): void {
    for (const f of this.listeners) f(p);
  },
};

function onMessage(type: string, payload: unknown): void {
  const s = useHealth.getState();
  switch (type) {
    case "prompt.update": {
      const p = payload as DmPromptView;
      const prompts = new Map(s.prompts);
      if (p.status === "open") {
        if (!prompts.has(p.id)) promptArrived.fire(p);
        prompts.set(p.id, p);
      } else prompts.delete(p.id);
      s.set({ prompts });
      return;
    }
    case "prompt.decided": {
      const d = payload as { title: string; applied: boolean; name: string };
      // The DM's answer takes the place of "Sent to the DM to confirm" (one toast per target, not a stack).
      useToasts.getState().dismissKey(PLAYER_DAMAGE_SENT);
      useToasts.getState().push({
        kind: d.applied ? "success" : "info",
        title: d.applied
          ? `The DM applied your damage to ${d.name}`
          : `The DM set aside your damage to ${d.name}`,
        key: `${PLAYER_DAMAGE_SENT}:${d.name}`,
      });
      return;
    }
    case "health.notice": {
      const n = payload as { kind: string; name: string };
      if (n.kind === "backOnFeet")
        toast.success("Back on your feet!", `${n.name} regains 1 HP (a natural 20).`);
      return;
    }
    case "hp.fx":
      hpFx.fire(payload as HpFx);
      return;
  }
}

let asked = "";
async function onConnection(): Promise<void> {
  const t = useTable.getState();
  const k = t.room ? `${t.room.roomId}|${t.room.sessionId}` : "";
  if (k === asked) return;
  asked = k;
  const dm = t.me?.role === "dm" || t.me?.role === "admin";
  if (!k || !dm) return;
  try {
    const list = await request<DmPromptView[]>("prompt.list", {});
    useHealth.getState().set({ prompts: new Map(list.map((p) => [p.id, p])) });
  } catch {
    // they load with the next connection
  }
}

/** Starts watching (once per page). */
export function watchHealth(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("prompts", () => [...useHealth.getState().prompts.values()]);
    provideTestHook("hpFx", () => hpFx.log.map((f) => ({ ...f })));
  }
  const offMsg = tableEvents.on("message", ({ type, payload }) => onMessage(type, payload));
  const offConn = useTable.subscribe(() => void onConnection());
  void onConnection();
  return () => {
    offMsg();
    offConn();
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type DamageTypeIn = DamageType | "untyped";

export interface HpDraft {
  targets: string[];
  kind: "damage" | "heal" | "temp";
  parts?: { amount: number; type: DamageTypeIn }[];
  amount?: number;
  halved?: boolean;
  crit?: boolean;
  totals?: Record<string, number>;
  tempChoice?: "keep" | "replace" | "best";
  label?: string;
  decide?: Record<string, { keep: string[]; choices?: Record<string, string> }>;
}

export const previewHp = (d: HpDraft) => request<HpPreviewRow[]>("hp.preview", d);
export const applyHp = (d: HpDraft) => request<{ applied: number; sent: number }>("hp.apply", d);

export interface StatusDraft {
  tokenId?: string;
  actorId?: string;
  add?: {
    id: string;
    source?: string;
    untilRound?: number;
    label?: string;
    color?: string;
    glyph?: string;
    description?: string;
  }[];
  remove?: string[];
  exhaustion?: number;
  concentration?: string | null;
}
export const changeStatus = (d: StatusDraft) =>
  request<{ conditions: string[]; markers: string[] }>("status.change", d);

export const resolvePrompt = (
  promptId: string,
  apply: boolean,
  o: { keep?: string[]; choices?: Record<string, string>; total?: number } = {},
) => request<DmPromptView>("prompt.resolve", { promptId, apply, ...o });

export const requestDeathSaves = (targets: string[]) =>
  request<{ requestId: string; asked: number }>("death.request", { targets });
