import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { ALL, FED, FILED, LOOSE, SAVED, seedHoldings } from "./unheld-sweep-fixture.js";

// The sweep that runs at startup: papers nothing holds. And what keeps the
// citation counts of a paper from outliving it.
//
// A paper is held by a topic's feed, a file in the Library or a folder's list,
// and every screen lists papers by one of the three. Letting go of one doesn't
// delete it, so a paper saved from a pasted link and then taken out of its
// folder stayed in the database with no screen to list it and nothing short of
// "Delete all data" to remove it. What is pinned is which papers the sweep
// takes — each kind of holding keeps its paper, alone — and that it is the
// ways of letting go, as they are, that leave a paper for it.

let db: Db;

const stored = () => [...db.existingPmids(ALL)].sort();
const counted = () => [...db.getCitations(ALL).keys()].sort();

let topic: number;
let shelf: number;
let folder: number;

beforeAll(async () => {
  db = await openTempDb("unheld-sweep");
});

afterAll(closeTempDb);

beforeEach(() => {
  ({ topic, shelf, folder } = seedHoldings(db));
});

describe("the sweep of papers nothing holds", () => {
  it("takes the one nothing holds, and what was counted about it", () => {
    expect(db.dropUnheldArticles()).toBe(1);
    expect(stored()).toEqual([FED, FILED, SAVED]);
    expect(counted()).toEqual([FED, FILED, SAVED]);
  });

  it("finds nothing to take the second time", () => {
    db.dropUnheldArticles();
    expect(db.dropUnheldArticles()).toBe(0);
    expect(stored()).toEqual([FED, FILED, SAVED]);
  });

  it("takes a paper whose last folder let go of it, or was deleted", () => {
    const other = db.createBookmarkFolder("Cited").id;
    db.addBookmarks(other, [SAVED, LOOSE]);

    // Still on the other folder's list.
    db.removeBookmarks(folder, [SAVED]);
    db.dropUnheldArticles();
    expect(stored()).toEqual(ALL);

    db.deleteBookmarkFolder(other);
    expect(stored()).toEqual(ALL); // letting go deletes nothing by itself
    expect(db.dropUnheldArticles()).toBe(2);
    expect(stored()).toEqual([FED, FILED]);
  });

  it("takes a paper whose file left the Library", () => {
    db.removeCollectionPapers(shelf, [FILED]);
    db.dropUnheldArticles();
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("takes a paper whose collection was deleted", () => {
    db.deleteCollection(shelf);
    db.dropUnheldArticles();
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("takes a paper its file was matched away from", () => {
    db.setFileMatched(db.listCollectionFiles(shelf)[0].id, LOOSE, "manual");
    db.dropUnheldArticles();
    expect(stored()).toEqual([FED, SAVED, LOOSE]);
  });

  it("keeps a paper a topic's removal spared because a folder has it", () => {
    db.addBookmarks(folder, [FED]);
    db.removeTopicWithArticles(topic);
    db.dropUnheldArticles();
    expect(stored()).toEqual([FED, FILED, SAVED]);
  });
});

describe("the citation counts of a paper", () => {
  it("go with it when a topic's removal deletes it", () => {
    // Removing a topic deletes the papers only it had, and always did. What
    // was counted about them has no foreign key, and used to stay.
    db.removeTopicWithArticles(topic);
    expect(db.existingPmids([FED]).size).toBe(0);
    expect(counted()).toEqual([FILED, SAVED, LOOSE]);
  });

  it("aren't written once it is gone", () => {
    // iCite answering a request made while the paper was stored, after it was
    // deleted.
    db.dropUnheldArticles();
    db.upsertCitations(
      [SAVED, LOOSE].map((pmid) => ({ pmid, info: { citation_count: 9, references: [] } }))
    );
    expect(counted()).toEqual([FED, FILED, SAVED]);
    // The paper that is stored still has its counts replaced.
    expect(db.getCitations([SAVED]).get(SAVED)?.citation_count).toBe(9);
  });
});
