/**
 * What the server sends about character sheets, proposals and roll requests (SPEC §8.9–8.10, §13.5): the shapes both
 * sides agree on.
 */
import type { Ability, SkillId } from "../constants.ts";
import type { Sheet } from "../schemas/sheet.ts";

/** A character as a client holds it: who plays it, its lock, and its sheet as read (status filled in). */
export interface ActorView {
  id: string;
  kind: "character" | "npc";
  ownerUserId: string | null;
  lockLevel: "unlocked" | "core" | "full";
  templateId: string | null;
  updatedAt: number;
  sheet: Sheet;
}

/** A proposal as shown: what approving it would change on the sheet now. */
export interface ProposalView {
  id: string;
  actorId: string;
  actorName: string;
  userId: string;
  userName: string;
  note: string;
  status: "pending" | "approved" | "denied" | "withdrawn";
  decisionNote: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** Whether approving it still makes a valid sheet (someone may have changed it since). */
  fits: boolean;
  changes: { path: (string | number)[]; label: string; before: unknown; after: unknown }[];
}

export type RequestState = "pending" | "rolled" | "manual" | "skipped" | "dm";

/** A target's card, for one of its controllers. */
export interface RequestCard {
  requestId: string;
  targetId: string;
  targetName: string;
  label: string;
  /** Its formula with the sheet's modifiers in ("1d20 + 5 adv"). */
  formula: string;
  /** Only when the DM shows it. */
  dc?: number;
  adv: "none" | "adv" | "dis";
  visibility: "public" | "dm" | "blind";
  state: RequestState;
  /** Not for blind requests. */
  total?: number;
  /** Only when the DC is shown. */
  success?: boolean;
  open: boolean;
  /** A death saving throw's card: the successes and failures so far (hearts and skulls). */
  deathSaves?: { successes: number; failures: number };
}

/** A request as the DM's live board has it. */
export interface RollRequestView {
  id: string;
  campaignId: string;
  createdBy: string;
  createdAt: number;
  type: "check" | "save" | "attack" | "custom";
  ability?: Ability;
  skill?: SkillId;
  label: string;
  dc?: number;
  showDc: boolean;
  adv: "none" | "adv" | "dis";
  visibility: "public" | "dm" | "blind";
  targets: { id: string; kind: "token" | "actor"; name: string; controllers: string[]; formula: string }[];
  responses: Record<
    string,
    { state: RequestState; rollId?: string; total?: number; success?: boolean; by?: string }
  >;
  status: "open" | "closed";
  closedAt: number | null;
}
