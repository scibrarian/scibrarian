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
  // Publication year bounds, null = unbounded. Kept nullable rather than
  // seeded with the source's range so "no year filter" is unambiguous — a
  // seeded pair can't be told apart from a deliberate full-range selection.
  const [yearFrom, setYearFrom] = useState<number | null>(null);
  const [yearTo, setYearTo] = useState<number | null>(null);

  // A new source starts unfiltered: its journals, citation range and year span
  // differ, so carrying the old filter over would hide papers for no visible
  // reason.
  useEffect(() => {
    setDeselected(new Set());
    setQuery("");
    setSearch("");
    setMinCitations(0);
    setMinText("0");
    setYearFrom(null);
    setYearTo(null);
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
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    // Whether anything is narrowing the list, so a view can tell "filtered to
    // nothing" apart from "this source is empty".
    active:
      search !== "" ||
      deselected.size > 0 ||
      minCitations > 0 ||
      yearFrom != null ||
      yearTo != null,
  };
}

// Whether a paper falls inside the (possibly open-ended) year range. A paper
// with no parsable year can't be shown to satisfy a bound, so it drops out as
// soon as either end is set — the same rule the graph applies to node.year.
export function inYearRange(
  year: number | null,
  from: number | null,
  to: number | null
): boolean {
  if (from == null && to == null) return true;
  if (year == null) return false;
  return (from == null || year >= from) && (to == null || year <= to);
}

// The 4-digit year of a sortable pub_date ('' or a partial date yields null).
export function paperYear(pubDate: string): number | null {
  return /^\d{4}/.test(pubDate) ? Number(pubDate.slice(0, 4)) : null;
}

// The [min, max] of a year list, ignoring unknowns. null when nothing is dated,
// which hides the year control rather than offering an empty range.
export function bounds(years: (number | null)[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const y of years) {
    if (y == null) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return min === Infinity ? null : { min, max };
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
  const { key, search, deselected, minCitations, yearFrom, yearTo } = filters;

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
    if (yearFrom != null || yearTo != null) {
      all = all.filter((p) => inYearRange(paperYear(p.pub_date), yearFrom, yearTo));
    }
    return all;
  }, [shown, deselected, minCitations, yearFrom, yearTo]);

  // The citation threshold's upper bound, so the slider spans this source's
  // actual range. Taken from the unfiltered list, or the threshold itself while
  // the first load is still in flight, so the handle never sits past the end.
  const maxCitations = useMemo(
    () => (shown?.papers ?? []).reduce((m, p) => Math.max(m, p.citation_count), 0),
    [shown]
  );

  // The source's publication span, used as the year inputs' placeholders and
  // clamp. Derived from the unfiltered list so narrowing the range never moves
  // the bounds under the user.
  const yearBounds = useMemo(() => bounds((shown?.papers ?? []).map((p) => paperYear(p.pub_date))), [shown]);

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
    yearBounds,
    loading: showLoading,
    error,
    allDeselected,
    // Whether an empty `visible` means "filters matched nothing" vs "no papers".
    filtered: filters.active,
  };
}
