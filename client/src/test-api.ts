import type { api as realApi } from "./api";
import type { SourcesApi } from "./lib/sources";
import type {
  BookmarkEntry,
  BookmarkFolder,
  BookmarkImport,
  Collection,
  ImportStatus,
  LinkAnswer,
  LinkedPaper,
  Topic,
} from "./types";
import { MAX_LINKS_PER_REQUEST } from "../../shared/limits";

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
    // Entries imported into folders and not yet bookmarks.
    imports: [] as BookmarkImport[],
    // Each folder's lookup, as its status route reports it; idle when absent.
    lookups: new Map<number, ImportStatus>(),
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

  // The paper a PMID names. The fake holds no papers, so every PMID names one.
  function paper(pmid: string): LinkedPaper {
    return { pmid, title: `Paper ${pmid}`, authors: [], journal_name: "", pub_date_display: "", url: "" };
  }

  function bookmarked(folderId: number, pmid: string): boolean {
    return library.bookmarks.some((b) => b.folder_id === folderId && b.pmid === pmid);
  }

  // One pasted line, read as a PubMed link and saved into the folder.
  function addLink(folderId: number, input: string): LinkAnswer {
    const pmid = input.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
    if (!pmid) return { parsed: { kind: "unknown", input }, outcome: "unreadable", paper: null };
    const parsed = { kind: "pmid" as const, input, pmid };
    if (bookmarked(folderId, pmid)) return { parsed, outcome: "already-saved", paper: paper(pmid) };
    library.bookmarks.push({ folder_id: folderId, pmid });
    return { parsed, outcome: "added", paper: paper(pmid) };
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
      answer("createBookmarkFolder", () => {
        const id = addFolder(name);
        return folderRow(library.folders.find((f) => f.id === id)!);
      }),
    renameBookmarkFolder: (id: number, name: string) =>
      answer("renameBookmarkFolder", () => {
        const folder = library.folders.find((f) => f.id === id)!;
        folder.name = name;
        return folderRow(folder);
      }),
    // Every pmid is taken as a stored paper: the fake holds no papers.
    addBookmarks: (folderId: number, pmids: string[]) =>
      answer("addBookmarks", () => {
        const fresh = pmids.filter((pmid) => !bookmarked(folderId, pmid));
        for (const pmid of fresh) library.bookmarks.push({ folder_id: folderId, pmid });
        return { added: fresh.length, alreadySaved: pmids.length - fresh.length, missing: 0 };
      }),
    removeBookmark: (folderId: number, pmid: string) =>
      answer("removeBookmark", () => {
        library.bookmarks = library.bookmarks.filter((b) => !(b.folder_id === folderId && b.pmid === pmid));
      }),
    removeBookmarks: (folderId: number, pmids: string[]) =>
      answer("removeBookmarks", () => {
        const before = library.bookmarks.length;
        library.bookmarks = library.bookmarks.filter(
          (b) => !(b.folder_id === folderId && pmids.includes(b.pmid))
        );
        return { removed: before - library.bookmarks.length };
      }),
    addBookmarkLinks: (folderId: number, lines: string[]) =>
      answer("addBookmarkLinks", () => ({
        results: lines.slice(0, MAX_LINKS_PER_REQUEST).map((line) => addLink(folderId, line)),
        truncated: Math.max(0, lines.length - MAX_LINKS_PER_REQUEST),
      })),
    // What the file held is the test's to put in library.imports; this only
    // starts the lookup the test has set for the folder.
    importToFolder: (folderId: number) =>
      answer("importToFolder", () => ({
        read: 0,
        notArticles: 0,
        blank: 0,
        queued: 0,
        noIdentifier: 0,
        status: library.lookups.get(folderId) ?? idle,
      })),
    startFolderImport: (folderId: number) =>
      answer("startFolderImport", () => library.lookups.get(folderId) ?? idle),
    setImportPmid: (entryId: number, pmid: string) =>
      answer("setImportPmid", () => {
        const entry = library.imports.find((e) => e.id === entryId)!;
        library.imports = library.imports.filter((e) => e !== entry);
        if (!bookmarked(entry.folder_id, pmid)) library.bookmarks.push({ folder_id: entry.folder_id, pmid });
        return paper(pmid);
      }),
    // Its bookmarks go with it, as the rows cascade on the server.
    deleteBookmarkFolder: (id: number) =>
      answer("deleteBookmarkFolder", () => {
        library.folders = library.folders.filter((f) => f.id !== id);
        library.bookmarks = library.bookmarks.filter((b) => b.folder_id !== id);
      }),
    createCollection: (name: string) =>
      answer("createCollection", () => {
        const id = addCollection(name);
        return collectionRow(library.collections.find((c) => c.id === id)!);
      }),
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
    getFolderImports: (folderId: number) =>
      answer("getFolderImports", () => library.imports.filter((e) => e.folder_id === folderId)),
    getFolderImportStatus: (folderId: number) =>
      answer("getFolderImportStatus", () => library.lookups.get(folderId) ?? idle),
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
