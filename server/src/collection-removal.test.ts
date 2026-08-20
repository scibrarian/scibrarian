import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQL_PARAMS_PER_CHUNK } from "../../shared/sqlite.js";
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
    expect(db.removeCollectionPapers(pfizer, [])).toEqual({ removed: 0, papers: 0 });
    expect(names(pfizer)).toHaveLength(4);
  });

  it("takes every copy of a doubled paper, not just the lowest-id one", () => {
    // Two files removed for the one paper asked for — which is why both counts
    // come back, and why the caller reports them rather than echoing what it
    // sent. A notice built from the request's own length would say "1 paper"
    // over two vanished rows; one built from `removed` alone would say "2
    // papers" over one.
    expect(db.removeCollectionPapers(pfizer, ["11111111"])).toEqual({ removed: 2, papers: 1 });
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
    expect(db.removeCollectionPapers(pfizer, ["99999999"])).toEqual({ removed: 0, papers: 0 });
    expect(names(pfizer)).toHaveLength(2);
  });

  it("removes several papers in one call", () => {
    // Two asked for, one held — the shortfall the notice has to report rather
    // than claim two papers left.
    expect(db.removeCollectionPapers(novartis, ["11111111", "22222222"])).toEqual({
      removed: 1,
      papers: 1,
    });
    expect(names(novartis)).toEqual([]);
  });
});

// Past SQL_PARAMS_PER_CHUNK the removal is several DELETEs where the caller
// asked for one, which is the whole reason it runs under a transaction. Its own
// collection, because these tests share a database and a fixture this size
// would swamp the assertions above.
describe("a removal that spans several chunks", () => {
  const CHUNKS = 3;
  const COUNT = SQL_PARAMS_PER_CHUNK * CHUNKS - 1;
  // Poisoned in the last chunk, so a failure can only be observed by the first
  // two chunks' rows coming back.
  const POISON = String(COUNT - 1).padStart(8, "0");
  let big: number;

  const pmidAt = (i: number) => String(i).padStart(8, "0");
  const hashAt = (i: number) => i.toString(16).padStart(64, "0");
  const fileCount = () => db.listCollectionFiles(big).length;

  beforeAll(() => {
    big = db.createCollection("Bulk").id;
    db.addCollectionFiles(
      big,
      Array.from({ length: COUNT }, (_, i) => ({ hash: hashAt(i), name: `paper-${i}.pdf` }))
    );
    const files = db.listCollectionFiles(big);
    for (let i = 0; i < COUNT; i++) db.setFileMatched(files[i].id, pmidAt(i), "pmid");
  });

  // A BEFORE DELETE trigger that aborts on one row is the only way to fail
  // part-way through for real: the failure has to come from SQLite, mid-loop,
  // with earlier chunks already applied. Nothing is mocked, so what the test
  // observes is what a genuine mid-removal error would leave behind.
  const withPoisonedRow = (fn: () => void) => {
    db.db.exec(`
      CREATE TEMP TRIGGER poison BEFORE DELETE ON collection_files
      WHEN OLD.pmid = '${POISON}'
      BEGIN SELECT RAISE(ABORT, 'poisoned row'); END
    `);
    try {
      fn();
    } finally {
      db.db.exec("DROP TRIGGER poison");
    }
  };

  // Ordered so the fixture is built once: the failure leaves it whole, which is
  // the assertion, and only the last case empties it.
  it("removes nothing at all when a later chunk fails", () => {
    const everything = Array.from({ length: COUNT }, (_, i) => pmidAt(i));
    withPoisonedRow(() => {
      expect(() => db.removeCollectionPapers(big, everything)).toThrow();
    });
    // The point of the transaction: the first two chunks' DELETEs had already
    // succeeded when the third aborted. Unwrapped, this came back holding only
    // its last chunk — 899 of 2699 rows — with the earlier files' blobs and
    // pdf_text rows stranded, nothing left naming their hashes to collect them.
    expect(fileCount()).toBe(COUNT);
  });

  it("still collects the orphaned text once the removal commits", () => {
    // The GC moved outside the transaction, so this pins that it still runs
    // after a successful one. pdf_text is keyed by content_hash and is the half
    // of the GC a test can observe — addCollectionFiles writes rows, not bytes,
    // so there is nothing on disk for deleteBlobs to unlink.
    const hash = hashAt(0);
    db.savePdfText({ contentHash: hash, text: "hello", pages: 1, truncated: false });
    const textRows = () =>
      (
        db.db.prepare("SELECT COUNT(*) AS c FROM pdf_text WHERE content_hash = ?").get(hash) as {
          c: number;
        }
      ).c;
    expect(textRows()).toBe(1);

    expect(db.removeCollectionPapers(big, [pmidAt(0)])).toEqual({ removed: 1, papers: 1 });
    expect(textRows()).toBe(0);
  });

  it("removes every chunk's papers, not just the first", () => {
    const spare = db.createCollection("Bulk spare").id;
    db.addCollectionFiles(spare, [{ hash: HASH("f"), name: "keep.pdf" }]);
    db.setFileMatched(db.listCollectionFiles(spare)[0].id, pmidAt(1), "pmid");

    // One fewer than COUNT: the case above already took pmidAt(0), and passing
    // it again is the "pmid this collection doesn't hold" case at scale.
    const everything = Array.from({ length: COUNT }, (_, i) => pmidAt(i));
    expect(db.removeCollectionPapers(big, everything)).toEqual({
      removed: COUNT - 1,
      papers: COUNT - 1,
    });
    expect(fileCount()).toBe(0);
    // And the chunking still didn't reach past this collection, which is the
    // bind-order bug a chunked DELETE fails at silently: `extra` params go
    // after the chunk's ids, so a statement expecting them first would scope
    // the delete to the wrong collection, or to none.
    expect(db.listCollectionFiles(spare)).toHaveLength(1);
  });
});
