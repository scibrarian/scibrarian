import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useCachedFetch, type FetchCache } from "../lib/hooks";
import type { Article, ArticlesResponse } from "../types";
import { ArticleCard } from "./ArticleCard";
import { JournalFilter } from "./JournalFilter";
import { FilterSkeleton, TimelineSkeleton } from "./Skeleton";

interface MonthGroup {
  key: string;
  label: string;
  items: Article[];
}

// A topic can hold thousands of papers; render them incrementally so the first
// paint stays cheap. The rest materialize as the user scrolls near the bottom.
const PAGE_SIZE = 50;

// Cache the last successful fetch per (disease, search). Remounting the Timeline
// — e.g. clicking back into Discover after visiting another tab — then paints
// from cache instead of refetching. reloadToken is bumped whenever the data
// actually changes ("Refresh now"), so a stale entry is never served.
const articleCache: FetchCache<ArticlesResponse> = new Map();
const cacheKey = (diseaseId: number, search: string) => `${diseaseId}:${search}`;

export function Timeline({ diseaseId, reloadToken }: { diseaseId: number; reloadToken: number }) {
  // Journals the user has turned off (empty = show all). Client-side, so
  // toggling is instant and never refetches.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Only the disease and free-text search hit the server; journal filtering is
  // done client-side below. On a fresh mount `search` is "", which is the key a
  // previous visit to this topic would have cached under.
  const { data, loading, error } = useCachedFetch(
    articleCache,
    cacheKey(diseaseId, search),
    reloadToken,
    () => api.getArticles(diseaseId, undefined, search || undefined)
  );
  const articles = data?.articles ?? [];
  const journals = data?.journals ?? [];

  // Reset filters whenever the active disease changes.
  useEffect(() => {
    setDeselected(new Set());
    setQuery("");
    setSearch("");
  }, [diseaseId]);

  // Debounce the free-text search box. Kept inline rather than useDebounced:
  // the reset above must clear `search` instantly, not one debounce later.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // A new query starts from the top.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [diseaseId, search, reloadToken]);

  const visible = useMemo(
    () => (deselected.size === 0 ? articles : articles.filter((a) => !deselected.has(a.journal_name))),
    [articles, deselected]
  );
  const shown = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);
  const groups = groupByMonth(shown);
  const hasMore = visibleCount < visible.length;
  const allDeselected = journals.length > 0 && deselected.size >= journals.length;

  // Grow the rendered slice as the sentinel near the bottom scrolls into view.
  // rootMargin preloads the next page before the user hits the very end.
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
  }, [hasMore, visible.length]);

  return (
    <div className="timeline-wrap">
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search titles & abstracts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Keep the filter row a fixed height: the real dropdown once journals
            are known, a skeleton on first load, nothing for an empty topic. */}
        {(journals.length > 0 || loading) && (
          <div className="filter-row">
            {journals.length > 0 ? (
              <JournalFilter journals={journals} deselected={deselected} onChange={setDeselected} />
            ) : (
              <FilterSkeleton />
            )}
          </div>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <TimelineSkeleton />
      ) : visible.length === 0 ? (
        <div className="empty">
          {allDeselected
            ? "No journals selected. Use the Journals filter to show papers."
            : search || deselected.size > 0
              ? "No papers match the current filters."
              : "No papers yet. Add journals & diseases in Settings, then click “Refresh now”."}
        </div>
      ) : (
        <div className="timeline">
          {groups.map((g) => (
            <section key={g.key} className="month-group">
              <h2 className="month-label">{g.label}</h2>
              {g.items.map((a) => (
                <div key={a.pmid} className="timeline-row">
                  <div className="timeline-dot" />
                  <ArticleCard article={a} />
                </div>
              ))}
            </section>
          ))}
          {hasMore && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
          <p className="timeline-footer">
            {hasMore
              ? `Showing ${shown.length} of ${visible.length} papers — scroll for more`
              : `${visible.length} paper${visible.length === 1 ? "" : "s"}`}
          </p>
        </div>
      )}
    </div>
  );
}

function groupByMonth(articles: Article[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  const index = new Map<string, number>();
  for (const a of articles) {
    const key = /^\d{4}-\d{2}/.test(a.pub_date) ? a.pub_date.slice(0, 7) : "unknown";
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key, label: monthLabel(key), items: [] });
    }
    groups[index.get(key)!].items.push(a);
  }
  return groups;
}

function monthLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return "Undated";
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}
