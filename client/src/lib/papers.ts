import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { PaperSource, PapersResponse } from "../types";
import { useCachedFetch, type FetchCache } from "./hooks";

// Stable cache/state key for a paper source ("t3" / "c1").
export function sourceKey(source: PaperSource): string {
  return "topic" in source ? `t${source.topic}` : `c${source.collection}`;
}

// Cache the last successful fetch per (source, search). Remounting a view —
// flipping between Papers/Timeline, or clicking back into a workspace — then
// paints from cache instead of refetching. The Table and Timeline modules share
// this cache because they read the same endpoint with the same key. reloadToken
// is bumped whenever the underlying data changes ("Refresh now", collection
// imports and file edits), so a stale entry is never served.
const papersCache: FetchCache<PapersResponse> = new Map();

// The data + toolbar state shared by the Table and Timeline modules: fetches
// /api/papers for the source, owns the debounced free-text search (server-side)
// and the journal filter chips (client-side, so toggling never refetches).
export function usePapers(source: PaperSource, reloadToken: number) {
  const key = sourceKey(source);
  // Journals the user has turned off (empty = show all).
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");

  // Reset filters whenever the source changes.
  useEffect(() => {
    setDeselected(new Set());
    setQuery("");
    setSearch("");
  }, [key]);

  // Debounce the free-text search box. Kept inline rather than useDebounced:
  // the reset above must clear `search` instantly, not one debounce later.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // On a fresh mount `search` is "", which is the key a previous visit to this
  // source would have cached under.
  const { data, loading, error } = useCachedFetch(
    papersCache,
    `${key}:${search}`,
    reloadToken,
    () => api.getPapers(source, search || undefined)
  );

  // Keep the last successful result for THIS source on screen while a search
  // refetch is in flight, so typing in the search box refines the list in place
  // instead of flashing a skeleton on every keystroke. `data` goes null the
  // moment the (source, search) key changes; the ref bridges that gap. Cleared
  // implicitly when the source changes — its papers/journals no longer apply.
  const lastForSource = useRef<{ key: string; data: PapersResponse } | null>(null);
  if (data) lastForSource.current = { key, data };
  const kept = lastForSource.current?.key === key ? lastForSource.current.data : null;
  const shown = data ?? kept;

  const journals = shown?.journals ?? [];
  const visible = useMemo(() => {
    const all = shown?.papers ?? [];
    return deselected.size === 0 ? all : all.filter((p) => !deselected.has(p.journal_name));
  }, [shown, deselected]);

  // Only the initial load of a source (nothing to show yet) counts as loading;
  // a search refetch keeps the prior list visible, so it doesn't skeleton.
  const showLoading = loading && shown == null;

  const allDeselected = journals.length > 0 && deselected.size >= journals.length;
  // Whether an empty `visible` means "filters matched nothing" vs "no papers".
  const filtered = search !== "" || deselected.size > 0;

  return {
    key,
    search,
    visible,
    journals,
    loading: showLoading,
    error,
    query,
    setQuery,
    deselected,
    setDeselected,
    allDeselected,
    filtered,
  };
}
