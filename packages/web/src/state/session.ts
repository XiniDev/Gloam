import { create } from "zustand";
import { get } from "../net/http.ts";

export type Role = "admin" | "dm" | "player" | "spectator";

export interface MeDto {
  authenticated: boolean;
  setupNeeded?: boolean;
  local: boolean;
  user?: {
    id: string;
    name: string;
    color: string;
    isAdmin: boolean;
    hasPin: boolean;
    diceSkin: unknown;
    prefs: unknown;
  };
  session?: {
    kind: "admin" | "player";
    status: "pending" | "admitted" | "denied" | "kicked" | "expired";
    admittedAs: string | null;
  };
  role?: Role | null;
  campaignId?: string | null;
  table: { open: boolean; campaignId: string | null; sessionNo: number | null };
}

interface SessionStore {
  me: MeDto | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<MeDto | null>;
}

/** Who am I (SPEC §23.2 `session` store). */
export const useSession = create<SessionStore>((set) => ({
  me: null,
  loading: true,
  error: null,
  async refresh() {
    try {
      const me = await get<MeDto>("/api/me");
      set({ me, loading: false, error: null });
      return me;
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
      return null;
    }
  },
}));
