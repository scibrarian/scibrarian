import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FilePlus } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useCachedFetch, useHeldWhile, type FetchCache } from "../lib/hooks";
import { useImportJob, type ImportJobs } from "../lib/import-jobs";
import { Banner } from "./Banner";
import { ConfirmDialog, ModalShell, PromptDialog, STORED_COPIES_NOTE } from "./Dialogs";
import type {
  CollectionFile,
  CollectionFilesResponse,
  ImportStatus,
  ProCollectionStamp,
} from "../types";
import { MAX_NAME_CHARS, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "../../../shared/limits";

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

// "3 files" / "1 file".
function fileCount(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

// A file with no paper behind it: the scan found none, couldn't read it, or
// never reached it.
function isUnresolved(f: CollectionFile): boolean {
  return f.match_status === "unmatched" || f.match_status === "error" || f.match_status === "pending";
}

// Cache the last file listing per collection, same pattern as papersCache:
// re-entering Library paints from cache instead of refetching. Every mutation
// (upload, import, match, delete) reports through onChanged, which bumps this
// collection's reload token and thereby invalidates this cache along with the
// modules'.
const filesCache: FetchCache<CollectionFilesResponse> = new Map();

// The collection management shell: upload/import/rename/delete chrome and the
// unmatched-files dialog, wrapped around whichever analysis module (table or
// timeline) is active — those render as `children` and fetch their own paper
// rows from /api/papers.
export function CollectionView({
  collectionId,
  isAdmin,
  summary,
  stamp,
  reloadToken,
  importJobs,
  onChanged,
  onDeleted,
  children,
}: {
  // Null when the Library is showing every collection at once. There is no
  // collection to add files to, rename, delete, or list unmatched files for, so
  // all of that chrome is absent — the same shape a viewer already sees. The
  // component is still rendered rather than skipped, because `source-head`
  // below is a deliberate spacer: without it the papers module starts at a
  // different height here than in every other section and the list jumps as
  // you switch.
  collectionId: number | null;
  isAdmin: boolean;
  /**
   * The collection counted out — or, for every collection at once, the
   * collections — for the row's left half. See App's sourceSummary.
   */
  summary: string | null;
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
  // App's, so a scan goes on being followed after this view has gone.
  importJobs: ImportJobs;
  onChanged: () => void;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const watched = useImportJob(importJobs, collectionId);
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
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  // The unmatched-files dialog, opened from the count in the summary line, and
  // what its rows last failed with, shown inside it where the page's own
  // banner would be behind it.
  const [showingUnmatched, setShowingUnmatched] = useState(false);
  const [unmatchedError, setUnmatchedError] = useState<string | null>(null);

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

  // What the last selection left behind — files ignored for not being PDFs,
  // files skipped for being too large. Reported once the selection has run its
  // course: when its scan finishes, or by the upload itself when that added
  // nothing or failed. Kept here because the scan can't restate them: the job
  // only ever saw the files that made it in.
  const selectionNotesRef = useRef("");

  // The one place a settled job becomes a message. Two things can be the first
  // to see a job finish — App's poll, seen below as the status leaving
  // 'running', and the status read right after starting one that was over
  // before the first tick — and both have to come here, or a failed scan goes
  // unreported and its pre-scan rows are shown as its answer.
  const reportSettled = useCallback((s: ImportStatus) => {
    // The caller refreshes the file list next, and until that lands the rows on
    // screen are the pre-scan ones — all 'pending', none of them yet an answer.
    setFilesStale(true);
    const notes = selectionNotesRef.current;
    if (s.state === "done") {
      // Only for what nothing else on screen mentions: the files the selection
      // left behind, which never reached the scan. What the scan did shows for
      // itself — the papers it matched in the table, the files it couldn't in
      // the summary line's counts (see unmatchedCount), which stay true after a
      // reload or a trip to another tab where a banner about the scan would
      // not. A scan that only matched papers already here changes neither, and
      // says nothing: there is nothing new to point at.
      if (notes) setNotice(notes.trim());
    } else if (s.state === "error") setError((s.error ?? "The scan failed.") + notes);
  }, []);

  // A scan this view was watching has ended. App polls it and refreshes the
  // collection when it does (see lib/import-jobs), so what is left here is
  // reportSettled's part: the selection's notes or the scan's error, and
  // holding the pre-scan rows back until the fresh list lands.
  //
  // Before paint, not after: the render that first sees the scan over still
  // has those rows, every one 'pending', and with nothing running any more a
  // passive effect would paint them for a frame as files never scanned.
  const lastWatched = useRef(watched);
  useLayoutEffect(() => {
    const was = lastWatched.current;
    lastWatched.current = watched;
    if (was?.state !== "running" || !watched || watched.state === "running") return;
    if (watched.state === "lost") {
      setError("Lost contact with the import job. Reload to check its status.");
    } else reportSettled(watched);
  }, [watched, reportSettled]);

  // Resume the progress UI if an import is already running for this collection.
  //
  // Also the answer to "is anything scanning these rows?", which is why
  // scanChecked is set either way. Entering a collection mid-scan paints the
  // cached file list — every row 'pending' — before this comes back, and a
  // pending row means nothing until it is known whether something is working
  // on it. Asked on every entry rather than taken from what App last heard,
  // which may predate a scan started since.
  useEffect(() => {
    if (collectionId == null) return;
    void importJobs.check(collectionId).then(() => setScanChecked(true));
  }, [collectionId, importJobs]);

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
      importJobs.follow(collectionId, started);
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
    // as it happened and the scan's outcome lands seconds later, as papers in
    // the table and counts in the summary line, so an "Added N files" banner in
    // between is a message whose whole life is spent being superseded. Only a
    // selection that added nothing needs a banner, because
    // for that one the bar and the scan both say nothing.
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

  // The dialog's "Scan them": a scan over the files an earlier one stopped
  // before reaching. The two requests handleImport makes after an upload,
  // which is all re-adding files ever did for these — a scan takes every file
  // still waiting, and only those.
  async function scanUnscanned() {
    if (collectionId == null) return;
    setUnmatchedError(null);
    // An earlier upload's notes belong to that upload, not to this scan.
    selectionNotesRef.current = "";
    try {
      await api.startImport(collectionId);
      const started = await api.getImportStatus(collectionId);
      importJobs.follow(collectionId, started);
      // Over before it could be followed, so nothing else will report it or
      // refresh what it changed.
      if (started.state !== "running") {
        reportSettled(started);
        onChanged();
      }
    } catch (e) {
      setUnmatchedError(errorMessage(e));
    }
  }

  const unresolved = files.filter(isUnresolved);

  // Narrow away the "idle" sentinel so the live-job fields (total, processed, …)
  // are available; when idle there's no progress to show anyway, nor once the
  // poll has lost contact.
  const job = watched && watched.state !== "idle" && watched.state !== "lost" ? watched : null;
  const running = job?.state === "running";
  const progressPct = job && job.total ? Math.round((job.processed / job.total) * 100) : 0;

  // Rows nothing has decided about yet.
  const anyPending = files.some((f) => f.match_status === "pending");

  // Whether the file list can be trusted to say what it says. Until it can, the
  // unmatched files are withheld entirely and the progress bar stands in for
  // them — so no file is ever listed as having no PubMed ID before the scanner
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
  // of *every* refetch, including the one a manual match triggers, and closing
  // the dialog there discards whatever PMIDs are half-typed into its other rows.
  const settling = uploading != null || running || filesStale || (!scanChecked && anyPending);

  // Files the scan couldn't place, counted onto the end of the summary line.
  // That line is the one part of the page always at the top, so it is where
  // they get noticed, and a few words there don't push the papers down for as
  // long as the files stay unmatched, which a list above the table would. Held
  // back by `settling`, so it never counts a file a running scan has yet to
  // reach; admin-only, because nobody else can match one.
  //
  // Files no scan reached at all are counted apart, as not scanned: the app
  // closed during the scan, or PubMed failed part way through it. Counted as
  // unmatched, they read as files the scanner had opened and failed on.
  //
  // Both open the files in a dialog rather than linking down to a section under
  // the papers. A long collection renders its papers a page at a time as the
  // reader scrolls, so a section below them moved away from a scroll aimed at
  // it, and the graph has no room under it for one at all.
  const counted = isAdmin && !settling;
  const unscannedCount = counted ? unresolved.filter((f) => f.match_status === "pending").length : 0;
  const unmatchedCount = counted ? unresolved.length - unscannedCount : 0;

  // The dialog closes itself once nothing is left in it — the last file
  // matched or removed, or a scan started over the rest — and stays closed
  // when more turn up later.
  const anyUnresolved = unmatchedCount + unscannedCount > 0;
  if (showingUnmatched && !anyUnresolved) setShowingUnmatched(false);

  function showUnmatched() {
    setUnmatchedError(null);
    setShowingUnmatched(true);
  }

  return (
    <div className="source-view">
      {/* The row is always here, because the papers below it start at one
          height in every section; the management chrome inside it is
          admin-only, so viewers just see the papers module (and, below, live
          progress of any admin-triggered import). Showing every collection at
          once empties it the same way: adding files, renaming and deleting all
          name a single collection, and there isn't one. */}
      <div className="source-head">
        {/* The row's left half: the summary, then the stamp. One box for the
            two (see .source-meta) so the slack between them and the actions
            is claimed once.

            The stamp sits outside the isAdmin gate below only because it
            needs no gate of its own: /auth reports the Pro block to the owner
            alone, so a viewer's stamps are empty and it never renders for
            them. Three states, not four — "local" is the ordinary case, and a
            badge on every unshared collection would mark the majority to
            label the minority. Absence carries it, exactly as ProvenanceBadges
            leaves a locally acquired paper unmarked.

            The two faded ones read alike and are not: `ended` is this
            organisation refusing us, which a new pairing code fixes, and the
            panel in Settings says so at length. Collapsing them would put "not
            the organization this library is paired with now" under the name of
            the organisation it is paired with. */}
        {(summary || stamp) && (
          <div className="source-meta">
            {summary && (
              <span className="source-summary">
                {summary}
                {unmatchedCount > 0 && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={showUnmatched}>
                      {unmatchedCount} unmatched
                    </button>
                  </>
                )}
                {unscannedCount > 0 && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={showUnmatched}>
                      {unscannedCount} not scanned
                    </button>
                  </>
                )}
              </span>
            )}
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
          </div>
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

      <Banner kind="error" message={error ?? filesError} onDismiss={() => setError(null)} />
      <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />

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

      {isAdmin && (
        <UnresolvedFiles
          open={showingUnmatched && anyUnresolved}
          files={files}
          error={unmatchedError}
          onClose={() => setShowingUnmatched(false)}
          onScan={scanUnscanned}
          onChanged={onChanged}
          onError={setUnmatchedError}
        />
      )}

      <PromptDialog
        open={renaming}
        title="Rename collection"
        placeholder="New name"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Rename"
        onSubmit={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete collection?"
        message={`Everything filed in it is removed. ${STORED_COPIES_NOTE}`}
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

function UnresolvedFiles({
  open,
  files,
  error,
  onClose,
  onScan,
  onChanged,
  onError,
}: {
  open: boolean;
  // The collection's whole listing, held by identity while the dialog closes
  // (see below), which a list filtered for it on every render can't be.
  files: CollectionFile[];
  error: string | null;
  onClose: () => void;
  onScan: () => Promise<void>;
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const unscannedId = useId();
  const unmatchedId = useId();
  // The rows it was showing, kept through its exit. It closes itself when the
  // last one is matched, and read live it would spend its fade as an empty list.
  const unresolved = useHeldWhile(open, files).filter(isUnresolved);
  // In two groups, because they need different things. Rows no scan reached
  // need a scan, and nothing has yet looked for a PubMed ID on them. Only
  // reachable once nothing is in flight (see `settling`), so their presence
  // here means stranded, not "in progress". The rest were looked at and need a
  // PMID from the reader: scanning the same bytes again finds the same nothing.
  const unscanned = unresolved.filter((f) => f.match_status === "pending");
  const unmatched = unresolved.filter((f) => f.match_status !== "pending");

  async function scan() {
    setScanning(true);
    try {
      await onScan();
    } finally {
      setScanning(false);
    }
  }

  const rows = (list: CollectionFile[]) => (
    <ul className="unmatched-list">
      {list.map((f) => (
        <UnmatchedRow key={f.id} file={f} onChanged={onChanged} onError={onError} />
      ))}
    </ul>
  );

  return (
    <ModalShell open={open} onClose={onClose} title="Unmatched files" wide>
      <Banner kind="error" message={error} onDismiss={() => onError(null)} />
      <div className="unmatched-groups">
        {unscanned.length > 0 && (
          <section className="unmatched" aria-labelledby={unscannedId}>
            <div className="unmatched-head">
              <h3 id={unscannedId}>
                Not scanned <span className="count">{unscanned.length}</span>
              </h3>
              {/* Disabled for the two requests that start it, which a second
                  click would only meet with "already running". */}
              <button onClick={scan} disabled={scanning}>
                Scan them
              </button>
            </div>
            <p className="hint">The scan stopped before reaching these.</p>
            {rows(unscanned)}
          </section>
        )}
        {unmatched.length > 0 && (
          <section className="unmatched" aria-labelledby={unmatchedId}>
            <h3 id={unmatchedId}>
              No PubMed ID found <span className="count">{unmatched.length}</span>
            </h3>
            <p className="hint">
              The scanner couldn't find a PubMed ID on these files' first pages (common for scanned
              or older PDFs). Paste a PMID to match one manually.
            </p>
            {rows(unmatched)}
          </section>
        )}
      </div>
    </ModalShell>
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
