import { STATUS_ICONS } from "@gloam/shared/icons";
import type { CombatTurnMessage, CombatView, RequestCard } from "@gloam/shared/protocol";
import { tableEvents, useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { audio } from "./engine.ts";
import type { ConditionSound } from "./sounds/combat.ts";

/** Each condition or status to its family's blip (§27.2 badge categories; sound.md §2.4). */
const CONDITION_SOUND = new Map<string, ConditionSound>(
  STATUS_ICONS.map((i) => [
    i.id,
    `condition${i.category[0]?.toUpperCase()}${i.category.slice(1)}` as ConditionSound,
  ]),
);

/**
 * The table's sound cues that aren't a place on the board (SPEC §31): initiative's war drum when combat begins, a tick
 * as the turn passes to someone else, a heartbeat or a hollow knock for a death save, a condition's blip as it lands
 * (several one after another, 100 ms apart), and the DM's bell for a raised hand. Nothing plays for what was already so
 * when this page joined: a page arriving mid-combat hears no drum.
 */
export function watchSoundCues(): () => void {
  let session = "";
  let combatActive: boolean | null = null;
  const cards = new Map<string, RequestCard["state"]>();

  const offMsg = tableEvents.on("message", ({ type, payload }) => {
    const room = useTable.getState().room;
    const k = room ? `${room.roomId}|${room.sessionId}` : "";
    if (k !== session) {
      session = k;
      combatActive = null;
    }
    switch (type) {
      case "combat.view": {
        const v = payload as CombatView;
        if (combatActive === false && v.active) audio.play("initiativeStart");
        combatActive = v.active;
        return;
      }
      case "combat.turn": {
        if (!(payload as CombatTurnMessage).yours) audio.play("turnPass");
        return;
      }
      case "request.card": {
        const c = payload as RequestCard;
        const key = `${c.requestId}|${c.targetId}`;
        const before = cards.get(key);
        cards.set(key, c.state);
        if (!c.open) cards.delete(key);
        // A death save rolled (or entered) just now: 10 or more is a success.
        if (c.deathSaves && before === "pending" && (c.state === "rolled" || c.state === "manual"))
          if (c.total !== undefined) audio.play(c.total >= 10 ? "deathSaveSuccess" : "deathSaveFail");
        return;
      }
    }
  });

  const offHand = tableEvents.on("hand.raised", () => {
    audio.play("handRaised");
  });

  // Conditions and statuses as they land on the creatures this client sees (not those it just came to see).
  let seen = new Map<string, Set<string>>();
  let sceneId: string | null = null;
  const offEntities = useEntities.subscribe((s) => {
    const d = boardData(s);
    const next = new Map<string, Set<string>>();
    const fresh: ConditionSound[] = [];
    const sameScene = (d.scene?.id ?? null) === sceneId;
    for (const [id, t] of d.tokens) {
      const now = new Set([...t.conditions, ...t.markers]);
      next.set(id, now);
      const was = seen.get(id);
      if (!sameScene || !was) continue;
      for (const c of now) {
        const sound = !was.has(c) && CONDITION_SOUND.get(c);
        if (sound) fresh.push(sound);
      }
    }
    seen = next;
    sceneId = d.scene?.id ?? null;
    // Several at once play one after another, 100 ms apart (a compound earcon, not a chord).
    fresh.slice(0, 6).forEach((sound, i) => {
      audio.play(sound, { delay: i * 0.1 });
    });
  });

  return () => {
    offMsg();
    offHand();
    offEntities();
  };
}
