import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronUp, ChevronDown, ExternalLink, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Bookmarking } from "../lib/bookmarking";
import { describeRemoval, errorMessage, formatAuthors } from "../lib/format";
import { useIncrementalList, useMediaQuery, useReveal } from "../lib/hooks";
import { openTitle, usePaperOpener, type PaperAccess } from "../lib/openPaper";
import {
  selectionOnScreen,
  settleRemovalNotice,
  usePapers,
  type PaperFilterState,
} from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { Banner } from "./Banner";
import { BookmarkMenu } from "./BookmarkMenu";
import { ConfirmDialog, STORED_COPIES_NOTE } from "./Dialogs";
import { NewFolderDialog } from "./FolderMenu";
import { useFacetHold, useMeshFacets } from "./MeshFilter";
import { PaperFilters } from "./PaperFilters";
import { ProvenanceBadges } from "./ProvenanceBadges";
import { SaveAllButton } from "./SaveAllButton";
import { ShareLinkButton } from "./ShareLinkButton";
import { Snippet } from "./Snippet";
import { PapersColgroup, PapersTableSkeleton, papersTableClass } from "./Skeleton";

type SortKey = "title" | "authors" | "journal" | "year" | "citations";
type SortDir = "asc" | "desc";

// The order a table opens in, and the one it goes back to while the column it
// was sorted by is off screen (see `sortKey` in PapersTable).
const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "year", dir: "desc" };

// Where the table goes narrow, and the one place that width is written. The
// stylesheet's half of the narrow layout hangs on a class the table takes
// below this width (see papersTableClass), not on a media query of its own
// that would have to say 780 as well and could be moved without this one.
const NARROW_TABLE = "(max-width: 780px)";

// The sortable papers table, for either source. Collection rows carry a linked
// PDF (title click opens it); topic rows have none, so the title opens PubMed.
export function PapersTable({
  source,
  reloadToken,
  emptyState,
  knownEmpty,
  isAdmin,
  tokenRequired,
  libraryOpen,
  onAuthRefreshed,
  onCollectionChanged,
  onFolderChanged,
  filters,
  bookmarking,
}: PaperAccess & {
  source: PaperSource;
  reloadToken: number;
  emptyState?: ReactNode;
  /**
   * The first paint goes straight to the empty state instead of a skeleton
   * standing in for rows that aren't coming. See PaperViews, which owns the
   * prop and the reasoning; App's knownEmpty is where it comes from.
   */
  knownEmpty?: boolean;
  filters: PaperFilterState;
  /**
   * Papers were taken out of the collection on screen, so the shell has to
   * reload the sources that counted them. Only ever called for a single
   * collection; a bookmark folder's removal reports through onFolderChanged.
   *
   * Named for the collection rather than for the papers because Settings has an
   * `onPapersRemoved` of its own, with a different signature and a different
   * meaning — papers dropped by a journal or topic removal, reported by count.
   * Both are wired from App, so one name across the two left a reader tracing
   * either of them having to work out which component it landed on. This is the
   * same event CollectionView reports through `onChanged`, and App answers both
   * with handleCollectionChanged.
   */
  onCollectionChanged?: () => void;
  /**
   * The same event for a bookmark folder: papers were ticked out of the one on
   * screen. A prop of its own because what App reloads for it is different —
   * the folder's list and count, and the map of what is saved where.
   */
  onFolderChanged?: () => void;
  bookmarking: Bookmarking | null;
}) {
  const {
    key,
    fetchKey,
    visible,
    journals,
    maxCitations,
    yearBounds,
    loading,
    reloading,
    error,
    allDeselected,
    filtered,
    total,
  } = usePapers(source, reloadToken, filters);
  const facets = useMeshFacets(source, reloadToken);
  // The first paint waits for the facets as well as the papers (bounded —
  // see useFacetHold), and the swap from stand-in to rows is committed behind
  // a cross-fade (see useReveal). `revealed` is what the stand-in branch
  // below and the toolbar's `settling` both read, so the filter row and the
  // rows settle in the one commit. Keyed on the source, not on `fetchKey`: a
  // source that is ready when it is switched to is drawn at once, whatever the
  // one before it was doing, while a search within a source is not a new thing
  // to reveal.
  const held = useFacetHold(fetchKey, loading, facets);
  const revealed = useReveal(knownEmpty || !((loading && visible.length === 0) || held), key);
  // Narrower than the columns were measured for (1440px — see PapersColgroup)
  // the Authors column goes: the title is what a row is scanned by, and the
  // author list is the column that gives it back the most room. styles.css's
  // narrow rules do the rest (Links wraps, the headers tighten), on the class
  // the table takes with this flag.
  const showAuthorsCol = !useMediaQuery(NARROW_TABLE);
  const [pickedSortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT.key);
  const [pickedSortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT.dir);
  // The order on screen: the one picked, except while the column it was picked
  // on is away. A sort by Authors with no Authors header has no arrow to show
  // it and no header to click to undo it, so the rows would sit in an order
  // nothing on the page explains; they take the opening order instead. Derived
  // rather than reset, so widening the window brings the sort back along with
  // the header that shows it.
  const sortHidden = pickedSortKey === "authors" && !showAuthorsCol;
  const sortKey = sortHidden ? DEFAULT_SORT.key : pickedSortKey;
  const sortDir = sortHidden ? DEFAULT_SORT.dir : pickedSortDir;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A removal's message, held back until the rows it is about have gone.
  //
  // The two used to land separately and the page moved twice for one action:
  // the banner appeared the moment the request answered, pushing the table
  // down ~55px while it still showed every row that had just been deleted, and
  // the rows left when the refetch behind it landed — 584ms later on a local
  // server, measured. Two shifts in opposite directions, half a second apart,
  // for something the user did once.
  //
  // Waiting is the same answer Settings' `ready` gate gives: one coordinated
  // change beats two that settle independently. The button holds its "Removing…"
  // label throughout, so the wait is accounted for rather than silent.
  //
  // `token` is what reloadToken read when the removal answered, so the message
  // can tell its own refresh from a later one and not outlive it.
  const [pendingNotice, setPendingNotice] = useState<{
    text: string;
    pmids: string[];
    token: number;
  } | null>(null);
  // The paper waiting on a new folder, if any — one prompt for the table
  // rather than one per row (see NewFolderDialog).
  const [namingFor, setNamingFor] = useState<string | null>(null);
  // Papers ticked for removal, by pmid.
  //
  // Offered for one collection, or one bookmark folder. In the all-collections
  // view a paper can be filed under three engagements and "remove it" has no
  // single meaning — the view exists to show that reuse, so a control that
  // silently picked one of them would undo the thing it was opened to reveal.
  // A topic has nothing to remove a paper from: its list is PubMed's answer.
  // Admin-only because the server refuses the mutation anyway, and a control
  // that always fails is worse than none.
  //
  // The folder case replaced a bookmark icon on every row, which un-saved one
  // paper per click through a menu. Emptying a folder of forty was forty of
  // those; here it is the header tick and one button, as it is in the Library.
  const removeFrom = !isAdmin
    ? null
    : "collection" in source
      ? ({ place: "collection", id: source.collection } as const)
      : "folder" in source
        ? ({ place: "folder", id: source.folder } as const)
        : null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Papers the removal request is out for, by pmid. Their rows dim while it is
  // in flight (see .paper-rows.leaving) — the only feedback the click has other
  // than the button's own label, and the thing that stops the rows vanishing
  // out of a table that looked untouched a moment earlier.
  //
  // A set of ids rather than a flag on the request because it has to be
  // reversible: a removal that fails leaves the papers exactly where they were,
  // and the rows have to come back to full strength to say so.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const { openPaper, opensStoredPdf, openError, clearOpenError } = usePaperOpener({
    isAdmin,
    tokenRequired,
    libraryOpen,
    onAuthRefreshed,
  });

  const sortedPapers = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (p: Paper) => {
      switch (sortKey) {
        case "title":
          return p.title.toLowerCase();
        case "authors":
          return (p.authors[0] ?? "").toLowerCase();
        case "journal":
          return p.journal_name.toLowerCase();
        case "year":
          return p.pub_date;
        case "citations":
          return p.citation_count;
      }
    };
    return [...visible].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [visible, sortKey, sortDir]);

  // A new source or query starts from the top; re-sorting keeps scroll depth.
  const { shown, hasMore, sentinelRef } = useIncrementalList(
    sortedPapers,
    `${fetchKey}|${reloadToken}`
  );

  // Dropped outright when the source or a server-side filter changes, which is
  // what `fetchKey` covers. This is about identity rather than visibility: a
  // tick is a pmid, and the same pmid in the next source is a different row's
  // tick. The client-side filters never reach this — they don't refetch — and
  // are handled below instead.
  useEffect(() => setSelected(new Set()), [fetchKey, reloadToken]);

  // A held message belongs to the source it was measured against, so a switch
  // away discards it rather than letting it surface over a different set of
  // papers. Keyed on `fetchKey` alone and deliberately *not* on `reloadToken`:
  // the removal that holds the message is what bumps that token, so including
  // it here would throw every message away one render after it was set.
  // The dimmed rows go with it, and for the same reason: a pmid held over from
  // the last source would dim whichever paper happens to share it here.
  useEffect(() => {
    setPendingNotice(null);
    setLeaving(new Set());
  }, [fetchKey]);

  // The ticks that are actually actionable. Every read of the selection goes
  // through this rather than through `selected`, so a row the filters have
  // hidden cannot be counted, drawn as select-all, or deleted — whichever
  // filter hid it, and whether or not this component knows that filter exists.
  const onScreen = useMemo(() => selectionOnScreen(selected, visible), [selected, visible]);

  // Act on the held message once settleRemovalNotice has an answer for it. The
  // rule itself lives beside the intersection it is built from — see there for
  // why the wait is bounded by the reload rather than by the rows leaving.
  //
  // Only the two things that belong to this component are here: which message
  // gets published, and the dimmed rows going with it. They are released on
  // every way out that isn't "wait", so nothing un-dims a moment before it
  // disappears, and a paper filed back into the collection later doesn't arrive
  // still faded.
  useEffect(() => {
    if (!pendingNotice) return;
    const outcome = settleRemovalNotice(pendingNotice, {
      token: reloadToken,
      loading: reloading,
      error,
      visible,
    });
    if (outcome === "wait") return;
    if (outcome === "publish") setNotice(pendingNotice.text);
    setPendingNotice(null);
    setLeaving(new Set());
  }, [pendingNotice, visible, reloadToken, reloading, error]);

  // The whole filtered set, not the rows rendered so far: the table lazy-renders
  // (see useIncrementalList), so selecting "all" from `shown` would silently
  // mean "all of what you have scrolled past".
  const allSelected = visible.length > 0 && onScreen.size === visible.length;
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(visible.map((p) => p.pmid)) : new Set());
  }
  function toggleOne(pmid: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(pmid);
      else next.delete(pmid);
      return next;
    });
  }

  async function removeSelected() {
    if (removeFrom == null) return;
    setConfirmingRemove(false);
    setRemoving(true);
    setActionError(null);
    // What this call is answerable for, read once. `onScreen` is derived from
    // the ticks and the list, and both move underneath a request that is still
    // out — the success path clears the ticks, and the refetch rewrites the
    // list — so every later step here works from this rather than re-reading it.
    const batch = [...onScreen];
    // Dim them now, on the click, rather than when the server answers. The fade
    // is feedback for the action, and at --dur-slow it has long settled before
    // the refetch that actually drops the rows lands.
    //
    // Merged into whatever is already dimmed rather than replacing it. The
    // button comes back the moment the server answers, roughly half a second
    // before the refetch drops the rows, so a second removal can start while the
    // first one's rows are still sitting there waiting to go. Replacing the set
    // snapped those back to full strength and then took them away with no
    // warning — the one thing the dim exists to prevent.
    setLeaving((prev) => new Set([...prev, ...batch]));
    try {
      // What happened, from the server, rather than the length of what was
      // sent. The two disagree in both directions — a collection holding two
      // copies of one article removes more files than papers, and anything that
      // got there first (another tab, a second window, an import cleanup)
      // removes fewer papers than were ticked. See describeRemoval.
      let text: string;
      if (removeFrom.place === "collection") {
        const { removed, papers } = await api.removeCollectionPapers(removeFrom.id, batch);
        text = describeRemoval(batch.length, removed, papers);
      } else {
        // A folder holds a paper once, so it has the one count and only the
        // shortfall to report.
        const { removed } = await api.removeBookmarks(removeFrom.id, batch);
        text = describeRemoval(batch.length, removed, removed, "folder");
      }
      setPendingNotice({
        text,
        pmids: batch,
        // Read before the callback below bumps it, which is the point: the
        // refresh this message waits for is the next one, not this one.
        token: reloadToken,
      });
      setSelected(new Set());
      // The papers list, the source's count in the picker and — for a
      // collection — the file list in the view above are all now stale, and
      // none of them is this component's to reload.
      if (removeFrom.place === "collection") onCollectionChanged?.();
      else onFolderChanged?.();
    } catch (err) {
      setActionError(errorMessage(err));
      // Nothing left the collection, so nothing should still look like it is
      // about to — but only these ids. An earlier removal still waiting on its
      // refetch keeps its own rows dimmed, and they are still going. The ticks
      // stay put, so the same removal can be retried.
      setLeaving((prev) => {
        const next = new Set(prev);
        for (const pmid of batch) next.delete(pmid);
        return next;
      });
    } finally {
      setRemoving(false);
    }
  }

  function toggleSort(next: SortKey) {
    // From the order on screen rather than the one last picked (see sortKey):
    // while the two differ, a click on the header carrying the arrow has to
    // flip what that arrow shows.
    setSortKey(next);
    if (next === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortDir(next === "title" || next === "authors" || next === "journal" ? "asc" : "desc");
    }
  }

  const arrow = (k: SortKey): ReactNode =>
    k === sortKey ? (
      sortDir === "asc" ? (
        <ChevronUp size={14} className="inline-icon sort-arrow" aria-hidden />
      ) : (
        <ChevronDown size={14} className="inline-icon sort-arrow" aria-hidden />
      )
    ) : null;

  // The share-link column only exists for the owner of a token-mode instance;
  // viewers and tokenless single-user setups get the plain table.
  const showShareCol = isAdmin && tokenRequired;
  // Whether saving is offered at all is App's call (only Interests gets it,
  // and not for viewers); the column follows from that rather than re-deciding
  // it.
  const showBookmarkCol = bookmarking != null;
  // Only across every collection: inside one, every row is in it, and a topic
  // or folder holds nothing. This is the column that turns "we have it" into
  // "we have it in the Pfizer package", which is what decides reuse.
  const showCollectionsCol = "allCollections" in source;
  // The tick column, which exists exactly when removal does.
  const showSelectCol = removeFrom != null;
  // Kept beside the flags that decide the optional columns, so a new column
  // can't be added without this following it — the excerpt row below spans the
  // table by count, and a stale number would silently narrow it.
  const columnCount =
    5 +
    (showAuthorsCol ? 1 : 0) +
    (showSelectCol ? 1 : 0) +
    (showCollectionsCol ? 1 : 0) +
    (showBookmarkCol ? 1 : 0) +
    (showShareCol ? 1 : 0);

  return (
    <div className="papers-table-view">
      <PaperFilters
        filters={filters}
        source={source}
        journals={journals}
        maxCitations={maxCitations}
        yearBounds={yearBounds}
        loading={loading}
        knownEmpty={knownEmpty}
        facets={facets}
        settling={!revealed}
        action={
          showSelectCol ? (
            // Sits where the bulk save does in the section that has one. The
            // two never coexist — bookmarking is null in the Library and in
            // Bookmarks, the two places removal is offered — so the slot
            // carries whichever bulk action this source actually has.
            //
            // Rendered even with nothing ticked, disabled. Appearing only once
            // a box is checked means the control is invisible at the moment
            // someone is looking for it, and the row would change height the
            // first time one was.
            <button
              type="button"
              className="remove-selected"
              disabled={onScreen.size === 0 || removing}
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash2 size={14} className="inline-icon" aria-hidden />
              {removing
                ? "Removing…"
                : onScreen.size > 0
                  ? `Remove ${onScreen.size} selected`
                  : "Remove selected"}
            </button>
          ) : (
            showBookmarkCol && (
              // The whole filtered list, not the rows currently rendered — the
              // table lazy-renders, so `shown` would silently save a scroll depth.
              <SaveAllButton
                pmids={visible.map((p) => p.pmid)}
                total={total}
                bookmarking={bookmarking!}
                onError={setActionError}
                onDone={setNotice}
              />
            )
          )
        }
      />

      <Banner
        kind="error"
        message={error ?? actionError ?? openError}
        onDismiss={() => {
          setActionError(null);
          clearOpenError();
        }}
      />
      <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />

      {!revealed ? (
        <PapersTableSkeleton
          select={showSelectCol}
          share={showShareCol}
          bookmark={showBookmarkCol}
          collections={showCollectionsCol}
          authors={showAuthorsCol}
        />
      ) : visible.length === 0 ? (
        <div className="empty">
          {allDeselected
            ? "No journals selected. Use the Journals filter to show papers."
            : filtered
              ? "No papers match the current filters."
              : (emptyState ?? "No papers yet.")}
        </div>
      ) : (
        <>
          <div className="papers-table-wrap">
            <table className={papersTableClass(showAuthorsCol)}>
              <PapersColgroup
                share={showShareCol}
                select={showSelectCol}
                bookmark={showBookmarkCol}
                collections={showCollectionsCol}
                authors={showAuthorsCol}
              />
              <thead>
                <tr>
                  {showSelectCol && (
                    <th className="select-col">
                      {/* Selects the whole filtered set, which is what the
                          action beside it acts on — not the rows rendered so
                          far. Indeterminate when some are ticked, so "some" is
                          distinguishable from "none" at a glance. */}
                      <input
                        type="checkbox"
                        aria-label={allSelected ? "Clear selection" : "Select all papers"}
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = onScreen.size > 0 && !allSelected;
                        }}
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                    </th>
                  )}
                  <th className="sortable" onClick={() => toggleSort("title")}>
                    Title{arrow("title")}
                  </th>
                  {showAuthorsCol && (
                    <th className="sortable" onClick={() => toggleSort("authors")}>
                      Authors{arrow("authors")}
                    </th>
                  )}
                  <th className="sortable" onClick={() => toggleSort("journal")}>
                    Journal{arrow("journal")}
                  </th>
                  <th className="sortable num" onClick={() => toggleSort("year")}>
                    Year{arrow("year")}
                  </th>
                  <th className="sortable num" onClick={() => toggleSort("citations")}>
                    Citations{arrow("citations")}
                  </th>
                  {showCollectionsCol && <th>Collections</th>}
                  <th>Links</th>
                  {showBookmarkCol && <th className="bookmark-col" aria-label="Bookmark" />}
                  {showShareCol && <th className="share-col" aria-label="Share" />}
                </tr>
              </thead>
              {/* One tbody per paper rather than one for the table. An excerpt
                  needs the full table width to be legible, so it goes in a
                  second row, and grouping the pair is what lets hover and the
                  row divider treat them as the single record they are.
                  Several tbodies in one table is valid HTML. */}
              {shown.map((p) => (
                <tbody
                  className={leaving.has(p.pmid) ? "paper-rows leaving" : "paper-rows"}
                  key={p.pmid}
                >
                  <tr>
                    {showSelectCol && (
                      <td className="select-cell">
                        <input
                          type="checkbox"
                          checked={onScreen.has(p.pmid)}
                          // Named by the paper rather than "Select row": read
                          // out of context, a column of identical "Select row"
                          // is a column of identical nothing.
                          aria-label={`Select ${p.title || p.pmid}`}
                          onChange={(e) => toggleOne(p.pmid, e.target.checked)}
                        />
                      </td>
                    )}
                    <td className="paper-title-cell">
                      <button
                        className="paper-open"
                        onClick={() => openPaper(p)}
                        title={openTitle(p, opensStoredPdf)}
                      >
                        {p.title || "(untitled)"}
                      </button>
                      {p.file_id != null && !p.file_exists && (
                        <span className="file-missing" title="The stored PDF is missing">
                          file missing
                        </span>
                      )}
                      {/* Where this came from, when it wasn't bought here.
                          Wording lives in the component — see it for why the
                          copy is chosen by kind rather than assumed. */}
                      <ProvenanceBadges entries={p.provenance} />
                    </td>
                    {showAuthorsCol && (
                      <td className="authors-cell">{formatAuthors(p.authors, 3)}</td>
                    )}
                    <td>{p.journal_name}</td>
                    <td className="num">{year(p.pub_date)}</td>
                    <td className="num">{p.citation_count}</td>
                    {showCollectionsCol && (
                      <td className="collections-cell">
                        {/* Every collection holding it, not only the one whose
                            file the title opens — a paper reused across three
                            engagements has to read as three. */}
                        {p.collections.join(", ")}
                      </td>
                    )}
                    <td className="links-cell">
                      <a href={p.url} target="_blank" rel="noreferrer">
                        PubMed <ExternalLink size={13} className="inline-icon" aria-hidden />
                      </a>
                      {p.doi && (
                        <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
                          DOI <ExternalLink size={13} className="inline-icon" aria-hidden />
                        </a>
                      )}
                    </td>
                    {showBookmarkCol && (
                      <td className="bookmark-cell">
                        <BookmarkMenu
                          pmid={p.pmid}
                          bookmarking={bookmarking!}
                          onError={setActionError}
                          onNewFolder={() => setNamingFor(p.pmid)}
                        />
                      </td>
                    )}
                    {showShareCol && (
                      <td className="share-cell">
                        {p.file_id != null && p.file_exists && (
                          <ShareLinkButton
                            mint={() => api.mintShareLink(p.file_id!)}
                            title="Copy a link that lets anyone download this PDF for 24 hours"
                            ariaLabel="Copy share link"
                            onError={setActionError}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                  {p.snippet && (
                    // Spans every column. In the title cell this clamped to two
                    // lines of a 36%-wide column, which routinely cut the
                    // excerpt off *before* its highlighted match — showing the
                    // context and hiding the answer the excerpt exists for.
                    <tr className="snippet-row">
                      <td colSpan={columnCount}>
                        <Snippet text={p.snippet} className="paper-snippet" />
                      </td>
                    </tr>
                  )}
                </tbody>
              ))}
            </table>
          </div>
          {hasMore && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
          <p className="timeline-footer">
            {hasMore
              ? `Showing ${shown.length} of ${sortedPapers.length} papers — scroll for more`
              : `${sortedPapers.length} paper${sortedPapers.length === 1 ? "" : "s"}`}
          </p>
        </>
      )}

      {bookmarking && (
        <NewFolderDialog
          pmid={namingFor}
          bookmarking={bookmarking}
          onError={setActionError}
          onClose={() => setNamingFor(null)}
        />
      )}

      {/* Names the collection's side of it and nothing more. The papers
          themselves are articles rows the whole app shares — a topic feed may
          have put them there, and another collection may hold its own copy — so
          "delete this paper" would promise something this does not do. A
          folder's side of it is smaller still: the entry on its list, which the
          title says, with no line under it. It used to add that the papers stay
          in the app. One that only this entry held does not: the sweep that
          follows the removal deletes it (see dropUnheldArticles in db.ts), and
          how a paper is stored is not the reader's to weigh. */}
      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove ${onScreen.size} paper${onScreen.size === 1 ? "" : "s"}${
          removeFrom?.place === "folder" ? " from this folder" : ""
        }?`}
        message={removeFrom?.place === "folder" ? undefined : STORED_COPIES_NOTE}
        confirmLabel="Remove"
        danger
        onConfirm={() => void removeSelected()}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}

function year(pubDate: string): string {
  return /^\d{4}/.test(pubDate) ? pubDate.slice(0, 4) : "—";
}
