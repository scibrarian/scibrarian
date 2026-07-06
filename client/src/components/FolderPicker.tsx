import { useEffect, useState } from "react";
import { api } from "../api";
import type { FsListing, FsRootsResponse } from "../types";

// Native-like folder dialog backed by the server's /api/fs endpoints. The user
// either adds a whole folder (optionally recursively) or ticks individual PDFs.
export function FolderPicker({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (paths: string[], recursive: boolean) => void;
}) {
  const [roots, setRoots] = useState<FsRootsResponse | null>(null);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recursive, setRecursive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .fsRoots()
      .then((r) => {
        setRoots(r);
        // Start in the home folder for convenience.
        navigate(r.home);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigate(path: string) {
    setLoading(true);
    setError(null);
    api
      .fsList(path)
      .then((l) => {
        setListing(l);
        setCwd(l.path);
        setSelected(new Set());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  function toggleFile(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function confirmFolder() {
    if (cwd) onConfirm([cwd], recursive);
  }

  function confirmFiles() {
    if (selected.size > 0) onConfirm([...selected], false);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3 className="picker-title">Add PDFs to collection</h3>

        <div className="picker-places">
          {roots?.shortcuts.map((s) => (
            <button key={s.path} className="place-btn" onClick={() => navigate(s.path)}>
              {s.label}
            </button>
          ))}
          {roots?.roots.map((r) => (
            <button key={r.path} className="place-btn drive" onClick={() => navigate(r.path)}>
              {r.label}
            </button>
          ))}
        </div>

        <div className="picker-path">
          {listing?.parent != null ? (
            <button className="link-btn" onClick={() => navigate(listing.parent!)}>
              ↑ Up
            </button>
          ) : (
            <span className="link-btn disabled">↑ Up</span>
          )}
          <span className="picker-cwd">{cwd ?? "…"}</span>
        </div>

        {error && <div className="banner error">{error}</div>}

        <div className="picker-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : (
            <>
              {listing && listing.dirs.length === 0 && listing.files.length === 0 && (
                <div className="empty">This folder has no subfolders or PDFs.</div>
              )}
              <ul className="picker-list">
                {listing?.dirs.map((d) => (
                  <li key={d.path} className="picker-dir">
                    <button onClick={() => navigate(d.path)}>
                      <span className="picker-icon">📁</span>
                      {d.name}
                    </button>
                  </li>
                ))}
                {listing?.files.map((f) => (
                  <li key={f.path} className="picker-file">
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        onChange={() => toggleFile(f.path)}
                      />
                      <span className="picker-icon">📄</span>
                      {f.name}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="picker-footer">
          <label className="picker-recursive">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            Include subfolders
          </label>
          <div className="picker-buttons">
            {selected.size > 0 && (
              <button onClick={confirmFiles}>
                Add {selected.size} selected file{selected.size === 1 ? "" : "s"}
              </button>
            )}
            <button className="primary" onClick={confirmFolder} disabled={!cwd}>
              Add this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
