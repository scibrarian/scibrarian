import { type ReactNode } from "react";
import { useIncrementalList } from "../lib/hooks";
import { usePaperOpener, type PaperAccess } from "../lib/openPaper";
import { usePapers, type PaperFilterState } from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { ArticleCard } from "./ArticleCard";
import { Banner } from "./Banner";
import { PaperFilters } from "./PaperFilters";
import { TimelineSkeleton } from "./Skeleton";

interface MonthGroup {
  key: string;
  label: string;
  items: Paper[];
}

// Month-grouped article cards, for either source. Card titles open the same
// thing the table's do — the linked PDF when there is one, PubMed otherwise.
export function Timeline({
  source,
  reloadToken,
  emptyState,
  isAdmin,
  tokenRequired,
  libraryOpen,
  onAuthRefreshed,
  filters,
}: PaperAccess & {
  source: PaperSource;
  reloadToken: number;
  emptyState?: ReactNode;
  filters: PaperFilterState;
}) {
  const { key, search, visible, journals, maxCitations, loading, error, allDeselected, filtered } =
    usePapers(source, reloadToken, filters);
  // A new source or query starts from the top.
  const { shown, hasMore, sentinelRef } = useIncrementalList(
    visible,
    `${key}|${search}|${reloadToken}`
  );
  const groups = groupByMonth(shown);
  // One opener for the whole timeline, so a failed open surfaces in a single
  // banner rather than per-card.
  const opener = usePaperOpener({ isAdmin, tokenRequired, libraryOpen, onAuthRefreshed });

  return (
    <div className="timeline-wrap">
      <PaperFilters
        filters={filters}
        journals={journals}
        maxCitations={maxCitations}
        loading={loading}
      />

      {(error ?? opener.openError) && (
        <Banner
          kind="error"
          message={(error ?? opener.openError)!}
          onDismiss={opener.openError ? opener.clearOpenError : undefined}
        />
      )}

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
                  <ArticleCard article={p} opener={opener} />
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
