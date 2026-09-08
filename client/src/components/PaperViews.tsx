import { lazy, Suspense, type ReactNode } from "react";
import type { Bookmarking } from "../lib/bookmarking";
import type { PaperAccess } from "../lib/openPaper";
import { usePaperFilters } from "../lib/papers";
import type { PaperSource } from "../types";
import { ErrorBoundary } from "./ErrorBoundary";
import { PapersTable } from "./PapersTable";
import { Timeline } from "./Timeline";
import type { ViewMode } from "./ViewSwitcher";

// The graph view alone pulls in the force-graph + graphology libraries — the
// bulk of the JS bundle. Load it as a separate chunk on demand, so opening
// Papers or Timeline never downloads the graph engine; it arrives only when a
// viewer actually switches to Graph.
const CitationGraph = lazy(() =>
  import("./CitationGraph").then((m) => ({ default: m.CitationGraph }))
);

// Renders the active view and owns the filter state it runs on.
//
// The filters live here, one level above the views, precisely because only one
// view is mounted at a time: state held inside a view is destroyed the moment
// you switch to another. Hoisting it here is what lets a search term, journal
// selection, or citation threshold survive Papers -> Timeline -> Graph.
//
// It also gives the filter hook a source that is known to exist, which App
// cannot guarantee (no topic/collection selected yet) without calling a hook
// conditionally.
export function PaperViews({
  source,
  viewMode,
  reloadToken,
  emptyState,
  knownEmpty,
  access,
  bookmarking,
  onCollectionChanged,
}: {
  source: PaperSource;
  viewMode: ViewMode;
  reloadToken: number;
  emptyState?: ReactNode;
  /**
   * This source was counted at zero before its papers were asked for, so the
   * list views open on `emptyState` rather than a skeleton (see App, which
   * derives it from the picker badges).
   *
   * A statement about the first paint only. The fetch still runs and still
   * decides what is shown; being wrong costs an empty frame, not a wrong view.
   * Travels with `emptyState` because it is about the same frame — the graph
   * takes neither, having a loading state of its own.
   */
  knownEmpty?: boolean;
  access: PaperAccess;
  // null in a section that doesn't bookmark (the Library) — see Bookmarking.
  bookmarking: Bookmarking | null;
  // Papers left the collection on screen (see PapersTable). Only the table
  // offers it, so only the table is handed it. Named for the collection because
  // Settings' onPapersRemoved is a different event with a different signature.
  onCollectionChanged?: () => void;
}) {
  const filters = usePaperFilters(source);
  const common = { source, reloadToken, filters, bookmarking, ...access };

  if (viewMode === "graph") {
    // The boundary sits outside Suspense: Suspense handles the chunk being slow,
    // the boundary handles it never arriving at all (see ErrorBoundary).
    return (
      <ErrorBoundary message="The graph view couldn't be loaded. If the app was updated while this tab was open, reloading will pick up the new version.">
        <Suspense fallback={<div className="empty">Loading graph…</div>}>
          <CitationGraph {...common} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  if (viewMode === "timeline")
    return <Timeline {...common} emptyState={emptyState} knownEmpty={knownEmpty} />;
  return (
    <PapersTable
      {...common}
      emptyState={emptyState}
      knownEmpty={knownEmpty}
      onCollectionChanged={onCollectionChanged}
    />
  );
}
