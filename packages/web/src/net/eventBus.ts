/** Buffered events kept per kind (a room message's own type), and in all. */
const PENDING_PER_KIND = 200;
const PENDING_ALL = 3000;

/**
 * Table events with a replay buffer: the connection starts before the table screen mounts (during the waiting
 * room's dissolve, AC-AUTH-03), so an event emitted while nobody listens is kept and delivered to the first
 * listener of its type, in the order it came. Bounded per kind — a room message by its own type — so a busy table's
 * flood of one kind (rolls, cast views) never pushes out the one message of another that a store needs (a player's
 * `actor.snapshot`: found by the P10 crash journey, a returning player on a busy table got no sheet); and in all.
 */
export class ReplayBus<M extends object> {
  private listeners = new Map<keyof M, Set<(payload: never) => void>>();
  private pending: { type: keyof M; payload: unknown; kind: string }[] = [];
  private kinds = new Map<string, number>();

  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn as (payload: never) => void);
    this.listeners.set(type, set);
    const replay = this.pending.filter((e) => e.type === type);
    this.pending = this.pending.filter((e) => e.type !== type);
    for (const e of replay) this.kinds.set(e.kind, (this.kinds.get(e.kind) ?? 1) - 1);
    for (const e of replay) fn(e.payload as M[K]);
    return () => set.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.listeners.get(type);
    if (set?.size) for (const fn of [...set]) (fn as (p: M[K]) => void)(payload);
    else {
      const kind = type === "message" ? `message:${(payload as { type?: string }).type ?? ""}` : String(type);
      this.pending.push({ type, payload, kind });
      const n = (this.kinds.get(kind) ?? 0) + 1;
      this.kinds.set(kind, n);
      if (n > PENDING_PER_KIND) {
        // The oldest of this kind goes (the rest keep their order).
        const i = this.pending.findIndex((e) => e.kind === kind);
        this.pending.splice(i, 1);
        this.kinds.set(kind, n - 1);
      }
      if (this.pending.length > PENDING_ALL) {
        const gone = this.pending.shift();
        if (gone) this.kinds.set(gone.kind, (this.kinds.get(gone.kind) ?? 1) - 1);
      }
    }
  }

  reset(): void {
    this.pending = [];
    this.kinds.clear();
  }
}
