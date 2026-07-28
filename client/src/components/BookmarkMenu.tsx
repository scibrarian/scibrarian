import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, Check } from "lucide-react";
import { errorMessage } from "../lib/format";
import { NO_FOLDERS, type Bookmarking } from "../lib/bookmarking";
import { FolderMenuContent } from "./FolderMenu";

// The per-paper bookmark control, used identically by the table, the timeline
// card and the graph's paper dialog.
//
// It's a menu of folders with checkmarks rather than a plain "add to…" list, so
// one control covers all three things you can do: save, unsave, and file the
// same paper into a second folder. Toggling deliberately leaves the menu open —
// a paper often belongs in more than one folder, and reopening between each
// would make that tedious.
//
// There is one of these per paper on screen, so it holds as little as it can:
// naming a new folder is asked of the view (see NewFolderDialog), which keeps
// one prompt for the whole list rather than one per row.
export function BookmarkMenu({
  pmid,
  bookmarking,
  onError,
  onNewFolder,
}: {
  pmid: string;
  bookmarking: Bookmarking;
  onError: (message: string) => void;
  onNewFolder: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { folders, saved } = bookmarking;
  const inFolders = saved.get(pmid) ?? NO_FOLDERS;
  const savedCount = inFolders.size;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(folderId: number) {
    void run(() =>
      inFolders.has(folderId)
        ? bookmarking.remove(folderId, pmid)
        : bookmarking.add(folderId, pmid)
    );
  }

  const label =
    savedCount === 0
      ? "Save to a bookmark folder"
      : `Saved in ${savedCount} folder${savedCount === 1 ? "" : "s"}`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={`bookmark-btn ${savedCount > 0 ? "saved" : ""}`}
        disabled={busy}
        aria-label={label}
        title={label}
      >
        {/* Filled vs. outline is the at-a-glance answer to "have I already
            kept this one?" while scanning a list of results. */}
        <Bookmark size={15} fill={savedCount > 0 ? "currentColor" : "none"} aria-hidden />
      </DropdownMenu.Trigger>

      <FolderMenuContent
        folders={folders}
        onNewFolder={onNewFolder}
        renderFolder={(f) => (
          <DropdownMenu.CheckboxItem
            key={f.id}
            className="bookmark-option"
            checked={inFolders.has(f.id)}
            // preventDefault keeps the menu open across a toggle.
            onSelect={(e) => {
              e.preventDefault();
              toggle(f.id);
            }}
          >
            <span className="bookmark-check" aria-hidden>
              {inFolders.has(f.id) && <Check size={14} />}
            </span>
            <span className="bookmark-name">{f.name}</span>
          </DropdownMenu.CheckboxItem>
        )}
      />
    </DropdownMenu.Root>
  );
}
