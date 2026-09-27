import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * `React.lazy` for code-split screens and panels. When a chunk fails to load, main.tsx reloads the page and cancels
 * Vite's error, which makes the import resolve to nothing; this keeps such an import pending (the Suspense fallback
 * stays up for the moment before the reload) instead of rendering a "Cannot read … default" error.
 */
export function lazyPage<P extends object>(
  load: () => Promise<{ default: ComponentType<P> } | undefined>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => load().then((m) => m ?? new Promise<{ default: ComponentType<P> }>(() => {})));
}
