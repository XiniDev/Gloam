import { z } from "zod";

/**
 * Table flavour (SPEC §8.18): emotes and quick phrases, the raised hand, handouts and secret notes, the campaign log.
 */

/** The twelve emotes (emoji appear only here, SPEC §27.6). */
export const EMOTES = [
  { id: "laugh", glyph: "😂", label: "Laugh" },
  { id: "gasp", glyph: "😮", label: "Gasp" },
  { id: "thumbsUp", glyph: "👍", label: "Thumbs up" },
  { id: "clap", glyph: "👏", label: "Clap" },
  { id: "heart", glyph: "❤️", label: "Heart" },
  { id: "fire", glyph: "🔥", label: "Fire" },
  { id: "skull", glyph: "💀", label: "Skull" },
  { id: "thinking", glyph: "🤔", label: "Thinking" },
  { id: "sleepy", glyph: "😴", label: "Sleepy" },
  { id: "popcorn", glyph: "🍿", label: "Popcorn" },
  { id: "facepalm", glyph: "🤦", label: "Facepalm" },
  { id: "party", glyph: "🎉", label: "Party" },
] as const;
export type EmoteId = (typeof EMOTES)[number]["id"];
export const EMOTE_IDS = EMOTES.map((e) => e.id) as [EmoteId, ...EmoteId[]];

/** The eight quick phrases. */
export const QUICK_PHRASES = [
  "Nat 20!",
  "Wait for me!",
  "Let's go!",
  "I have a plan…",
  "Bad idea.",
  "Nice roll!",
  "Is it my turn?",
  "BRB",
] as const;

/** A player's own phrases: up to six, each up to 40 characters. */
export const MAX_PHRASES = 6;
export const PHRASE_MAX = 40;
const Phrase = z
  .string()
  .trim()
  .min(1)
  .max(PHRASE_MAX)
  // One line of plain text: no control characters.
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, "A phrase is one line of plain text.");

/** `emote.send`: an emote, or a phrase (a quick one or one of the sender's own). */
export const EmoteSend = z
  .strictObject({ emote: z.enum(EMOTE_IDS).optional(), phrase: Phrase.optional() })
  .refine((p) => (p.emote === undefined) !== (p.phrase === undefined), "An emote or a phrase, not both.");
export type EmoteSend = z.infer<typeof EmoteSend>;

/** `profile.phrases`: the sender's own phrases, replaced. */
export const ProfilePhrases = z.strictObject({ phrases: z.array(Phrase).max(MAX_PHRASES) });

/** What each client gets (`emote`): who, what, and their token — only when this client sees it. */
export interface EmoteMessage {
  userId: string;
  name: string;
  color: string;
  emote?: EmoteId;
  phrase?: string;
  tokenId?: string;
  at: number;
}

// ── Handouts and secret notes (§8.18) ─────────────────────────────────────────────────────────────────────

const Id = z.string().min(1).max(64);
const Title = z.string().trim().min(1).max(120);
/** Markdown (rendered without raw HTML). */
const Body = z.string().max(20_000);

export const HandoutCreate = z.strictObject({
  title: Title,
  bodyMd: Body.default(""),
  imageAssetId: Id.nullable().default(null),
});
export const HandoutUpdate = z.strictObject({
  handoutId: Id,
  title: Title.optional(),
  bodyMd: Body.optional(),
  imageAssetId: Id.nullable().optional(),
});
export const HandoutDelete = z.strictObject({ handoutId: Id });
/** `handout.show`: to everyone at the table, or to chosen players (added to whoever has it already). */
export const HandoutShow = z.strictObject({
  handoutId: Id,
  to: z.union([z.literal("all"), z.array(Id).min(1).max(40)]),
});
/** `note.secret`: a line for one player's eyes only ("Only you notice the glyph glowing"). */
export const NoteSecret = z.strictObject({ userId: Id, text: z.string().trim().min(1).max(2000) });

/** A handout or note as a client holds it (a player: only those shown to them). */
export interface HandoutView {
  id: string;
  kind: "handout" | "note";
  title: string;
  bodyMd: string;
  imageAssetId: string | null;
  /** DMs only: who has it ("all", or player ids). */
  recipients?: string[] | "all";
  createdAt: number;
}

// ── The campaign log (§8.18) ───────────────────────────────────────────────────────────────────────────────

/** `log.add`: a manual entry (a recap, a note) — the DM's or a player's. */
export const LogAdd = z.strictObject({ text: z.string().trim().min(1).max(4000) });

/**
 * Act as (SPEC §8.19, AC-DMP-03): the DM (or Admin) takes control of a character on its player's behalf — what they
 * then do is recorded as "DM as <character>" — or lets go (`null`).
 */
export const ActAs = z.strictObject({ actorId: z.string().min(1).max(64).nullable() });
/** Who is acting as whom now (to the DMs; to the character's players, their own). */
export interface ActingAsView {
  userId: string;
  dmName: string;
  actorId: string | null;
  name: string | null;
}
export const LogList = z.strictObject({
  sinceSession: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).default(2000),
});

export interface LogEntryView {
  id: string;
  sessionNo: number;
  kind: string;
  text: string;
  userId: string | null;
  /** Who wrote it (manual entries). */
  author?: string;
  createdAt: number;
}
