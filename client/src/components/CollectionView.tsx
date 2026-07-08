import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { api } from "../api";
import { errorMessage, formatAuthors } from "../lib/format";
import type { CollectionFile, CollectionPaper, ImportStatus } from "../types";
import { PapersColgroup, PapersTableSkeleton } from "./Skeleton";

type SortKey = "title" | "authors" | "journal" | "year" | "citations";
type SortDir = "asc" | "desc";

// Files per upload request, so huge folder selections don't become one
// gigantic multipart body (the server also caps files-per-request).
const UPLOAD_BATCH = 20;

// webkitdirectory (folder selection) isn't in React's input typings.
const folderInputProps = { webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>;

// Cache the last successful fetch per collection. Remounting the view — e.g.
// clicking back into My Papers — then paints from cache instead of refetching.
// Unlike Timeline's reloadToken, this data changes through the component's own
// actions, which all reload via loadPapers(): every successful fetch writes
// through here, and a running import drops the entry (the server-side job is
// mutating the collection), so a stale list is never served.
type CachedCollection = { papers: CollectionPaper[]; files: CollectionFile[] };
const collectionCache = new Map<number, CachedCollection>();

export function CollectionView({
  collectionId,
  onChanged,
  onDeleted,
}: {
  collectionId: number;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  // Seed from cache so returning to a collection paints instantly.
  const [papers, setPapers] = useState<CollectionPaper[]>(
    () => collectionCache.get(collectionId)?.papers ?? []
  );
  const [files, setFiles] = useState<CollectionFile[]>(
    () => collectionCache.get(collectionId)?.files ?? []
  );
  const [loading, setLoading] = useState(() => !collectionCache.has(collectionId));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("year");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const loadPapers = useCallback(() => {
    setLoading(true);
    return api
      .getCollectionPapers(collectionId)
      .then((res) => {
        collectionCache.set(collectionId, { papers: res.papers, files: res.files });
        setPapers(res.papers);
        setFiles(res.files);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [collectionId]);

  useEffect(() => {
    // Cache hit: state was seeded above, so skip the redundant refetch.
    if (collectionCache.has(collectionId)) return;
    loadPapers();
  }, [collectionId, loadPapers]);

  // Poll import status while a job runs; refresh papers + tab counts on finish.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    // The import job is mutating this collection server-side; drop the cached
    // entry so leaving and returning mid-import refetches rather than serving
    // the pre-import list. loadPapers() re-caches when the job finishes.
    collectionCache.delete(collectionId);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getImportStatus(collectionId);
        setImportStatus(s);
        if (s.state === "done" || s.state === "error" || s.state === "idle") {
          stopPolling();
          await loadPapers();
          onChanged();
        }
      } catch {
        stopPolling();
      }
    }, 1000);
  }, [collectionId, loadPapers, onChanged, stopPolling]);

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
      else await loadPapers();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function rename() {
    const next = window.prompt("Rename collection:");
    if (!next || !next.trim()) return;
    try {
      await api.renameCollection(collectionId, next.trim());
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    if (
      !window.confirm(
        "Delete this collection? Its uploaded PDF copies are removed from the app (unless another collection also has them); your original files are untouched."
      )
    ) {
      return;
    }
    try {
      await api.deleteCollection(collectionId);
      collectionCache.delete(collectionId);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function openPaper(pmid: string) {
    const file = files.find((f) => f.pmid === pmid && f.match_status === "matched");
    if (!file) return;
    window.open(api.fileContentUrl(file.id), "_blank", "noopener");
  }

  // pmid -> its first matched file, for open-on-click and the missing badge.
  const fileByPmid = useMemo(() => {
    const m = new Map<string, CollectionFile>();
    for (const f of files) if (f.pmid && f.match_status === "matched" && !m.has(f.pmid)) m.set(f.pmid, f);
    return m;
  }, [files]);

  const unresolved = files.filter(
    (f) => f.match_status === "unmatched" || f.match_status === "error" || f.match_status === "pending"
  );

  const sortedPapers = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (p: CollectionPaper) => {
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
    return [...papers].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [papers, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "title" || key === "authors" || key === "journal" ? "asc" : "desc");
    }
  }

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const running = importStatus?.state === "running";
  const progressPct =
    importStatus && importStatus.total
      ? Math.round(((importStatus.processed ?? 0) / importStatus.total) * 100)
      : 0;

  return (
    <div className="collection-view">
      <div className="collection-head">
        <div className="collection-actions">
          <button onClick={() => filesInputRef.current?.click()}>+ Add files</button>
          <button onClick={() => folderInputRef.current?.click()}>+ Add folder</button>
          <button className="link-btn" onClick={rename}>
            Rename
          </button>
          <button className="link-btn danger" onClick={remove}>
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

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {running && (
        <div className="import-progress">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="progress-label">
            Scanning {importStatus?.processed ?? 0} / {importStatus?.total ?? 0} ·{" "}
            {importStatus?.matched ?? 0} matched · {importStatus?.unmatched ?? 0} unmatched
            {importStatus?.errors ? ` · ${importStatus.errors} error` : ""}
            {importStatus?.currentFile ? ` · ${importStatus.currentFile}` : ""}
          </div>
        </div>
      )}

      {loading && papers.length === 0 ? (
        <PapersTableSkeleton />
      ) : papers.length === 0 && unresolved.length === 0 ? (
        <div className="empty">
          No papers yet. Click <strong>+ Add files</strong> or <strong>+ Add folder</strong> to
          upload PDFs. The app scans each PDF for its PubMed ID and pulls in the title, authors,
          journal, year, and citation count.
        </div>
      ) : (
        <>
          {papers.length > 0 && (
            <div className="papers-table-wrap">
              <table className="papers-table">
                <PapersColgroup />
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => toggleSort("title")}>
                      Title{arrow("title")}
                    </th>
                    <th className="sortable" onClick={() => toggleSort("authors")}>
                      Authors{arrow("authors")}
                    </th>
                    <th className="sortable" onClick={() => toggleSort("journal")}>
                      Journal{arrow("journal")}
                    </th>
                    <th className="sortable num" onClick={() => toggleSort("year")}>
                      Year{arrow("year")}
                    </th>
                    <th className="sortable num" onClick={() => toggleSort("citations")}>
                      Citations{arrow("citations")}
                    </th>
                    <th>Links</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPapers.map((p) => {
                    const file = fileByPmid.get(p.pmid);
                    const missing = file && !file.exists;
                    return (
                      <tr key={p.pmid}>
                        <td className="paper-title-cell">
                          <button
                            className="paper-open"
                            onClick={() => openPaper(p.pmid)}
                            title={file ? `Open ${file.file_name}` : "Open PDF"}
                          >
                            {p.title || "(untitled)"}
                          </button>
                          {missing && (
                            <span className="file-missing" title="The stored PDF is missing">
                              file missing
                            </span>
                          )}
                        </td>
                        <td className="authors-cell">{formatAuthors(p.authors, 3)}</td>
                        <td>{p.journal_name}</td>
                        <td className="num">{year(p.pub_date)}</td>
                        <td className="num">{p.citation_count}</td>
                        <td className="links-cell">
                          <a href={p.url} target="_blank" rel="noreferrer">
                            PubMed ↗
                          </a>
                          {p.doi && (
                            <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
                              DOI ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {unresolved.length > 0 && (
            <UnresolvedFiles
              files={unresolved}
              onChanged={async () => {
                await loadPapers();
                onChanged();
              }}
              onError={setError}
            />
          )}
        </>
      )}
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

function year(pubDate: string): string {
  return /^\d{4}/.test(pubDate) ? pubDate.slice(0, 4) : "—";
}
