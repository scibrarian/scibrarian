import { useId, useState } from "react";
import { api } from "../api";
import { useHeldWhile } from "../lib/hooks";
import { errorMessage } from "../lib/format";
import type { BookmarkImport, LinkedPaper } from "../types";
import { Banner } from "./Banner";
import { ConfirmDialog, ModalShell } from "./Dialogs";

// The entries a folder's reference-file imports left that aren't bookmarks yet,
// opened from the count in the folder's summary line — the folder's version of
// a collection's unmatched files (see UnresolvedFiles in CollectionView), and
// split the same way: entries no lookup reached, which need one, and entries
// PubMed was asked about and didn't find, which need a PMID from the reader.

// Why an entry wasn't found, in the reader's terms.
function reasonText(entry: BookmarkImport): string {
  switch (entry.reason) {
    case "no-identifier":
      return "The file gives no DOI or PMID for this one.";
    case "ambiguous-doi":
      return `PubMed files DOI ${entry.doi} under more than one record.`;
    case "not-in-pubmed":
      // An entry with both was looked up by each: its DOI when its PMID failed.
      if (entry.pmid && entry.doi) return `PubMed has no record of PMID ${entry.pmid} or DOI ${entry.doi}.`;
      return entry.pmid
        ? `PubMed has no record of PMID ${entry.pmid}.`
        : `PubMed has no record of DOI ${entry.doi}.`;
    default:
      return "";
  }
}

// PubMed's own search for the entry's title, which is usually one click from
// the record: PubMed recognises a pasted title and opens the paper it names.
function pubmedSearch(entry: BookmarkImport): string {
  return `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(entry.title)}`;
}

export function ImportedEntries({
  open,
  entries,
  error,
  onClose,
  onLookUp,
  onChanged,
  onError,
}: {
  open: boolean;
  // The folder's whole list, held by identity through the dialog's exit, as
  // UnresolvedFiles holds its files.
  entries: BookmarkImport[];
  error: string | null;
  onClose: () => void;
  // "Look them up": a lookup over the entries none has reached yet.
  onLookUp: () => Promise<void>;
  // An entry was saved or removed. `saved` when one became a bookmark, which
  // changes the folder's papers as well as this list.
  onChanged: (saved: boolean) => void;
  onError: (msg: string | null) => void;
}) {
  const [lookingUp, setLookingUp] = useState(false);
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);
  const pendingId = useId();
  const unmatchedId = useId();
  const shown = useHeldWhile(open, entries);
  const pending = shown.filter((e) => e.status === "pending");
  const unmatched = shown.filter((e) => e.status === "unmatched");

  async function lookUp() {
    setLookingUp(true);
    try {
      await onLookUp();
    } finally {
      setLookingUp(false);
    }
  }

  async function removeAll() {
    setConfirmingRemoveAll(false);
    const folderId = unmatched[0]?.folder_id;
    if (folderId == null) return;
    try {
      await api.removeUnmatchedImports(folderId);
      onChanged(false);
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  const rows = (list: BookmarkImport[]) => (
    <ul className="unmatched-list">
      {list.map((entry) => (
        <EntryRow key={entry.id} entry={entry} onChanged={onChanged} onError={onError} />
      ))}
    </ul>
  );

  return (
    <ModalShell open={open} onClose={onClose} title="Unmatched references" wide>
      <Banner kind="error" message={error} onDismiss={() => onError(null)} />
      <div className="unmatched-groups">
        {pending.length > 0 && (
          <section className="unmatched" aria-labelledby={pendingId}>
            <div className="unmatched-head">
              <h3 id={pendingId}>
                Not looked up <span className="count">{pending.length}</span>
              </h3>
              <button onClick={lookUp} disabled={lookingUp}>
                Look them up
              </button>
            </div>
            <p className="hint">The import stopped before reaching these.</p>
            {rows(pending)}
          </section>
        )}
        {unmatched.length > 0 && (
          <section className="unmatched" aria-labelledby={unmatchedId}>
            <div className="unmatched-head">
              <h3 id={unmatchedId}>
                Not found on PubMed <span className="count">{unmatched.length}</span>
              </h3>
              <button className="link-btn danger" onClick={() => setConfirmingRemoveAll(true)}>
                Remove all
              </button>
            </div>
            <p className="hint">
              Search PubMed for each one and paste its PMID to save it to this folder, or remove it.
            </p>
            {rows(unmatched)}
          </section>
        )}
      </div>
      <ConfirmDialog
        open={confirmingRemoveAll}
        title={`Remove ${unmatched.length} unmatched ${unmatched.length === 1 ? "reference" : "references"}?`}
        confirmLabel="Remove"
        danger
        onConfirm={removeAll}
        onCancel={() => setConfirmingRemoveAll(false)}
      />
    </ModalShell>
  );
}

// One entry: what the file said about it, and the PMID box. A PMID is looked
// up before it is saved, and the paper it names is shown beside the entry for
// the reader to compare — a digit lost in copying names a different paper that
// really exists, and the number alone gives no sign of it.
function EntryRow({
  entry,
  onChanged,
  onError,
}: {
  entry: BookmarkImport;
  onChanged: (saved: boolean) => void;
  onError: (msg: string | null) => void;
}) {
  const [pmid, setPmid] = useState("");
  const [found, setFound] = useState<LinkedPaper | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await work();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const find = () =>
    run(async () => {
      const value = pmid.trim();
      if (value) setFound(await api.lookUpImportPmid(entry.id, value));
    });

  const save = () =>
    run(async () => {
      if (!found) return;
      await api.setImportPmid(entry.id, found.pmid);
      onChanged(true);
    });

  const remove = () =>
    run(async () => {
      await api.removeImport(entry.id);
      onChanged(false);
    });

  const meta = [entry.authors, entry.journal, entry.year].filter(Boolean).join(" · ");
  const reason = reasonText(entry);
  const where = found ? [found.journal_name, found.pub_date_display].filter(Boolean).join(", ") : "";

  return (
    <li className="unmatched-row import-row">
      <div className="import-entry">
        <div className="import-title">{entry.title || "Untitled"}</div>
        {meta && <div className="import-meta">{meta}</div>}
        {entry.status === "unmatched" && reason && <div className="import-reason">{reason}</div>}
        {found && (
          <div className="import-found">
            PMID {found.pmid} is <strong>{found.title}</strong>
            {where && ` — ${where}`}
          </div>
        )}
      </div>
      <div className="unmatched-controls">
        {found ? (
          <>
            <button onClick={save} disabled={busy} autoFocus>
              Save
            </button>
            <button className="link-btn" onClick={() => setFound(null)} disabled={busy}>
              Not this one
            </button>
          </>
        ) : (
          <>
            {entry.title && (
              <a className="import-search" href={pubmedSearch(entry)} target="_blank" rel="noreferrer">
                Search PubMed
              </a>
            )}
            <input
              className="pmid-input"
              inputMode="numeric"
              placeholder="PMID"
              aria-label={`PMID for ${entry.title || "this reference"}`}
              value={pmid}
              onChange={(e) => setPmid(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && find()}
              disabled={busy}
            />
            <button onClick={find} disabled={busy || !pmid.trim()}>
              Find
            </button>
            <button className="link-btn danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}
