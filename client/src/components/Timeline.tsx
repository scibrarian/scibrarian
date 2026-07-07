import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Article } from "../types";
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
type CachedArticles = { token: number; articles: Article[]; journals: string[] };
const articleCache = new Map<string, CachedArticles>();
const cacheKey = (diseaseId: number, search: string) => `${diseaseId}:${search}`;
function cachedArticles(diseaseId: number, search: string, token: number): CachedArticles | undefined {
  const hit = articleCache.get(cacheKey(diseaseId, search));
  return hit && hit.token === token ? hit : undefined;
}

export function Timeline({ diseaseId, reloadToken }: { diseaseId: number; reloadToken: number }) {
  // Seed from cache so returning to a topic paints instantly. On a fresh mount
  // `search` is "", which is the key a tab switch would have cached under.
  const [articles, setArticles] = useState<Article[]>(
    () => cachedArticles(diseaseId, "", reloadToken)?.articles ?? []
  );
  const [journals, setJournals] = useState<string[]>(
    () => cachedArticles(diseaseId, "", reloadToken)?.journals ?? []
  );
  // Journals the user has turned off (empty = show all). Client-side, so
  // toggling is instant and never refetches.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(() => cachedArticles(diseaseId, "", reloadToken) === undefined);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset filters whenever the active disease changes.
  useEffect(() => {
    setDeselected(new Set());
    setJournals([]);
    setQuery("");
    setSearch("");
  }, [diseaseId]);

  // Debounce the free-text search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Only the disease and free-text search hit the server; journal filtering is
  // done client-side below.
  useEffect(() => {
    setError(null);
    setVisibleCount(PAGE_SIZE); // a new query starts from the top

    // Serve an unchanged (same reloadToken) result from cache without a refetch.
    const cached = cachedArticles(diseaseId, search, reloadToken);
    if (cached) {
      setArticles(cached.articles);
      setJournals(cached.journals);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api
      .getArticles(diseaseId, undefined, search || undefined)
      .then((res) => {
        if (cancelled) return;
        articleCache.set(cacheKey(diseaseId, search), {
          token: reloadToken,
          articles: res.articles,
          journals: res.journals,
        });
        setArticles(res.articles);
        setJournals(res.journals);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
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
