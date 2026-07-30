import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { api } from "../api";
import { useCachedFetch, useDebounced, type FetchCache } from "../lib/hooks";
import { sourceKey } from "../lib/papers";
import type { MeshDescriptorRef, MeshFiling, MeshHeadingsResponse, PaperSource } from "../types";

// Facet lists per (source, search). Module-level like the other caches here, so
// reopening the dropdown — or flipping between Papers, Timeline and Graph —
// paints from memory instead of refetching a list that hasn't changed.
const facetCache: FetchCache<MeshHeadingsResponse> = new Map();

// The papers a subject filter can't reach, and why — the second half of "no
// papers match".
//
// Every paper a source holds is in exactly one bucket, so a facet list covering
// 40 of 300 papers has a reason attached: the rest are either non-MEDLINE (there
// are no headings to file them under, and never will be), still working through
// NLM's indexing queue, or simply not looked at yet. Without this the filing
// looks broken in exactly the case where it is working correctly.
function filingNote(filing: MeshFiling): string | null {
  const parts: string[] = [];
  if (filing.unchecked > 0) parts.push(`${filing.unchecked} not looked up yet`);
  if (filing.pending > 0) parts.push(`${filing.pending} awaiting MeSH indexing`);
  if (filing.none > 0) parts.push(`${filing.none} not indexed for MEDLINE`);
  if (parts.length === 0) return null;
  return `${filing.filed} of ${filing.filed + filing.none + filing.pending + filing.unchecked} papers filed — ${parts.join(", ")}.`;
}

// The facet list for a source, with its own search state.
//
// Owned by the toolbar rather than by the dropdown so the toolbar can decide
// whether the control belongs in the row at all — a source with nothing filed
// shouldn't grow a picker that opens on an empty list, and only the response
// knows that. `available` reads it off `filing`, which the server computes over
// the whole source regardless of the search, so typing a query that matches no
// heading can't make the control vanish out from under the cursor.
export function useMeshFacets(source: PaperSource, reloadToken: number) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), 250);
  const { data } = useCachedFetch(
    facetCache,
    `${sourceKey(source)}:${search}`,
    reloadToken,
    () => api.getMeshHeadings(source, search || undefined)
  );
  return {
    data,
    query,
    setQuery,
    searching: search !== "",
    available: data != null && (data.filing.filed > 0 || data.filing.unchecked > 0),
  };
}

export type MeshFacets = ReturnType<typeof useMeshFacets>;

// Multiselect subject filter, driven by the descriptors a source is actually
// filed under. Unlike the journal filter beside it this tracks what is
// *selected* rather than what is deselected: the default is no subject filter at
// all, and a source can carry thousands of headings, so "everything except the
// ones you turned off" would be neither the sensible default nor a list anyone
// could work through.
//
// The papers are narrowed server-side (the payload carries no subjects, so there
// is nothing to filter client-side), which also means the search box has to
// query rather than filter what already arrived — headings past the response's
// cut are otherwise unreachable.
export function MeshFilter({
  facets,
  selected,
  onChange,
  majorOnly,
  onMajorOnlyChange,
}: {
  facets: MeshFacets;
  selected: MeshDescriptorRef[];
  onChange: (next: MeshDescriptorRef[]) => void;
  majorOnly: boolean;
  onMajorOnlyChange: (next: boolean) => void;
}) {
  const { data, query, setQuery, searching } = facets;
  const headings = data?.headings ?? [];
  const chosen = new Set(selected.map((s) => s.ui));

  const toggle = (subject: MeshDescriptorRef) => {
    onChange(
      chosen.has(subject.ui)
        ? selected.filter((s) => s.ui !== subject.ui)
        : [...selected, { ui: subject.ui, name: subject.name }]
    );
  };

  const label =
    selected.length === 0
      ? "All subjects"
      : selected.length === 1
        ? selected[0].name
        : `${selected.length} subjects`;
  const note = data ? filingNote(data.filing) : null;

  return (
    <div className="filter-picker">
      <DropdownMenu.Root>
        {/* The label becomes the heading itself once one subject is picked,
            which is the most useful thing it can say but stops the control
            naming what it does — hence the fixed accessible name. */}
        <DropdownMenu.Trigger
          className={`filter-trigger${selected.length > 0 ? " active" : ""}`}
          aria-label="Filter by subject"
        >
          <span className="filter-label">{label}</span>
          <span className="ws-caret"><ChevronDown size={16} aria-hidden /></span>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="filter-menu subject-menu"
            align="start"
            sideOffset={6}
            loop
          >
            {/* Radix moves focus to the first item on open and treats printable
                keys as typeahead, both of which would fight a text field; this
                keeps the box usable and the arrow keys working on the list. */}
            <input
              className="filter-search"
              type="search"
              value={query}
              placeholder="Search subjects…"
              aria-label="Search subjects"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />

            <div className="filter-actions">
              <DropdownMenu.Item
                className="link-btn"
                onSelect={(e) => {
                  e.preventDefault();
                  onChange([]);
                }}
                disabled={selected.length === 0}
              >
                Clear
              </DropdownMenu.Item>
              <label className="filter-check" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={majorOnly}
                  onChange={(e) => onMajorOnlyChange(e.target.checked)}
                />
                {/* Accent-colored to match .filter-count em: same blue as the
                    major-topic number this checkbox filters down to. */}
                <span className="filter-check-label">Main subject only</span>
              </label>
            </div>

            <div className="filter-list">
              {headings.length === 0 ? (
                <p className="filter-empty">
                  {!data
                    ? "Loading subjects…"
                    : searching
                      ? "No subject here matches that."
                      : "No papers here are filed under a MeSH heading yet."}
                </p>
              ) : (
                headings.map((h) => (
                  <DropdownMenu.CheckboxItem
                    key={h.ui}
                    className="filter-option"
                    checked={chosen.has(h.ui)}
                    onCheckedChange={() => toggle(h)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {/* Purely visual — the CheckboxItem itself carries the
                        role/aria-checked semantics. */}
                    <input
                      type="checkbox"
                      checked={chosen.has(h.ui)}
                      readOnly
                      tabIndex={-1}
                      aria-hidden="true"
                      style={{ pointerEvents: "none" }}
                    />
                    <span className="filter-option-name" title={h.name}>{h.name}</span>
                    {/* Two numbers, because they answer different questions:
                        how much of this source the subject touches, and how much
                        of it the subject is actually the point of. */}
                    <span className="filter-count" title={`${h.majorCount} as a main subject`}>
                      {h.count}
                      {h.majorCount > 0 && <em>·{h.majorCount}</em>}
                    </span>
                  </DropdownMenu.CheckboxItem>
                ))
              )}
            </div>

            {data?.truncated && (
              <p className="filter-note">
                Showing the most common subjects. Search to reach the rest.
              </p>
            )}
            {note && <p className="filter-note">{note}</p>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
