import { type ReactNode } from "react";
import type { PaperAccess } from "../lib/openPaper";
import { usePaperFilters } from "../lib/papers";
import type { PaperSource } from "../types";
import { CitationGraph } from "./CitationGraph";
import { PapersTable } from "./PapersTable";
import { Timeline } from "./Timeline";
import type { ViewMode } from "./ViewSwitcher";

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
  access,
}: {
  source: PaperSource;
  viewMode: ViewMode;
  reloadToken: number;
  emptyState?: ReactNode;
  access: PaperAccess;
}) {
  const filters = usePaperFilters(source);
  const common = { source, reloadToken, filters, ...access };

  if (viewMode === "graph") return <CitationGraph {...common} />;
  if (viewMode === "timeline") return <Timeline {...common} emptyState={emptyState} />;
  return <PapersTable {...common} emptyState={emptyState} />;
}
