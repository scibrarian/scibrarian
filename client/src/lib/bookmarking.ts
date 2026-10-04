import type { BookmarkFolder } from "../types";

// What the per-paper bookmark control needs, threaded down from App the same
// way PaperAccess is — the three views (table, timeline, graph) all take it and
// hand it to the same control, so a paper is saved identically wherever it's
// shown.
//
// A null Bookmarking is how a section opts out, and only Interests opts in:
// that is where a paper is saved, unsaved, or filed into a second folder. The
// Library holds papers you already own, not ones you're still deciding about.
// Bookmarks holds the ones you decided on, and what is left to do with those is
// take them back out — which the folder's table does by tick, the way a
// collection's does (see PapersTable), rather than through this control.
export interface Bookmarking {
  folders: BookmarkFolder[];
  // Which folders each paper is saved in, keyed by pmid. App owns this map and
  // updates it in place on a toggle, so the icon repaints without refetching a
  // source's whole paper list. A pmid absent from the map is saved nowhere.
  saved: ReadonlyMap<string, ReadonlySet<number>>;
  add: (folderId: number, pmid: string) => Promise<void>;
  // The bulk save behind "Save N papers". Returns what actually landed so the
  // result can distinguish papers added from ones already in the folder.
  addMany: (folderId: number, pmids: string[]) => Promise<{ added: number; alreadySaved: number }>;
  remove: (folderId: number, pmid: string) => Promise<void>;
  // Creates a folder without navigating to it — the menu saves the paper into
  // the new folder next, and the user stays where they were.
  createFolder: (name: string) => Promise<BookmarkFolder>;
}

// Shared empty set so a paper that isn't saved anywhere doesn't allocate one
// per render (the table renders hundreds of rows).
export const NO_FOLDERS: ReadonlySet<number> = new Set();
