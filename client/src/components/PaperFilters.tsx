import { useEffect, useState, type ReactNode } from "react";
import type { PaperFilterState } from "../lib/papers";
import { JournalFilter } from "./JournalFilter";
import { FilterSkeleton } from "./Skeleton";

// One end of the year range. Holds its own text so a 4-digit year can be typed
// without each keystroke re-filtering (and without "19" clamping to the first
// year on the way to "1990"); the shared value is set on blur or Enter. Empty
// means unbounded, and the placeholder shows the source's actual bound.
function YearBox({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: number | null;
  placeholder: number;
  label: string;
  onCommit: (raw: string) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));

  // Follow the shared value when it changes underneath us — a source switch
  // clearing the range, or the clamp rewriting what was typed.
  useEffect(() => setText(value == null ? "" : String(value)), [value]);

  return (
    <input
      type="text"
      inputMode="numeric"
      className="year-input"
      value={text}
      placeholder={String(placeholder)}
      aria-label={label}
      onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 4))}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => e.key === "Enter" && onCommit(text)}
    />
  );
}

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
  yearBounds,
  loading = false,
  children,
}: {
  filters: PaperFilterState;
  searchable?: boolean;
  journals?: string[];
  maxCitations?: number;
  yearBounds?: { min: number; max: number } | null;
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

  // A year box is empty when unbounded; anything typed is clamped to the
  // source's span so a stray digit can't filter everything away. Committing on
  // blur/Enter rather than per keystroke lets a 4-digit year be typed in peace.
  const commitYear = (raw: string, set: (v: number | null) => void) => {
    const digits = raw.replace(/\D/g, "");
    if (digits === "" || !yearBounds) return set(null);
    const v = Number(digits);
    set(Math.min(Math.max(v, yearBounds.min), yearBounds.max));
  };

  // The journal slot holds its space during the first load (skeleton) so the
  // row doesn't grow a line once journals arrive; an empty source shows none.
  const showJournals = journals != null && (journals.length > 0 || loading);
  const showCitations = maxCitations != null && maxCitations > 0;
  // A single-year source has no range to pick, so the control would be inert.
  const showYears = yearBounds != null && yearBounds.min < yearBounds.max;
  const hasRow = showJournals || showCitations || showYears || children != null;

  return (
    <div className="toolbar">
      {searchable && (
        <input
          className="search"
          type="search"
          placeholder="Search titles, abstracts & authors…"
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

          {showYears && (
            <div className="year-filter">
              <span>Years:</span>
              <YearBox
                value={filters.yearFrom}
                placeholder={yearBounds.min}
                label="From year"
                onCommit={(raw) => commitYear(raw, filters.setYearFrom)}
              />
              <span className="year-dash">–</span>
              <YearBox
                value={filters.yearTo}
                placeholder={yearBounds.max}
                label="To year"
                onCommit={(raw) => commitYear(raw, filters.setYearTo)}
              />
            </div>
          )}

          {children}
        </div>
      )}
    </div>
  );
}
