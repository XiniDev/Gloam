/**
 * Character sheets on the client (SPEC §8.10): a mirror of the sheets this person may read — whole on joining
 * (`actor.snapshot`) and as one comes into view (`actor.view`), a JSON Patch per change (`sheet.patch`), gone when it
 * leaves (`actor.gone`) — kept by the server's messages alone (every change goes through a command). A patch that
 * doesn't fit (a message missed) or a reconnect asks for the whole set again. Also the proposals this person sees
 * (their own; a DM's, everyone's) and roll-request cards (and, for DMs, the live board).
 */
import type { ActorView, ProposalView, RequestCard, RollRequestView } from "@gloam/shared/protocol";
import { applyPatch, type JsonPatchOp } from "@gloam/shared/rules";
import type { Sheet } from "@gloam/shared/schemas";
import { create } from "zustand";
import { provideTestHook } from "../test/hooks.ts";
import { toast } from "../ui/Toast.tsx";
import { request, tableEvents, useTable } from "./table.ts";

interface SheetsStore {
  actors: Map<string, ActorView>;
  proposals: Map<string, ProposalView>;
  /** Roll-request cards this person answers, by `requestId|targetId`. */
  cards: Map<string, RequestCard>;
  /** DMs: the requests on the live board. */
  requests: Map<string, RollRequestView>;
  set(p: Partial<Omit<SheetsStore, "set">>): void;
}

export const useSheets = create<SheetsStore>((set) => ({
  actors: new Map(),
  proposals: new Map(),
  cards: new Map(),
  requests: new Map(),
  set: (p) => set(p),
}));

const withActor = (a: ActorView) => {
  const actors = new Map(useSheets.getState().actors);
  actors.set(a.id, a);
  useSheets.getState().set({ actors });
};

let resyncing = false;
async function resync(): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    await request("sheets.sync", {});
  } catch {
    // Not connected: the next connection sends its snapshot.
  } finally {
    resyncing = false;
  }
}

function onMessage(type: string, payload: unknown): void {
  const s = useSheets.getState();
  switch (type) {
    case "actor.snapshot": {
      const list = (payload as { actors: ActorView[] }).actors;
      s.set({ actors: new Map(list.map((a) => [a.id, a])) });
      return;
    }
    case "actor.view":
      withActor((payload as { actor: ActorView }).actor);
      return;
    case "actor.gone": {
      const actors = new Map(s.actors);
      actors.delete((payload as { id: string }).id);
      s.set({ actors });
      return;
    }
    case "sheet.patch": {
      const p = payload as { actorId: string; patch: JsonPatchOp[]; updatedAt: number };
      const a = s.actors.get(p.actorId);
      if (!a) return void resync();
      try {
        withActor({ ...a, sheet: applyPatch<Sheet>(a.sheet, p.patch), updatedAt: p.updatedAt });
      } catch {
        void resync();
      }
      return;
    }
    case "proposal.new":
    case "proposal.update": {
      const v = payload as ProposalView;
      // The player hears the DM's answer to their own proposal, wherever they are.
      const was = s.proposals.get(v.id);
      if (
        was?.status === "pending" &&
        v.status !== "pending" &&
        v.userId === useTable.getState().me?.userId
      ) {
        const what = v.changes.map((c) => c.label).join(", ");
        if (v.status === "approved")
          toast.success(`The DM approved your change to ${v.actorName}`, v.decisionNote || what);
        else if (v.status === "denied")
          toast.warning(`The DM declined your change to ${v.actorName}`, v.decisionNote || what);
      }
      const proposals = new Map(s.proposals);
      proposals.set(v.id, v);
      s.set({ proposals });
      return;
    }
    case "request.card": {
      const c = payload as RequestCard;
      if (c.open && !s.cards.has(`${c.requestId}|${c.targetId}`)) requestArrived.fire(c);
      const cards = new Map(s.cards);
      const key = `${c.requestId}|${c.targetId}`;
      if (c.open) cards.set(key, c);
      else cards.delete(key);
      s.set({ cards });
      return;
    }
    case "request.status": {
      const r = payload as RollRequestView;
      const requests = new Map(s.requests);
      if (r.status === "open") requests.set(r.id, r);
      else requests.delete(r.id);
      s.set({ requests });
      return;
    }
  }
}

/** A new card for this person (the HUD brings it forward with a chime). */
export const requestArrived = {
  listeners: new Set<(c: RequestCard) => void>(),
  on(f: (c: RequestCard) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  },
  fire(c: RequestCard): void {
    for (const f of this.listeners) f(c);
  },
};

let asked = "";
async function onConnection(): Promise<void> {
  const room = useTable.getState().room;
  const k = room ? `${room.roomId}|${room.sessionId}` : "";
  if (k === asked) return;
  asked = k;
  if (!k) return;
  try {
    const list = await request<ProposalView[]>("proposal.list", {});
    useSheets.getState().set({ proposals: new Map(list.map((p) => [p.id, p])) });
  } catch {
    // proposals load with the next connection
  }
}

/** Starts watching (once per page): sheets, proposals and roll requests as the server sends them. */
export function watchSheets(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("sheets", () => [...useSheets.getState().actors.values()]);
    provideTestHook("proposals", () => [...useSheets.getState().proposals.values()]);
    provideTestHook("requestCards", () => [...useSheets.getState().cards.values()]);
  }
  const offMsg = tableEvents.on("message", ({ type, payload }) => onMessage(type, payload));
  let wasDropped = false;
  const offConn = useTable.subscribe((t) => {
    void onConnection();
    // Back after a drop: messages may have been missed while away.
    if (t.connection === "dropped") wasDropped = true;
    else if (t.connection === "open" && wasDropped) {
      wasDropped = false;
      void resync();
      void request<RequestCard[] | RollRequestView[]>("request.list", {}).then((list) => {
        const me = useTable.getState().me;
        const dm = me?.role === "dm" || me?.role === "admin";
        if (dm)
          useSheets.getState().set({ requests: new Map((list as RollRequestView[]).map((r) => [r.id, r])) });
        else
          useSheets
            .getState()
            .set({ cards: new Map((list as RequestCard[]).map((c) => [`${c.requestId}|${c.targetId}`, c])) });
      });
    }
  });
  void onConnection();
  return () => {
    offMsg();
    offConn();
  };
}

// ── Actions (every one a server command or request) ─────────────────────────────────────────────────────────────

export type SheetPath = (string | number)[];
export interface SheetChangeIn {
  path: SheetPath;
  after: unknown;
}

export const changeSheet = (actorId: string, changes: SheetChangeIn[]) =>
  request<{ updatedAt: number }>("actor.change", { actorId, changes });
export const replaceSheet = (actorId: string, sheet: unknown) => request("actor.replace", { actorId, sheet });
export const proposeChange = (actorId: string, changes: SheetChangeIn[], note: string) =>
  request<{ proposalId: string }>("actor.propose", { actorId, changes, note });
/** Proposals waiting for a decision (the DM's Approvals badge). */
export function pendingProposals(s: { proposals: Map<string, ProposalView> }): number {
  let n = 0;
  for (const p of s.proposals.values()) if (p.status === "pending") n++;
  return n;
}
export const decideProposal = (proposalId: string, approve: boolean, note: string) =>
  request("proposal.decide", { proposalId, approve, note });

// Roll requests (§8.9): the DM asks; a target's controller answers its card; the DM answers for anyone or closes it.
export interface RequestDraft {
  targets: string[];
  type: "check" | "save" | "attack" | "custom";
  ability?: string;
  skill?: string;
  formula?: string;
  label?: string;
  dc?: number;
  showDc: boolean;
  adv: "none" | "adv" | "dis";
  visibility: "public" | "dm" | "blind";
}
export const createRequest = (d: RequestDraft) => request<{ requestId: string }>("request.create", d);
export const respondRequest = (
  requestId: string,
  target: string,
  action: "roll" | "manual" | "skip",
  total?: number,
  /** The roller sets aside the advantage or disadvantage their conditions suggest (AC-DICE-11). */
  ignoreHints?: boolean,
) =>
  request<RequestCard>("request.respond", {
    requestId,
    target,
    action,
    ...(total !== undefined ? { total } : {}),
    ...(ignoreHints ? { ignoreHints: true } : {}),
  });
export const answerRequest = (
  requestId: string,
  target: string,
  action: "roll" | "set" | "skip",
  total?: number,
) => request("request.answer", { requestId, target, action, ...(total !== undefined ? { total } : {}) });
export const closeRequest = (requestId: string) => request("request.close", { requestId });

/** The characters this person plays (their own). */
export function myCharacters(userId: string | undefined): ActorView[] {
  if (!userId) return [];
  return [...useSheets.getState().actors.values()].filter(
    (a) => a.ownerUserId === userId && a.kind === "character",
  );
}
