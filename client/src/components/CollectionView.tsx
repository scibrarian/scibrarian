import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CollectionFile, CollectionPaper, ImportStatus } from "../types";
import { FolderPicker } from "./FolderPicker";
import { PapersColgroup, PapersTableSkeleton } from "./Skeleton";

type SortKey = "title" | "authors" | "journal" | "year" | "citations";
type SortDir = "asc" | "desc";

export function CollectionView({
  collectionId,
  onChanged,
  onDeleted,
}: {
  collectionId: number;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [papers, setPapers] = useState<CollectionPaper[]>([]);
  const [files, setFiles] = useState<CollectionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("year");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPapers = useCallback(() => {
    setLoading(true);
    return api
      .getCollectionPapers(collectionId)
      .then((res) => {
        setPapers(res.papers);
        setFiles(res.files);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [collectionId]);

  useEffect(() => {
    loadPapers();
  }, [loadPapers]);

  // Poll import status while a job runs; refresh papers + tab counts on finish.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
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

  async function handleImport(paths: string[], recursive: boolean) {
    setPicking(false);
    setError(null);
    setNotice(null);
    try {
      const res = await api.importIntoCollection(collectionId, paths, recursive);
      setNotice(
        res.added > 0
          ? `Added ${res.added} file${res.added === 1 ? "" : "s"}; scanning for PubMed IDs…`
          : res.skipped > 0
            ? "Those files are already in this collection."
            : "No PDFs found in the selection."
      );
      const s = await api.getImportStatus(collectionId);
      setImportStatus(s);
      if (s.state === "running") startPolling();
      else await loadPapers();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function rename() {
    const next = window.prompt("Rename collection:");
    if (!next || !next.trim()) return;
    try {
      await api.renameCollection(collectionId, next.trim());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove() {
    if (
      !window.confirm(
        "Delete this collection? The imported PDFs stay on your disk; only the collection and its list are removed."
      )
    ) {
      return;
    }
    try {
      await api.deleteCollection(collectionId);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function openPaper(pmid: string) {
    const file = files.find((f) => f.pmid === pmid && f.match_status === "matched");
    if (!file) return;
    try {
      await api.openFile(file.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
          <button onClick={() => setPicking(true)}>+ Add folder / files</button>
          <button className="link-btn" onClick={rename}>
            Rename
          </button>
          <button className="link-btn danger" onClick={remove}>
            Delete collection
          </button>
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
          No papers yet. Click <strong>+ Add folder / files</strong> to import PDFs. The app scans
          each PDF for its PubMed ID and pulls in the title, authors, journal, year, and citation
          count.
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
                            <span className="file-missing" title="The PDF has moved or been deleted">
                              file missing
                            </span>
                          )}
                        </td>
                        <td className="authors-cell">{formatAuthors(p.authors)}</td>
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

      {picking && (
        <FolderPicker onClose={() => setPicking(false)} onConfirm={handleImport} />
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
      onError(e instanceof Error ? e.message : String(e));
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
      onError(e instanceof Error ? e.message : String(e));
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

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "—";
  if (authors.length <= 3) return authors.join(", ");
  return authors.slice(0, 3).join(", ") + ", et al.";
}

function year(pubDate: string): string {
  return /^\d{4}/.test(pubDate) ? pubDate.slice(0, 4) : "—";
}
