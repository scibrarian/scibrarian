import type { CSSProperties } from "react";

// Shimmering placeholder bar — the building block for the skeleton screens.
export function SkeletonBar({
  w,
  h = 14,
  style,
}: {
  w: number | string;
  h?: number;
  style?: CSSProperties;
}) {
  return <span className="skeleton" style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

// Mirrors the timeline layout (month label + dotted rows of article cards) so
// the page doesn't jump when real content arrives. `withToolbar` also renders
// the search bar the way <Timeline> does — needed for the App-level pre-load
// skeleton, which sits where <Timeline> (toolbar included) will render, so the
// search bar doesn't pop in and shove the cards down on that handoff.
export function TimelineSkeleton({ withToolbar = false }: { withToolbar?: boolean }) {
  return (
    <div className="timeline-wrap" aria-busy="true" aria-label="Loading papers">
      {withToolbar && (
        <div className="toolbar">
          <input
            className="search"
            type="search"
            placeholder="Search titles & abstracts…"
            readOnly
            aria-hidden="true"
            tabIndex={-1}
          />
          <div className="filter-row">
            <FilterSkeleton />
          </div>
        </div>
      )}
      <div className="timeline">
        <section className="month-group">
          <h2 className="month-label">
            <SkeletonBar w={150} h={16} />
          </h2>
          {[0, 1, 2].map((i) => (
            <div key={i} className="timeline-row">
              <div className="timeline-dot" />
              <article className="card">
                <div className="card-meta">
                  <SkeletonBar w={90} h={20} />
                  <SkeletonBar w={70} h={12} />
                </div>
                <SkeletonBar w={["82%", "64%", "74%"][i]} h={18} style={{ marginBottom: 10 }} />
                <SkeletonBar w="38%" h={12} style={{ marginBottom: 12 }} />
                <SkeletonBar w="100%" h={12} style={{ marginBottom: 6 }} />
                <SkeletonBar w={["88%", "94%", "70%"][i]} h={12} />
              </article>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

// Placeholder for the journal-filter dropdown trigger — a fixed size so the
// real dropdown drops in without shifting the toolbar.
export function FilterSkeleton() {
  return <SkeletonBar w={160} h={32} style={{ borderRadius: "var(--radius)" }} />;
}

// One placeholder row for the settings lists and the journal-manager panes: a
// name bar plus an optional pill bar where a metric badge would sit. Flex
// layout and padding come from the surrounding list's li styling.
export function ListRowSkeleton({
  w,
  pill = false,
  className,
}: {
  w: number | string;
  pill?: boolean;
  className?: string;
}) {
  return (
    <li className={className} aria-hidden="true" style={{ pointerEvents: "none" }}>
      <SkeletonBar w={w} h={14} />
      {pill && <SkeletonBar w={40} h={20} style={{ borderRadius: 999 }} />}
    </li>
  );
}

// Mirrors the Polling & NCBI stacked form (label / control / hint groups plus
// the save button) so the panel doesn't pop in when settings arrive.
export function StackedFormSkeleton({ groups = 4 }: { groups?: number }) {
  return (
    <div className="stacked-form" aria-busy="true" aria-label="Loading settings">
      {Array.from({ length: groups }).map((_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <SkeletonBar w={140} h={14} />
          <SkeletonBar w="100%" h={36} />
          <SkeletonBar w={["55%", "70%", "62%", "48%"][i % 4]} h={12} />
        </div>
      ))}
      <SkeletonBar w={116} h={36} style={{ borderRadius: 8 }} />
    </div>
  );
}

// Shared column widths for the papers table. The table uses `table-layout:
// fixed`, so these widths (not the cell content) determine the columns — which
// is what keeps the skeleton and the loaded table pixel-identical instead of
// reflowing when real titles arrive. `share` adds the admin-only headerless
// share-link column, and must match between skeleton and table for the same
// reason.
export function PapersColgroup({ share = false }: { share?: boolean }) {
  return (
    <colgroup>
      <col style={{ width: "36%" }} />
      <col style={{ width: "15%" }} />
      <col style={{ width: "15%" }} />
      <col style={{ width: "8%" }} />
      <col style={{ width: "11%" }} />
      <col style={{ width: "15%" }} />
      {share && <col style={{ width: 40 }} />}
    </colgroup>
  );
}

// Mirrors the collection papers table: real headers, shimmering rows.
export function PapersTableSkeleton({ rows = 5, share = false }: { rows?: number; share?: boolean }) {
  return (
    <div className="papers-table-wrap" aria-busy="true" aria-label="Loading papers">
      <table className="papers-table">
        <PapersColgroup share={share} />
        <thead>
          <tr>
            <th>Title</th>
            <th>Authors</th>
            <th>Journal</th>
            <th className="num">Year</th>
            <th className="num">Citations</th>
            <th>Links</th>
            {share && <th className="share-col" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              <td>
                <SkeletonBar w={["85%", "62%", "75%", "90%", "68%"][i % 5]} h={14} />
              </td>
              <td>
                <SkeletonBar w="80%" h={12} />
              </td>
              <td>
                <SkeletonBar w={90} h={12} />
              </td>
              <td className="num">
                <SkeletonBar w={36} h={12} />
              </td>
              <td className="num">
                <SkeletonBar w={28} h={12} />
              </td>
              <td>
                <SkeletonBar w={70} h={12} />
              </td>
              {share && <td className="share-cell" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
