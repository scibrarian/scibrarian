import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "./format";

// The given value, trailing `ms` behind its live counterpart.
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Tracks the system light/dark preference so canvas drawing (which isn't styled
// by CSS variables) can recolor to stay visible.
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

// A list can hold thousands of items; render them incrementally so the first
// paint stays cheap. `shown` is the first PAGE_SIZE items, growing by a page
// whenever the sentinel (rendered by the caller near the bottom, while
// `hasMore`) scrolls into view — rootMargin preloads the next page before the
// user hits the very end. A `resetKey` change (new source, search, reload)
// snaps back to the first page.
const PAGE_SIZE = 50;

export function useIncrementalList<T>(items: T[], resetKey: string) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [resetKey]);

  const shown = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMore = visibleCount < items.length;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((c) => c + PAGE_SIZE);
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, items.length]);

  return { shown, hasMore, sentinelRef };
}

// A module-level cache for useCachedFetch: one entry per key, invalidated when
// `token` no longer matches (bumped whenever the underlying data changes, e.g.
// by "Refresh now").
export type FetchCache<T> = Map<string, { token: number; data: T }>;

// Cap each cache so a long session — every distinct search prefix mints a key —
// can't pin unbounded responses in memory. LRU: re-inserting on write/hit keeps
// the Map ordered oldest-first, so evicting from the front drops the
// least-recently-used entry. Sized to comfortably hold a session's worth of
// recent views (the point of the cache) while bounding the worst case.
const MAX_CACHE_ENTRIES = 30;

function cacheTouch<T>(cache: FetchCache<T>, key: string, value: { token: number; data: T }): void {
  cache.delete(key); // re-insert at the end so Map order tracks recency
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Fetch-with-cache for view data. `data` is null until the *current* key's
// result is available, so callers never see another key's data.
//
// Everything the caller sees is derived at render time from the cache and
// keyed state — not from state an effect updates one tick later. Deriving
// fixes two flashes: switching sources used to render one frame with the old
// `loading=false` and no data (an empty-state blink before the skeleton), and
// returning to a cached source rendered one null frame before the cached data
// appeared. A reload (same key, bumped token) still reports loading while the
// previous data stays visible, exactly as before.
export function useCachedFetch<T>(
  cache: FetchCache<T>,
  key: string,
  token: number,
  fetcher: () => Promise<T>
): { data: T | null; loading: boolean; error: string | null } {
  const lookup = () => {
    const hit = cache.get(key);
    return hit && hit.token === token ? hit.data : undefined;
  };
  // Fetch results land in `entry` (a bare cache.set wouldn't re-render); it
  // also keeps the current key's data alive if the LRU evicts it mid-view.
  const [entry, setEntry] = useState<{ key: string; data: T } | null>(null);
  // Errors are keyed by (key, token) so a stale one can't leak across a
  // source switch, and bumping the token to retry clears it implicitly.
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);

  const hit = lookup();
  const data = entry && entry.key === key ? entry.data : hit !== undefined ? hit : null;
  const error = err && err.id === `${key}:${token}` ? err.message : null;
  const loading = hit === undefined && error == null;

  useEffect(() => {
    const hit = lookup();
    if (hit !== undefined) {
      cacheTouch(cache, key, { token, data: hit }); // mark most-recently-used
      setEntry({ key, data: hit });
      return;
    }

    let cancelled = false;
    fetcher()
      .then((res) => {
        if (cancelled) return;
        cacheTouch(cache, key, { token, data: res });
        setEntry({ key, data: res });
      })
      .catch((e) => !cancelled && setErr({ id: `${key}:${token}`, message: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
    // cache/fetcher are intentionally omitted: key + token identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  return { data, loading, error };
}
