import { useEffect, useLayoutEffect, useState } from "react";
import { ArrowRight, ArrowLeft, TriangleAlert } from "lucide-react";
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

// Staged adds carry optional topic attribution when they came from Auto
// (JournalSuggestion rows), so the right pane can say why each was suggested.
type StagedAdd = JournalSearchResult & { topics?: string[] };

// A right-pane row is either a stored journal or a staged add. Stored rows key
// by id (legacy rows can have a null nlm_id); staged rows key by nlm_id.
type RightRow =
  | { kind: "current"; journal: Journal }
  | { kind: "staged"; result: StagedAdd };

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

// The persistent counterpart to the add-time warning below: without it, a
// journal that can never match a topic is visually identical to one that can,
// everywhere journals are listed. Exported because the Settings journal list
// needs exactly the same mark — two renderings of this would drift.
export function MeshBadge({ name }: { name: string }) {
  return (
    <span
      className="mesh-warn"
      title={`MEDLINE doesn't index ${name}, so its papers carry no MeSH headings and it can't match any topic.`}
    >
      <TriangleAlert size={11} aria-hidden />
      no MeSH
    </span>
  );
}

// Post-add warning for journals PubMed carries but MEDLINE doesn't index. Topics
// are MeSH headings and only MEDLINE-indexed records get MeSH headings, so these
// journals match no topic and contribute nothing to Interests, however long they
// are polled. They're still worth keeping for a library built by PDF import,
// which doesn't go through the watchlist at all — hence a warning, not a refusal.
function meshWarning(names: string[]): string {
  const one = names.length === 1;
  return (
    `Added, but MEDLINE doesn't index ${names.join(", ")}. ` +
    `${one ? "Its papers carry" : "Their papers carry"} no MeSH headings, so ` +
    `${one ? "it" : "they"} can't match any topic and won't add anything to ` +
    `Interests. Papers from ${one ? "it" : "them"} can still enter your library ` +
    `by importing the PDF.`
  );
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
  const [stagedAdds, setStagedAdds] = useState<Map<string, StagedAdd>>(new Map());
  const [stagedRemovals, setStagedRemovals] = useState<Set<number>>(new Set());
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ title: string; message: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts fresh — stale staging from the last use would be worse
  // than empty. Runs in a layout effect (before paint) so the previous session's
  // filter/results can't flash for a frame before being cleared.
  useLayoutEffect(() => {
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
    setSuggesting(false);
    setNotice(null);
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

  // ----- auto-suggest -----

  // Auto: pull per-topic suggestions from the server and stage them as adds.
  // Nothing is committed — suggestions land in the right pane for review and
  // go through the same Apply as manual moves. The server already excludes
  // stored journals; the functional update keeps any staging the user did
  // while the (slow, multi-request) fetch was in flight.
  async function autoSuggest() {
    if (suggesting || applying) return;
    setSuggesting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.suggestJournals();
      if (r.topicCount === 0) {
        setNotice("No topics yet — add topics first, then Auto can suggest journals for them.");
        return;
      }
      const fresh = r.results.filter((s) => !stagedAdds.has(s.nlm_id));
      setStagedAdds((prev) => {
        const next = new Map(prev);
        for (const s of r.results) if (!next.has(s.nlm_id)) next.set(s.nlm_id, s);
        return next;
      });
      const parts = [
        fresh.length > 0
          ? `Staged ${fresh.length} suggested journal${
              fresh.length === 1 ? "" : "s"
            } — review below, then press Apply.`
          : "No new suggestions — your list already covers your topics' top journals.",
      ];
      if (r.failed.length > 0) {
        parts.push(`Couldn't fetch suggestions for: ${r.failed.join(", ")}.`);
      }
      setNotice(parts.join(" "));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  // ----- apply -----

  async function beginApply() {
    if (applying || suggesting) return;
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
          ? `This will remove ${their} ${m} stored paper${
              m === 1 ? "" : "s"
            } from Interests. Papers saved in your Library are kept. This cannot be undone.`
          : "No stored papers will be removed.",
    });
  }

  async function commit() {
    setConfirm(null);
    setApplying(true);
    setError(null);
    let removedFromInterests = 0;
    let removalsCommitted = false;
    let committedAnything = false;
    // Journals the server added but flagged as not indexed for MEDLINE. They
    // carry no MeSH headings, so they can never match a topic — the one thing
    // about an add that's worth saying out loud, because otherwise it presents
    // as a journal that simply never publishes anything.
    const unindexed: string[] = [];
    try {
      // Adds first: a failed add aborts before anything destructive runs.
      // Known edge: staging a removal plus an add that resolves to the same
      // UNIQUE name 409s here (the removal hasn't run yet) — remove, apply,
      // then add.
      for (const r of [...stagedAdds.values()]) {
        const created = await api.createJournal(r.abbr || r.title, r.nlm_id);
        if (created.medline_indexed === false) unindexed.push(created.name);
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
      // Everything applied. Normally that closes the dialog — but a warning the
      // user never sees is the failure this is meant to fix, so when there is
      // one the dialog stays open showing it, with the journals now in the right
      // pane as stored rows.
      if (unindexed.length > 0) {
        try {
          setCurrent(await api.getJournals());
        } catch {
          /* the adds succeeded; a failed refresh only leaves the pane stale */
        }
        setNotice(meshWarning(unindexed));
        return;
      }
      onClose();
    } catch (err) {
      // Partial failure: committed items were already pruned from staging, so
      // what's left is retryable. Refetch so committed changes show as normal
      // rows, and still notify the caller — committed deletions must
      // invalidate its caches even though the dialog stays open.
      setError(errorMessage(err));
      // A later add failing must not swallow the warning for earlier ones that
      // succeeded: those are committed and already pruned from staging, so a
      // retry will never mention them again. Both banners render, so the error
      // and the warning show together.
      if (unindexed.length > 0) setNotice(meshWarning(unindexed));
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

  // Named rather than positional: the row already carried seven parameters, and
  // the two call sites differ only in the optional tail.
  function renderRow({
    key,
    name,
    metric,
    selected,
    onToggle,
    isNew = false,
    warn = false,
    tooltip,
  }: {
    key: string;
    name: string;
    metric: number | null;
    selected: boolean;
    onToggle: () => void;
    isNew?: boolean;
    warn?: boolean;
    tooltip?: string;
  }) {
    return (
      <li key={key} className="jm-row" title={tooltip ?? name}>
        <label className="filter-option">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <span className="filter-option-name">{name}</span>
          {isNew && <span className="jm-new">new</span>}
          {warn && <MeshBadge name={name} />}
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
        {notice && <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />}
        <div className="jm-auto">
          <button
            type="button"
            onClick={autoSuggest}
            disabled={suggesting || applying}
            title="Stage the top journals publishing on your topics, ranked by the citation metric"
          >
            {suggesting ? "Searching PubMed…" : "Auto"}
          </button>
          <span className="hint">
            Auto stages the top journals for each of your topics (recent papers, highest
            metric first) — nothing is added until you press Apply.
          </span>
        </div>
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
                renderRow({
                  key: r.nlm_id,
                  name: titleCaseJournal(r.title),
                  metric: r.metric,
                  selected: leftSelected.has(r.nlm_id),
                  onToggle: () => setLeftSelected(toggled(leftSelected, r.nlm_id)),
                })
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
              Add <ArrowRight size={14} className="inline-icon" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => moveLeft(rightPicked)}
              disabled={applying || rightPicked.length === 0}
            >
              <ArrowLeft size={14} className="inline-icon" aria-hidden /> Remove
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
                renderRow({
                  key: rightKey(row),
                  name: rightName(row),
                  metric: rightMetric(row),
                  selected: rightSelected.has(rightKey(row)),
                  onToggle: () => setRightSelected(toggled(rightSelected, rightKey(row))),
                  isNew: row.kind === "staged",
                  // Staged rows are deliberately unmarked: nothing has asked NLM
                  // about them yet, and "unknown" must not render as "fine".
                  warn: row.kind === "current" && row.journal.medline_indexed === false,
                  tooltip:
                    row.kind === "staged" && row.result.topics?.length
                      ? `${rightName(row)} — suggested for: ${row.result.topics.join(", ")}`
                      : undefined,
                })
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
            disabled={!dirty || applying || suggesting}
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
