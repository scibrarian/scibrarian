import { type ReactNode } from "react";
import type { PaperFilterState } from "../lib/papers";
import { JournalFilter } from "./JournalFilter";
import { FilterSkeleton } from "./Skeleton";

// The filter row for every view. Which controls appear is driven by what the
// view can actually honour rather than by a view name, so a control is never
// shown where it would silently do nothing:
//   searchable   — the view's data source supports the free-text query
//   journals     — the journal list is known (omit to hide the dropdown)
//   maxCitations — the source's citation range is known
//   children     — view-specific extras (the graph's hide-unconnected toggle
//                  and its node/link readout)
//
// The graph opts out of search and journals for now: /api/graph takes neither,
// and filtering its payload client-side would mean the same query returning a
// different set than the table does (abstracts are deliberately left out of the
// graph payload). Turn them on once the endpoint accepts them.
export function PaperFilters({
  filters,
  searchable = true,
  journals,
  maxCitations,
  loading = false,
  children,
}: {
  filters: PaperFilterState;
  searchable?: boolean;
  journals?: string[];
  maxCitations?: number;
  loading?: boolean;
  children?: ReactNode;
}) {
  const { minCitations, setMinCitations, minText, setMinText } = filters;

  // Slider and number box share this range; the box is clamped so a typed value
  // always maps to a valid slider position.
  const sliderMax = Math.max(10, maxCitations ?? 0);
  const clampMin = (raw: string): number => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return 0;
    return Math.min(Math.max(0, v), sliderMax);
  };
  const setBothMin = (v: number) => {
    setMinCitations(v);
    setMinText(String(v));
  };
  const handleMinText = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits === "") {
      setMinText("");
      setMinCitations(0);
      return;
    }
    setBothMin(clampMin(digits));
  };

  // The journal slot holds its space during the first load (skeleton) so the
  // row doesn't grow a line once journals arrive; an empty source shows none.
  const showJournals = journals != null && (journals.length > 0 || loading);
  const showCitations = maxCitations != null && maxCitations > 0;
  const hasRow = showJournals || showCitations || children != null;

  return (
    <div className="toolbar">
      {searchable && (
        <input
          className="search"
          type="search"
          placeholder="Search titles & abstracts…"
          value={filters.query}
          onChange={(e) => filters.setQuery(e.target.value)}
        />
      )}

      {hasRow && (
        <div className="filter-row">
          {showJournals &&
            (journals.length > 0 ? (
              <JournalFilter
                journals={journals}
                deselected={filters.deselected}
                onChange={filters.setDeselected}
              />
            ) : (
              <FilterSkeleton />
            ))}

          {showCitations && (
            <div className="citation-filter">
              <span>Min citations:</span>
              <input
                type="text"
                inputMode="numeric"
                className="min-input"
                value={minText}
                onChange={(e) => handleMinText(e.target.value)}
                onBlur={() => minText === "" && setMinText("0")}
                aria-label="Minimum citations"
              />
              <input
                type="range"
                min={0}
                max={sliderMax}
                value={minCitations}
                onChange={(e) => setBothMin(clampMin(e.target.value))}
                aria-label="Minimum citations"
              />
            </div>
          )}

          {children}
        </div>
      )}
    </div>
  );
}
