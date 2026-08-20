import type { CSSProperties, ReactNode } from "react";
import { ALL_JOURNALS_LABEL } from "./JournalFilter";

// Shimmering placeholder bar — the building block for the skeleton screens.
//
// `w` is usually a guess at how wide the real thing will be. Omitting it and
// passing the real text as `children` instead makes the bar exactly that text's
// width: .skeleton paints its own background over transparent text, so the
// label sizes the bar without ever being read (the bar is aria-hidden) or seen.
// Worth it where being a few pixels out would slide a neighbour sideways on the
// handoff; a guess is fine everywhere else.
export function SkeletonBar({
  w,
  h,
  style,
  children,
}: {
  w?: number | string;
  h?: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  // `children` sizes the WIDTH. The height is always set rather than left to
  // the text: a bar is an inline-block with vertical-align: middle, so in a line
  // box it is centred on the baseline plus half an x-height instead of sitting
  // on the strut the way the text it replaces does. Letting the text set its
  // height there makes the line box taller than the label will, not equal to it.
  //
  // Measured in the view switch, whose buttons hold nothing but a label: with
  // the text setting it, .view-toggle stood 1.13px taller than the control it
  // replaces and carried 0.13px of that up into .header-actions, moving the
  // header on the handoff. Fixed, the residual is 0.63px and .header-actions
  // matches exactly — a stand-in that has to match a real control's height gets
  // it from the control (its padding, its border, a real-sized sibling beside
  // the bar), never from the bar itself.
  const height = h ?? 14;
  return (
    <span className="skeleton" style={{ width: w, height, ...style }} aria-hidden="true">
      {children}
    </span>
  );
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
            placeholder="Search titles, abstracts & authors…"
            readOnly
            aria-hidden="true"
            tabIndex={-1}
          />
          <div className="filter-row">
            <FilterSkeleton label={ALL_JOURNALS_LABEL} />
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

// Placeholder for a filter dropdown trigger: the real trigger, disabled, with
// shimmer bars over its label and its caret.
//
// The real control has no width — .filter-trigger is whatever its label, its
// padding, its border and its 16px caret add up to, in the button's own font
// rather than the body's. A bar guessed at that (this was 160x32) lands beside
// it, not on it, and .filter-row is a flex row, so the miss slides every control
// after it the moment the real one arrives. Same element, same classes, same
// label text is the only thing that measures the same.
//
// `label` is the trigger's unfiltered text, which is what a first load always
// resolves to — passed from the filter that owns it so a rename can't leave the
// stand-in holding the old width.
export function FilterSkeleton({ label }: { label: string }) {
  return (
    <div className="filter-picker" aria-hidden="true">
      <button className="filter-trigger" disabled>
        <span className="filter-label">
          <SkeletonBar h={14}>{label}</SkeletonBar>
        </span>
        <span className="ws-caret">
          <SkeletonBar w={16} h={16} />
        </span>
      </button>
    </div>
  );
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
export function PapersColgroup({
  select = false,
  share = false,
  bookmark = false,
  collections = false,
}: {
  select?: boolean;
  share?: boolean;
  bookmark?: boolean;
  collections?: boolean;
}) {
  // Both sets total 100%. The collections column is paid for out of Title,
  // Authors and Journal, which wrap, rather than spread evenly — the table is
  // table-layout: fixed inside an overflow-x: auto wrapper, so a column whose
  // content cannot fit its box produces a horizontal scrollbar rather than a
  // squeeze. Links is the one that can't: it is white-space: nowrap and needs
  // ~136px for "PubMed ↗ DOI ↗", so it keeps its 15% in both sets. Measured at
  // 1440px wide; taking it to 13% overflowed by 17px.
  //
  // The fixed-pixel columns (select, bookmark, share) sit outside that 100%:
  // table-layout: fixed distributes the percentages over what is left once the
  // absolute widths are taken, so they narrow the text columns proportionally
  // rather than pushing the total past the wrapper.
  return (
    <colgroup>
      {select && <col style={{ width: 36 }} />}
      <col style={{ width: collections ? "25%" : "36%" }} />
      <col style={{ width: collections ? "13%" : "15%" }} />
      <col style={{ width: collections ? "12%" : "15%" }} />
      <col style={{ width: "8%" }} />
      <col style={{ width: "11%" }} />
      {collections && <col style={{ width: "16%" }} />}
      <col style={{ width: "15%" }} />
      {bookmark && <col style={{ width: 40 }} />}
      {share && <col style={{ width: 40 }} />}
    </colgroup>
  );
}

// Mirrors the collection papers table: real headers, shimmering rows.
export function PapersTableSkeleton({
  select = false,
  rows = 5,
  share = false,
  bookmark = false,
  collections = false,
}: {
  rows?: number;
  select?: boolean;
  share?: boolean;
  bookmark?: boolean;
  collections?: boolean;
}) {
  return (
    <div className="papers-table-wrap" aria-busy="true" aria-label="Loading papers">
      <table className="papers-table">
        <PapersColgroup select={select} share={share} bookmark={bookmark} collections={collections} />
        <thead>
          <tr>
            {select && <th className="select-col" aria-label="Select" />}
            <th>Title</th>
            <th>Authors</th>
            <th>Journal</th>
            <th className="num">Year</th>
            <th className="num">Citations</th>
            {collections && <th>Collections</th>}
            <th>Links</th>
            {bookmark && <th className="bookmark-col" />}
            {share && <th className="share-col" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              {select && <td className="select-cell" />}
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
              {collections && (
                <td>
                  <SkeletonBar w={64} h={12} />
                </td>
              )}
              <td>
                <SkeletonBar w={70} h={12} />
              </td>
              {bookmark && <td className="bookmark-cell" />}
              {share && <td className="share-cell" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Stands in for the Pro panel while its own reload is in flight.
//
// Sized to the panel's shortest *certain* state. The spoke half is always
// drawn, so it is always reserved; the master half is drawn whenever this is
// not the desktop build, which Settings already knows by the time this renders
// — so `master` reserves a fact rather than guessing at one.
//
// What is deliberately not reserved is anything conditional on the pairing: the
// collections list, the mint form's minted code, the node rows. Those are
// growth, and growth is the one direction a stand-in may be wrong in. See the
// Topics list for what happens when it reserves for a guess and the answer
// comes back smaller.
//
// The real headings rather than bars over them. They never change, so a shimmer
// there would be standing in for strings this file already knows.
export function ProPanelSkeleton({ master }: { master: boolean }) {
  return (
    <section className="panel pro-panel" aria-busy="true" aria-label="Loading shared holdings">
      <h3>Shared holdings</h3>
      <SkeletonBar w="92%" h={12} style={{ marginBottom: 6 }} />
      <SkeletonBar w="70%" h={12} style={{ marginBottom: 18 }} />
      <h4>Your organization</h4>
      <SkeletonBar w="46%" h={12} style={{ marginBottom: 10 }} />
      {/* The pairing row: a full-width input beside its button, which is what
          sets the spoke half's height more than anything else in it. */}
      <ProSkeletonRow button={92} />
      {master && (
        <>
          <h4>People connected to this library</h4>
          <SkeletonBar w="88%" h={12} style={{ marginBottom: 4 }} />
          <SkeletonBar w="52%" h={12} style={{ marginBottom: 12 }} />
          {/* The license line, which is present in every state including the
              good one — so it is reserved rather than treated as an alert. */}
          <SkeletonBar w="100%" h={36} style={{ borderRadius: 8, marginBottom: 10 }} />
          <ProSkeletonRow button={112} />
          <SkeletonBar w="76%" h={12} style={{ marginBottom: 10 }} />
          {/* Organization name, then this library's public address. */}
          <SkeletonBar w="100%" h={38} style={{ borderRadius: 8, marginBottom: 12 }} />
          <SkeletonBar w="100%" h={38} style={{ borderRadius: 8, marginBottom: 6 }} />
          <SkeletonBar w="90%" h={12} style={{ marginBottom: 14 }} />
          <ProSkeletonRow button={104} />
          <SkeletonBar w="34%" h={12} />
        </>
      )}
    </section>
  );
}

// An input with a button beside it — the shape most of the Pro panel is made
// of. Reproduces .pro-row's own flex so the two measure the same.
function ProSkeletonRow({ button }: { button: number }) {
  return (
    <div className="pro-row">
      <SkeletonBar w="100%" h={38} style={{ flex: "1 1 220px", borderRadius: 8 }} />
      <SkeletonBar w={button} h={38} style={{ borderRadius: 8 }} />
    </div>
  );
}
