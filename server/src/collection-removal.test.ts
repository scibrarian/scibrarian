import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Removing papers from a collection — the table's "Delete selected".
//
// Worth a database test rather than a unit test because the thing that makes it
// correct is which rows the DELETE matches, and the bug it guards is one the
// types cannot see. `collection_files` is unique on (collection_id,
// content_hash), not on (collection_id, pmid), so a collection may hold two
// files for one article — a preprint and the published PDF. The paper rows the
// client ticks carry MIN(id) of those, so removing by file id deletes one copy
// and leaves the paper still listed, pointing at the other. Only a fixture with
// a doubled paper in it shows the difference.
//
// The opposite error matters just as much and is pinned here too: this must not
// reach into another collection, and it must not delete a blob another
// collection still references. Reuse across engagements is the thing the
// Library exists to make visible, and a removal that quietly took a file out
// from under a different client would be the worst possible way to learn that.

let db: Db;
let pfizer: number;
let novartis: number;

const HASH = (c: string) => c.repeat(64);

beforeAll(async () => {
  db = await openTempDb("collection-removal");
  pfizer = db.createCollection("Pfizer").id;
  novartis = db.createCollection("Novartis").id;

  // Two files, one paper: the case the whole design turns on.
  db.addCollectionFiles(pfizer, [
    { hash: HASH("a"), name: "preprint.pdf" },
    { hash: HASH("b"), name: "published.pdf" },
    // An ordinary single-file paper alongside it.
    { hash: HASH("c"), name: "other.pdf" },
    // Never matched to anything. Removal is keyed on pmid, so this is the row
    // that proves an unmatched file isn't swept up by a NULL comparison.
    { hash: HASH("d"), name: "unmatched.pdf" },
  ]);
  // The same published PDF, also filed for another client — same bytes, so the
  // same blob, and a second row.
  db.addCollectionFiles(novartis, [{ hash: HASH("b"), name: "published.pdf" }]);

  const byName = (collectionId: number, name: string) =>
    db.listCollectionFiles(collectionId).find((f) => f.file_name === name)!.id;
  db.setFileMatched(byName(pfizer, "preprint.pdf"), "11111111", "pmid");
  db.setFileMatched(byName(pfizer, "published.pdf"), "11111111", "pmid");
  db.setFileMatched(byName(pfizer, "other.pdf"), "22222222", "pmid");
  db.setFileMatched(byName(novartis, "published.pdf"), "11111111", "pmid");
});

afterAll(closeTempDb);

const names = (collectionId: number) =>
  db.listCollectionFiles(collectionId).map((f) => f.file_name).sort();

describe("removing papers from a collection", () => {
  it("ignores an empty list without touching anything", () => {
    // The client can send one: ticking a box and un-ticking it leaves an empty
    // selection, and the button is disabled but the route is not the button.
    expect(db.removeCollectionPapers(pfizer, [])).toBe(0);
    expect(names(pfizer)).toHaveLength(4);
  });

  it("takes every copy of a doubled paper, not just the lowest-id one", () => {
    // Two files removed for one paper asked for — which is why the count that
    // comes back is files, and why the caller reports it rather than echoing
    // what it sent.
    expect(db.removeCollectionPapers(pfizer, ["11111111"])).toBe(2);
    expect(names(pfizer)).toEqual(["other.pdf", "unmatched.pdf"]);
  });

  it("leaves the same paper filed under another collection alone", () => {
    expect(names(novartis)).toEqual(["published.pdf"]);
  });

  it("leaves another collection's row on a shared blob standing", () => {
    // The two collections hold the same bytes under one hash. Blob GC is driven
    // by how many rows still reference it, so the surviving Novartis row is
    // precisely what stops the removal above taking the file out from under a
    // different client.
    //
    // The row, not the file: addCollectionFiles writes rows and no blobs, so
    // this fixture has no bytes on disk to assert about. What it can pin is the
    // condition gcBlobsIfOrphaned actually reads.
    expect(db.listCollectionFiles(novartis)).toHaveLength(1);
  });

  it("leaves unmatched files alone", () => {
    // pmid IS NULL on that row. A DELETE built with `IN (?)` over an empty or
    // null-bearing set is the classic way to take out more than was asked for.
    expect(names(pfizer)).toContain("unmatched.pdf");
  });

  it("ignores a pmid this collection doesn't hold", () => {
    expect(db.removeCollectionPapers(pfizer, ["99999999"])).toBe(0);
    expect(names(pfizer)).toHaveLength(2);
  });

  it("removes several papers in one call", () => {
    expect(db.removeCollectionPapers(novartis, ["11111111", "22222222"])).toBe(1);
    expect(names(novartis)).toEqual([]);
  });
});
