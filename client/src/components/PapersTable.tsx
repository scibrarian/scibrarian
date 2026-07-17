import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage, formatAuthors } from "../lib/format";
import { usePapers } from "../lib/papers";
import type { AuthStatus, Paper, PaperSource } from "../types";
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
  libraryOpen,
  onAuthRefreshed,
}: {
  source: PaperSource;
  reloadToken: number;
  emptyState?: ReactNode;
  isAdmin: boolean;
  tokenRequired: boolean;
  libraryOpen: boolean;
  // Reports the fresh /auth fetched on a title click so the app-wide snapshot
  // (isAdmin/tokenRequired/libraryOpen) heals without a reload.
  onAuthRefreshed: (auth: AuthStatus) => void;
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

  // Predicts what a title click will open, for the hover tooltip only. It reads
  // the auth snapshot, which can lag a mid-session Open Library toggle until the
  // next click refreshes it — openPaper below decides against fresh /auth.
  function opensStoredPdf(p: Paper): boolean {
    if (p.file_id == null || !p.file_exists) return false;
    if (!tokenRequired || libraryOpen) return true; // bare URL works for everyone
    return isAdmin;
  }

  // Open what a title click refers to. When a stored PDF exists, the access
  // policy (open library / token mode / admin) is re-checked against a fresh
  // /auth at click time — the load-time snapshot goes stale when the owner
  // toggles Open Library mid-session, which used to strand viewers on a raw
  // 401 tab (closed after load) or hide newly opened PDFs (opened after load).
  async function openPaper(p: Paper) {
    // No matched file, or the blob is gone (orphaned/deleted) — plain PubMed
    // link rather than a content URL the server answers with 410.
    if (p.file_id == null || !p.file_exists) {
      return void window.open(p.url, "_blank", "noopener");
    }
    const fileId = p.file_id;
    // The tab must be opened synchronously in the click (popup blockers); it
    // is navigated once the fresh policy is known. Detach opener since the
    // fallback destination (PubMed) is cross-origin.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const auth = await api.getAuth();
      onAuthRefreshed(auth); // heal the app-wide snapshot too
      let url: string;
      if (!auth.token_required || auth.library_open) {
        url = api.fileContentUrl(fileId); // bare URL works for everyone
      } else if (auth.admin) {
        // window.open can't carry the Authorization header, so mint a
        // short-lived signed URL first.
        const { path } = await api.mintShareLink(fileId, 300);
        url = new URL(path, window.location.origin).toString();
      } else {
        url = p.url; // PDFs are owner-only and we're a viewer: go to PubMed
      }
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
