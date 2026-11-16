import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus } from "lucide-react";
import { errorMessage } from "../lib/format";
import { useFolders, useSources } from "../lib/sources";
import type { BookmarkFolder } from "../types";
import { PromptDialog } from "./Dialogs";
import { MAX_NAME_CHARS } from "../../../shared/limits";

// The dropdown body both bookmark controls open: the list of folders, the
// empty state, and the row that starts a new one.
//
// Only the folder row itself differs between them — the per-paper menu is a
// checklist of where that paper already is, the bulk button a list of
// destinations with their counts — so the row is the caller's to render and
// everything around it is here. Worth sharing because the two were copies and
// had already started to drift: one grew a check gutter, the other a count
// badge, and anything about how folders are listed — sorting, a search box,
// truncation, the empty copy — had to be changed in both or in neither.
export function FolderMenuContent({
  renderFolder,
  onNewFolder,
}: {
  // Returns one menu row; it owns the row's key, since only the caller knows
  // which Radix item type its semantics need.
  renderFolder: (folder: BookmarkFolder) => ReactNode;
  onNewFolder: () => void;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="bookmark-menu" align="end" sideOffset={4} loop>
        <FolderRows renderFolder={renderFolder} />
        <DropdownMenu.Item className="bookmark-add" onSelect={onNewFolder}>
          <Plus size={14} aria-hidden /> New folder…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

// The folders, read from the store only while the menu is open: Radix mounts
// nothing inside a closed menu's portal. There is a per-paper menu on every row
// on screen, and each one reading the list re-rendered them all whenever it was
// read again, which a toggle and each round of a lookup both do.
function FolderRows({ renderFolder }: { renderFolder: (folder: BookmarkFolder) => ReactNode }) {
  const folders = useFolders();
  return (
    <>
      {folders.map((f) => renderFolder(f))}
      {folders.length === 0 && <div className="bookmark-empty">No folders yet.</div>}
    </>
  );
}

// The "New folder…" prompt for a whole view, holding the paper that asked for
// one — null when nothing is waiting, which is also what closes it.
//
// One per view rather than one per menu. BookmarkMenu used to carry its own,
// so a table scrolled to the end of a large topic held a Radix dialog root per
// row — thousands of identical dialogs standing by for a prompt that only ever
// opens once, and only for one paper. Lifting it also puts the create-then-save
// pair in one place instead of repeating it in every view that lists papers.
export function NewFolderDialog({
  pmid,
  onError,
  onClose,
}: {
  pmid: string | null;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const sources = useSources();
  return (
    <PromptDialog
      open={pmid != null}
      title="New folder"
      placeholder="Folder name"
      maxLength={MAX_NAME_CHARS}
      submitLabel="Create & save"
      onSubmit={(name) => {
        onClose();
        if (pmid == null) return;
        // Creating from here saves the paper into the new folder straight away
        // — otherwise the folder you just made for this paper wouldn't contain
        // it.
        void (async () => {
          try {
            const folder = await sources.createFolder(name);
            await sources.addBookmark(folder.id, pmid);
          } catch (e) {
            onError(errorMessage(e));
          }
        })();
      }}
      onCancel={onClose}
    />
  );
}
