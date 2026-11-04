import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, FileInput, Link as LinkIcon, Plus } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useImportJob, type ImportJobs } from "../lib/import-jobs";
import type { BookmarkImport, FolderImportResponse } from "../types";
import { AddLinks } from "./AddLinks";
import { Banner } from "./Banner";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { ImportedEntries } from "./FolderImports";
import { MAX_IMPORT_BYTES, MAX_NAME_CHARS } from "../../../shared/limits";

const MAX_IMPORT_MB = Math.round(MAX_IMPORT_BYTES / (1024 * 1024));

// What an import left out of the file, said once it has been read: the lookup
// that follows reports itself, as papers arriving and as the unmatched count,
// but these never reach it.
function leftOutNote(res: FolderImportResponse): string {
  const notes: string[] = [];
  if (res.notArticles > 0) {
    const what = res.notArticles === 1 ? "isn't a journal article" : "aren't journal articles";
    notes.push(`Skipped ${res.notArticles} that ${what}.`);
  }
  if (res.blank > 0) notes.push(`Skipped ${res.blank} with no title, DOI or PMID.`);
  return notes.join(" ");
}

// The bookmark-folder management shell: rename/delete chrome wrapped around
// whichever analysis module (table or timeline) is active, exactly as
// CollectionView does for the Library — same .source-* chrome, so the two
// sections read the same way.
//
// It stays smaller than CollectionView because a folder owns no files. Its
// papers come from /api/papers?folder=<id> like any other source, so there is
// no listing of them to fetch here. "Add papers" stands where "Add files" does
// in a collection, with two ways in behind it: Add links, for a paper found
// outside Interests, and a reference manager's whole library imported as a
// file. The import is the one thing here with a job behind it: the file's
// entries are looked up on PubMed for minutes after it is sent, and the ones
// not found stay listed, for a PMID from the reader, behind a count in the
// summary line.
export function BookmarkFolderView({
  folderId,
  isAdmin,
  summary,
  importJobs,
  onChanged,
  onPapersAdded,
  onDeleted,
  children,
}: {
  folderId: number;
  isAdmin: boolean;
  /** The folder counted out, for the row's left half — see App's sourceSummary. */
  summary: string | null;
  /** App's, so a lookup goes on being followed after this view has gone. */
  importJobs: ImportJobs;
  onChanged: () => void;
  /** Add links, or a PMID given to an imported entry, saved papers into this folder. */
  onPapersAdded: () => void;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingLinks, setAddingLinks] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const watched = useImportJob(importJobs, folderId);
  // While a file is being sent and read, before any lookup has started.
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The entries imports have left that aren't bookmarks yet, refetched by
  // bumping `entriesToken`. `entriesStale` is set when a lookup ends and
  // cleared when the refetch lands: until then every entry it settled is still
  // on screen as pending, and would be counted as not looked up.
  const [entries, setEntries] = useState<BookmarkImport[]>([]);
  const [entriesToken, setEntriesToken] = useState(0);
  const [entriesStale, setEntriesStale] = useState(false);
  // Whether the resume probe below has answered: until it has, a pending entry
  // may be one a lookup is working on right now.
  const [lookupChecked, setLookupChecked] = useState(false);
  const [showingEntries, setShowingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .getFolderImports(folderId)
      .then((list) => {
        if (!current) return;
        setEntries(list);
        setEntriesStale(false);
      })
      .catch((e) => current && setError(errorMessage(e)));
    return () => {
      current = false;
    };
  }, [folderId, entriesToken]);

  const refreshEntries = () => setEntriesToken((t) => t + 1);

  // Resume the progress bar if a lookup is already running over this folder.
  useEffect(() => {
    void importJobs.check(folderId).then(() => setLookupChecked(true));
  }, [folderId, importJobs]);

  // A lookup this view was watching has ended. App refreshes the folder's
  // papers when it does (see handleFolderImportSettled); what is left here is
  // the list of entries it settled, and its failure if it failed.
  //
  // Before paint, for CollectionView's reason: the render that first sees the
  // lookup over still holds its entries as pending, and with nothing running
  // any more a passive effect would paint them for a frame as not looked up.
  const lastWatched = useRef(watched);
  useLayoutEffect(() => {
    const was = lastWatched.current;
    lastWatched.current = watched;
    if (was?.state !== "running" || !watched || watched.state === "running") return;
    if (watched.state === "lost") setError("Lost contact with the import. Reload to check its status.");
    else if (watched.state === "error") setError(watched.error ?? "The import failed.");
    setEntriesStale(true);
    refreshEntries();
  }, [watched]);

  async function importFile(file: File) {
    setError(null);
    setNotice(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`That file is over ${MAX_IMPORT_MB} MB, which is more than one import can read.`);
      return;
    }
    setSending(true);
    try {
      const res = await api.importToFolder(folderId, file);
      importJobs.follow(folderId, res.status);
      const note = leftOutNote(res);
      if (res.queued + res.noIdentifier === 0) {
        setNotice(`Nothing in that file could be imported. ${note}`.trim());
      } else if (note) setNotice(note);
      refreshEntries();
      // Over before it could be followed — everything it named was already
      // stored — so App's poll will never see it end and refresh the folder.
      if (res.status.state !== "running") onPapersAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  // The dialog's "Look them up".
  async function lookUp() {
    setEntriesError(null);
    try {
      const started = await api.startFolderImport(folderId);
      importJobs.follow(folderId, started);
      if (started.state !== "running") {
        refreshEntries();
        onPapersAdded();
      }
    } catch (e) {
      setEntriesError(errorMessage(e));
    }
  }

  function entriesChanged(saved: boolean) {
    refreshEntries();
    if (saved) onPapersAdded();
  }

  async function rename(next: string) {
    setRenaming(false);
    try {
      await api.renameBookmarkFolder(folderId, next);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    setConfirmingDelete(false);
    try {
      await api.deleteBookmarkFolder(folderId);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const job = watched && watched.state !== "idle" && watched.state !== "lost" ? watched : null;
  const running = job?.state === "running";
  const progressPct = job && job.total ? Math.round((job.processed / job.total) * 100) : 0;

  // Counted onto the summary line, as a collection's unmatched files are, and
  // held back while the count can't yet be trusted: a file going up, a lookup
  // running, its settled list not back yet, or a fresh mount holding pending
  // entries before the probe has said whether a lookup owns them.
  const anyPending = entries.some((e) => e.status === "pending");
  const settling = sending || running || entriesStale || (!lookupChecked && anyPending);
  const counted = isAdmin && !settling;
  const pendingCount = counted ? entries.filter((e) => e.status === "pending").length : 0;
  const unmatchedCount = counted ? entries.filter((e) => e.status === "unmatched").length : 0;
  const anyListed = pendingCount + unmatchedCount > 0;
  if (showingEntries && !anyListed) setShowingEntries(false);

  function showEntries() {
    setEntriesError(null);
    setShowingEntries(true);
  }

  return (
    <div className="source-view">
      {/* The row is always here, because the papers below it start at one
          height in every section; only the management chrome inside it is
          admin-only, so a viewer gets the reserved space with the summary in
          it and nothing else. */}
      <div className="source-head">
        {summary && (
          <div className="source-meta">
            <span className="source-summary">
              {summary}
              {unmatchedCount > 0 && (
                <>
                  {" · "}
                  <button type="button" className="link-btn" onClick={showEntries}>
                    {unmatchedCount} unmatched
                  </button>
                </>
              )}
              {pendingCount > 0 && (
                <>
                  {" · "}
                  <button type="button" className="link-btn" onClick={showEntries}>
                    {pendingCount} not looked up
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {isAdmin && (
          <div className="source-actions">
            {/* One button for both ways in, so the row keeps a single primary
                action as a collection's does. The items say what each takes,
                because Add links also reads a pasted reference list: "Links"
                and "References" alone sent a list meant for pasting to the file
                picker. */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Plus size={14} className="inline-icon" aria-hidden /> Add papers{" "}
                <ChevronDown size={14} className="inline-icon" aria-hidden />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="bookmark-menu add-papers-menu"
                  align="end"
                  sideOffset={4}
                  loop
                >
                  <DropdownMenu.Item className="bookmark-option" onSelect={() => setAddingLinks(true)}>
                    <LinkIcon size={14} aria-hidden /> Paste DOIs or links…
                  </DropdownMenu.Item>
                  {/* Off while an import is still being read or looked up,
                      which the server would refuse. */}
                  <DropdownMenu.Item
                    className="bookmark-option"
                    disabled={sending || running}
                    onSelect={() => fileInputRef.current?.click()}
                  >
                    <FileInput size={14} aria-hidden /> Import a reference file (RIS, .nbib)…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button className="link-btn" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button className="link-btn danger" onClick={() => setConfirmingDelete(true)}>
              Delete folder
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".ris,.nbib,.txt"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // allow picking the same file again
                if (file) void importFile(file);
              }}
            />
          </div>
        )}
      </div>

      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />

      {/* The file going up and being read, then the lookup over what it kept:
          one wait, as a collection's upload and scan are. */}
      {sending ? (
        <div className="import-progress">
          <div className="progress-label">Reading the file…</div>
        </div>
      ) : (
        running && (
          <div className="import-progress">
            <div className="progress">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="progress-label">
              Looking up {job?.processed ?? 0} / {job?.total ?? 0} · {job?.matched ?? 0} found ·{" "}
              {job?.unmatched ?? 0} not found
            </div>
          </div>
        )
      )}

      {children}

      {isAdmin && (
        <ImportedEntries
          open={showingEntries && anyListed}
          entries={entries}
          error={entriesError}
          onClose={() => setShowingEntries(false)}
          onLookUp={lookUp}
          onChanged={entriesChanged}
          onError={setEntriesError}
        />
      )}
      <AddLinks
        open={addingLinks}
        onClose={() => setAddingLinks(false)}
        folderId={folderId}
        onAdded={onPapersAdded}
      />
      <PromptDialog
        open={renaming}
        title="Rename folder"
        placeholder="New name"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Rename"
        onSubmit={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete folder?"
        message="The folder and its list of saved papers are removed."
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
