import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { api } from "../api";
import { useCachedFetch, type FetchCache } from "../lib/hooks";
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
// 40 of 300 papers has a reason attached, and the reasons are worth telling
// apart: two of them resolve on their own (the queue, and the ones nobody has
// asked about), two never will (non-MEDLINE, and indexed-under-nothing). Only
// the non-empty ones are listed, so the note names causes that are real here.
// Without this the filing looks broken in exactly the case where it is working
// correctly.
function filingNote(filing: MeshFiling): string | null {
  const parts: string[] = [];
  if (filing.unchecked > 0) parts.push(`${filing.unchecked} not looked up yet`);
  if (filing.pending > 0) parts.push(`${filing.pending} awaiting MeSH indexing`);
  if (filing.indexed > 0) parts.push(`${filing.indexed} indexed under no subject`);
  if (filing.none > 0) parts.push(`${filing.none} not indexed for MEDLINE`);
  if (parts.length === 0) return null;
  // Summed over the buckets rather than spelled out, so a bucket added to the
  // ladder can't leave the denominator quietly short of the source's papers.
  const total = Object.values(filing).reduce((a, b) => a + b, 0);
  return `${filing.filed} of ${total} papers filed — ${parts.join(", ")}.`;
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
  const key = sourceKey(source);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");

  // A new source starts unsearched. This box is the one filter that doesn't
  // live in usePaperFilters, so its `[key]` reset can't reach it, and a term
  // typed against one source's vocabulary silently pre-filters the next one's.
  // `search` is cleared here rather than left to the debounce below for the
  // same reason usePaperFilters clears its own: one debounce later is a fetch
  // too late.
  useEffect(() => {
    setQuery("");
    setSearch("");
  }, [key]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, loading } = useCachedFetch(facetCache, `${key}:${search}`, reloadToken, () =>
    api.getMeshHeadings(source, search || undefined)
  );

  // Keep the last response for THIS source on screen while a refetch is in
  // flight. useCachedFetch reports null for any key it hasn't cached yet, so
  // the search key changing emptied `data` — and `available` with it, which
  // unmounted the control, the open menu and the box being typed into, on the
  // first keystroke past the debounce. The same bridge usePapers builds for the
  // paper list, for the same reason. `filing` is computed over the whole source
  // and so survives a search unchanged, which is what makes it safe to hold.
  const last = useRef<{ key: string; data: MeshHeadingsResponse } | null>(null);
  if (data) last.current = { key, data };
  const shown = data ?? (last.current?.key === key ? last.current.data : null);

  return {
    data: shown,
    query,
    setQuery,
    searching: search !== "",
    available: shown != null && (shown.filing.filed > 0 || shown.filing.unchecked > 0),
    // A first load for this source, with nothing yet to stand in its place —
    // the toolbar holds the slot with a skeleton rather than letting the
    // control drop into the row once the facets land. Deliberately not true
    // for a search refetch: `shown` still holds the previous response then, so
    // the control stays where it is instead of blinking into a skeleton on
    // every keystroke past the debounce.
    loading: shown == null && loading,
  };
}

export type MeshFacets = ReturnType<typeof useMeshFacets>;

// The unfiltered trigger text, which is what a first load resolves to and so
// what the loading stand-in measures itself against (see FilterSkeleton).
export const ALL_SUBJECTS_LABEL = "All subjects";

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
      ? ALL_SUBJECTS_LABEL
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
            {/* Radix reads printable keys as menu typeahead, which would fight a
                text field, so keystrokes stop at the box. Focus reaches it on
                open because React's autoFocus lands during the commit and
                Radix's FocusScope skips its own open-focus whenever focus is
                already inside the menu; Escape still closes because
                DismissableLayer listens on the document in the capture phase,
                ahead of this handler. Tab moves from the box to the list —
                Radix's arrow navigation only fires when a menu item is itself
                the event target, so it never reaches out to a search box. */}
            <input
              className="filter-search"
              type="search"
              value={query}
              placeholder="Search subjects…"
              aria-label="Search subjects"
              // Every term this box can match is a MeSH descriptor, so the
              // squiggles mark correct input as wrong and never mark anything
              // that is — more so than the paper search beside it, which at
              // least sees ordinary words in titles.
              spellCheck={false}
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
                // No loading branch: the toolbar only mounts this once a
                // response has arrived (see `available`), and a refetch keeps
                // the previous one on screen, so `data` is never null here.
                <p className="filter-empty">
                  {searching
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
