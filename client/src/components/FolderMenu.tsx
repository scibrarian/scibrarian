import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus } from "lucide-react";
import type { BookmarkFolder } from "../types";

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
  folders,
  renderFolder,
  onNewFolder,
}: {
  folders: BookmarkFolder[];
  // Returns one menu row; it owns the row's key, since only the caller knows
  // which Radix item type its semantics need.
  renderFolder: (folder: BookmarkFolder) => ReactNode;
  onNewFolder: () => void;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="bookmark-menu" align="end" sideOffset={4} loop>
        {folders.map((f) => renderFolder(f))}
        {folders.length === 0 && <div className="bookmark-empty">No folders yet.</div>}
        <DropdownMenu.Item className="bookmark-add" onSelect={onNewFolder}>
          <Plus size={14} aria-hidden /> New folder…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
