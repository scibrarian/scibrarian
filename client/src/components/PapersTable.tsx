import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { formatAuthors } from "../lib/format";
import { useIncrementalList } from "../lib/hooks";
import { openTitle, usePaperOpener, type PaperAccess } from "../lib/openPaper";
import { usePapers } from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { Banner } from "./Banner";
import { PapersToolbar } from "./PapersToolbar";
import { ShareLinkButton } from "./ShareLinkButton";
import { PapersColgroup, PapersTableSkeleton } from "./Skeleton";

type SortKey = "title" | "authors" | "journal" | "year" | "citations";
type SortDir = "asc" | "desc";

// The sortable papers table, for either source. Collection rows carry a linked
// PDF (title click opens it); topic rows have none, so the title opens PubMed.
export function PapersTable({
  source,
  reloadToken,
  emptyState,
  isAdmin,
  tokenRequired,
  libraryOpen,
  onAuthRefreshed,
}: PaperAccess & {
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
  const [sortKey, setSortKey] = useState<SortKey>("year");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [actionError, setActionError] = useState<string | null>(null);
  const { openPaper, opensStoredPdf, openError, clearOpenError } = usePaperOpener({
    isAdmin,
    tokenRequired,
    libraryOpen,
    onAuthRefreshed,
  });

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

  // A new source or query starts from the top; re-sorting keeps scroll depth.
  const { shown, hasMore, sentinelRef } = useIncrementalList(
    sortedPapers,
    `${key}|${search}|${reloadToken}`
  );

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

      {(error ?? actionError ?? openError) && (
        <Banner
          kind="error"
          message={(error ?? actionError ?? openError)!}
          onDismiss={() => {
            setActionError(null);
            clearOpenError();
          }}
        />
      )}

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
                        title={openTitle(p, opensStoredPdf)}
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
