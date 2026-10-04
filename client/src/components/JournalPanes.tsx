import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowLeft, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { errorMessage, round1, titleCaseJournal } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { Banner } from "./Banner";
import { InfoTip } from "./InfoTip";
import { ListRowSkeleton } from "./Skeleton";
import type { Journal, JournalSearchResult, MeshDescriptorRef, Topic } from "../types";

// The transfer list a topic's journals are picked in: left pane is the NLM
// catalog (search-driven), right pane is the topic's list. It edits a list the
// topic dialog holds and saves nothing itself — the list is stored when the
// topic is, and what a change would remove is asked about then.

// A journal on a topic's list, as the dialog holds it.
export interface ListedJournal {
  nlm_id: string;
  name: string;
  metric: number | null;
  // What NLM said when the journal was first listed. Null for one picked in
  // this dialog and not yet saved: nothing has asked about it, and "unknown"
  // must not render as "fine".
  medline_indexed: boolean | null;
}

// A stored journal as a list entry. Null for one stored without an NLM id,
// which predates NLM resolution and can't be named in a scope.
export function listedFromStored(j: Journal): ListedJournal | null {
  if (!j.nlm_id) return null;
  return { nlm_id: j.nlm_id, name: j.name, metric: j.metric, medline_indexed: j.medline_indexed };
}

const listedFromCatalog = (r: JournalSearchResult): ListedJournal => ({
  nlm_id: r.nlm_id,
  name: r.abbr || titleCaseJournal(r.title),
  metric: r.metric,
  medline_indexed: null,
});

const AUTO_HELP =
  "Auto adds the top journals for these headings. The number is OpenAlex 2-yr citations " +
  "per article — an open stand-in for impact factor.";

// Metric descending, unknown metrics last, alphabetical tie-break.
function metricSort(rows: ListedJournal[]): ListedJournal[] {
  return [...rows].sort((a, b) => {
    if (a.metric == null && b.metric == null) return a.name.localeCompare(b.name);
    if (a.metric == null) return 1;
    if (b.metric == null) return -1;
    return b.metric - a.metric || a.name.localeCompare(b.name);
  });
}

// Marks a journal MEDLINE doesn't index. Without it, a journal that can never
// match a topic is visually identical to one that can.
function MeshBadge({ name }: { name: string }) {
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

function toggled<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function JournalPanes({
  original,
  value,
  onChange,
  headings,
  copyFrom,
  loading,
  disabled,
}: {
  // The list as stored — empty for a topic being created — so the pane can mark
  // what is new and keep what was dropped within reach.
  original: ListedJournal[];
  value: ListedJournal[];
  onChange: (next: ListedJournal[]) => void;
  // The headings Auto asks about.
  headings: MeshDescriptorRef[];
  // The topics whose lists can be copied in.
  copyFrom: Topic[];
  // The stored list is still on its way.
  loading: boolean;
  disabled: boolean;
}) {
  const [leftFilter, setLeftFilter] = useState("");
  const [rightFilter, setRightFilter] = useState("");
  const [searchResults, setSearchResults] = useState<JournalSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  // Auto or Copy from, while its request is out.
  const [fetching, setFetching] = useState<"auto" | "copy" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list as it stands when a slow request lands, not as it stood when the
  // request left: Auto takes several PubMed round trips, and whatever was moved
  // meanwhile must survive it.
  const latest = useRef(value);
  latest.current = value;

  // Whether these panes are still on screen. Auto and Copy from can outlive
  // them — the dialog cancelled, or switched to All of PubMed, with a request
  // out — and `onChange` is the dialog's, which stays: the answer would be
  // added to whatever list it holds by then, another topic's if one has been
  // opened since. Set on mount as well as cleared on unmount, for StrictMode's
  // mount-unmount-mount.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Debounced catalog search; the `active` flag keeps a stale earlier response
  // from overwriting newer results.
  const query = useDebounced(leftFilter.trim(), 200);
  useEffect(() => {
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
  }, [query]);

  // ----- derived pane contents (computed at render, no synced state) -----

  const searching = leftFilter.trim().length >= 2;
  // No answer yet for what is in the box: the request is out, or the debounce
  // hasn't let it leave. The second half is the one that is easy to miss — for
  // those 200ms nothing is loading and nothing has been found, which read as a
  // search that had finished empty, and "No matches." flashed ahead of
  // "Searching…" on every keystroke.
  const awaiting = searchLoading || query !== leftFilter.trim();
  const listed = new Set(value.map((j) => j.nlm_id));
  const stored = new Map(original.map((j) => [j.nlm_id, j]));

  // Journals dropped from the stored list sit at the top of the left pane
  // whether or not a search is running, so pressing Remove moves the rows here
  // instead of leaving them nowhere: the pane is otherwise search-only, and a
  // journal dropped with an empty search box would simply vanish.
  const lq = leftFilter.trim().toLowerCase();
  const dropped: JournalSearchResult[] = original
    .filter((j) => !listed.has(j.nlm_id) && (!searching || j.name.toLowerCase().includes(lq)))
    .map((j) => ({ nlm_id: j.nlm_id, title: j.name, abbr: j.name, issn: "", metric: j.metric }));
  const droppedIds = new Set(dropped.map((r) => r.nlm_id));

  // Search results keep the server's relevance-aware order (metric-desc with
  // catalog name-relevance breaking ties), under the dropped journals — which a
  // search can return too, hence the dedupe.
  const leftRows = [
    ...dropped,
    ...(searching ? searchResults : []).filter(
      (r) => !listed.has(r.nlm_id) && !droppedIds.has(r.nlm_id)
    ),
  ];

  const rq = rightFilter.trim().toLowerCase();
  const rightRows = metricSort(value.filter((j) => !rq || j.name.toLowerCase().includes(rq)));

  // Selections intersected with the visible rows, so rows hidden by a filter
  // can't be moved while checked.
  const leftPicked = leftRows.filter((r) => leftSelected.has(r.nlm_id));
  const rightPicked = rightRows.filter((j) => rightSelected.has(j.nlm_id));

  // ----- moves -----

  // A journal going back onto the list it was stored on is that stored entry
  // again — its MEDLINE answer with it — rather than a fresh pick.
  const entryFor = (r: JournalSearchResult): ListedJournal =>
    stored.get(r.nlm_id) ?? listedFromCatalog(r);

  // Onto the end of the list as it stands, skipping what is already on it.
  // Returns how many were new to it.
  function add(rows: ListedJournal[]): number {
    const have = new Set(latest.current.map((j) => j.nlm_id));
    const fresh = rows.filter((j) => !have.has(j.nlm_id) && have.add(j.nlm_id));
    if (fresh.length > 0) onChange([...latest.current, ...fresh]);
    return fresh.length;
  }

  function moveRight(rows: JournalSearchResult[]) {
    add(rows.map(entryFor));
    setLeftSelected(new Set());
  }

  function moveLeft(rows: ListedJournal[]) {
    const going = new Set(rows.map((j) => j.nlm_id));
    onChange(value.filter((j) => !going.has(j.nlm_id)));
    setRightSelected(new Set());
  }

  // ----- auto-suggest and copy -----

  // Auto: the top journals publishing on these headings, added to the list for
  // review. Nothing is stored until the topic is saved.
  async function autoSuggest() {
    if (fetching || disabled) return;
    setFetching("auto");
    setError(null);
    setNotice(null);
    try {
      const r = await api.suggestJournals(headings.map((h) => h.ui));
      if (!mounted.current) return;
      const added = add(r.results.map(entryFor));
      setNotice(
        added > 0
          ? `Added ${added} suggested journal${added === 1 ? "" : "s"} to the list.`
          : "No new suggestions — the list already has these headings' top journals."
      );
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setFetching(null);
    }
  }

  async function copyList(topicId: number) {
    if (fetching || disabled) return;
    const from = copyFrom.find((t) => t.id === topicId);
    setFetching("copy");
    setError(null);
    setNotice(null);
    try {
      const detail = await api.getTopic(topicId);
      if (!mounted.current) return;
      const theirs = detail.journals.flatMap((j) => {
        const entry = listedFromStored(j);
        // The same journal on this topic's stored list is this topic's entry.
        return entry ? [stored.get(entry.nlm_id) ?? entry] : [];
      });
      const added = add(theirs);
      setNotice(
        added > 0
          ? `Added ${added} journal${added === 1 ? "" : "s"} from “${from?.name ?? "that topic"}”.`
          : `The list already has every journal “${from?.name ?? "that topic"}” does.`
      );
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setFetching(null);
    }
  }

  // ----- render -----

  function renderRow({
    key,
    name,
    metric,
    selected,
    onToggle,
    isNew = false,
    warn = false,
  }: {
    key: string;
    name: string;
    metric: number | null;
    selected: boolean;
    onToggle: () => void;
    isNew?: boolean;
    warn?: boolean;
  }) {
    return (
      <li key={key} className="jm-row" title={name}>
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

  const leftEmpty =
    leftRows.length > 0
      ? null
      : !searching
        ? "Type to search the NLM catalog (e.g. lancet, n engl j med)…"
        : awaiting
          ? "Searching…"
          : searchResults.length === 0
            ? "No matches."
            : "All matches already on the list.";

  return (
    <div
      className="jm"
      // The panes sit inside the topic dialog's form, where Enter in a box
      // submits. No box here is a field of the topic — they filter the lists
      // and tick their rows — and Enter in one saved the topic as it stood.
      // Buttons and the Copy from menu are left theirs.
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />
      <div className="jm-auto">
        <button
          type="button"
          onClick={autoSuggest}
          disabled={fetching != null || disabled || headings.length === 0}
        >
          {fetching === "auto" ? "Searching PubMed…" : "Auto"}
        </button>
        {/* What Auto does and what the numbers are, read once and in the way
            from then on — so beside the button rather than under it. */}
        <InfoTip text={AUTO_HELP} />
        {copyFrom.length > 0 && (
          <select
            aria-label="Copy another topic's journals"
            value=""
            disabled={fetching != null || disabled}
            onChange={(e) => e.target.value && copyList(Number(e.target.value))}
          >
            <option value="">{fetching === "copy" ? "Copying…" : "Copy from…"}</option>
            {copyFrom.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.journalCount})
              </option>
            ))}
          </select>
        )}
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
            disabled={disabled || leftPicked.length === 0}
          >
            Add <ArrowRight size={14} className="inline-icon" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => moveLeft(rightPicked)}
            disabled={disabled || rightPicked.length === 0}
          >
            <ArrowLeft size={14} className="inline-icon" aria-hidden /> Remove
          </button>
        </div>

        <section className="jm-pane" aria-label="This topic's journals">
          <header className="jm-pane-header">
            <span>This topic’s journals</span>
            <span className="muted">{rightRows.length}</span>
          </header>
          <input
            type="search"
            value={rightFilter}
            onChange={(e) => setRightFilter(e.target.value)}
            placeholder="Filter this topic’s journals…"
            aria-label="Filter this topic's journals"
          />
          <ul className="jm-list">
            {loading &&
              [0, 1, 2].map((i) => (
                <ListRowSkeleton key={i} className="filter-option" w={["40%", "55%", "35%"][i]} pill />
              ))}
            {rightRows.map((j) =>
              renderRow({
                key: j.nlm_id,
                name: j.name,
                metric: j.metric,
                selected: rightSelected.has(j.nlm_id),
                onToggle: () => setRightSelected(toggled(rightSelected, j.nlm_id)),
                isNew: !stored.has(j.nlm_id),
                warn: j.medline_indexed === false,
              })
            )}
            {!loading && rightRows.length === 0 && (
              <li className="muted jm-empty">
                {value.length === 0 ? "No journals chosen yet." : "No matches."}
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
