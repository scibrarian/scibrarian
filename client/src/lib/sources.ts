import { createContext, useContext, useSyncExternalStore } from "react";
import type { api } from "../api";
import type {
  AddLinksResponse,
  BookmarkFolder,
  BookmarkImport,
  Collection,
  CollectionFile,
  FolderImportResponse,
  LinkedPaper,
  PaperSource,
  Topic,
} from "../types";
import { errorMessage } from "./format";
import { createImportJobs, type ImportJobs } from "./import-jobs";
import { seedEmptySource } from "./papers";
import { NO_RELOADS, bumpAll, bumpSource, tokenFor as tokenIn, type ReloadTokens } from "./reload";
import { sourceKey } from "../../../shared/source";
import { MAX_LINKS_PER_REQUEST, MAX_UPLOAD_FILES } from "../../../shared/limits";

// Files per upload request, so a large selection doesn't become one gigantic
// multipart body. Clamped to the server's per-request cap so raising this for
// speed can't silently start failing every upload.
const UPLOAD_BATCH = Math.min(20, MAX_UPLOAD_FILES);

// The paper sources the app lists — its topics, bookmark folders and
// collections (see "Source" in GLOSSARY.md) — with which folders each paper is
// saved in, and the reload tokens that say when what a view cached for a
// source has gone stale.
//
// One store for the whole app, made in main.tsx and handed down through
// SourcesContext, rather than state in App threaded through every view. Read
// through the hooks at the bottom, one per piece, so a change to one piece
// re-renders what reads that piece and nothing else: a bump to one folder's
// token re-renders the views showing that folder, not the whole app.

// What the store asks of the server: api.ts's methods, and test-api.ts's in
// the tests.
export type SourcesApi = Pick<
  typeof api,
  | "getTopics"
  | "getBookmarkFolders"
  | "getBookmarks"
  | "getCollections"
  | "createCollection"
  | "proShareCollection"
  | "renameCollection"
  | "deleteCollection"
  | "uploadFiles"
  | "startImport"
  | "setFilePmid"
  | "deleteCollectionFile"
  | "removeCollectionPapers"
  | "getImportStatus"
  | "createBookmarkFolder"
  | "renameBookmarkFolder"
  | "deleteBookmarkFolder"
  | "addBookmarks"
  | "removeBookmark"
  | "removeBookmarks"
  | "addBookmarkLinks"
  | "importToFolder"
  | "startFolderImport"
  | "setImportPmid"
  | "getFolderImportStatus"
>;

// What adding files did: the files added and skipped, the files in batches
// that failed, and the first failure — a batch's, or else the scan's start.
export type Upload = { added: number; skipped: number; failedFiles: number; failure: unknown };

// Which folders each paper is saved in, keyed by pmid: the whole bookmarks
// table, held here so every view's icons agree and a toggle repaints without
// refetching a source's papers (see BookmarkEntry in shared/types). A pmid
// absent from the map is saved nowhere.
export type SavedMap = ReadonlyMap<string, ReadonlySet<number>>;

export type Sources = {
  topics: () => Topic[];
  // Why the last reading of the topics failed, or null when it didn't. A read
  // that fails leaves the topics as they were — empty at first, or with a
  // topic just removed still on the list — and Settings, which lists them, has
  // to be able to say that its list is not the truth.
  topicsError: () => string | null;
  folders: () => BookmarkFolder[];
  collections: () => Collection[];
  saved: () => SavedMap;
  // The token every cached fetch under this source is stamped with (see
  // lib/reload). A bump to any other source leaves it alone.
  tokenFor: (source: PaperSource) => number;
  subscribe: (onChange: () => void) => () => void;

  // The topics, read again. Answers with them, or with null when they couldn't
  // be read: the list is then left as it was, and a caller that goes on to
  // count what it got back has nothing to count.
  //
  // Of reads that overlap, only the latest to start is taken as the list,
  // whatever order they are answered in; an earlier one still answers its own
  // caller. The same for each read below.
  loadTopics: () => Promise<Topic[] | null>;
  // The rest, read again. A failed read leaves the list as it was, and answers
  // with an empty one.
  loadFolders: () => Promise<BookmarkFolder[]>;
  loadBookmarks: () => Promise<void>;
  loadCollections: () => Promise<Collection[]>;

  // The scans running over collections, followed for as long as the app is
  // open rather than for as long as a collection is on screen (see
  // lib/import-jobs). One that ends after its collection has been left still
  // refreshes what it changed; otherwise the collection came back painting its
  // pre-scan file list from cache, every row still waiting on a scan.
  scans: ImportJobs;
  // The lookups running over bookmark folders' imported entries, followed for
  // as long as the app is open rather than for as long as a folder is on
  // screen (see lib/import-jobs). A lookup fills its folder for minutes after
  // the import that started it, so each round that saves papers refreshes the
  // folder as it goes, and so does the lookup's end.
  lookups: ImportJobs;
  // Stop following every job.
  stop: () => void;

  // Make a collection, and share it with the organization when asked — which
  // App does only while paired. Shared at once, from the pairing live when it
  // was made: a boundary set later is one the writer forgets, and one derived
  // from the *current* pairing would hand an old client's collections to a new
  // one the moment they re-pair. A failure to share must not lose the
  // collection, which exists, so it is answered for the caller to report
  // rather than unwound. Seeded empty, as a new folder is.
  createCollection: (
    name: string,
    options: { share: boolean }
  ) => Promise<{ collection: Collection; shareError: string | null }>;
  // These collections' papers or files changed. Their caches go, and every
  // collection's at once, which aggregates them all; and the list is read
  // again for its counts. For what changes a collection without passing
  // through one of the operations below.
  collectionsChanged: (collectionIds: number[]) => Promise<void>;

  // The rest of what changes a collection. As for a folder, each answers once
  // the server has, and reads again behind it what it made stale: the
  // collection's caches, every collection's at once, and the list's counts.
  renameCollection: (collectionId: number, name: string) => Promise<void>;
  // Taken off the list at once, so App's selection moves off it without
  // waiting for the read.
  deleteCollection: (collectionId: number) => Promise<void>;
  // Add files: the PDFs, UPLOAD_BATCH to a request, then the scan over them,
  // followed in `scans`. `on.batch` hears how many have gone up after each
  // request, and `on.uploaded` what the upload did once the last has, before
  // the scan is asked for: a scan with nothing to do ends at its start, and
  // reports itself at once. A batch that fails doesn't stop the rest, and the
  // scan is asked for after one does. Answers with what was added and the
  // first failure, and refreshes the collection once, whatever happened.
  addFiles: (
    collectionId: number,
    files: File[],
    on: { batch: (sent: number) => void; uploaded: (upload: Upload) => void }
  ) => Promise<Upload>;
  // The unmatched-files dialog's "Scan them": a scan over the files an earlier
  // one stopped before reaching.
  scanCollection: (collectionId: number) => Promise<void>;
  // A file given the PMID the reader found for it, or taken out.
  matchFile: (file: CollectionFile, pmid: string) => Promise<void>;
  deleteFile: (file: CollectionFile) => Promise<void>;
  // The collection table's "Remove selected": one request for the ticked set.
  removeFromCollection: (
    collectionId: number,
    pmids: string[]
  ) => Promise<{ removed: number; papers: number }>;

  // Make a bookmark folder. Its empty list is known without asking, and is
  // filed under its token, so a view opening on it paints the empty state at
  // once rather than a skeleton on the way there (see seedEmptySource).
  createFolder: (name: string) => Promise<BookmarkFolder>;
  // The bookmark toggle. The saved map is patched in place of reading it
  // again — in Interests the rows don't change, only the icon, and refetching
  // a few thousand papers per click would be absurd. The folder is the
  // exception: its membership *is* its paper list, so each toggle makes that
  // one folder stale, on screen or not.
  //
  // A read of the map still out when a toggle is applied is read again: it may
  // have been answered before the toggle reached the server, and landing after
  // it would put the paper back as it was.
  addBookmark: (folderId: number, pmid: string) => Promise<void>;
  removeBookmark: (folderId: number, pmid: string) => Promise<void>;
  // The bulk save. Papers the server skipped as unstored would leave a patched
  // map claiming they're saved, so the whole map is read again instead — one
  // request, and it can't drift.
  addBookmarks: (
    folderId: number,
    pmids: string[]
  ) => Promise<{ added: number; alreadySaved: number; missing: number }>;

  // The rest of what changes a folder. Each answers once the server has, and
  // reads again behind it what it made stale. A folder that gained or lost
  // papers has three things stale — its list, its count in the picker, and
  // the saved map, which fills the bookmark icon on every paper in Interests.
  renameFolder: (folderId: number, name: string) => Promise<void>;
  // Taken off the list at once, so App's selection moves off it without
  // waiting for the reads.
  deleteFolder: (folderId: number) => Promise<void>;
  // The folder table's "Remove selected": one request for the ticked set.
  removeBookmarks: (folderId: number, pmids: string[]) => Promise<{ removed: number }>;
  // Add links: the pasted lines, MAX_LINKS_PER_REQUEST to a request, one after
  // another. Each batch's answer goes to `onBatch` as it lands — a DOI is a
  // throttled PubMed search, so a long paste takes a while, and the rows
  // arriving are the progress — which answers false to send no more: the
  // dialog has gone. A batch that fails rejects, keeping what the earlier ones
  // saved. The folder is refreshed once, after the last batch sent, if any
  // saved a paper: per batch, the refreshes overlapped.
  addLinks: (
    folderId: number,
    lines: string[],
    onBatch: (batch: string[], answer: AddLinksResponse, from: number) => boolean
  ) => Promise<void>;
  // Import a reference file into a folder, and follow the lookup it starts.
  importToFolder: (folderId: number, file: File) => Promise<FolderImportResponse>;
  // Look up the entries a lookup stopped before reaching, and follow it.
  lookUpImports: (folderId: number) => Promise<void>;
  // Give an imported entry the PMID the reader found for it, which saves that
  // paper into the entry's folder.
  setImportPmid: (entry: BookmarkImport, pmid: string) => Promise<LinkedPaper>;

  // Data under a papers view changed (poll, import, match, file delete, a paper
  // saved): invalidate that source's caches so the next look at it refetches.
  // What moved isn't always what's on screen — saving from Interests has to
  // leave the folder's list stale while the topic being read stays cached.
  reloadSource: (source: PaperSource) => void;
  // The changes no single source owns: a poll across every topic, papers
  // removed from Interests wholesale, or a deleted source — that last one
  // because SQLite may hand the dead id to the next source created, which
  // would then inherit its cache entries.
  reloadEverything: () => void;
};

export function createSources(port: SourcesApi): Sources {
  let topics: Topic[] = [];
  let topicsError: string | null = null;
  let folders: BookmarkFolder[] = [];
  let collections: Collection[] = [];
  let saved: Map<string, Set<number>> = new Map();
  let reloads: ReloadTokens = NO_RELOADS;
  const listeners = new Set<() => void>();
  // How many reads of each list have started. An answer is taken as the list
  // only if no read of it started after its own, the way App's ticket for the
  // stamps works: the last answer to land is not the latest, and taking it
  // put a list back to how it was before a newer read.
  const started = { topics: 0, folders: 0, bookmarks: 0, collections: 0 };
  // Reads of the saved map not yet answered, for applySaved.
  let bookmarksOut = 0;

  function changed() {
    for (const listener of listeners) listener();
  }

  function loadTopics(): Promise<Topic[] | null> {
    const read = ++started.topics;
    return port
      .getTopics()
      .then((ds) => {
        if (read === started.topics) {
          topicsError = null;
          topics = ds;
          changed();
        }
        return ds;
      })
      .catch((e) => {
        if (read === started.topics) {
          topicsError = errorMessage(e);
          changed();
        }
        return null;
      });
  }

  function loadFolders(): Promise<BookmarkFolder[]> {
    const read = ++started.folders;
    return port
      .getBookmarkFolders()
      .then((fs) => {
        if (read === started.folders) {
          folders = fs;
          changed();
        }
        return fs;
      })
      .catch(() => []);
  }

  function loadBookmarks(): Promise<void> {
    const read = ++started.bookmarks;
    bookmarksOut++;
    return port
      .getBookmarks()
      .then((rows) => {
        if (read !== started.bookmarks) return;
        const map = new Map<string, Set<number>>();
        for (const r of rows) {
          const folders = map.get(r.pmid);
          if (folders) folders.add(r.folder_id);
          else map.set(r.pmid, new Set([r.folder_id]));
        }
        saved = map;
        changed();
      })
      .catch(() => {})
      .finally(() => bookmarksOut--);
  }

  function loadCollections(): Promise<Collection[]> {
    const read = ++started.collections;
    return port
      .getCollections()
      .then((cs) => {
        if (read === started.collections) {
          collections = cs;
          changed();
        }
        return cs;
      })
      .catch(() => []);
  }

  function reloadSource(source: PaperSource) {
    reloads = bumpSource(reloads, sourceKey(source));
    changed();
  }

  function reloadEverything() {
    reloads = bumpAll(reloads);
    changed();
  }

  // A toggle, patched into the saved map. A new map every time, so the hooks
  // below see the change.
  function applySaved(pmid: string, update: (folders: Set<number>) => void) {
    const next = new Map(saved);
    const folders = new Set(next.get(pmid) ?? []);
    update(folders);
    if (folders.size > 0) next.set(pmid, folders);
    else next.delete(pmid);
    saved = next;
    changed();
    // Started after the toggle reached the server, so it can't undo it, and
    // the read it supersedes may carry changes of its own.
    if (bookmarksOut > 0) void loadBookmarks();
  }

  async function createCollection(name: string, { share }: { share: boolean }) {
    const collection = await port.createCollection(name);
    let shareError: string | null = null;
    if (share) {
      try {
        await port.proShareCollection(collection.id);
      } catch (e) {
        shareError = errorMessage(e);
      }
    }
    const source = { collection: collection.id };
    seedEmptySource(source, tokenIn(reloads, sourceKey(source)));
    await loadCollections();
    return { collection, shareError };
  }

  // Bumped before the read, not after it. The two are independent — the
  // papers fetch doesn't read the collection list — and sequencing them cost
  // a whole round trip of staleness: the papers on screen were the ones just
  // removed, and they stayed that way until the list had been and come back.
  // Measured on a local server, that alone was ~260ms of the delay between a
  // removal being reported and the rows leaving.
  async function collectionsChanged(collectionIds: number[]) {
    reloads = bumpSource(reloads, sourceKey({ allCollections: true }));
    for (const id of collectionIds) reloads = bumpSource(reloads, sourceKey({ collection: id }));
    changed();
    await loadCollections();
  }

  // Every source's caches, for the reason a deleted folder gives below.
  async function collectionDeleted(collectionId: number) {
    collections = collections.filter((c) => c.id !== collectionId);
    reloads = bumpAll(reloads);
    changed();
    await loadCollections();
  }

  async function renameCollection(collectionId: number, name: string) {
    await port.renameCollection(collectionId, name);
    void collectionsChanged([collectionId]);
  }

  async function deleteCollection(collectionId: number) {
    await port.deleteCollection(collectionId);
    void collectionDeleted(collectionId);
  }

  async function addFiles(
    collectionId: number,
    files: File[],
    on: { batch: (sent: number) => void; uploaded: (upload: Upload) => void }
  ): Promise<Upload> {
    const upload: Upload = { added: 0, skipped: 0, failedFiles: 0, failure: null };
    for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
      const batch = files.slice(i, i + UPLOAD_BATCH);
      try {
        const res = await port.uploadFiles(collectionId, batch);
        upload.added += res.added;
        upload.skipped += res.skipped;
      } catch (e) {
        // One rejected batch is not a reason to abandon the other nineteen
        // files the user picked. Keep going and report the shortfall at the
        // end — whatever made this request fail (a file the browser can no
        // longer read, a blip) usually has nothing to do with the next batch.
        upload.failedFiles += batch.length;
        upload.failure ??= e;
      }
      on.batch(Math.min(i + batch.length, files.length));
    }
    on.uploaded(upload);
    // Asked for even when a batch failed. Files that uploaded before the
    // failure are sitting in 'pending' with no job queued, and nothing else in
    // the UI can queue one — so without this they're stranded until the user
    // happens to upload again. The job walks every pending row, so this also
    // sweeps up whatever an earlier partial upload left behind.
    try {
      scans.start(collectionId, await port.startImport(collectionId));
    } catch (e) {
      upload.failure ??= e; // the upload error, if there was one, is the more useful
    } finally {
      void collectionsChanged([collectionId]);
    }
    return upload;
  }

  async function scanCollection(collectionId: number) {
    scans.start(collectionId, await port.startImport(collectionId));
  }

  async function matchFile(file: CollectionFile, pmid: string) {
    await port.setFilePmid(file.id, pmid);
    void collectionsChanged([file.collection_id]);
  }

  async function deleteFile(file: CollectionFile) {
    await port.deleteCollectionFile(file.id);
    void collectionsChanged([file.collection_id]);
  }

  async function removeFromCollection(collectionId: number, pmids: string[]) {
    const result = await port.removeCollectionPapers(collectionId, pmids);
    void collectionsChanged([collectionId]);
    return result;
  }

  async function createFolder(name: string): Promise<BookmarkFolder> {
    const created = await port.createBookmarkFolder(name);
    const source = { folder: created.id };
    seedEmptySource(source, tokenIn(reloads, sourceKey(source)));
    await loadFolders();
    return created;
  }

  async function addBookmark(folderId: number, pmid: string) {
    await port.addBookmarks(folderId, [pmid]);
    applySaved(pmid, (folders) => folders.add(folderId));
    await loadFolders();
    reloadSource({ folder: folderId });
  }

  async function removeBookmark(folderId: number, pmid: string) {
    await port.removeBookmark(folderId, pmid);
    applySaved(pmid, (folders) => folders.delete(folderId));
    await loadFolders();
    reloadSource({ folder: folderId });
  }

  async function addBookmarks(folderId: number, pmids: string[]) {
    const result = await port.addBookmarks(folderId, pmids);
    await Promise.all([loadBookmarks(), loadFolders()]);
    reloadSource({ folder: folderId });
    return result;
  }

  // A folder renamed: the list read again for its new name, and the folder's
  // own caches dropped, as for any change its view reports.
  async function folderChanged(folderId: number) {
    await loadFolders();
    reloadSource({ folder: folderId });
  }

  // Bumped before the reads, not after them: the papers fetch reads neither
  // of the other two, and a removal's rows stay on screen, dimmed, until it
  // lands.
  async function folderPapersChanged(folderId: number) {
    reloadSource({ folder: folderId });
    await Promise.all([loadBookmarks(), loadFolders()]);
  }

  // Every source's caches, not just the folder's: SQLite may hand the dead id
  // to the next folder created, which would then inherit its cache entries.
  // Bumped with the list, in one change, so the folder the selection moves to
  // is asked for once. The saved map comes back from the server too: the
  // folder's bookmarks went with it, and a map left alone would show every
  // paper it held as saved in a folder that no longer exists.
  async function folderDeleted(folderId: number) {
    folders = folders.filter((f) => f.id !== folderId);
    reloads = bumpAll(reloads);
    changed();
    await Promise.all([loadBookmarks(), loadFolders()]);
  }

  async function renameFolder(folderId: number, name: string) {
    await port.renameBookmarkFolder(folderId, name);
    void folderChanged(folderId);
  }

  async function deleteFolder(folderId: number) {
    await port.deleteBookmarkFolder(folderId);
    void folderDeleted(folderId);
  }

  async function removeBookmarks(folderId: number, pmids: string[]) {
    const result = await port.removeBookmarks(folderId, pmids);
    void folderPapersChanged(folderId);
    return result;
  }

  async function addLinks(
    folderId: number,
    lines: string[],
    onBatch: (batch: string[], answer: AddLinksResponse, from: number) => boolean
  ) {
    let added = false;
    try {
      for (let i = 0; i < lines.length; i += MAX_LINKS_PER_REQUEST) {
        const batch = lines.slice(i, i + MAX_LINKS_PER_REQUEST);
        const answer = await port.addBookmarkLinks(folderId, batch);
        if (answer.results.some((a) => a.outcome === "added")) added = true;
        if (!onBatch(batch, answer, i)) return;
      }
    } finally {
      if (added) void folderPapersChanged(folderId);
    }
  }

  async function importToFolder(folderId: number, file: File) {
    const answer = await port.importToFolder(folderId, file);
    lookups.start(folderId, answer.status);
    return answer;
  }

  async function lookUpImports(folderId: number) {
    lookups.start(folderId, await port.startFolderImport(folderId));
  }

  async function setImportPmid(entry: BookmarkImport, pmid: string) {
    const paper = await port.setImportPmid(entry.id, pmid);
    void folderPapersChanged(entry.folder_id);
    return paper;
  }

  const scans = createImportJobs(port.getImportStatus, (id) => void collectionsChanged([id]));
  const lookups = createImportJobs(
    port.getFolderImportStatus,
    (id) => void folderPapersChanged(id),
    (id) => void folderPapersChanged(id)
  );

  return {
    topics: () => topics,
    topicsError: () => topicsError,
    folders: () => folders,
    collections: () => collections,
    saved: () => saved,
    tokenFor: (source) => tokenIn(reloads, sourceKey(source)),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    loadTopics,
    loadFolders,
    loadBookmarks,
    loadCollections,
    scans,
    lookups,
    stop() {
      scans.stop();
      lookups.stop();
    },
    createCollection,
    collectionsChanged,
    renameCollection,
    deleteCollection,
    addFiles,
    scanCollection,
    matchFile,
    deleteFile,
    removeFromCollection,
    createFolder,
    addBookmark,
    removeBookmark,
    addBookmarks,
    renameFolder,
    deleteFolder,
    removeBookmarks,
    addLinks,
    importToFolder,
    lookUpImports,
    setImportPmid,
    reloadSource,
    reloadEverything,
  };
}

export const SourcesContext = createContext<Sources | null>(null);

export function useSources(): Sources {
  const sources = useContext(SourcesContext);
  if (!sources) throw new Error("useSources needs a SourcesContext provider above it.");
  return sources;
}

// One piece of the store, re-read on every change and re-rendering only when
// what it answers is a different value: each piece keeps its identity until it
// is replaced.
function usePiece<T>(read: (sources: Sources) => T): T {
  const sources = useSources();
  return useSyncExternalStore(sources.subscribe, () => read(sources));
}

export const useTopics = () => usePiece((s) => s.topics());
export const useTopicsError = () => usePiece((s) => s.topicsError());
export const useFolders = () => usePiece((s) => s.folders());
export const useCollections = () => usePiece((s) => s.collections());
// The folders one paper is saved in. A toggle replaces only that paper's set,
// so of the hundreds of rows reading this, it re-renders one.
export const useSavedIn = (pmid: string) => usePiece((s) => s.saved().get(pmid) ?? NO_FOLDERS);

// Shared, so a paper saved nowhere doesn't allocate a set per render.
const NO_FOLDERS: ReadonlySet<number> = new Set();

// The token for a view's own source, or 0 with none.
export function useReloadToken(source: PaperSource | null): number {
  return usePiece((s) => (source ? s.tokenFor(source) : 0));
}
