import { useEffect, useMemo, useState } from "react";
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

export function Timeline({ diseaseId, reloadToken }: { diseaseId: number; reloadToken: number }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [journals, setJournals] = useState<string[]>([]);
  // Journals the user has turned off (empty = show all). Client-side, so
  // toggling is instant and never refetches.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getArticles(diseaseId, undefined, search || undefined)
      .then((res) => {
        if (cancelled) return;
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
  const groups = groupByMonth(visible);
  const allDeselected = journals.length > 0 && deselected.size >= journals.length;

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
