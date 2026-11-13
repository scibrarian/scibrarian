import { createContext, useContext, useSyncExternalStore } from "react";
import type { api } from "../api";
import type { BookmarkFolder, Collection, PaperSource, Topic } from "../types";
import { errorMessage } from "./format";
import { NO_RELOADS, bumpAll, bumpSource, tokenFor as tokenIn, type ReloadTokens } from "./reload";
import { sourceKey } from "../../../shared/source";

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
  "getTopics" | "getBookmarkFolders" | "getBookmarks" | "getCollections"
>;

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

  // A bookmark toggle, applied to the saved map in place of reading it again.
  // A read of the map still out when it is applied is read again: it may have
  // been answered before the toggle reached the server, and landing after it
  // would put the paper back as it was.
  applySaved: (pmid: string, update: (folders: Set<number>) => void) => void;
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

  // A new map every time, so the hooks below see the change.
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
    applySaved,
    reloadSource(source) {
      reloads = bumpSource(reloads, sourceKey(source));
      changed();
    },
    reloadEverything() {
      reloads = bumpAll(reloads);
      changed();
    },
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
export const useSaved = () => usePiece((s) => s.saved());

// The token for a view's own source, or 0 with none.
export function useReloadToken(source: PaperSource | null): number {
  return usePiece((s) => (source ? s.tokenFor(source) : 0));
}
