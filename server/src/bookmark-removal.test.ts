import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Removing papers from a bookmark folder — the folder table's "Remove selected".
//
// The count is what this pins. The notice above the table is built from it, and
// the one number it must never be is the length of what was sent: a tick set of
// three that another tab had already taken one out of reports two, and a pmid
// sent twice is one paper.
//
// And the scope, for the reason collection-removal.test.ts gives for its own:
// the same paper saved in a second folder is that folder's, and the paper
// itself is the app's. Taking it out of one list touches neither.

let db: Db;
let toRead: number;
let cited: number;

function article(pmid: string) {
  return {
    pmid,
    title: `Paper ${pmid}`,
    abstract: "",
    journal_name: "Lancet",
    nlm_id: "0053266",
    authors: ["Smith J"],
    pub_date: "2021-01-01",
    pub_date_display: "2021",
    doi: `10.1000/${pmid}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

const ALL = ["11111111", "22222222", "33333333"];

const saved = (folderId: number) =>
  db
    .listBookmarks()
    .filter((b) => b.folder_id === folderId)
    .map((b) => b.pmid)
    .sort();

beforeAll(async () => {
  db = await openTempDb("bookmark-removal");
  db.upsertArticles(ALL.map(article));
  toRead = db.createBookmarkFolder("To read").id;
  cited = db.createBookmarkFolder("Cited").id;
  db.addBookmarks(toRead, ALL);
  // One paper in both folders: the row a removal from the other must not reach.
  db.addBookmarks(cited, ["11111111"]);
});

afterAll(closeTempDb);

describe("removing papers from a bookmark folder", () => {
  it("ignores an empty list without touching anything", () => {
    expect(db.removeBookmarks(toRead, [])).toBe(0);
    expect(saved(toRead)).toEqual(ALL);
  });

  it("ignores a pmid this folder doesn't hold", () => {
    expect(db.removeBookmarks(toRead, ["99999999"])).toBe(0);
    expect(saved(toRead)).toEqual(ALL);
  });

  it("removes several papers in one call, and counts a repeated one once", () => {
    expect(db.removeBookmarks(toRead, ["11111111", "22222222", "11111111"])).toBe(2);
    expect(saved(toRead)).toEqual(["33333333"]);
  });

  it("leaves the same paper saved in another folder alone", () => {
    expect(saved(cited)).toEqual(["11111111"]);
  });

  it("reports the shortfall when something else got there first", () => {
    // Two asked for, one still there — the first went in the test above, as it
    // would have from another tab.
    expect(db.removeBookmarks(toRead, ["22222222", "33333333"])).toBe(1);
    expect(saved(toRead)).toEqual([]);
  });

  it("leaves the papers themselves in the app", () => {
    expect([...db.existingPmids(ALL)].sort()).toEqual(ALL);
  });
});
