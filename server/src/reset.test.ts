import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// "Delete all data" — the one operation here with no predicate narrowing it.
//
// A database test rather than a unit test, because what makes it correct is
// which rows and which files are left afterwards, and every way of getting that
// wrong is silent. Two directions, both of them:
//
// Too little, and the reset lies. A table nobody remembered to name survives
// with rows in it — pdf_text and paper_citations are the candidates, since
// neither carries a foreign key and so nothing cascades to them — and the
// library that was supposedly deleted keeps answering full-text searches with
// documents that no longer exist. The blobs are the same failure on disk: rows
// gone, bytes still there, and nothing left naming their hashes to collect them.
//
// Too much, and it destroys things nobody asked it to. The MeSH vocabulary and
// the NLM journal catalog are downloads, not contents; taking them costs a
// multi-minute re-fetch and leaves both typeaheads dead in the meantime —
// including the one you would use to add the first topic back. The settings row
// is the same argument about the owner's own NCBI key.
//
// Both halves are asserted from one fixture, on purpose: they are the same
// decision seen from either side, and a test that only pinned the deletion
// would go green for a `DROP` of everything.

let db: Db;
let blobPath: (hash: string) => string;

const HASH = (c: string) => c.repeat(64);
const HELD = HASH("a");
const SHARED = HASH("b");

function article(pmid: string, title: string) {
  return {
    pmid,
    title,
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

const count = (table: string): number =>
  (db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

beforeAll(async () => {
  db = await openTempDb("reset");
  // After openTempDb, so BLOBS_DIR is already redirected into the temp
  // directory by the time blobstore.ts runs its module body.
  ({ blobPath } = await import("./blobstore.js"));

  // Reference data — the half that has to survive.
  db.bulkUpsertCatalog([
    {
      nlm_id: "0053266",
      title: "The Lancet",
      med_abbr: "Lancet",
      iso_abbr: "Lancet",
      issn_print: "0140-6736",
      issn_online: "1474-547X",
    },
  ]);
  db.replaceMeshData(
    [{ ui: "D003924", name: "Diabetes Mellitus, Type 2", terms: ["NIDDM", "Adult-Onset Diabetes"] }],
    "2026"
  );
  db.setSetting("ncbi_email", "owner@example.com");
  db.setSetting("ncbi_api_key", "secret-key");

  // Contents — the half that has to go. Everything below is something a person
  // put here.
  const topic = db.createTopic("Diabetes Mellitus, Type 2", "diabetes").id;
  db.createJournal("The Lancet", "0053266", true);
  db.saveArticles([article("11111111", "Metformin in cohort A")], topic);
  db.upsertArticles([article("22222222", "A paper held as a file")]);
  db.saveArticleMesh([
    {
      pmid: "11111111",
      status: "MEDLINE",
      headings: [{ ui: "D003924", name: "Diabetes Mellitus, Type 2", major: true }],
      pubTypes: ["Randomized Controlled Trial"],
    },
  ]);
  db.upsertCitations([
    { pmid: "11111111", info: { citation_count: 7, references: ["22222222"] } },
  ]);

  const folder = db.createBookmarkFolder("To read").id;
  db.addBookmarks(folder, ["11111111"]);

  const pfizer = db.createCollection("Pfizer").id;
  const novartis = db.createCollection("Novartis").id;
  db.addCollectionFiles(pfizer, [
    { hash: HELD, name: "held.pdf" },
    { hash: SHARED, name: "shared.pdf" },
  ]);
  // The same bytes on a second shelf: two rows, one blob. The reset has to
  // unlink it once and not trip over the second row naming it.
  db.addCollectionFiles(novartis, [{ hash: SHARED, name: "shared.pdf" }]);
  db.setFileMatched(db.listCollectionFiles(pfizer)[0].id, "22222222", "pmid");
  db.savePdfText({
    contentHash: HELD,
    text: "Estimated glomerular filtration rate declined over twelve months.",
    pages: 1,
    truncated: false,
  });

  // addCollectionFiles writes rows, not bytes — the store is only ever written
  // through an upload — so the blobs those rows point at are placed by hand.
  for (const hash of [HELD, SHARED]) fs.writeFileSync(blobPath(hash), "%PDF-1.4\n");
});

afterAll(closeTempDb);

describe("deleting all data", () => {
  it("reports what it destroyed", () => {
    // Counted inside the transaction that does the deleting, so these are the
    // rows that actually went rather than a reading taken beforehand — which is
    // also why this is the only way the counts get out. Papers are articles
    // rows and files are collection_files rows: the doubled PDF is three files
    // across two collections, not two.
    expect(db.resetLibrary()).toEqual({
      topics: 1,
      journals: 1,
      papers: 2,
      folders: 1,
      collections: 2,
      files: 3,
    });
  });

  it("leaves nothing behind in any table it owns", () => {
    for (const table of [
      "topics",
      "journals",
      "articles",
      "bookmark_folders",
      "collections",
      "collection_files",
      "paper_citations",
      "pdf_text",
      // Cascades rather than named deletes, which is exactly why they are
      // asserted: a foreign key that stopped cascading would leave these full
      // and nothing else in this suite would notice.
      "article_mesh",
      "article_pub_types",
      "article_topics",
      "bookmarks",
    ]) {
      expect({ table, rows: count(table) }).toEqual({ table, rows: 0 });
    }
  });

  it("takes the full-text index with the text", () => {
    // pdf_text_fts is external-content: it stores its own structures and reads
    // the column values back from pdf_text. Emptying pdf_text without the
    // triggers firing leaves the index still matching a term whose document is
    // gone — a search that answers with a file the library no longer has.
    const hits = (
      db.db
        .prepare("SELECT COUNT(*) AS c FROM pdf_text_fts WHERE pdf_text_fts MATCH ?")
        .get("glomerular") as { c: number }
    ).c;
    expect(hits).toBe(0);
  });

  it("unlinks the stored files", () => {
    // Including the blob two collections shared. Every row referencing it is
    // gone, so it is as orphaned as the single-shelf one — this is the case a
    // per-hash reference count would also have got right, and that a
    // "skip anything referenced twice" shortcut would not.
    for (const hash of [HELD, SHARED]) {
      expect({ hash, onDisk: fs.existsSync(blobPath(hash)) }).toEqual({ hash, onDisk: false });
    }
  });

  it("keeps the reference data it did not put there", () => {
    // The MeSH vocabulary and NLM's journal list are downloads. Clearing them
    // would delete nothing the user filed and cost a re-fetch on the next start
    // — with the topic picker dead until it lands, which is the picker you need
    // to add the first topic back.
    expect(db.journalCatalogCount()).toBe(1);
    expect(db.meshDescriptorCount()).toBe(1);
    expect(db.searchMesh("NIDDM")).toEqual([
      { ui: "D003924", name: "Diabetes Mellitus, Type 2", rank: 1 },
    ]);
    // And the timestamps that say they are loaded, or the next start re-fetches
    // both anyway and the sparing was for nothing.
    expect(db.getCatalogLoadedAt()).not.toBe("");
    expect(db.getMeshVersion()).toBe("2026");
  });

  it("keeps the owner's settings", () => {
    // Configuration, not contents. Someone emptying their library has not asked
    // to go and find their NCBI key again.
    const settings = db.getSettings();
    expect(settings.ncbi_email).toBe("owner@example.com");
    expect(settings.ncbi_api_key).toBe("secret-key");
    expect(settings.poll_cron).not.toBe("");
  });

  it("does not hand out an id twice afterwards", () => {
    // sqlite_sequence is deliberately left alone. The client caches papers per
    // source id, and Pro's tables reference collections and files by id, so a
    // counter that restarted is how a new collection inherits a dead one's
    // cache entries and a dead one's provenance.
    expect(db.createCollection("Fresh start").id).toBeGreaterThan(2);
  });

  it("is safe to run again on the library it just emptied", () => {
    // The second press of a button whose first press appeared to do nothing —
    // and the empty-library case in general, which is what a new install is.
    db.deleteCollection(db.collectionByName("Fresh start")!.id);
    expect(db.resetLibrary()).toEqual({
      topics: 0,
      journals: 0,
      papers: 0,
      folders: 0,
      collections: 0,
      files: 0,
    });
  });
});

// The tail that runs after the delete has committed — past the point where
// anything is still allowed to fail the request.
//
// Both of these are guards rather than features, and both are invisible: take
// either out and every other test in this file still passes. They protect the
// same property from two sides. A wipe that has already happened must be
// reported as having happened, whatever the filesystem does afterwards; and one
// that had nothing to wipe must not pay for a rebuild there is nothing to
// reclaim from.
describe("what happens after the delete has committed", () => {
  const vacuumedDuring = (run: () => void): boolean => {
    const exec = vi.spyOn(db.db, "exec");
    try {
      run();
      return exec.mock.calls.some((c) => String(c[0]).includes("VACUUM"));
    } finally {
      exec.mockRestore();
    }
  };

  it("does not rebuild the database when nothing was deleted", () => {
    // Empty by this point in the file, which is also a new install and the
    // second press of the button. VACUUM rewrites the whole file — the
    // reference data a reset deliberately keeps included, and on a real install
    // mesh_entry_terms alone runs to hundreds of thousands of rows — on a
    // synchronous handle that serves nothing else while it runs.
    expect(vacuumedDuring(() => db.resetLibrary())).toBe(false);
  });

  it("does rebuild it when something was", () => {
    db.createCollection("Something to lose");
    expect(vacuumedDuring(() => db.resetLibrary())).toBe(true);
  });

  it("still reports the deletion when the blobs directory cannot be read", () => {
    db.createCollection("Something to lose");
    // ENOENT out of existingBlobHashes' readdir — the reachable form of a blobs
    // directory that has been moved, remounted or locked. It happens *after*
    // the transaction has committed, so a throw escaping here would report a
    // completed, irreversible deletion as a 500, and leave the route's tail —
    // clearing the import jobs, telling Pro — unrun behind it.
    fs.rmSync(path.dirname(blobPath(HELD)), { recursive: true, force: true });

    let stats: ReturnType<typeof db.resetLibrary> | null = null;
    expect(() => {
      stats = db.resetLibrary();
    }).not.toThrow();
    expect(stats!.collections).toBe(1);
  });
});
