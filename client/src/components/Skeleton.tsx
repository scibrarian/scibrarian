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

// Mirrors the collection papers table: real headers, shimmering rows.
export function PapersTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="papers-table-wrap" aria-busy="true" aria-label="Loading papers">
      <table className="papers-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Authors</th>
            <th>Journal</th>
            <th className="num">Year</th>
            <th className="num">Citations</th>
            <th>Links</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Mirrors the folder picker's file/directory rows.
export function PickerListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="picker-list" aria-busy="true" aria-label="Loading folder">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="picker-skeleton-row">
          <SkeletonBar w={18} h={18} />
          <SkeletonBar w={`${45 + ((i * 13) % 35)}%`} h={13} />
        </li>
      ))}
    </ul>
  );
}
