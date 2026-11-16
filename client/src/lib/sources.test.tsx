// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createSources, SourcesContext, useReloadToken, useSavedIn } from "./sources";
import { createTestApi } from "../test-api";
import type { PaperSource } from "../types";
import { MAX_LINKS_PER_REQUEST } from "../../../shared/limits";

// The store's own bookkeeping, against a library held in memory (test-api.ts).
// What a view does with what it holds is that view's test's.

afterEach(cleanup);

function setUp() {
  const server = createTestApi();
  return { server, sources: createSources(server.api) };
}

describe("reading the lists", () => {
  it("reads the topics, and says why when it can't", async () => {
    const { server, sources } = setUp();
    server.addTopic("Asthma");
    expect(await sources.loadTopics()).toHaveLength(1);

    server.addTopic("Gout");
    server.fail("getTopics", "Offline.");
    expect(await sources.loadTopics()).toBeNull();
    expect(sources.topics().map((t) => t.name)).toEqual(["Asthma"]);
    expect(sources.topicsError()).toBe("Offline.");

    server.recover("getTopics");
    await sources.loadTopics();
    expect(sources.topics()).toHaveLength(2);
    expect(sources.topicsError()).toBeNull();
  });

  it("keeps the folders and collections it had when they can't be read", async () => {
    const { server, sources } = setUp();
    server.addFolder("Reading");
    server.addCollection("Thesis");
    await Promise.all([sources.loadFolders(), sources.loadCollections()]);

    server.addFolder("Later");
    server.fail("getBookmarkFolders");
    server.fail("getCollections");
    expect(await sources.loadFolders()).toEqual([]);
    expect(await sources.loadCollections()).toEqual([]);
    expect(sources.folders().map((f) => f.name)).toEqual(["Reading"]);
    expect(sources.collections().map((c) => c.name)).toEqual(["Thesis"]);
  });

  it("files each bookmark under its paper", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    server.bookmark(reading, "1", "2");
    server.bookmark(later, "2");
    await sources.loadBookmarks();
    expect(sources.saved()).toEqual(new Map([["1", new Set([reading])], ["2", new Set([reading, later])]]));
  });

  it("keeps the saved map it had when the bookmarks can't be read", async () => {
    const { server, sources } = setUp();
    server.bookmark(server.addFolder("Reading"), "1");
    await sources.loadBookmarks();
    const before = sources.saved();
    server.fail("getBookmarks");
    await sources.loadBookmarks();
    expect(sources.saved()).toBe(before);
  });
});

// Reads overlap — a lookup round's refresh and a toggle's, two refreshes a
// quick pair of clicks started — and the server answers them in whatever order
// it likes. The last answer to land is not the latest, and a list that took it
// went back to how it was before the newer read.
describe("overlapping reads", () => {
  it("keep the folders the later read found, whichever answer lands last", async () => {
    const { server, sources } = setUp();
    server.addFolder("Reading");
    const release = server.hold("getBookmarkFolders");
    const earlier = sources.loadFolders();
    server.addFolder("Later");
    await sources.loadFolders();
    release();
    await earlier;
    expect(sources.folders().map((f) => f.name)).toEqual(["Reading", "Later"]);
  });

  it("keep the collections the later read found", async () => {
    const { server, sources } = setUp();
    const release = server.hold("getCollections");
    const earlier = sources.loadCollections();
    server.addCollection("Thesis");
    await sources.loadCollections();
    release();
    await earlier;
    expect(sources.collections()).toHaveLength(1);
  });

  it("keep the topics the later read found, and its word on whether they could be read", async () => {
    const { server, sources } = setUp();
    server.fail("getTopics");
    const release = server.hold("getTopics");
    const earlier = sources.loadTopics();
    server.recover("getTopics");
    server.addTopic("Asthma");
    await sources.loadTopics();
    release();
    await earlier;
    expect(sources.topics()).toHaveLength(1);
    expect(sources.topicsError()).toBeNull();
  });

  it("keep the saved map the later read found", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const release = server.hold("getBookmarks");
    const earlier = sources.loadBookmarks();
    server.bookmark(reading, "1");
    await sources.loadBookmarks();
    release();
    await earlier;
    expect(sources.saved().get("1")).toEqual(new Set([reading]));
  });

  // The toggle is applied to the map in place of a read, and a read already
  // out may have been answered before the toggle reached the server: landing
  // after it, it would put the paper back as it was. Nor can it simply be
  // dropped, since it may carry other changes — a lookup round's bookmarks — so
  // it is read again.
  it("don't undo a toggle made while one was out", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const release = server.hold("getBookmarks");
    const earlier = sources.loadBookmarks();
    server.bookmark(reading, "1"); // a lookup round, saving a paper
    await sources.addBookmark(reading, "2");
    release();
    await earlier;
    await vi.waitFor(() => expect(sources.saved().get("1")).toEqual(new Set([reading])));
    expect(sources.saved().get("2")).toEqual(new Set([reading]));
  });
});

describe("bookmark folders", () => {
  it("saves a paper into a folder and takes it out again, counting it in the folder", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    await sources.addBookmark(reading, "1");
    await sources.addBookmark(later, "1");
    expect(sources.saved().get("1")).toEqual(new Set([reading, later]));
    expect(sources.folders().map((f) => f.paperCount)).toEqual([1, 1]);
    await sources.removeBookmark(reading, "1");
    await sources.removeBookmark(later, "1");
    expect(sources.saved().has("1")).toBe(false);
    expect(sources.folders().map((f) => f.paperCount)).toEqual([0, 0]);
  });

  // The views read the map through useSaved, which re-renders only for a
  // different value.
  it("replaces the saved map on a toggle rather than changing the one it handed out", async () => {
    const { server, sources } = setUp();
    const before = sources.saved();
    await sources.addBookmark(server.addFolder("Reading"), "1");
    expect(sources.saved()).not.toBe(before);
    expect(before.size).toBe(0);
  });

  // A folder's membership is its paper list, on screen or not; the topic the
  // paper was saved from lists the same papers as before.
  it("makes a toggle's folder stale, and nothing else", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    await sources.addBookmark(reading, "1");
    await sources.removeBookmark(reading, "1");
    expect(sources.tokenFor({ folder: reading })).toBe(2);
    expect(sources.tokenFor({ folder: later })).toBe(0);
    expect(sources.tokenFor({ topic: 9 })).toBe(0);
  });

  it("saves many at once, and says how many were in the folder already", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    await sources.addBookmark(reading, "1");
    expect(await sources.addBookmarks(reading, ["1", "2", "3"])).toMatchObject({ added: 2, alreadySaved: 1 });
    expect([...sources.saved().keys()]).toEqual(["1", "2", "3"]);
    expect(sources.folders()[0].paperCount).toBe(3);
    expect(sources.tokenFor({ folder: reading })).toBe(2);
  });

  it("makes a folder, listing it", async () => {
    const { sources } = setUp();
    const made = await sources.createFolder("Reading");
    expect(sources.folders()).toEqual([made]);
  });

  it("renames a folder, and reads the list again for its new name", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    await sources.loadFolders();
    await sources.renameFolder(reading, "Read");
    await vi.waitFor(() => expect(sources.folders()[0].name).toBe("Read"));
  });

  // The folder's table, ticked.
  it("takes papers out of a folder, and reads its list, its count and the saved map again", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    server.bookmark(reading, "1", "2");
    await Promise.all([sources.loadFolders(), sources.loadBookmarks()]);
    expect(await sources.removeBookmarks(reading, ["1"])).toEqual({ removed: 1 });
    // At once, not behind the reads: the rows the table dimmed wait on it.
    expect(sources.tokenFor({ folder: reading })).toBe(1);
    await vi.waitFor(() => expect(sources.folders()[0].paperCount).toBe(1));
    expect(sources.saved().has("1")).toBe(false);
  });

  it("takes a deleted folder off the list at once, and its papers out of the saved map", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    server.bookmark(reading, "1");
    await Promise.all([sources.loadFolders(), sources.loadBookmarks()]);
    const release = server.hold("getBookmarkFolders");
    await sources.deleteFolder(reading);
    expect(sources.folders().map((f) => f.id)).toEqual([later]);
    release();
    await vi.waitFor(() => expect(sources.saved().has("1")).toBe(false));
  });

  // SQLite may hand the dead id to the next folder created.
  it("makes every source stale when a folder is deleted", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    await sources.deleteFolder(reading);
    expect(sources.tokenFor({ folder: reading })).toBe(1);
    expect(sources.tokenFor({ collection: 5 })).toBe(1);
  });
});

describe("topics", () => {
  it("checks one topic for new papers, reading the topics again, and makes that topic stale", async () => {
    const { server, sources } = setUp();
    const asthma = server.addTopic("Asthma");
    const gout = server.addTopic("Gout");
    server.library.unpolled.set(asthma.id, 3);
    const { results, topics } = await sources.checkForPapers(asthma.id);
    expect(results.map((r) => [r.topicName, r.added])).toEqual([["Asthma", 3]]);
    expect(topics?.find((t) => t.id === asthma.id)?.articleCount).toBe(3);
    expect(sources.topics()).toBe(topics);
    expect(sources.tokenFor({ topic: asthma.id })).toBe(1);
    expect(sources.tokenFor({ topic: gout.id })).toBe(0);
  });

  it("checks every topic when given none, making every source stale", async () => {
    const { server, sources } = setUp();
    server.addTopic("Asthma");
    server.addTopic("Gout");
    const { results } = await sources.checkForPapers(null);
    expect(results).toHaveLength(2);
    expect(sources.tokenFor({ folder: 9 })).toBe(1);
  });

  // There is nothing to count what the check did against.
  it("answers with no topics when they couldn't be read after a check", async () => {
    const { server, sources } = setUp();
    const asthma = server.addTopic("Asthma");
    server.fail("getTopics");
    expect((await sources.checkForPapers(asthma.id)).topics).toBeNull();
    expect(sources.tokenFor({ topic: asthma.id })).toBe(1);
  });

  // So that a caller can go to it, the list having it.
  it("makes a topic, answering once the topics have been read with it", async () => {
    const { sources } = setUp();
    const made = await sources.createTopic(["D001249"], { allPubmed: true, journals: [] }, "Asthma");
    expect(sources.topics().map((t) => t.id)).toEqual([made.id]);
    expect(sources.tokenFor({ topic: made.id })).toBe(0);
  });

  it("reads a changed topic's row again, and its papers only when a change of scope took some out", async () => {
    const { server, sources } = setUp();
    const asthma = server.addTopic("Asthma");
    await sources.updateTopic(asthma.id, { name: "Asthma in children" });
    expect(sources.topics()[0].name).toBe("Asthma in children");
    expect(sources.tokenFor({ topic: asthma.id })).toBe(0);
    server.library.outOfScope.set(asthma.id, 2);
    const { removed } = await sources.updateTopic(asthma.id, { allPubmed: false, journals: ["1"] });
    expect(removed.removedFromInterests).toBe(2);
    expect(sources.tokenFor({ topic: asthma.id })).toBe(1);
  });

  // Its papers are cached under the bookmarks and the graph as well as its
  // own feed.
  it("removes a topic, making every source stale when papers went with it", async () => {
    const { server, sources } = setUp();
    const asthma = server.addTopic("Asthma");
    const gout = server.addTopic("Gout");
    server.library.topics[1].articleCount = 4;
    expect(await sources.deleteTopic(asthma.id)).toEqual({ deletedArticles: 0 });
    expect(sources.topics().map((t) => t.id)).toEqual([gout.id]);
    expect(sources.tokenFor({ folder: 9 })).toBe(0);
    expect(await sources.deleteTopic(gout.id)).toEqual({ deletedArticles: 4 });
    expect(sources.topics()).toEqual([]);
    expect(sources.tokenFor({ folder: 9 })).toBe(1);
  });
});

describe("a reset", () => {
  it("empties every list and the saved map at once, and makes every source stale", async () => {
    const { server, sources } = setUp();
    server.addTopic("Asthma");
    server.bookmark(server.addFolder("Reading"), "1");
    server.addCollection("Thesis");
    await Promise.all([sources.loadTopics(), sources.loadFolders(), sources.loadCollections(), sources.loadBookmarks()]);
    const release = server.hold("getTopics");
    expect(await sources.resetLibrary()).toMatchObject({ topics: 1, folders: 1, collections: 1 });
    expect([sources.topics(), sources.folders(), sources.collections()]).toEqual([[], [], []]);
    expect(sources.saved().size).toBe(0);
    expect(sources.tokenFor({ topic: 1 })).toBe(1);
    release();
    await vi.waitFor(() => expect(sources.topicsError()).toBeNull());
  });
});

describe("collections", () => {
  it("makes a collection, listing it, and shares it only when asked", async () => {
    const { server, sources } = setUp();
    const { collection: thesis, shareError } = await sources.createCollection("Thesis", { share: true });
    const { collection: notes } = await sources.createCollection("Notes", { share: false });
    expect(shareError).toBeNull();
    expect(sources.collections().map((c) => c.name)).toEqual(["Thesis", "Notes"]);
    expect([...server.library.shared]).toEqual([thesis.id]);
    expect(server.library.shared.has(notes.id)).toBe(false);
  });

  // It exists, and the writer is about to be dropped into it.
  it("keeps a collection it couldn't share, saying why", async () => {
    const { server, sources } = setUp();
    server.fail("proShareCollection", "Not paired.");
    const { collection, shareError } = await sources.createCollection("Thesis", { share: true });
    expect(shareError).toBe("Not paired.");
    expect(sources.collections()).toEqual([expect.objectContaining({ id: collection.id })]);
  });

  // The check-holdings dialog's copy from the organization. It used to make
  // stale only the collection on screen, and one visited earlier in the
  // session went on painting its cached list without the paper. Every
  // collection at once aggregates them all, so it goes stale too. Bumped
  // before the list is read again, which the papers fetch doesn't wait on.
  it("makes every collection a copy went into stale, on screen or not, before reading the list", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const notes = server.addCollection("Notes");
    const grants = server.addCollection("Grants");
    const release = server.hold("getCollections");
    await sources.pullToCollections("7", [thesis, notes]);
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
    expect(sources.tokenFor({ collection: notes })).toBe(1);
    expect(sources.tokenFor({ allCollections: true })).toBe(1);
    expect(sources.tokenFor({ collection: grants })).toBe(0);
    release();
    await vi.waitFor(() =>
      expect(sources.collections().map((c) => c.heldCount)).toEqual([1, 1, 0])
    );
  });

  it("takes a deleted collection off the list at once, and makes every source stale", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const notes = server.addCollection("Notes");
    await sources.loadCollections();
    const release = server.hold("getCollections");
    await sources.deleteCollection(thesis);
    expect(sources.collections().map((c) => c.id)).toEqual([notes]);
    expect(sources.tokenFor({ folder: 9 })).toBe(1);
    release();
  });

  it("renames a collection, reading the list again", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    await sources.renameCollection(thesis, "Dissertation");
    await vi.waitFor(() => expect(sources.collections()[0].name).toBe("Dissertation"));
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
  });

  // The unmatched-files dialog: a file matched by hand, or taken out.
  it("makes a collection stale when one of its files is matched or deleted", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const file = server.addFile(thesis, "a.pdf");
    await sources.matchFile(file, "7");
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
    await vi.waitFor(() => expect(sources.collections()[0].heldCount).toBe(1));
    await sources.deleteFile(file);
    expect(sources.tokenFor({ collection: thesis })).toBe(2);
    expect(sources.tokenFor({ allCollections: true })).toBe(2);
    await vi.waitFor(() => expect(sources.collections()[0].fileCount).toBe(0));
  });

  // The collection's table, ticked.
  it("takes papers out of a collection, and makes it stale at once", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    await sources.matchFile(server.addFile(thesis, "a.pdf"), "7");
    await sources.matchFile(server.addFile(thesis, "b.pdf"), "7");
    expect(await sources.removeFromCollection(thesis, ["7"])).toEqual({ removed: 2, papers: 1 });
    expect(sources.tokenFor({ collection: thesis })).toBe(3);
    await vi.waitFor(() => expect(sources.collections()[0].heldCount).toBe(0));
  });
});

describe("adding files to a collection", () => {
  const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
  const pdfs = (n: number) => Array.from({ length: n }, (_, i) => pdf(`${i}.pdf`));

  // Twenty to a request, so a large selection isn't one gigantic body.
  it("sends them in batches, saying how many have gone up, then asks for the scan", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const sent: number[] = [];
    let uploadedBeforeScan = false;
    const upload = await sources.addFiles(thesis, pdfs(45), {
      batch: (n) => sent.push(n),
      uploaded: () => {
        uploadedBeforeScan = sources.scans.get(thesis) === undefined;
      },
    });
    expect(sent).toEqual([20, 40, 45]);
    expect(upload).toEqual({ added: 45, skipped: 0, failedFiles: 0, failure: null });
    expect(uploadedBeforeScan).toBe(true);
    expect(sources.scans.get(thesis)).toEqual({ state: "idle" });
  });

  // Here the scan's start answers with it over already, and its end is the
  // refresh. It used to be followed by a second, whose read overtook the
  // first's and threw it away.
  it("refreshes the collection once, after the scan is asked for", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const reads = vi.spyOn(server.api, "getCollections");
    await sources.addFiles(thesis, pdfs(45), { batch: () => {}, uploaded: () => {} });
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
    await vi.waitFor(() => expect(sources.collections()[0].fileCount).toBe(45));
    expect(reads).toHaveBeenCalledTimes(1);
  });

  // For the files just added, now; the scan's end refreshes it again for what
  // the scan matched.
  it("refreshes the collection while its scan runs", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    server.library.scans.set(thesis, {
      jobId: "job",
      state: "running",
      total: 1,
      processed: 0,
      matched: 0,
      unmatched: 0,
      errors: 0,
      currentFile: null,
      startedAt: "2026-11-04T00:00:00Z",
      finishedAt: null,
    });
    await sources.addFiles(thesis, pdfs(1), { batch: () => {}, uploaded: () => {} });
    expect(sources.scans.get(thesis)).toMatchObject({ state: "running" });
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
    await vi.waitFor(() => expect(sources.collections()[0].fileCount).toBe(1));
    sources.stop();
  });

  // Whatever made one request fail usually has nothing to do with the next.
  it("goes on past a batch that fails, and still asks for the scan", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    let calls = 0;
    const upload = server.api.uploadFiles;
    server.api.uploadFiles = (id, files) => (++calls === 2 ? Promise.reject(new Error("Blip.")) : upload(id, files));
    const result = await sources.addFiles(thesis, pdfs(45), { batch: () => {}, uploaded: () => {} });
    expect(result).toMatchObject({ added: 25, failedFiles: 20 });
    expect((result.failure as Error).message).toBe("Blip.");
    expect(sources.scans.get(thesis)).toEqual({ state: "idle" });
  });

  it("answers with the scan's failure to start when the upload went through", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    server.fail("startImport", "An import is already running for this collection.");
    const result = await sources.addFiles(thesis, pdfs(1), { batch: () => {}, uploaded: () => {} });
    expect(result).toMatchObject({ added: 1, failedFiles: 0 });
    expect((result.failure as Error).message).toBe("An import is already running for this collection.");
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
  });

  it("scans the files an earlier scan didn't reach", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    await sources.scanCollection(thesis);
    expect(sources.scans.get(thesis)).toEqual({ state: "idle" });
  });
});

describe("a collection's scan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Whether or not the collection is on screen: one left before its scan
  // ended came back painting its pre-scan file list from cache.
  it("refreshes its collection when it ends", async () => {
    const { server, sources } = setUp();
    const thesis = server.addCollection("Thesis");
    const scan = {
      jobId: "job",
      state: "running" as const,
      total: 2,
      processed: 0,
      matched: 0,
      unmatched: 0,
      errors: 0,
      currentFile: null,
      startedAt: "2026-11-04T00:00:00Z",
      finishedAt: null,
    };
    sources.scans.start(thesis, scan);
    server.library.scans.set(thesis, scan);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources.tokenFor({ collection: thesis })).toBe(0);
    server.library.scans.set(thesis, { ...scan, state: "done", processed: 2, matched: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources.tokenFor({ collection: thesis })).toBe(1);
    expect(sources.tokenFor({ allCollections: true })).toBe(1);
    sources.stop();
  });
});

describe("Add links", () => {
  const links = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `https://pubmed.ncbi.nlm.nih.gov/${from + i}/`);
  // Two requests' worth: one full, one of five.
  const paste = links(MAX_LINKS_PER_REQUEST + 5);

  it("sends a batch at a time, in order, and refreshes the folder once, after the last", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const sent: [number, number][] = [];
    await sources.addLinks(reading, paste, (batch, _answer, from) => {
      sent.push([from, batch.length]);
      return true;
    });
    expect(sent).toEqual([
      [0, MAX_LINKS_PER_REQUEST],
      [MAX_LINKS_PER_REQUEST, 5],
    ]);
    expect(sources.tokenFor({ folder: reading })).toBe(1);
    await vi.waitFor(() => expect(sources.saved().size).toBe(paste.length));
  });

  it("doesn't refresh the folder when nothing was added", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    server.bookmark(reading, "0", "1");
    await sources.addLinks(reading, links(2), () => true);
    expect(sources.tokenFor({ folder: reading })).toBe(0);
  });

  // The dialog has gone: the folder view is keyed by folder, so leaving the
  // folder mid-paste unmounts it.
  it("sends no more when told to, and still refreshes for the batch that landed", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    await sources.addLinks(reading, paste, () => false);
    expect(server.library.bookmarks).toHaveLength(MAX_LINKS_PER_REQUEST);
    expect(sources.tokenFor({ folder: reading })).toBe(1);
  });

  it("stops at a batch that fails, and refreshes once for those that landed before it", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const run = sources.addLinks(reading, paste, () => {
      server.fail("addBookmarkLinks", "Couldn’t reach PubMed.");
      return true;
    });
    await expect(run).rejects.toThrow("Couldn’t reach PubMed.");
    expect(server.library.bookmarks).toHaveLength(MAX_LINKS_PER_REQUEST);
    expect(sources.tokenFor({ folder: reading })).toBe(1);
  });
});

describe("imported entries", () => {
  const lookup = {
    jobId: "job",
    state: "running" as const,
    total: 2,
    processed: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    currentFile: null,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: null,
  };

  it("follows the lookup an import starts, and the one Look them up does", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    server.library.lookups.set(reading, lookup);
    server.library.lookups.set(later, lookup);
    await sources.importToFolder(reading, new File([""], "refs.ris"));
    await sources.lookUpImports(later);
    expect(sources.lookups.get(reading)).toBe(lookup);
    expect(sources.lookups.get(later)).toBe(lookup);
    sources.stop();
  });

  it("saves the paper an entry is given into its folder", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const entry = {
      id: 50,
      folder_id: reading,
      title: "Not indexed",
      authors: "",
      journal: "",
      year: "",
      doi: null,
      pmid: null,
      status: "unmatched" as const,
      reason: "not-in-pubmed" as const,
      added_at: "",
    };
    server.library.imports.push(entry);
    await sources.setImportPmid(entry, "9");
    expect(sources.tokenFor({ folder: reading })).toBe(1);
    await vi.waitFor(() => expect(sources.saved().get("9")).toEqual(new Set([reading])));
  });
});

describe("a folder's lookup", () => {
  const job = { jobId: "job", total: 2, processed: 0, unmatched: 0, errors: 0, currentFile: null };
  const at = { startedAt: "2026-11-04T00:00:00Z", finishedAt: null };
  const running = (matched: number) => ({ ...job, ...at, state: "running" as const, matched });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // It saves papers for minutes after the import that started it, and the
  // folder fills in as it goes rather than all at once at the end — on screen
  // or not.
  it("refreshes its folder after each round that saves papers, and at its end", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    server.library.lookups.set(reading, running(0));
    sources.lookups.start(reading, running(0));

    server.bookmark(reading, "1");
    server.library.lookups.set(reading, running(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources.saved().has("1")).toBe(true);
    expect(sources.tokenFor({ folder: reading })).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sources.tokenFor({ folder: reading })).toBe(1);

    server.bookmark(reading, "2");
    server.library.lookups.set(reading, { ...running(2), state: "done", processed: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources.saved().has("2")).toBe(true);
    expect(sources.tokenFor({ folder: reading })).toBe(2);
    sources.stop();
  });
});

describe("reload tokens", () => {
  const folder: PaperSource = { folder: 1 };
  const collection: PaperSource = { collection: 1 };
  const everyCollection: PaperSource = { allCollections: true };

  it("moves one source's token, and no other's", () => {
    const { sources } = setUp();
    sources.reloadSource(collection);
    expect(sources.tokenFor(collection)).toBe(1);
    // The same id, a different source.
    expect(sources.tokenFor(folder)).toBe(0);
    expect(sources.tokenFor(everyCollection)).toBe(0);
  });

  it("moves every source's token at once, those never moved before too", () => {
    const { sources } = setUp();
    sources.reloadSource(collection);
    sources.reloadEverything();
    expect(sources.tokenFor(collection)).toBe(2);
    expect(sources.tokenFor(folder)).toBe(1);
    expect(sources.tokenFor({ topic: 9 })).toBe(1);
  });
});

describe("the hooks", () => {
  function mount(read: () => unknown) {
    const { server, sources } = setUp();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SourcesContext.Provider value={sources}>{children}</SourcesContext.Provider>
    );
    let renders = 0;
    const view = renderHook(
      () => {
        renders++;
        return read();
      },
      { wrapper }
    );
    return { server, sources, view, renders: () => renders };
  }

  it("re-render a view when its own source's token moves, and not for another's", () => {
    const { sources, view, renders } = mount(() => useReloadToken({ folder: 1 }));
    const before = renders();
    act(() => sources.reloadSource({ folder: 2 }));
    expect(renders()).toBe(before);
    act(() => sources.reloadSource({ folder: 1 }));
    expect(view.result.current).toBe(1);
    expect(renders()).toBe(before + 1);
  });

  it("don't re-render a paper's bookmark control when only a token moves", () => {
    const { sources, renders } = mount(() => useSavedIn("1"));
    const before = renders();
    act(() => sources.reloadSource({ folder: 1 }));
    expect(renders()).toBe(before);
  });

  // Hundreds of rows read the saved map, one paper each.
  it("re-render the bookmark control of the paper toggled, and no other's", async () => {
    const { server, sources, view, renders } = mount(() => useSavedIn("1"));
    const reading = server.addFolder("Reading");
    const before = renders();
    await act(() => sources.addBookmark(reading, "2"));
    expect(renders()).toBe(before);
    await act(() => sources.addBookmark(reading, "1"));
    expect(view.result.current).toEqual(new Set([reading]));
    expect(renders()).toBe(before + 1);
  });
});
