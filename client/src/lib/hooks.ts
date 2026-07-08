import { useEffect, useState, type RefObject } from "react";
import { errorMessage } from "./format";

// Close a dropdown when a mousedown lands outside `ref`. `active` gates the
// listener so it only exists while the dropdown is open.
export function useClickOutside(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onOutside: () => void
): void {
  useEffect(() => {
    if (!active) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [ref, active, onOutside]);
}

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

// A module-level cache for useCachedFetch: one entry per key, invalidated when
// `token` no longer matches (bumped whenever the underlying data changes, e.g.
// by "Refresh now").
export type FetchCache<T> = Map<string, { token: number; data: T }>;

// Fetch-with-cache for view data. State is seeded from the cache so remounting
// — e.g. flipping back to a tab — paints instantly instead of refetching and
// re-showing a loading state. `data` is null until the *current* key's result
// is available, so callers never see another key's data.
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
  const [entry, setEntry] = useState<{ key: string; data: T } | null>(() => {
    const hit = lookup();
    return hit === undefined ? null : { key, data: hit };
  });
  const [loading, setLoading] = useState(() => lookup() === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);

    // Serve an unchanged (same token) result from cache without a refetch.
    const hit = lookup();
    if (hit !== undefined) {
      setEntry({ key, data: hit });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetcher()
      .then((res) => {
        if (cancelled) return;
        cache.set(key, { token, data: res });
        setEntry({ key, data: res });
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // cache/fetcher are intentionally omitted: key + token identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  return { data: entry && entry.key === key ? entry.data : null, loading, error };
}
