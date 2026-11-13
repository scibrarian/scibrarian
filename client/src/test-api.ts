import type { api as realApi } from "./api";
import type { SourcesApi } from "./lib/sources";
import type { BookmarkEntry, BookmarkFolder, Collection, ImportStatus, Topic } from "./types";

// An in-memory server for the client's tests: a library of topics, bookmark
// folders, bookmarks and collections, answering as api.ts's methods do. The
// store (lib/sources) is built on it in place of api.ts, so a test sets up a
// library, does what the reader would, and asks what the store holds after —
// rather than which requests went out. App's tests render the whole shell on
// it, which is what the reads below the store's own are for: what the views
// ask for as they mount, answered as an empty source would be.
//
// `satisfies` below is what keeps it honest: the store asking the server for
// something new is a compile error here until the fake answers it, and every
// other method has to answer in api.ts's own shape.

type Api = typeof realApi;
type Method = keyof Api;

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
  // The next call to each of these methods, held back until it is released.
  const held = new Map<Method, Promise<void>>();

  // What the server says at the moment it is asked, sent once any hold on the
  // call is released — so a held call answers with the library as it was.
  function answer<T>(method: Method, reply: () => T): Promise<T> {
    const message = failing.get(method);
    const value = message == null ? reply() : undefined;
    const gate = held.get(method) ?? Promise.resolve();
    held.delete(method);
    return gate.then(() => {
      if (message != null) throw new Error(message);
      return value as T;
    });
  }

  const created = new Date(0).toISOString();
  const idle: ImportStatus = { state: "idle" };

  function folderRow(f: (typeof library.folders)[number]): BookmarkFolder {
    return { ...f, paperCount: library.bookmarks.filter((b) => b.folder_id === f.id).length };
  }

  function collectionRow(c: (typeof library.collections)[number]): Collection {
    return { ...c, fileCount: 0, matchedCount: 0, heldCount: 0 };
  }

  function addFolder(name: string): number {
    const id = nextId++;
    library.folders.push({ id, name, created_at: created });
    return id;
  }

  function addCollection(name: string): number {
    const id = nextId++;
    library.collections.push({ id, name, created_at: created });
    return id;
  }

  const api = {
    getTopics: () => answer("getTopics", () => library.topics.map((t) => ({ ...t }))),
    getBookmarkFolders: () => answer("getBookmarkFolders", () => library.folders.map(folderRow)),
    getBookmarks: () => answer("getBookmarks", () => library.bookmarks.map((b) => ({ ...b }))),
    getCollections: () => answer("getCollections", () => library.collections.map(collectionRow)),

    createBookmarkFolder: (name: string) =>
      answer("createBookmarkFolder", () => folderRow(library.folders.find((f) => f.id === addFolder(name))!)),
    // Its bookmarks go with it, as the rows cascade on the server.
    deleteBookmarkFolder: (id: number) =>
      answer("deleteBookmarkFolder", () => {
        library.folders = library.folders.filter((f) => f.id !== id);
        library.bookmarks = library.bookmarks.filter((b) => b.folder_id !== id);
      }),
    createCollection: (name: string) =>
      answer("createCollection", () =>
        collectionRow(library.collections.find((c) => c.id === addCollection(name))!)
      ),
    deleteCollection: (id: number) =>
      answer("deleteCollection", () => {
        library.collections = library.collections.filter((c) => c.id !== id);
      }),

    // The owner of a free, tokenless install.
    getAuth: () => answer("getAuth", () => ({ admin: true, token_required: false, library_open: false })),
    getWorkspaces: () => answer("getWorkspaces", () => ({ workspaces: [] })),
    getPapers: () => answer("getPapers", () => ({ papers: [], journals: [] })),
    getMeshHeadings: () =>
      answer("getMeshHeadings", () => ({
        headings: [],
        filing: { filed: 0, indexed: 0, none: 0, pending: 0, unchecked: 0 },
        truncated: false,
      })),
    getCollectionFiles: () => answer("getCollectionFiles", () => ({ files: [] })),
    getImportStatus: () => answer("getImportStatus", () => idle),
    getFolderImports: () => answer("getFolderImports", () => []),
    getFolderImportStatus: () => answer("getFolderImportStatus", () => idle),
  } satisfies SourcesApi & Partial<Api>;

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
    addFolder,
    bookmark(folderId: number, ...pmids: string[]) {
      for (const pmid of pmids) library.bookmarks.push({ folder_id: folderId, pmid });
    },
    addCollection,
    // Every call to this method fails, saying so, until it recovers.
    fail(method: Method, message = "The server couldn't be reached.") {
      failing.set(method, message);
    },
    recover(method: Method) {
      failing.delete(method);
    },
    // Hold back the next call to this method, answering it only when the
    // function this returns is called: how a test lands two overlapping
    // requests in the order it wants.
    hold(method: Method): () => void {
      let release!: () => void;
      held.set(method, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
  };
}
