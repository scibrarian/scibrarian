import { useState, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { Banner } from "./Banner";
import { ConfirmDialog, PromptDialog } from "./Dialogs";

// The bookmark-folder management shell: rename/delete chrome wrapped around
// whichever analysis module (table or timeline) is active, exactly as
// CollectionView does for the Library — same .source-* chrome, so the two
// workspaces read the same way.
//
// It stays much smaller than CollectionView because a folder owns nothing: no
// uploads, no import job, no files to reconcile. Its papers come from
// /api/papers?folder=<id> like any other source, so there is no listing to
// fetch here.
export function BookmarkFolderView({
  folderId,
  isAdmin,
  onChanged,
  onDeleted,
  children,
}: {
  folderId: number;
  isAdmin: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  return (
    <div className="source-view">
      {/* The row is always here, because the papers below it start at one
          height in every workspace; only the management chrome inside it is
          admin-only, so a viewer gets the reserved space and nothing in it. */}
      <div className="source-head">
        {isAdmin && (
          <div className="source-actions">
            <button className="link-btn" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button className="link-btn danger" onClick={() => setConfirmingDelete(true)}>
              Delete folder
            </button>
          </div>
        )}
      </div>

      {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}

      {children}

      <PromptDialog
        open={renaming}
        title="Rename folder"
        placeholder="New name"
        submitLabel="Rename"
        onSubmit={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete folder?"
        message="The folder and its list of saved papers are removed. The papers themselves stay in the app."
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
