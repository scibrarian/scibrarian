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
// is bumped whenever the underlying data changes ("Check for new papers",
// collection imports and file edits), so a stale entry is never served.
const papersCache: FetchCache<PapersResponse> = new Map();

// Filter state for one paper source, owned above the views (in App) instead of
// inside them. Each view unmounts as you flip Papers / Timeline / Graph, so
// state held in a view was silently discarded on every switch — typing a search
// in Timeline and moving to Papers used to start over from an unfiltered list.
export function usePaperFilters(source: PaperSource) {
  const key = sourceKey(source);
  // Journals the user has turned off (empty = show all).
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // The citation threshold's value plus the number box's string, which must be
  // allowed to go empty mid-typing. Clamping needs the source's citation range,
  // so it lives in the control (see PaperFilters), not here.
  const [minCitations, setMinCitations] = useState(0);
  const [minText, setMinText] = useState("0");

  // A new source starts unfiltered: its journals and citation range differ, so
  // carrying the old filter over would hide papers for no visible reason.
  useEffect(() => {
    setDeselected(new Set());
    setQuery("");
    setSearch("");
    setMinCitations(0);
    setMinText("0");
  }, [key]);

  // Debounce the free-text search box. Kept inline rather than useDebounced:
  // the reset above must clear `search` instantly, not one debounce later.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  return {
    key,
    query,
    setQuery,
    search,
    deselected,
    setDeselected,
    minCitations,
    setMinCitations,
    minText,
    setMinText,
    // Whether anything is narrowing the list, so a view can tell "filtered to
    // nothing" apart from "this source is empty".
    active: search !== "" || deselected.size > 0 || minCitations > 0,
  };
}

export type PaperFilterState = ReturnType<typeof usePaperFilters>;

// The paper list for a source, filtered by the shared state above: the search
// runs server-side (refetch per term), journals and the citation threshold are
// applied client-side so toggling them never refetches.
export function usePapers(
  source: PaperSource,
  reloadToken: number,
  filters: PaperFilterState
) {
  const { key, search, deselected, minCitations } = filters;

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
    let all = shown?.papers ?? [];
    if (deselected.size > 0) all = all.filter((p) => !deselected.has(p.journal_name));
    if (minCitations > 0) all = all.filter((p) => p.citation_count >= minCitations);
    return all;
  }, [shown, deselected, minCitations]);

  // The citation threshold's upper bound, so the slider spans this source's
  // actual range. Taken from the unfiltered list, or the threshold itself while
  // the first load is still in flight, so the handle never sits past the end.
  const maxCitations = useMemo(
    () => (shown?.papers ?? []).reduce((m, p) => Math.max(m, p.citation_count), 0),
    [shown]
  );

  // Only the initial load of a source (nothing to show yet) counts as loading;
  // a search refetch keeps the prior list visible, so it doesn't skeleton.
  const showLoading = loading && shown == null;

  const allDeselected = journals.length > 0 && deselected.size >= journals.length;

  return {
    key,
    search,
    visible,
    journals,
    maxCitations,
    loading: showLoading,
    error,
    allDeselected,
    // Whether an empty `visible` means "filters matched nothing" vs "no papers".
    filtered: filters.active,
  };
}
