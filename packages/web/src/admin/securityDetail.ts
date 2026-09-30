const MODE: Record<string, string> = {
  quick: "Quick tunnel",
  named: "Named tunnel",
  lan: "LAN",
  local: "Local only",
};
const ROLE_WORD: Record<string, string> = {
  dm: "DM",
  player: "player",
  spectator: "spectator",
  none: "not in the campaign",
};

/**
 * A detail object as short words — the log's reader is the host, not a developer ("auto: false" meant nothing). Ids
 * (who did it, which campaign) are left out: the row already names the person. No secrets are ever stored in it (the
 * server refuses such keys). A key this doesn't know still shows, as it is.
 */
export function detailText(d: Record<string, unknown>): string {
  const words: string[] = [];
  const str = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null || v === "") continue;
    switch (k) {
      case "by":
      case "campaignId":
      case "to":
        break;
      case "as":
        words.push(`as a ${ROLE_WORD[str(v)] ?? str(v)}`);
        break;
      case "auto":
        if (v === true) words.push("automatically");
        break;
      case "identity":
        words.push(v === "new" ? "someone new" : v === "returning" ? "returning" : str(v));
        break;
      case "via":
        words.push(v === "magic" ? "with the host link" : `via ${str(v)}`);
        break;
      case "mode":
        words.push(MODE[str(v)] ?? str(v));
        break;
      case "sessionNo":
        words.push(`session ${str(v)}`);
        break;
      case "locked":
        words.push(v ? "locked" : "unlocked");
        break;
      case "field":
        words.push(
          v === "role" && typeof d.role === "string" ? `role: ${ROLE_WORD[d.role] ?? d.role}` : str(v),
        );
        break;
      case "role":
        break;
      case "reassigned":
        words.push(`${str(v)} ${v === 1 ? "character" : "characters"} handed on`);
        break;
      case "campaignDeleted":
        words.push(`campaign “${str(v)}” deleted`);
        break;
      case "keys":
        words.push(`changed: ${Array.isArray(v) ? v.join(", ") : str(v)}`);
        break;
      case "cleanup": {
        const c = v as { references?: number; files?: number };
        words.push(`cleaned up ${c.files ?? 0} ${c.files === 1 ? "file" : "files"}`);
        break;
      }
      case "purpose":
        words.push(`a ${str(v)} upload`);
        break;
      case "status":
        break;
      case "type":
        words.push(`${str(v)} messages`);
        break;
      case "directive":
        words.push(`${str(v)} rule`);
        break;
      case "blocked":
        words.push(`blocked ${str(v)}`);
        break;
      case "reason":
      case "path":
        words.push(str(v));
        break;
      default:
        words.push(`${k}: ${str(v)}`);
    }
  }
  return words.join(" · ");
}
