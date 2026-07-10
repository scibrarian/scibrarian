import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage, formatAuthors } from "../lib/format";
import { usePapers } from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { PapersToolbar } from "./PapersToolbar";
import { ShareLinkButton } from "./ShareLinkButton";
import { PapersColgroup, PapersTableSkeleton } from "./Skeleton";

type SortKey = "title" | "authors" | "journal" | "year" | "citations";
type SortDir = "asc" | "desc";

// A source can hold thousands of papers; render rows incrementally so the
// first paint stays cheap (same treatment as the Timeline). Sorting still runs
// over the full filtered set.
const PAGE_SIZE = 50;

// The sortable papers table, for either source. Collection rows carry a linked
// PDF (title click opens it); topic rows have none, so the title opens PubMed.
export function PapersTable({
  source,
  reloadToken,
  emptyState,
  isAdmin,
  tokenRequired,
}: {
  source: PaperSource;
  reloadToken: number;
  emptyState?: ReactNode;
  isAdmin: boolean;
  tokenRequired: boolean;
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
  const [sortKey, setSortKey] = useState<SortKey>("year");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [actionError, setActionError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // A new source or query starts from the top.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [key, search, reloadToken]);

  const sortedPapers = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (p: Paper) => {
      switch (sortKey) {
        case "title":
          return p.title.toLowerCase();
        case "authors":
          return (p.authors[0] ?? "").toLowerCase();
        case "journal":
          return p.journal_name.toLowerCase();
        case "year":
          return p.pub_date;
        case "citations":
          return p.citation_count;
      }
    };
    return [...visible].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [visible, sortKey, sortDir]);

  const shown = useMemo(() => sortedPapers.slice(0, visibleCount), [sortedPapers, visibleCount]);
  const hasMore = visibleCount < sortedPapers.length;

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
  }, [hasMore, sortedPapers.length]);

  function toggleSort(next: SortKey) {
    if (next === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(next);
      setSortDir(next === "title" || next === "authors" || next === "journal" ? "asc" : "desc");
    }
  }

  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // The share-link column only exists for the owner of a token-mode instance;
  // viewers and tokenless single-user setups get the plain table.
  const showShareCol = isAdmin && tokenRequired;

  // Whether a title click will open the stored PDF (vs falling back to PubMed).
  // Viewers never open stored PDFs in token mode — they're owner-only.
  function opensStoredPdf(p: Paper): boolean {
    if (p.file_id == null) return false;
    if (!tokenRequired) return true; // tokenless single-user: open as always
    return isAdmin && p.file_exists;
  }

  async function openPaper(p: Paper) {
    if (!opensStoredPdf(p)) return void window.open(p.url, "_blank", "noopener");
    if (!tokenRequired) {
      return void window.open(api.fileContentUrl(p.file_id!), "_blank", "noopener");
    }
    // Token mode: window.open can't carry the Authorization header, so mint a
    // short-lived signed URL first. The tab must be opened synchronously in
    // the click (popup blockers) and without "noopener" (we need the handle
    // to navigate it) — it only ever goes to a same-origin PDF.
    const tab = window.open("about:blank", "_blank");
    try {
      const { path } = await api.mintShareLink(p.file_id!, 300);
      const url = new URL(path, window.location.origin).toString();
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      tab?.close();
      setActionError(errorMessage(err));
    }
  }

  return (
    <div className="papers-table-view">
      <PapersToolbar
        query={query}
        onQueryChange={setQuery}
        journals={journals}
        deselected={deselected}
        onDeselectedChange={setDeselected}
        loading={loading}
      />

      {(error ?? actionError) && <div className="banner error">{error ?? actionError}</div>}

      {loading && visible.length === 0 ? (
        <PapersTableSkeleton share={showShareCol} />
      ) : visible.length === 0 ? (
        <div className="empty">
          {allDeselected
            ? "No journals selected. Use the Journals filter to show papers."
            : filtered
              ? "No papers match the current filters."
              : (emptyState ?? "No papers yet.")}
        </div>
      ) : (
        <>
          <div className="papers-table-wrap">
            <table className="papers-table">
              <PapersColgroup share={showShareCol} />
              <thead>
                <tr>
                  <th className="sortable" onClick={() => toggleSort("title")}>
                    Title{arrow("title")}
                  </th>
                  <th className="sortable" onClick={() => toggleSort("authors")}>
                    Authors{arrow("authors")}
                  </th>
                  <th className="sortable" onClick={() => toggleSort("journal")}>
                    Journal{arrow("journal")}
                  </th>
                  <th className="sortable num" onClick={() => toggleSort("year")}>
                    Year{arrow("year")}
                  </th>
                  <th className="sortable num" onClick={() => toggleSort("citations")}>
                    Citations{arrow("citations")}
                  </th>
                  <th>Links</th>
                  {showShareCol && <th className="share-col" aria-label="Share" />}
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.pmid}>
                    <td className="paper-title-cell">
                      <button
                        className="paper-open"
                        onClick={() => openPaper(p)}
                        title={opensStoredPdf(p) ? `Open ${p.file_name}` : "Open on PubMed"}
                      >
                        {p.title || "(untitled)"}
                      </button>
                      {p.file_id != null && !p.file_exists && (
                        <span className="file-missing" title="The stored PDF is missing">
                          file missing
                        </span>
                      )}
                    </td>
                    <td className="authors-cell">{formatAuthors(p.authors, 3)}</td>
                    <td>{p.journal_name}</td>
                    <td className="num">{year(p.pub_date)}</td>
                    <td className="num">{p.citation_count}</td>
                    <td className="links-cell">
                      <a href={p.url} target="_blank" rel="noreferrer">
                        PubMed ↗
                      </a>
                      {p.doi && (
                        <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
                          DOI ↗
                        </a>
                      )}
                    </td>
                    {showShareCol && (
                      <td className="share-cell">
                        {p.file_id != null && p.file_exists && (
                          <ShareLinkButton
                            mint={() => api.mintShareLink(p.file_id!)}
                            title="Copy a link that lets anyone download this PDF for 24 hours"
                            ariaLabel="Copy share link"
                            onError={setActionError}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
          <p className="timeline-footer">
            {hasMore
              ? `Showing ${shown.length} of ${sortedPapers.length} papers — scroll for more`
              : `${sortedPapers.length} paper${sortedPapers.length === 1 ? "" : "s"}`}
          </p>
        </>
      )}
    </div>
  );
}

function year(pubDate: string): string {
  return /^\d{4}/.test(pubDate) ? pubDate.slice(0, 4) : "—";
}
