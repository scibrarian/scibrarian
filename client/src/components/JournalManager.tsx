import { useEffect, useState } from "react";
import { api } from "../api";
import { errorMessage, round1, titleCaseJournal } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { Banner } from "./Banner";
import { ConfirmDialog, ModalShell } from "./Dialogs";
import { ListRowSkeleton } from "./Skeleton";
import type { Journal, JournalSearchResult } from "../types";

// Transfer-list dialog for bulk journal curation: left pane is the NLM catalog
// (search-driven), right pane is the user's journals. Moves are staged locally —
// nothing hits the server until Apply, which shows one aggregated warning when
// removals are staged (removal permanently deletes non-library papers).

// A right-pane row is either a stored journal or a staged add. Stored rows key
// by id (legacy rows can have a null nlm_id); staged rows key by nlm_id.
type RightRow =
  | { kind: "current"; journal: Journal }
  | { kind: "staged"; result: JournalSearchResult };

const rightKey = (row: RightRow) =>
  row.kind === "current" ? `j${row.journal.id}` : `n${row.result.nlm_id}`;
const rightName = (row: RightRow) =>
  row.kind === "current"
    ? row.journal.name
    : row.result.abbr || titleCaseJournal(row.result.title);
const rightMetric = (row: RightRow) =>
  row.kind === "current" ? row.journal.metric : row.result.metric;

// Metric descending, unknown metrics last, alphabetical tie-break.
function metricSort<T>(rows: T[], metric: (r: T) => number | null, name: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ma = metric(a);
    const mb = metric(b);
    if (ma == null && mb == null) return name(a).localeCompare(name(b));
    if (ma == null) return 1;
    if (mb == null) return -1;
    return mb - ma || name(a).localeCompare(name(b));
  });
}

function toggled<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function JournalManager({
  open,
  onClose,
  onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  // Fires whenever server-side changes were made — after a full apply, but also
  // after a partial failure (so callers refresh even though the dialog stays
  // open). `removalsCommitted` gates the caller's paper-cache invalidation.
  onCommitted: (papersRemovedFromInterests: number, removalsCommitted: boolean) => void;
}) {
  const [current, setCurrent] = useState<Journal[] | null>(null);
  const [leftFilter, setLeftFilter] = useState("");
  const [rightFilter, setRightFilter] = useState("");
  const [searchResults, setSearchResults] = useState<JournalSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [stagedAdds, setStagedAdds] = useState<Map<string, JournalSearchResult>>(new Map());
  const [stagedRemovals, setStagedRemovals] = useState<Set<number>>(new Set());
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ title: string; message: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts fresh — stale staging from the last use would be worse
  // than empty.
  useEffect(() => {
    if (!open) return;
    setCurrent(null);
    setLeftFilter("");
    setRightFilter("");
    setSearchResults([]);
    setStagedAdds(new Map());
    setStagedRemovals(new Set());
    setLeftSelected(new Set());
    setRightSelected(new Set());
    setConfirm(null);
    setApplying(false);
    setError(null);
    let active = true;
    api
      .getJournals()
      .then((j) => active && setCurrent(j))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [open]);

  // Debounced catalog search; the `active` flag keeps a stale earlier response
  // from overwriting newer results.
  const query = useDebounced(leftFilter.trim(), 200);
  useEffect(() => {
    if (!open) return;
    if (query.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    let active = true;
    setSearchLoading(true);
    api
      .searchJournals(query, 30)
      .then((r) => active && setSearchResults(r.results))
      .catch(() => active && setSearchResults([]))
      .finally(() => active && setSearchLoading(false));
    return () => {
      active = false;
    };
  }, [query, open]);

  // ----- derived pane contents (computed at render, no synced state) -----

  const searching = leftFilter.trim().length >= 2;

  // Journals the left pane must not offer: stored ones (unless staged for
  // removal — those become addable again, which cancels the removal) and
  // staged adds.
  const excluded = new Set<string>();
  for (const j of current ?? []) {
    if (j.nlm_id && !stagedRemovals.has(j.id)) excluded.add(j.nlm_id);
  }
  for (const k of stagedAdds.keys()) excluded.add(k);

  // Search results keep the server's relevance-aware order (metric-desc with
  // catalog name-relevance breaking ties).
  const leftRows = (searching ? searchResults : []).filter((r) => !excluded.has(r.nlm_id));

  const rightAll: RightRow[] = [
    ...(current ?? [])
      .filter((j) => !stagedRemovals.has(j.id))
      .map((j) => ({ kind: "current" as const, journal: j })),
    ...[...stagedAdds.values()].map((r) => ({ kind: "staged" as const, result: r })),
  ];
  const rq = rightFilter.trim().toLowerCase();
  const rightRows = metricSort(
    rightAll.filter((row) => {
      if (!rq) return true;
      if (row.kind === "current") return row.journal.name.toLowerCase().includes(rq);
      return (
        row.result.title.toLowerCase().includes(rq) ||
        row.result.abbr.toLowerCase().includes(rq)
      );
    }),
    rightMetric,
    rightName
  );

  // Selections intersected with the visible rows, so rows hidden by a filter
  // can't be moved while checked.
  const leftPicked = leftRows.filter((r) => leftSelected.has(r.nlm_id));
  const rightPicked = rightRows.filter((row) => rightSelected.has(rightKey(row)));

  const dirty = stagedAdds.size > 0 || stagedRemovals.size > 0;

  // ----- moves -----

  function moveRight(rows: JournalSearchResult[]) {
    const adds = new Map(stagedAdds);
    const removals = new Set(stagedRemovals);
    for (const r of rows) {
      // Re-adding a journal that's staged for removal just cancels the removal
      // — the stored journal (and its papers) survive untouched.
      const pending = (current ?? []).find(
        (j) => j.nlm_id === r.nlm_id && removals.has(j.id)
      );
      if (pending) removals.delete(pending.id);
      else adds.set(r.nlm_id, r);
    }
    setStagedAdds(adds);
    setStagedRemovals(removals);
    setLeftSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.delete(r.nlm_id);
      return next;
    });
  }

  function moveLeft(rows: RightRow[]) {
    const adds = new Map(stagedAdds);
    const removals = new Set(stagedRemovals);
    for (const row of rows) {
      if (row.kind === "staged") adds.delete(row.result.nlm_id);
      else removals.add(row.journal.id);
    }
    setStagedAdds(adds);
    setStagedRemovals(removals);
    setRightSelected((prev) => {
      const next = new Set(prev);
      for (const row of rows) next.delete(rightKey(row));
      return next;
    });
  }

  // ----- apply -----

  async function beginApply() {
    if (applying) return;
    if (stagedRemovals.size === 0) return commit();
    // The warning needs article counts fetched before the dialog opens; a
    // failed count falls through as 0 (same tolerance as the old per-journal
    // confirm).
    setApplying(true);
    const ids = [...stagedRemovals];
    const counts = await Promise.all(
      ids.map((id) => api.journalArticleCount(id).catch(() => ({ count: 0 })))
    );
    setApplying(false);
    const m = counts.reduce((sum, c) => sum + c.count, 0);
    const n = ids.length;
    const their = n === 1 ? "its" : "their";
    setConfirm({
      title: `Remove ${n} journal${n === 1 ? "" : "s"}?`,
      message:
        m > 0
          ? `This will remove ${their} papers from Interests and permanently delete ${m} stored paper${
              m === 1 ? "" : "s"
            }. Papers saved in your Library are kept. This cannot be undone.`
          : `${n === 1 ? "Its" : "Their"} papers will be removed from Interests. Papers saved in your Library are kept.`,
    });
  }

  async function commit() {
    setConfirm(null);
    setApplying(true);
    setError(null);
    let removedFromInterests = 0;
    let removalsCommitted = false;
    let committedAnything = false;
    try {
      // Adds first: a failed add aborts before anything destructive runs.
      // Known edge: staging a removal plus an add that resolves to the same
      // UNIQUE name 409s here (the removal hasn't run yet) — remove, apply,
      // then add.
      for (const r of [...stagedAdds.values()]) {
        await api.createJournal(r.abbr || r.title, r.nlm_id);
        committedAnything = true;
        setStagedAdds((prev) => {
          const next = new Map(prev);
          next.delete(r.nlm_id);
          return next;
        });
      }
      for (const id of [...stagedRemovals]) {
        const res = await api.deleteJournal(id);
        removedFromInterests += res.removedFromInterests;
        removalsCommitted = true;
        committedAnything = true;
        setStagedRemovals((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      onCommitted(removedFromInterests, removalsCommitted);
      onClose();
    } catch (err) {
      // Partial failure: committed items were already pruned from staging, so
      // what's left is retryable. Refetch so committed changes show as normal
      // rows, and still notify the caller — committed deletions must
      // invalidate its caches even though the dialog stays open.
      setError(errorMessage(err));
      try {
        setCurrent(await api.getJournals());
      } catch {
        /* keep the stale list; the error banner already explains */
      }
      if (committedAnything) onCommitted(removedFromInterests, removalsCommitted);
    } finally {
      setApplying(false);
    }
  }

  // ----- render -----

  function renderRow(
    key: string,
    name: string,
    metric: number | null,
    selected: boolean,
    onToggle: () => void,
    onMove: () => void,
    isNew = false
  ) {
    return (
      <li key={key} className="jm-row" onDoubleClick={onMove} title={name}>
        <label className="filter-option">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <span className="filter-option-name">{name}</span>
          {isNew && <span className="jm-new">new</span>}
          {metric != null && (
            <span
              className={`ta-metric${metric === 0 ? " zero" : ""}`}
              title="OpenAlex 2-yr citations per article"
            >
              {round1(metric)}
            </span>
          )}
        </label>
      </li>
    );
  }

  const leftEmpty = !searching
    ? "Type to search the NLM catalog (e.g. lancet, n engl j med)…"
    : searchLoading
      ? "Searching…"
      : searchResults.length === 0
        ? "No matches."
        : leftRows.length === 0
          ? "All matches already added."
          : null;

  const applyLabel = dirty
    ? `Apply (${[
        stagedAdds.size > 0 ? `add ${stagedAdds.size}` : "",
        stagedRemovals.size > 0 ? `remove ${stagedRemovals.size}` : "",
      ]
        .filter(Boolean)
        .join(", ")})`
    : "Apply";

  return (
    <>
      <ModalShell wide open={open} onClose={() => !applying && onClose()} title="Manage journals">
        <p className="hint">
          Check journals and move them between the catalog and your list. Changes are applied
          when you press Apply. The number is OpenAlex 2-yr citations per article — an open
          stand-in for impact factor.
        </p>
        {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}
        <div className="jm-panes">
          <section className="jm-pane" aria-label="Catalog journals">
            <header className="jm-pane-header">
              <span>Catalog</span>
              <span className="muted">{leftRows.length}</span>
            </header>
            <input
              type="search"
              value={leftFilter}
              onChange={(e) => setLeftFilter(e.target.value)}
              placeholder="Search catalog (e.g. lancet)…"
              aria-label="Search the journal catalog"
            />
            <ul className="jm-list">
              {leftRows.map((r) =>
                renderRow(
                  r.nlm_id,
                  titleCaseJournal(r.title),
                  r.metric,
                  leftSelected.has(r.nlm_id),
                  () => setLeftSelected(toggled(leftSelected, r.nlm_id)),
                  () => moveRight([r])
                )
              )}
              {leftEmpty && <li className="muted jm-empty">{leftEmpty}</li>}
            </ul>
          </section>

          <div className="jm-move">
            <button
              type="button"
              onClick={() => moveRight(leftPicked)}
              disabled={applying || leftPicked.length === 0}
            >
              Add →
            </button>
            <button
              type="button"
              onClick={() => moveLeft(rightPicked)}
              disabled={applying || rightPicked.length === 0}
            >
              ← Remove
            </button>
          </div>

          <section className="jm-pane" aria-label="Your journals">
            <header className="jm-pane-header">
              <span>Your journals</span>
              <span className="muted">{rightRows.length}</span>
            </header>
            <input
              type="search"
              value={rightFilter}
              onChange={(e) => setRightFilter(e.target.value)}
              placeholder="Filter your journals…"
              aria-label="Filter your journals"
            />
            <ul className="jm-list">
              {current === null &&
                [0, 1, 2].map((i) => (
                  <ListRowSkeleton key={i} className="filter-option" w={["40%", "55%", "35%"][i]} pill />
                ))}
              {rightRows.map((row) =>
                renderRow(
                  rightKey(row),
                  rightName(row),
                  rightMetric(row),
                  rightSelected.has(rightKey(row)),
                  () => setRightSelected(toggled(rightSelected, rightKey(row))),
                  () => moveLeft([row]),
                  row.kind === "staged"
                )
              )}
              {current !== null && rightRows.length === 0 && (
                <li className="muted jm-empty">
                  {rightAll.length === 0 ? "No journals yet." : "No matches."}
                </li>
              )}
            </ul>
          </section>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={beginApply}
            disabled={!dirty || applying}
          >
            {applyLabel}
          </button>
        </div>
      </ModalShell>

      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel="Remove"
        danger
        onConfirm={commit}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
