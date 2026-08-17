import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FilePlus } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useCachedFetch, type FetchCache } from "../lib/hooks";
import { Banner } from "./Banner";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import type {
  CollectionFile,
  CollectionFilesResponse,
  ImportJob,
  ImportStatus,
  ProCollectionStamp,
} from "../types";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "../../../shared/limits";

// Files per upload request, so a large selection doesn't become one gigantic
// multipart body. Clamped to the server's per-request cap so raising this for
// speed can't silently start failing every upload.
const UPLOAD_BATCH = Math.min(20, MAX_UPLOAD_FILES);

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

// "a.pdf, b.pdf, c.pdf and 4 more" — enough to act on without a wall of names.
function nameList(files: File[], max = 3): string {
  const shown = files.slice(0, max).map((f) => f.name);
  const rest = files.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

// Consecutive failed status polls before we give up on a running import. A
// single blip must not freeze the progress UI, but a truly-dead server
// shouldn't be polled forever either. At the 1s tick this is ~5s of retries.
const MAX_POLL_FAILURES = 5;

// "3 files" / "1 file".
function fileCount(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

// What a finished scan actually did, for the banner that replaces the upload's.
// Only the tallies — which files ended up unmatched is the section below's job,
// and it lists them by name.
function scanSummary(job: ImportJob): string {
  const parts = [`${job.matched} matched`, `${job.unmatched} unmatched`];
  if (job.errors) parts.push(`${job.errors} unreadable`);
  return `Scanned ${fileCount(job.total)}: ${parts.join(", ")}.`;
}

// Cache the last file listing per collection, same pattern as papersCache:
// re-entering Library paints from cache instead of refetching. Every mutation
// (upload, import, match, delete) reports through onChanged, which bumps this
// collection's reload token and thereby invalidates this cache along with the
// modules'.
const filesCache: FetchCache<CollectionFilesResponse> = new Map();

// The collection management shell: upload/import/rename/delete chrome and the
// unmatched-files section, wrapped around whichever analysis module (table or
// timeline) is active — those render as `children` and fetch their own paper
// rows from /api/papers.
export function CollectionView({
  collectionId,
  isAdmin,
  stamp,
  reloadToken,
  showUnmatched = true,
  onChanged,
  onDeleted,
  children,
}: {
  // Null when the Library is showing every collection at once. There is no
  // collection to add files to, rename, delete, or list unmatched files for, so
  // all of that chrome is absent — the same shape a viewer already sees. The
  // component is still rendered rather than skipped, because `source-head`
  // below is a deliberate spacer: without it the papers module starts at a
  // different height here than in every other workspace and the list jumps as
  // you switch.
  collectionId: number | null;
  isAdmin: boolean;
  /**
   * This collection's organisation stamp, or null when it has none (and always
   * in a free build). Where the picker's icon answers "does this sync?", the
   * badge this drives carries the states that icon cannot: a collection stamped
   * for an engagement that has since ended, whose papers are nobody's to reuse
   * even though nothing about it syncs today.
   *
   * The wire type whole rather than the two fields read below. It is exported
   * for this, App hands one straight through, and a subset declared here would
   * go on compiling against a field that had been renamed out from under it.
   */
  stamp: ProCollectionStamp | null;
  reloadToken: number;
  // The unmatched-files section is the one piece of chrome that doesn't suit
  // every view — a long list under a full-height graph. The action row and
  // import progress are not gated: they belong wherever the collection is.
  showUnmatched?: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  // Files sent so far, while a selection is being uploaded. Non-null *is* the
  // "upload in progress" flag: the bytes are still going up, nothing has been
  // scanned, and the rows the server already has say nothing yet about whether
  // they matched.
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  // Set when a scan settles: the refreshed file list has been asked for but has
  // not arrived, and until it does every row on screen still reads 'pending'.
  const [filesStale, setFilesStale] = useState(false);
  // Whether the resume probe below has answered for this collection yet — that
  // is, whether we know if a scan is working on the rows we're looking at.
  const [scanChecked, setScanChecked] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);

  // The file listing is fully derived: mutations never set it directly, they
  // call onChanged() and the token bump refetches it here.
  const { data: filesData, error: filesError } = useCachedFetch(
    filesCache,
    `files:${collectionId ?? "all"}`,
    reloadToken,
    () => (collectionId == null ? Promise.resolve({ files: [] }) : api.getCollectionFiles(collectionId))
  );
  const files = filesData?.files ?? [];

  // A genuinely new response has landed, so the list is current again. Keyed on
  // the response object rather than the loading flag: `filesData` holds its
  // identity across every re-render that doesn't refetch, so this fires exactly
  // when there is fresh data and never merely because something re-rendered.
  useEffect(() => {
    setFilesStale(false);
  }, [filesData]);

  // The latest onChanged, reachable from the interval without being one of its
  // dependencies. App declares it as a plain function in its body, so it is a
  // new value on every App render; depending on it directly rebuilt
  // startPolling, and the resume effect below with it, on every App-level state
  // change. That effect's cleanup clears a live interval and its body fires
  // another status request — measured at one stray GET /import/status per view
  // toggle or dialog open, with no import running at all.
  //
  // Written in an effect rather than during render: assigning to a ref while
  // rendering is a side effect, and this only has to be current by the time the
  // interval next ticks.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  // Poll import status while a job runs; refresh files + everything else
  // (via onChanged) when it finishes.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // What the last selection left behind — files ignored for not being PDFs,
  // files skipped for being too large. It is reported when the upload finishes
  // and again when the scan does, because the scan's summary replaces that
  // first banner and these are the one part of it the scan can't restate: the
  // job only ever saw the files that made it in.
  const selectionNotesRef = useRef("");

  // The one place a settled job becomes a message. Two things can be the first
  // to see a job finish — the poll below, and the status read right after
  // starting one that was over before the first tick — and both have to say so,
  // or the banner is left claiming a scan is still running long after it ended.
  const reportSettled = useCallback((s: ImportStatus) => {
    // The caller refreshes the file list next, and until that lands the rows on
    // screen are the pre-scan ones — all 'pending', none of them yet an answer.
    setFilesStale(true);
    if (s.state === "done") setNotice(scanSummary(s) + selectionNotesRef.current);
    else if (s.state === "error") setError((s.error ?? "The scan failed.") + selectionNotesRef.current);
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    // Captured once rather than read through the prop inside the interval: an
    // import job belongs to a collection, so there is nothing to poll when the
    // Library is showing all of them.
    const id = collectionId;
    if (id == null) return;
    // Scoped to this polling session (reset each startPolling). inFlight stops
    // slow responses from stacking requests — without it, several polls can be
    // outstanding at once and each fires onChanged() when the job completes.
    let inFlight = false;
    let failures = 0;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await api.getImportStatus(id);
        failures = 0;
        setImportStatus(s);
        if (s.state === "done" || s.state === "error" || s.state === "idle") {
          stopPolling();
          reportSettled(s);
          onChangedRef.current();
        }
      } catch {
        // A transient failure must not freeze the progress bar: keep polling
        // and retry next tick. Only give up after several failures in a row —
        // then clear the stuck "running" UI so it doesn't hang forever.
        if (++failures >= MAX_POLL_FAILURES) {
          stopPolling();
          setImportStatus(null);
          setError("Lost contact with the import job. Reload to check its status.");
        }
      } finally {
        inFlight = false;
      }
    }, 1000);
    // Deliberately not onChanged: see onChangedRef above. The poll's identity
    // tracks what it polls — the collection — and nothing else.
  }, [collectionId, reportSettled, stopPolling]);

  // Resume the progress UI if an import is already running for this collection.
  //
  // Also the answer to "is anything scanning these rows?", which is why
  // scanChecked is set either way. Entering a collection mid-scan paints the
  // cached file list — every row 'pending' — before this comes back, and a
  // pending row means nothing until it is known whether something is working
  // on it.
  useEffect(() => {
    if (collectionId == null) return stopPolling;
    api
      .getImportStatus(collectionId)
      .then((s) => {
        if (s.state === "running") {
          setImportStatus(s);
          startPolling();
        }
      })
      .catch(() => {})
      .finally(() => setScanChecked(true));
    return stopPolling;
  }, [collectionId, startPolling, stopPolling]);

  // Upload the picked PDFs in batches, then kick off the scan/match job.
  //
  // The three mutating handlers below all take a collection. None is reachable
  // without one — their buttons are part of the chrome that a null id removes —
  // so these guards exist to make that unreachability a fact the compiler
  // checks, rather than a claim about the markup that a later edit could break.
  async function handleImport(list: FileList | null) {
    if (collectionId == null) return;
    const picked = Array.from(list ?? []);
    const pdfs = picked.filter((f) => /\.pdf$/i.test(f.name));
    setError(null);
    setNotice(null);
    // Anything that isn't a PDF is dropped, never sent — a mixed selection
    // uploads its PDFs and says what it left behind. Counted rather than
    // silently filtered: dropping files without a word is how "it didn't
    // upload everything" becomes a mystery.
    const ignored = picked.length - pdfs.length;
    const ignoredNote = ignored ? ` Ignored ${fileCount(ignored)} that aren't PDFs.` : "";
    selectionNotesRef.current = ignoredNote; // + skipNote once the sizes are known
    if (pdfs.length === 0) {
      setNotice(`No PDFs found in the selection.${ignoredNote}`);
      return;
    }
    // Drop oversized files before batching. The server rejects the whole
    // request when any one file is over the cap, so leaving one in would fail
    // its 19 batch-mates too. Naming them here also fixes the part the server
    // can't: its "File too large" doesn't say which file.
    const oversized = pdfs.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const uploadable = pdfs.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    const skipNote = oversized.length
      ? ` Skipped ${fileCount(oversized.length)} over ${MAX_UPLOAD_MB} MB: ${nameList(oversized)}.`
      : "";
    selectionNotesRef.current = skipNote + ignoredNote;
    if (uploadable.length === 0) {
      setError(`Nothing left to upload.${skipNote}${ignoredNote}`);
      return;
    }
    let added = 0;
    let skipped = 0;
    let failedFiles = 0;
    let failure: unknown = null;
    setUploading({ done: 0, total: uploadable.length });
    for (let i = 0; i < uploadable.length; i += UPLOAD_BATCH) {
      const batch = uploadable.slice(i, i + UPLOAD_BATCH);
      try {
        const res = await api.uploadFiles(collectionId, batch);
        added += res.added;
        skipped += res.skipped;
      } catch (e) {
        // One rejected batch is not a reason to abandon the other nineteen
        // files the user picked. Keep going and report the shortfall at the
        // end — whatever made this request fail (a file the browser can no
        // longer read, a blip) usually has nothing to do with the next batch.
        failedFiles += batch.length;
        failure ??= e;
      }
      setUploading({ done: Math.min(i + batch.length, uploadable.length), total: uploadable.length });
    }

    // Start the scan even when a batch failed. Files that uploaded before the
    // failure are sitting in 'pending' with no job queued, and nothing else in
    // the UI can queue one — so without this they're stranded until the user
    // happens to upload again. The job walks every pending row, so this also
    // sweeps up whatever an earlier partial upload left behind.
    //
    // `uploading` is deliberately still set through both of these requests and
    // cleared in the finally: releasing it when the last batch landed left the
    // bar with nothing to draw for the two round trips that queue the job, so
    // it vanished and came back as "Scanning" a moment later. Clearing it in
    // the same tick that sets the job status makes the handover one render.
    let started: ImportStatus | null = null;
    try {
      await api.startImport(collectionId);
      started = await api.getImportStatus(collectionId);
      setImportStatus(started);
      if (started.state === "running") startPolling();
    } catch (e) {
      failure ??= e; // the upload error, if there was one, is the more useful
    } finally {
      setUploading(null);
    }
    onChanged();

    if (failure) {
      // Two different shortfalls reach here: files that never uploaded, and a
      // scan that wouldn't start over files that did. Both leave work undone
      // and both are fixed by re-running, but saying "0 files couldn't be
      // uploaded" for the second would be a lie about which half failed.
      setError(
        `${errorMessage(failure)} ${
          failedFiles > 0
            ? `${failedFiles} of ${fileCount(uploadable.length)} couldn't be uploaded; re-run to ` +
              `add ${failedFiles === 1 ? "it" : "them"}.`
            : `${fileCount(added)} uploaded but not scanned; re-run to scan ${
                added === 1 ? "it" : "them"
              }.`
        }${skipNote}${ignoredNote}`
      );
      return;
    }
    // Nothing is said about a successful upload. The progress bar reported it
    // as it happened and the scan's summary lands on top of it seconds later,
    // so an "Added N files" banner in between is a message whose whole life is
    // spent being superseded. Only a selection that added nothing needs a
    // banner, because for that one the bar and the summary both say nothing.
    if (added === 0) {
      setNotice(
        (skipped > 0 ? "Those files are already in this collection." : "No PDFs found in the selection.") +
          selectionNotesRef.current
      );
      return;
    }
    // A short scan can be over before the poll's first tick — or before it even
    // starts — and then nothing else would ever report it.
    if (started && started.state !== "running") reportSettled(started);
  }

  async function rename(next: string) {
    setRenaming(false);
    if (collectionId == null) return;
    try {
      await api.renameCollection(collectionId, next);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    setConfirmingDelete(false);
    if (collectionId == null) return;
    try {
      await api.deleteCollection(collectionId);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const unresolved = files.filter(
    (f) => f.match_status === "unmatched" || f.match_status === "error" || f.match_status === "pending"
  );

  // Narrow away the "idle" sentinel so the live-job fields (total, processed, …)
  // are available; when idle there's no progress to show anyway.
  const job = importStatus && importStatus.state !== "idle" ? importStatus : null;
  const running = job?.state === "running";
  const progressPct = job && job.total ? Math.round((job.processed / job.total) * 100) : 0;

  // Rows nothing has decided about yet.
  const anyPending = files.some((f) => f.match_status === "pending");

  // Whether the file list can be trusted to say what it says. Until it can, the
  // unmatched section is withheld entirely and the progress bar stands in for
  // it — so no file is ever listed as having no PubMed ID before the scanner
  // has looked at it. Three ways the list can be ahead of the truth:
  //
  //  - bytes are still going up, or a scan is running over them;
  //  - a scan just settled and the refreshed list hasn't landed, so what's on
  //    screen is still the pre-scan one (useCachedFetch keeps the old data
  //    visible across a reload, and every row of it is 'pending');
  //  - this is a fresh mount holding pending rows and the resume probe hasn't
  //    said whether a scan owns them — entering a collection mid-scan, or
  //    reloading the page during one, paints before that answer arrives.
  //
  // Deliberately not gated on the file list's `loading` instead: that is true
  // of *every* refetch, including the one a manual match triggers, and
  // unmounting the section there discards whatever PMIDs are half-typed into
  // its other rows.
  const settling = uploading != null || running || filesStale || (!scanChecked && anyPending);

  return (
    <div className="source-view">
      {/* The row is always here, because the papers below it start at one
          height in every workspace; the management chrome inside it is
          admin-only, so viewers just see the papers module (and, below, live
          progress of any admin-triggered import). Showing every collection at
          once empties it the same way: adding files, renaming and deleting all
          name a single collection, and there isn't one. */}
      <div className="source-head">
        {/* Left of the actions, and outside the isAdmin gate below only because
            it needs no gate of its own: /auth reports the Pro block to the
            owner alone, so a viewer's stamps are empty and this never renders
            for them. Three states, not four — "local" is the ordinary case, and
            a badge on every unshared collection would mark the majority to
            label the minority. Absence carries it, exactly as ProvenanceBadges
            leaves a locally acquired paper unmarked.

            The two faded ones read alike and are not: `ended` is this
            organisation refusing us, which a new pairing code fixes, and the
            panel in Settings says so at length. Collapsing them would put "not
            the organization this library is paired with now" under the name of
            the organisation it is paired with. */}
        {stamp && (
          <span
            className={stamp.active ? "from-org" : "from-org from-org-faded"}
            title={
              stamp.active
                ? `Papers filed here are copied up to ${stamp.org_name}'s library.`
                : stamp.ended
                  ? `${stamp.org_name} has ended this connection, so nothing filed here reaches them. Papers already sent stay there.`
                  : `Filed for ${stamp.org_name}, which isn't the organization this library is paired with now — nothing here syncs.`
            }
          >
            {stamp.active
              ? `Shared with ${stamp.org_name}`
              : stamp.ended
                ? `Sharing with ${stamp.org_name} ended`
                : `Was shared with ${stamp.org_name}`}
          </span>
        )}
        {isAdmin && collectionId != null && (
          <div className="source-actions">
            {/* One picker, not two. The OS file dialog already selects a whole
                folder's worth in one gesture (Ctrl+A inside it), so a separate
                webkitdirectory input bought nothing but a second button and a
                second way in — and its selection arrives unfiltered, since the
                accept list below doesn't apply to a directory pick. */}
            <button onClick={() => filesInputRef.current?.click()} disabled={uploading != null}>
              <FilePlus size={14} className="inline-icon" aria-hidden /> Add files
            </button>
            <button className="link-btn" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button className="link-btn danger" onClick={() => setConfirmingDelete(true)}>
              Delete collection
            </button>
            <input
              ref={filesInputRef}
              type="file"
              multiple
              accept=".pdf,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleImport(e.target.files);
                e.target.value = ""; // allow re-picking the same selection
              }}
            />
          </div>
        )}
      </div>

      {(error ?? filesError) && (
        <Banner kind="error" message={error ?? filesError!} onDismiss={() => setError(null)} />
      )}
      {notice && <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />}

      {/* The two phases of adding files, drawn as one bar that fills twice.
          Sending the bytes and scanning them are separate jobs with separate
          totals, but from here it is one wait, and the label says which half of
          it you are in. Uploading takes precedence: the previous scan's status
          can still be sitting in state while a new selection goes up. */}
      {uploading ? (
        <div className="import-progress">
          <div className="progress">
            <div
              className="progress-fill"
              style={{ width: `${Math.round((uploading.done / uploading.total) * 100)}%` }}
            />
          </div>
          <div className="progress-label">
            Uploading {uploading.done} / {uploading.total}…
          </div>
        </div>
      ) : (
        running && (
          <div className="import-progress">
            <div className="progress">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="progress-label">
              Scanning {job?.processed ?? 0} / {job?.total ?? 0} ·{" "}
              {job?.matched ?? 0} matched · {job?.unmatched ?? 0} unmatched
              {job?.errors ? ` · ${job.errors} error` : ""}
              {job?.currentFile ? ` · ${job.currentFile}` : ""}
            </div>
          </div>
        )
      )}

      {children}

      {isAdmin && showUnmatched && !settling && unresolved.length > 0 && (
        <UnresolvedFiles files={unresolved} onChanged={onChanged} onError={setError} />
      )}

      <PromptDialog
        open={renaming}
        title="Rename collection"
        placeholder="New name"
        submitLabel="Rename"
        onSubmit={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete collection?"
        message="Its uploaded PDF copies are removed from the app (unless another collection also has them); your original files are untouched."
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

function UnresolvedFiles({
  files,
  onChanged,
  onError,
}: {
  files: CollectionFile[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  // Rows the scan never reached, because it died or was never started over
  // them. Only reachable once nothing is in flight (see `settling`), so their
  // presence here means stranded, not "in progress" — and they need a different
  // sentence, since nothing has yet looked for a PubMed ID on them.
  const queued = files.filter((f) => f.match_status === "pending").length;

  return (
    <section className="unmatched">
      <h3>
        Unmatched files <span className="count">{files.length}</span>
      </h3>
      <p className="hint">
        The scanner couldn't find a PubMed ID on these files' first pages (common for scanned or
        older PDFs). Paste a PMID to match one manually.
        {queued > 0 &&
          ` ${fileCount(queued)} below ${queued === 1 ? "was" : "were"} never scanned — add files again to resume.`}
      </p>
      <ul className="unmatched-list">
        {files.map((f) => (
          <UnmatchedRow key={f.id} file={f} onChanged={onChanged} onError={onError} />
        ))}
      </ul>
    </section>
  );
}

function UnmatchedRow({
  file,
  onChanged,
  onError,
}: {
  file: CollectionFile;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [pmid, setPmid] = useState("");
  const [busy, setBusy] = useState(false);

  async function assign() {
    const value = pmid.trim();
    if (!value) return;
    setBusy(true);
    try {
      await api.setFilePmid(file.id, value);
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteCollectionFile(file.id);
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`unmatched-row status-${file.match_status}`}>
      <div className="unmatched-name">
        {file.file_name}
        {!file.exists && <span className="file-missing">file missing</span>}
        {file.match_status === "pending" && <span className="file-queued">not scanned</span>}
        {file.match_status === "error" && file.match_error && (
          <span className="unmatched-error" title={file.match_error}>
            {file.match_error}
          </span>
        )}
      </div>
      <div className="unmatched-controls">
        <input
          className="pmid-input"
          inputMode="numeric"
          placeholder="PMID"
          value={pmid}
          onChange={(e) => setPmid(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && assign()}
          disabled={busy}
        />
        <button onClick={assign} disabled={busy || !pmid.trim()}>
          Match
        </button>
        <button className="link-btn danger" onClick={remove} disabled={busy}>
          Remove
        </button>
      </div>
    </li>
  );
}
