/** DM panel → History (SPEC §8.14, §14.4): the table's changes as the panel lists them. */
export interface HistoryListEntry {
  id: number;
  at: number;
  userId: string;
  userName: string;
  type: string;
  summary: string;
  sceneId: string | null;
  sceneName: string | null;
  undoable: boolean;
  undoneAt: number | null;
  undoneByName: string | null;
}

export interface HistoryListResult {
  entries: HistoryListEntry[];
  /** Older entries past these. */
  more: boolean;
  /** Who and which scenes appear in the history (the filters' choices). */
  people: { id: string; name: string }[];
  scenes: { id: string; name: string }[];
}

/** What a Revert or a Restore to here would do: the entries it reverts, and the later ones it overrides. */
export interface HistoryRestorePlan {
  changes: HistoryListEntry[];
  conflicts: HistoryListEntry[];
}
