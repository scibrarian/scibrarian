import { useEffect, useState, type ReactNode } from "react";
import {
  SEARCH_PLACEHOLDER,
  SEARCH_PLACEHOLDER_FULL_TEXT,
  sourceHasFiles,
  type PaperFilterState,
} from "../lib/papers";
import type { PaperSource } from "../types";
import { ALL_JOURNALS_LABEL, JournalFilter } from "./JournalFilter";
import { ALL_SUBJECTS_LABEL, MeshFilter, useMeshFacets } from "./MeshFilter";
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
//   children     — view-specific extras (the graph's node/link readout)
//   action       — an action *on* the filtered result (the bulk save), pushed
//                  to the far end so it reads as "…and do this with it" rather
//                  than as one more control that narrows
//
// The subject filter is the exception: it fetches its own facet list per source
// rather than being handed one, because unlike journals the list is too large to
// derive from the papers payload (see MeshFilter). It therefore needs the source
// and its reload token.
export function PaperFilters({
  filters,
  source,
  reloadToken,
  searchable = true,
  journals,
  maxCitations,
  yearBounds,
  loading = false,
  knownEmpty = false,
  children,
  action,
}: {
  filters: PaperFilterState;
  source: PaperSource;
  reloadToken: number;
  searchable?: boolean;
  journals?: string[];
  maxCitations?: number;
  yearBounds?: { min: number; max: number } | null;
  loading?: boolean;
  /**
   * The source was counted at zero before its papers were asked for, so no
   * control is coming and neither slot below reserves space for one. Distinct
   * from `loading` because the subject slot waits on useMeshFacets, a fetch
   * this component starts itself — a caller cannot reach it by lying about
   * `loading`. Absent on the graph, which has a loading state of its own (see
   * PaperViews).
   */
  knownEmpty?: boolean;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const { minCitations, setMinCitations, minText, setMinText } = filters;
  const facets = useMeshFacets(source, reloadToken);

  // Collections also search the body text of the PDFs they hold; topics and
  // bookmark folders have no files behind their papers. Only the placeholder
  // changes -- the server decides what a query actually covers, from the same
  // source -- but promising "& PDF text" where there are no PDFs would be a lie.
  // Derived here rather than passed in: every view was handing this down
  // alongside `source` as the identical expression, so a fourth view (or a
  // change to which sources carry files) could disagree with the other three.
  const fullText = sourceHasFiles(source);

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
  //
  // Not while knownEmpty, though. A source counted at zero has no journals to
  // arrive, so the slot would shimmer and then be removed — reserving a line
  // against nothing, which is the one thing the stand-in is not for.
  const showJournals = journals != null && (journals.length > 0 || (loading && !knownEmpty));
  const showCitations = maxCitations != null && maxCitations > 0;
  // A single-year source has no range to pick, so the control would be inert.
  const showYears = yearBounds != null && yearBounds.min < yearBounds.max;
  // Whether anything *narrows*, which is now a question in its own right: the
  // controls that do go in their own wrapping box, and the action sits outside
  // it (see .filter-row). Rendering that box empty would cost the row a gap
  // with nothing in it, the same way `hasRow` guards the row itself.
  const hasControls =
    showJournals ||
    facets.available ||
    facets.loading ||
    showCitations ||
    showYears ||
    Boolean(children);

  // The action counts: a source with nothing to filter by still needs the row
  // if there's something to do with the result. Tested for truthiness, not for
  // null: a caller writing `action={cond && <Button/>}` passes `false` when the
  // button is suppressed, and a row rendered for that is an empty one — its
  // gap, with nothing in it.
  const hasRow = hasControls || Boolean(action);

  return (
    <div className="toolbar">
      {searchable && (
        <input
          className="search"
          type="search"
          placeholder={fullText ? SEARCH_PLACEHOLDER_FULL_TEXT : SEARCH_PLACEHOLDER}
          // Almost nothing typed here is a dictionary word — drug names, genes,
          // MeSH headings, author surnames — so the squiggles mark correct input
          // as wrong and never mark anything that is.
          spellCheck={false}
          value={filters.query}
          onChange={(e) => filters.setQuery(e.target.value)}
        />
      )}

      {hasRow && (
        <div className="filter-row">
          {/* Everything that narrows, in its own wrapping box. The action is
              deliberately outside it: .filter-row is now two slots rather than
              one long wrap, so how many lines these take can no longer move the
              button at the end of the row. */}
          {hasControls && (
            <div className="filter-controls">
              {showJournals &&
                (journals.length > 0 ? (
                  <JournalFilter
                    journals={journals}
                    deselected={filters.deselected}
                    onChange={filters.setDeselected}
                  />
                ) : (
                  <FilterSkeleton label={ALL_JOURNALS_LABEL} />
                ))}

              {/* Same handoff as the journal slot beside it: hold the space during
                  the first load so the row doesn't grow a control once the facets
                  arrive. A source with nothing filed still drops the slot — the
                  skeleton says "a control may land here", not "one will", and
                  under knownEmpty the answer to that is already no. */}
              {facets.available ? (
                <MeshFilter
                  facets={facets}
                  selected={filters.subjects}
                  onChange={filters.setSubjects}
                  majorOnly={filters.majorOnly}
                  onMajorOnlyChange={filters.setMajorOnly}
                />
              ) : (
                facets.loading && !knownEmpty && <FilterSkeleton label={ALL_SUBJECTS_LABEL} />
              )}

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

          {action && <div className="filter-action">{action}</div>}
        </div>
      )}
    </div>
  );
}
