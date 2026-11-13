import type { SourcesApi } from "./lib/sources";
import type { BookmarkEntry, BookmarkFolder, Collection, Topic } from "./types";

// An in-memory server for the client's tests: a library of topics, bookmark
// folders, bookmarks and collections, answering as api.ts's methods do. The
// store (lib/sources) is built on it in place of api.ts, so a test sets up a
// library, does what the reader would, and asks what the store holds after —
// rather than which requests went out.
//
// `satisfies SourcesApi` below is what keeps it honest: the store asking the
// server for something new is a compile error here until the fake answers it.

type Method = keyof SourcesApi;

export function createTestApi() {
  const library = {
    topics: [] as Topic[],
    folders: [] as Omit<BookmarkFolder, "paperCount">[],
    bookmarks: [] as BookmarkEntry[],
    collections: [] as Omit<Collection, "fileCount" | "matchedCount" | "heldCount">[],
  };
  let nextId = 1;
  // The methods answering with an error, and what it says.
  const failing = new Map<Method, string>();

  function answer<T>(method: Method, reply: () => T): Promise<T> {
    const message = failing.get(method);
    return message != null ? Promise.reject(new Error(message)) : Promise.resolve(reply());
  }

  const api = {
    getTopics: () => answer("getTopics", () => library.topics.map((t) => ({ ...t }))),
    getBookmarkFolders: () =>
      answer("getBookmarkFolders", () =>
        library.folders.map((f) => ({
          ...f,
          paperCount: library.bookmarks.filter((b) => b.folder_id === f.id).length,
        }))
      ),
    getBookmarks: () => answer("getBookmarks", () => library.bookmarks.map((b) => ({ ...b }))),
    getCollections: () =>
      answer("getCollections", () =>
        library.collections.map((c) => ({ ...c, fileCount: 0, matchedCount: 0, heldCount: 0 }))
      ),
  } satisfies SourcesApi;

  const created = new Date(0).toISOString();

  return {
    api,
    library,
    addTopic(name: string): Topic {
      const topic: Topic = {
        id: nextId++,
        name,
        term: name,
        headings: [],
        all_pubmed: true,
        journalCount: 0,
        last_polled_at: null,
        created_at: created,
        articleCount: 0,
      };
      library.topics.push(topic);
      return topic;
    },
    addFolder(name: string): number {
      const id = nextId++;
      library.folders.push({ id, name, created_at: created });
      return id;
    },
    bookmark(folderId: number, ...pmids: string[]) {
      for (const pmid of pmids) library.bookmarks.push({ folder_id: folderId, pmid });
    },
    addCollection(name: string): number {
      const id = nextId++;
      library.collections.push({ id, name, created_at: created });
      return id;
    },
    // Every call to this method fails, saying so, until it recovers.
    fail(method: Method, message = "The server couldn't be reached.") {
      failing.set(method, message);
    },
    recover(method: Method) {
      failing.delete(method);
    },
  };
}
