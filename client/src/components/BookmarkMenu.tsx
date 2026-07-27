import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, Check, Plus } from "lucide-react";
import { errorMessage } from "../lib/format";
import { NO_FOLDERS, type Bookmarking } from "../lib/bookmarking";
import { PromptDialog } from "./Dialogs";

// The per-paper bookmark control, used identically by the table, the timeline
// card and the graph's paper dialog.
//
// It's a menu of folders with checkmarks rather than a plain "add to…" list, so
// one control covers all three things you can do: save, unsave, and file the
// same paper into a second folder. Toggling deliberately leaves the menu open —
// a paper often belongs in more than one folder, and reopening between each
// would make that tedious.
export function BookmarkMenu({
  pmid,
  bookmarking,
  onError,
}: {
  pmid: string;
  bookmarking: Bookmarking;
  onError: (message: string) => void;
}) {
  const [naming, setNaming] = useState(false);
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

  // Creating from here saves the paper into the new folder straight away —
  // otherwise the folder you just made for this paper wouldn't contain it.
  function createAndSave(name: string) {
    setNaming(false);
    void run(async () => {
      const folder = await bookmarking.createFolder(name);
      await bookmarking.add(folder.id, pmid);
    });
  }

  const label =
    savedCount === 0
      ? "Save to a bookmark folder"
      : `Saved in ${savedCount} folder${savedCount === 1 ? "" : "s"}`;

  return (
    <>
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

        <DropdownMenu.Portal>
          <DropdownMenu.Content className="bookmark-menu" align="end" sideOffset={4} loop>
            {folders.map((f) => (
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
            ))}
            {folders.length === 0 && (
              <div className="bookmark-empty">No folders yet.</div>
            )}
            <DropdownMenu.Item className="bookmark-add" onSelect={() => setNaming(true)}>
              <Plus size={14} aria-hidden /> New folder…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <PromptDialog
        open={naming}
        title="New folder"
        placeholder="Folder name"
        submitLabel="Create & save"
        onSubmit={createAndSave}
        onCancel={() => setNaming(false)}
      />
    </>
  );
}
