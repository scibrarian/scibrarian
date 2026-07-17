import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useCachedFetch, type FetchCache } from "../lib/hooks";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import type { CollectionFile, CollectionFilesResponse, ImportStatus } from "../types";

// Files per upload request, so huge folder selections don't become one
// gigantic multipart body (the server also caps files-per-request).
const UPLOAD_BATCH = 20;

// Consecutive failed status polls before we give up on a running import. A
// single blip must not freeze the progress UI, but a truly-dead server
// shouldn't be polled forever either. At the 1s tick this is ~5s of retries.
const MAX_POLL_FAILURES = 5;

// webkitdirectory (folder selection) isn't in React's input typings.
const folderInputProps = { webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>;

// Cache the last file listing per collection, same pattern as papersCache:
// re-entering Library paints from cache instead of refetching. Every mutation
// (upload, import, match, delete) reports through onChanged, which bumps
// reloadToken and thereby invalidates this cache along with the modules'.
const filesCache: FetchCache<CollectionFilesResponse> = new Map();

// The collection management shell: upload/import/rename/delete chrome and the
// unmatched-files section, wrapped around whichever analysis module (table or
// timeline) is active — those render as `children` and fetch their own paper
// rows from /api/papers.
export function CollectionView({
  collectionId,
  isAdmin,
  reloadToken,
  onChanged,
  onDeleted,
  children,
}: {
  collectionId: number;
  isAdmin: boolean;
  reloadToken: number;
  onChanged: () => void;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // The file listing is fully derived: mutations never set it directly, they
  // call onChanged() and the token bump refetches it here.
  const { data: filesData, error: filesError } = useCachedFetch(
    filesCache,
    `files:${collectionId}`,
    reloadToken,
    () => api.getCollectionFiles(collectionId)
  );
  const files = filesData?.files ?? [];

  // Poll import status while a job runs; refresh files + everything else
  // (via onChanged) when it finishes.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    // Scoped to this polling session (reset each startPolling). inFlight stops
    // slow responses from stacking requests — without it, several polls can be
    // outstanding at once and each fires onChanged() when the job completes.
    let inFlight = false;
    let failures = 0;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await api.getImportStatus(collectionId);
        failures = 0;
        setImportStatus(s);
        if (s.state === "done" || s.state === "error" || s.state === "idle") {
          stopPolling();
          onChanged();
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
  }, [collectionId, onChanged, stopPolling]);

  // Resume the progress UI if an import is already running for this collection.
  useEffect(() => {
    api
      .getImportStatus(collectionId)
      .then((s) => {
        if (s.state === "running") {
          setImportStatus(s);
          startPolling();
        }
      })
      .catch(() => {});
    return stopPolling;
  }, [collectionId, startPolling, stopPolling]);

  // Upload the picked PDFs in batches, then kick off the scan/match job.
  async function handleImport(list: FileList | null) {
    const pdfs = Array.from(list ?? []).filter((f) => /\.pdf$/i.test(f.name));
    setError(null);
    setNotice(null);
    if (pdfs.length === 0) {
      setNotice("No PDFs found in the selection.");
      return;
    }
    try {
      let added = 0;
      let skipped = 0;
      for (let i = 0; i < pdfs.length; i += UPLOAD_BATCH) {
        const batch = pdfs.slice(i, i + UPLOAD_BATCH);
        setNotice(`Uploading ${i + batch.length} / ${pdfs.length}…`);
        const res = await api.uploadFiles(collectionId, batch);
        added += res.added;
        skipped += res.skipped;
      }
      setNotice(
        added > 0
          ? `Added ${added} file${added === 1 ? "" : "s"}; scanning for PubMed IDs…`
          : skipped > 0
            ? "Those files are already in this collection."
            : "No PDFs found in the selection."
      );
      await api.startImport(collectionId);
      const s = await api.getImportStatus(collectionId);
      setImportStatus(s);
      if (s.state === "running") startPolling();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function rename(next: string) {
    setRenaming(false);
    try {
      await api.renameCollection(collectionId, next);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    setConfirmingDelete(false);
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

  return (
    <div className="collection-view">
      {/* Management chrome is admin-only; viewers just see the papers module
          (and, below, live progress of any admin-triggered import). */}
      {isAdmin && (
        <div className="collection-head">
          <div className="collection-actions">
            <button onClick={() => filesInputRef.current?.click()}>+ Add files</button>
            <button onClick={() => folderInputRef.current?.click()}>+ Add folder</button>
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
            <input
              ref={folderInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleImport(e.target.files);
                e.target.value = "";
              }}
              {...folderInputProps}
            />
          </div>
        </div>
      )}

      {(error ?? filesError) && <div className="banner error">{error ?? filesError}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {running && (
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
      )}

      {children}

      {isAdmin && unresolved.length > 0 && (
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
  return (
    <section className="unmatched">
      <h3>
        Unmatched files <span className="count">{files.length}</span>
      </h3>
      <p className="hint">
        The scanner couldn't find a PubMed ID on these files' first pages (common for scanned or
        older PDFs). Paste a PMID to match one manually.
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
