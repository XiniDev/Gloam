import type { Room } from "@colyseus/sdk";
import type { KnockCard } from "@gloam/shared/protocol";
import { create } from "zustand";
import { dismissKnockCard, showKnockCard } from "../hud/KnockCards.tsx";
import { post } from "../net/http.ts";
import { joinLobby, type KnockView } from "../net/lobby.ts";
import { toast } from "../ui/Toast.tsx";

export interface TableStatusDto {
  status: "closed" | "opening" | "open" | "closing" | "reconnecting";
  mode: "quick" | "named" | "lan" | "local" | null;
  publicUrl: string | null;
  lanActive: boolean;
  invite: {
    code: string;
    display: string;
    expiresAt: number | null;
    maxUses: number | null;
    uses: number;
  } | null;
  locked: boolean;
  sessionNo: number | null;
  campaignId: string | null;
  campaignName: string | null;
  counts: { lobby: number; admitted: number; spectators: number };
  doorway: {
    status: string;
    kind: string | null;
    publicUrl: string | null;
    hostnameChanged: boolean;
    restarts: number;
    error: string | null;
  };
  cloudflared: {
    installed: boolean;
    version: string | null;
    os: string;
    configYaml: boolean;
    checkedAt: number;
  } | null;
  error: string | null;
  discordMessage: string | null;
  port: number;
}

interface AdminLive {
  status: TableStatusDto | null;
  knocks: KnockView[];
  connected: boolean;
  set(p: Partial<AdminLive>): void;
}

export const useAdminLive = create<AdminLive>((set) => ({
  status: null,
  knocks: [],
  connected: false,
  set: (p) => set(p),
}));

export async function decideKnock(
  sessionId: string,
  decision: "admitPlayer" | "admitSpectator" | "deny" | "ban",
): Promise<void> {
  try {
    const status = await post<TableStatusDto>("/api/admin/table/knocks/decide", { sessionId, decision });
    useAdminLive.getState().set({ status });
  } catch (e) {
    toast.danger("Couldn't do that", (e as Error).message);
  }
}

/** The Admin console watches the lobby for live knocks and `table.status` (SPEC §8.1 counters, §8.2 knocks). */
export async function watchLobby(): Promise<Room> {
  const room = await joinLobby({
    onKnocks: (knocks) =>
      useAdminLive.getState().set({ knocks: knocks.filter((k) => k.status === "pending") }),
    onMessage: (type, payload) => {
      if (type === "table.status") useAdminLive.getState().set({ status: payload as TableStatusDto });
      else if (type === "knock") showKnockCard(payload as KnockCard, decideKnock, true);
      else if (type === "knock.resolved") dismissKnockCard((payload as { sessionId: string }).sessionId);
    },
    onDrop: () => useAdminLive.getState().set({ connected: false }),
    onReconnect: () => useAdminLive.getState().set({ connected: true }),
    onLeave: () => useAdminLive.getState().set({ connected: false }),
  });
  useAdminLive.getState().set({ connected: true });
  return room;
}
