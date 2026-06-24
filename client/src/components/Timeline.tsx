import { useEffect, useState } from "react";
import { api } from "../api";
import type { Article } from "../types";
import { ArticleCard } from "./ArticleCard";

interface MonthGroup {
  key: string;
  label: string;
  items: Article[];
}

export function Timeline({ diseaseId, reloadToken }: { diseaseId: number; reloadToken: number }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [journals, setJournals] = useState<string[]>([]);
  const [journalFilter, setJournalFilter] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset filters whenever the active disease changes.
  useEffect(() => {
    setJournalFilter("");
    setQuery("");
    setSearch("");
  }, [diseaseId]);

  // Debounce the free-text search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getArticles(diseaseId, journalFilter || undefined, search || undefined)
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
  }, [diseaseId, journalFilter, search, reloadToken]);

  const groups = groupByMonth(articles);

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
        {journals.length > 0 && (
          <div className="chips">
            <button
              className={`chip ${journalFilter === "" ? "active" : ""}`}
              onClick={() => setJournalFilter("")}
            >
              All journals
            </button>
            {journals.map((j) => (
              <button
                key={j}
                className={`chip ${journalFilter === j ? "active" : ""}`}
                onClick={() => setJournalFilter(j)}
              >
                {j}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : articles.length === 0 ? (
        <div className="empty">
          {search || journalFilter
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
