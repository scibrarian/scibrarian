import type { api as realApi } from "./api";
import type { SourcesApi } from "./lib/sources";
import type {
  BookmarkEntry,
  BookmarkFolder,
  BookmarkImport,
  Collection,
  CollectionFile,
  ElsewhereHolding,
  HaveAnswer,
  ImportStatus,
  LinkAnswer,
  LinkedPaper,
  ProPullResult,
  ProSyncStatus,
  Topic,
  TopicScopeInput,
} from "./types";
import { MAX_LINKS_PER_REQUEST } from "../../shared/limits";

// An in-memory server for the client's tests: a library of topics, bookmark
// folders, bookmarks and collections, answering as api.ts's methods do. The
// store (lib/sources) is built on it in place of api.ts, so a test sets up a
// library, does what the reader would, and asks what the store holds after —
// rather than which requests went out. App's tests render the whole shell on
// it, which is what the reads below the store's own are for: what the views
// ask for as they mount, answered as an empty source would be. The
// check-holdings dialog's tests ask it what the library, the organization and
// the other workspaces hold.
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
    // The files uploaded into collections, which their counts are taken from.
    files: [] as CollectionFile[],
    // What PubMed has for each topic that its feed doesn't yet: how many new
    // papers the next check finds.
    unpolled: new Map<number, number>(),
    // How many of each topic's papers a change of its scope takes out.
    outOfScope: new Map<number, number>(),
    // The collections shared with the organization.
    shared: new Set<number>(),
    // The collections shared with an organization this library is no longer
    // paired with.
    sharedBefore: new Set<number>(),
    // The papers the organization holds, by PMID, and whether it can be asked.
    orgHolds: new Set<string>(),
    orgUnreachable: false,
    // The papers held in another workspace on this machine, by PMID.
    elsewhere: new Map<string, ElsewhereHolding>(),
    // Entries imported into folders and not yet bookmarks.
    imports: [] as BookmarkImport[],
    // Each collection's scan, as its status route reports it; idle when absent.
    scans: new Map<number, ImportStatus>(),
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
  const ORG = "The organization";

  function folderRow(f: (typeof library.folders)[number]): BookmarkFolder {
    return { ...f, paperCount: library.bookmarks.filter((b) => b.folder_id === f.id).length };
  }

  function collectionRow(c: (typeof library.collections)[number]): Collection {
    const files = library.files.filter((f) => f.collection_id === c.id);
    const matched = files.filter((f) => f.pmid != null);
    return {
      ...c,
      fileCount: files.length,
      matchedCount: matched.length,
      heldCount: new Set(matched.map((f) => f.pmid)).size,
    };
  }

  // The headings the search has offered, by UI, so a topic made from them
  // can be named as the server names one.
  const headingNames = new Map<string, string>();

  // A file uploaded and not yet scanned.
  function addFile(collectionId: number, name: string): CollectionFile {
    const file: CollectionFile = {
      id: nextId++,
      collection_id: collectionId,
      file_name: name,
      pmid: null,
      match_status: "pending",
      match_method: "",
      match_error: "",
      added_at: created,
      exists: true,
    };
    library.files.push(file);
    return file;
  }

  function addTopic(name: string, scope?: TopicScopeInput): Topic {
    const topic: Topic = {
      id: nextId++,
      name,
      term: name,
      headings: [],
      all_pubmed: scope?.allPubmed ?? true,
      journalCount: scope?.journals.length ?? 0,
      last_polled_at: null,
      created_at: created,
      articleCount: 0,
    };
    library.topics.push(topic);
    return topic;
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

  // One line of a holdings check, read as a PubMed link. The library holds a
  // paper when a collection has a file matched to it.
  function haveAnswer(input: string): HaveAnswer {
    const pmid = input.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
    const checked = {
      identifierChecked: true,
      orgChecked: !library.orgUnreachable,
      elsewhereChecked: true,
      verdictComplete: !library.orgUnreachable,
    };
    if (!pmid) {
      const parsed = { kind: "unknown" as const, input, reason: "No DOI or PubMed link in this line." };
      return { parsed, held: false, match: null, org: null, elsewhere: null, ...checked };
    }
    const file = library.files.find((f) => f.pmid === pmid);
    const collection = file && library.collections.find((c) => c.id === file.collection_id);
    const match = file && {
      ...paper(pmid),
      pub_date: "",
      doi: "",
      held: true,
      file_id: file.id,
      file_name: file.file_name,
      file_exists: file.exists,
      collection_id: file.collection_id,
      collection_name: collection?.name ?? null,
      evidence: "untyped" as const,
      pub_types: [],
    };
    return {
      parsed: { kind: "pmid", input, pmid },
      held: file != null,
      match: match ?? null,
      org: !library.orgUnreachable && library.orgHolds.has(pmid) ? { pmid, node: ORG } : null,
      elsewhere: library.elsewhere.get(pmid) ?? null,
      ...checked,
    };
  }

  function stamp(collectionId: number, active: boolean) {
    const master_url = "https://org.example";
    return { collection_id: collectionId, master_url, org_name: ORG, since: created, active, ended: false };
  }

  const api = {
    getTopics: () => answer("getTopics", () => library.topics.map((t) => ({ ...t }))),
    createTopic: (headings: string[], scope: TopicScopeInput, name?: string) =>
      answer("createTopic", () => {
        const named = name ?? headings.map((ui) => headingNames.get(ui) ?? ui).join(" + ");
        return { ...addTopic(named, scope), journals: [] };
      }),
    // A change of scope takes out of the feed what the test said it would.
    updateTopic: (id: number, change: { name?: string; allPubmed?: boolean }) =>
      answer("updateTopic", () => {
        const topic = library.topics.find((t) => t.id === id)!;
        if (change.name) topic.name = change.name;
        const removedFromInterests = change.allPubmed != null ? (library.outOfScope.get(id) ?? 0) : 0;
        topic.articleCount = (topic.articleCount ?? 0) - removedFromInterests;
        return { topic: { ...topic, journals: [] }, removed: { deletedArticles: 0, removedFromInterests } };
      }),
    // Every paper in its feed is taken as its own, and deleted with it.
    deleteTopic: (id: number) =>
      answer("deleteTopic", () => {
        const topic = library.topics.find((t) => t.id === id)!;
        library.topics = library.topics.filter((t) => t !== topic);
        return { deletedArticles: topic.articleCount ?? 0 };
      }),
    resetLibrary: () =>
      answer("resetLibrary", () => {
        const stats = {
          topics: library.topics.length,
          journals: 0,
          papers: 0,
          folders: library.folders.length,
          collections: library.collections.length,
          files: library.files.length,
        };
        Object.assign(library, { topics: [], folders: [], bookmarks: [], collections: [], files: [] });
        return stats;
      }),
    // A check for new papers, under one topic or every one: each takes what
    // PubMed has for it into its feed.
    refresh: (topicId?: number) =>
      answer("refresh", () => ({
        results: library.topics
          .filter((t) => topicId == null || t.id === topicId)
          .map((t) => {
            const added = library.unpolled.get(t.id) ?? 0;
            library.unpolled.delete(t.id);
            t.articleCount = (t.articleCount ?? 0) + added;
            return { topicId: t.id, topicName: t.name, found: added, added };
          }),
        polledAt: created,
      })),
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
    proShareCollection: (id: number) =>
      answer("proShareCollection", () => {
        library.shared.add(id);
        return { shared_with: ORG };
      }),
    renameCollection: (id: number, name: string) =>
      answer("renameCollection", () => {
        const collection = library.collections.find((c) => c.id === id)!;
        collection.name = name;
        return collectionRow(collection);
      }),
    deleteCollection: (id: number) =>
      answer("deleteCollection", () => {
        library.collections = library.collections.filter((c) => c.id !== id);
        library.files = library.files.filter((f) => f.collection_id !== id);
      }),
    uploadFiles: (id: number, files: File[]) =>
      answer("uploadFiles", () => {
        for (const file of files) addFile(id, file.name);
        return { added: files.length, skipped: 0 };
      }),
    startImport: (id: number) => answer("startImport", () => library.scans.get(id) ?? idle),
    setFilePmid: (fileId: number, pmid: string) =>
      answer("setFilePmid", () => {
        const file = library.files.find((f) => f.id === fileId)!;
        Object.assign(file, { pmid, match_status: "matched", match_method: "manual" });
        return { ...file };
      }),
    deleteCollectionFile: (fileId: number) =>
      answer("deleteCollectionFile", () => {
        library.files = library.files.filter((f) => f.id !== fileId);
      }),
    // A copy from the organization's library, filed matched in each
    // collection asked for — except one already holding the same file matched
    // by hand to another paper, which is left alone and warned about.
    proPull: (pmid: string, collectionIds: number[]) =>
      answer<ProPullResult>("proPull", () => {
        const fileName = `${pmid}.pdf`;
        const clashes = (id: number) =>
          library.files.some(
            (f) => f.collection_id === id && f.file_name === fileName && f.match_method === "manual"
          );
        const filed = collectionIds.filter((id) => !clashes(id));
        for (const id of filed) {
          Object.assign(addFile(id, fileName), { pmid, match_status: "matched", match_method: "pmid" });
        }
        const left = collectionIds
          .filter(clashes)
          .map((id) => library.collections.find((c) => c.id === id)!.name);
        return {
          pmid,
          collection_ids: filed,
          file_name: fileName,
          ...(left.length > 0 && { warning: `${left.join(", ")} already holds this file, matched by hand.` }),
        };
      }),
    removeCollectionPapers: (id: number, pmids: string[]) =>
      answer("removeCollectionPapers", () => {
        const going = library.files.filter((f) => f.collection_id === id && f.pmid && pmids.includes(f.pmid));
        library.files = library.files.filter((f) => !going.includes(f));
        return { removed: going.length, papers: new Set(going.map((f) => f.pmid)).size };
      }),

    // The check-holdings dialog's.
    checkHave: (refs: string[]) =>
      answer("checkHave", () => ({ results: refs.map(haveAnswer), truncated: 0 })),
    proSync: () =>
      answer<ProSyncStatus>("proSync", () => ({
        stamps: [
          ...[...library.shared].map((id) => stamp(id, true)),
          ...[...library.sharedBefore].map((id) => stamp(id, false)),
        ],
      })),

    // The heading search finds one heading, named as typed; it matches no
    // papers, and the library suggests none.
    searchMesh: (q: string) =>
      answer("searchMesh", () => {
        headingNames.set(`M-${q}`, q);
        return { results: [{ ui: `M-${q}`, name: q, synonym: null }] };
      }),
    previewTopic: () => answer("previewTopic", () => ({ term: "", count: 0 })),
    suggestTopics: () => answer("suggestTopics", () => ({ results: [], heldPapers: 0, unchecked: 0 })),
    topicArticleCount: (id: number) =>
      answer("topicArticleCount", () => ({
        count: library.topics.find((t) => t.id === id)?.articleCount ?? 0,
      })),
    getSettings: () =>
      answer("getSettings", () => ({
        ncbi_email: "",
        poll_cron: "",
        poll_enabled: false,
        library_open: false,
        has_api_key: false,
        alert_email_enabled: false,
        alert_email_to: "",
        smtp_host: "",
        smtp_port: "",
        smtp_user: "",
        smtp_from: "",
        has_smtp_pass: false,
        share_urls: [],
        desktop: false,
      })),
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
    getCollectionFiles: (id: number) =>
      answer("getCollectionFiles", () => ({
        files: library.files.filter((f) => f.collection_id === id).map((f) => ({ ...f })),
      })),
    getImportStatus: (collectionId: number) =>
      answer("getImportStatus", () => library.scans.get(collectionId) ?? idle),
    getFolderImports: (folderId: number) =>
      answer("getFolderImports", () => library.imports.filter((e) => e.folder_id === folderId)),
    getFolderImportStatus: (folderId: number) =>
      answer("getFolderImportStatus", () => library.lookups.get(folderId) ?? idle),
  } satisfies SourcesApi & Partial<Api>;

  return {
    api,
    library,
    addTopic: (name: string) => addTopic(name),
    addFolder,
    bookmark(folderId: number, ...pmids: string[]) {
      for (const pmid of pmids) library.bookmarks.push({ folder_id: folderId, pmid });
    },
    addCollection,
    addFile,
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
