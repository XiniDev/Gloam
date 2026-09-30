import { type DependencyList, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { D20Spinner } from "./Spinner.tsx";

/**
 * Something a panel fetches, in its three states before its content (SPEC §28 EmptyState; AC-DS-05 — no blank panels):
 * loading (a turning d20 and what's coming), failed (what couldn't be loaded, why, and Try again), and ready — where
 * the panel's own empty state takes over when there's nothing.
 */
export type LoadStatus = "loading" | "error" | "ready";

export interface LoadState {
  status: LoadStatus;
  /** Why the last load failed (the server's or the connection's words). */
  error: string | null;
  /** Loads again, showing the loading state. */
  retry: () => void;
}

export interface Loaded<T> extends LoadState {
  /** The data once loaded — kept through a reload, and through a reload that fails. */
  data: T | undefined;
  /**
   * Loads again without the loading state (after a change the panel made): what's shown stays until the new data
   * comes. Its failure is thrown for the caller to say (a toast), and what's shown stays.
   */
  reload: () => Promise<void>;
}

/** Loads with `fn` when mounted and whenever `deps` change; stale answers (from before a change) are dropped. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; status: LoadStatus; error: string | null }>({
    data: undefined,
    status: "loading",
    error: null,
  });
  const gen = useRef(0);
  const latest = useRef(fn);
  latest.current = fn;
  const run = useCallback(async (quiet: boolean) => {
    const mine = ++gen.current;
    if (!quiet) setState((s) => ({ ...s, status: "loading", error: null }));
    try {
      const data = await latest.current();
      if (mine === gen.current) setState({ data, status: "ready", error: null });
    } catch (e) {
      if (mine !== gen.current) return;
      if (quiet) throw e;
      setState((s) => ({ ...s, status: "error", error: (e as Error).message || null }));
    }
  }, []);
  // Loads when mounted and when the caller's deps change (compared as React compares a dependency list).
  const seen = useRef<DependencyList | null>(null);
  useEffect(() => {
    const was = seen.current;
    if (was && was.length === deps.length && was.every((d, i) => Object.is(d, deps[i]))) return;
    seen.current = deps;
    void run(false);
  });
  const retry = useCallback(() => void run(false), [run]);
  const reload = useCallback(() => run(true), [run]);
  return { ...state, retry, reload };
}

/** Loading: a turning d20 and what's coming (`compact`: one line, for a picker or a field). */
export function Loading({ what, compact = false }: { what: string; compact?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="loading"
      className={`flex items-center gap-2 text-fog ${compact ? "py-2" : "justify-center px-6 py-10"}`}
    >
      <span className="text-brass">
        <D20Spinner size={18} />
      </span>
      <span className="caps text-12">Loading {what}…</span>
    </div>
  );
}

/** A load that failed: what, why, and Try again. */
export function LoadFailed({
  what,
  error,
  retry,
  compact = false,
}: {
  what: string;
  error: string | null;
  retry: () => void;
  compact?: boolean;
}) {
  if (compact)
    return (
      <div
        role="alert"
        data-testid="load-failed"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1"
      >
        <p className="min-w-0 flex-1 text-13 text-muted">
          Couldn't load {what}.{error ? <span className="block text-12 text-fog">{error}</span> : null}
        </p>
        <Button size="S" variant="ghost" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  return (
    <div role="alert" data-testid="load-failed">
      <EmptyState
        art="scroll"
        title={
          <>
            Couldn't load {what}.{error ? <span className="mt-1 block text-12 text-fog">{error}</span> : null}
          </>
        }
        action={
          <Button size="S" onClick={retry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

/** The loading or failed state of `load`, or — once ready — `children()`. */
export function LoadGate({
  load,
  what,
  compact = false,
  children,
}: {
  load: LoadState;
  what: string;
  compact?: boolean;
  children: () => ReactNode;
}) {
  if (load.status === "loading") return <Loading what={what} compact={compact} />;
  if (load.status === "error")
    return <LoadFailed what={what} error={load.error} retry={load.retry} compact={compact} />;
  return <>{children()}</>;
}

/** A page's stand-in while its data isn't there: a panel holding the loading or failed state; nothing once ready. */
export function LoadPanel({ load, what }: { load: LoadState; what: string }) {
  if (load.status === "ready") return null;
  return (
    <section className="panel mt-6 p-5 sm:p-6">
      <LoadGate load={load} what={what}>
        {() => null}
      </LoadGate>
    </section>
  );
}
