import { JournalFilter } from "./JournalFilter";
import { FilterSkeleton } from "./Skeleton";

// The search box + journal filter row shared by the Table and Timeline
// modules; wired to usePapers state.
export function PapersToolbar({
  query,
  onQueryChange,
  journals,
  deselected,
  onDeselectedChange,
  loading,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  journals: string[];
  deselected: Set<string>;
  onDeselectedChange: (next: Set<string>) => void;
  loading: boolean;
}) {
  return (
    <div className="toolbar">
      <input
        className="search"
        type="search"
        placeholder="Search titles & abstracts…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {/* Keep the filter row a fixed height: the real dropdown once journals
          are known, a skeleton on first load, nothing for an empty source. */}
      {(journals.length > 0 || loading) && (
        <div className="filter-row">
          {journals.length > 0 ? (
            <JournalFilter journals={journals} deselected={deselected} onChange={onDeselectedChange} />
          ) : (
            <FilterSkeleton />
          )}
        </div>
      )}
    </div>
  );
}
