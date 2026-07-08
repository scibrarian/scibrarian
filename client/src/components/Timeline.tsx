import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePapers } from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { ArticleCard } from "./ArticleCard";
import { PapersToolbar } from "./PapersToolbar";
import { TimelineSkeleton } from "./Skeleton";

interface MonthGroup {
  key: string;
  label: string;
  items: Paper[];
}

// A source can hold thousands of papers; render them incrementally so the first
// paint stays cheap. The rest materialize as the user scrolls near the bottom.
const PAGE_SIZE = 50;

// Month-grouped article cards, for either source.
export function Timeline({
  source,
  reloadToken,
  emptyState,
}: {
  source: PaperSource;
  reloadToken: number;
  emptyState?: ReactNode;
}) {
  const {
    key,
    search,
    visible,
    journals,
    loading,
    error,
    query,
    setQuery,
    deselected,
    setDeselected,
    allDeselected,
    filtered,
  } = usePapers(source, reloadToken);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // A new source or query starts from the top.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [key, search, reloadToken]);

  const shown = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);
  const groups = groupByMonth(shown);
  const hasMore = visibleCount < visible.length;

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
      <PapersToolbar
        query={query}
        onQueryChange={setQuery}
        journals={journals}
        deselected={deselected}
        onDeselectedChange={setDeselected}
        loading={loading}
      />

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <TimelineSkeleton />
      ) : visible.length === 0 ? (
        <div className="empty">
          {allDeselected
            ? "No journals selected. Use the Journals filter to show papers."
            : filtered
              ? "No papers match the current filters."
              : (emptyState ?? "No papers yet.")}
        </div>
      ) : (
        <div className="timeline">
          {groups.map((g) => (
            <section key={g.key} className="month-group">
              <h2 className="month-label">{g.label}</h2>
              {g.items.map((p) => (
                <div key={p.pmid} className="timeline-row">
                  <div className="timeline-dot" />
                  <ArticleCard article={p} />
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

function groupByMonth(papers: Paper[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  const index = new Map<string, number>();
  for (const p of papers) {
    const key = /^\d{4}-\d{2}/.test(p.pub_date) ? p.pub_date.slice(0, 7) : "unknown";
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key, label: monthLabel(key), items: [] });
    }
    groups[index.get(key)!].items.push(p);
  }
  return groups;
}

function monthLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return "Undated";
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}
