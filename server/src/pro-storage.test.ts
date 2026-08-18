import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Filing a paper pulled down from a master.
//
// Two things are being pinned here, and neither is the happy path. First, the
// filename arrives from another instance over the network, and lands in a
// column the archive route hands to a zip writer as an entry name — a path.
// Second, the collection may already hold these exact bytes, in which case the
// insert is a no-op and there is a pre-existing row, possibly one the user
// matched by hand, that must not be quietly rewritten to agree with the master.

type Storage = typeof import("./pro-storage.js");
type Blob = typeof import("./blobstore.js");
type Config = typeof import("./config.js");

let db: Db;
let storage: Storage;
let blob: Blob;
let config: Config;

// Distinct bytes per test, so content-addressed storage doesn't make two cases
// collide on one hash.
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n`, "latin1");

const PULLED = "40000001";
const MINE = "40000002";

/**
 * A collection with a name nothing else in this file can collide with.
 *
 * Every test here shares one database. It has to: db.ts opens its connection at
 * import time, so openTempDb can only run once per file, and vitest caches the
 * module graph — a second call in beforeEach would hand back the first
 * database. Collections carry `UNIQUE INDEX … ON collections(name COLLATE
 * NOCASE)`, so a literal reused by a later test throws SQLITE_CONSTRAINT_UNIQUE
 * from inside createCollection, with nothing pointing at the sibling test
 * eighty lines away that took the name first.
 *
 * That trap was live: three names in this file had to be hand-disambiguated
 * ("Acme Medical (bad bytes)") for exactly this reason, which is a fix that
 * only holds until the next person writes the obvious thing.
 */
let collectionSeq = 0;
const collection = (label: string) => storage.newCollection(`${label} #${++collectionSeq}`);

function article(pmid: string) {
  return {
    pmid,
    title: `Paper ${pmid}`,
    abstract: "",
    journal_name: "J Test Med",
    mesh: { status: "MEDLINE", headings: [] },
    nlm_id: null,
    authors: ["Smith J"],
    pub_date: "2024-01-01",
    pub_date_display: "2024",
    doi: `10.1000/${pmid}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

beforeAll(async () => {
  db = await openTempDb("pro-storage");
  storage = await import("./pro-storage.js");
  blob = await import("./blobstore.js");
  config = await import("./config.js");
  // Seeded so ensureArticle is satisfied locally: an unseeded PMID would send
  // it to PubMed, and these tests don't touch the network.
  db.upsertArticles([article(PULLED), article(MINE)]);
});

afterAll(closeTempDb);

describe("safeFileName", () => {
  it("keeps only the last path segment", () => {
    expect(blob.safeFileName("../../evil.pdf")).toBe("evil.pdf");
    expect(blob.safeFileName("..\\..\\evil.pdf")).toBe("evil.pdf");
    expect(blob.safeFileName("/etc/passwd")).toBe("passwd");
  });

  // The case a `replace(/^.*[\\/]/, "")` strip misses entirely: regex `.` does
  // not cross a line terminator, so the separators survive it untouched.
  it("strips a path that hides behind a newline", () => {
    expect(blob.safeFileName("a\n../../evil.pdf")).toBe("evil.pdf");
    expect(blob.safeFileName("ok.pdf\n../../evil.pdf")).toBe("evil.pdf");
  });

  it("drops control characters", () => {
    expect(blob.safeFileName("re\u0000port\u007f.pdf")).toBe("report.pdf");
    expect(blob.safeFileName("two\nlines.pdf")).toBe("twolines.pdf");
  });

  it("falls back for names that resolve to no file at all", () => {
    expect(blob.safeFileName("..")).toBe("upload.pdf");
    expect(blob.safeFileName(".")).toBe("upload.pdf");
    expect(blob.safeFileName("some/dir/")).toBe("upload.pdf");
    expect(blob.safeFileName("   ")).toBe("upload.pdf");
    expect(blob.safeFileName("../x/", "40000001.pdf")).toBe("40000001.pdf");
  });

  // Names arriving already decoded must not be transcoded a second time —
  // that is why cleanUploadName wraps this rather than the other way round.
  it("leaves a legitimate non-ASCII name alone", () => {
    expect(blob.safeFileName("Müller — étude (2024).pdf")).toBe("Müller — étude (2024).pdf");
  });
});

describe("storePulledFile", () => {
  it("files the PDF, sanitises the master's name, and matches by PMID", async () => {
    const id = collection("Acme Medical");
    const out = await storage.storePulledFile({
      bytes: pdf("pulled"),
      // A hostile master's filename. Stored verbatim this becomes a zip entry
      // that escapes the folder the recipient extracts into.
      fileName: "../../evil.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });

    expect(out).not.toBeNull();
    const row = db.getCollectionFile(out!.filed[0].fileId);
    expect(row?.file_name).toBe("evil.pdf");
    expect(row?.pmid).toBe(PULLED);
    expect(row?.match_status).toBe("matched");
    expect(row?.match_method).toBe("pmid");
  });

  it("rejects bytes that aren't a PDF, writing nothing", async () => {
    const id = collection("Acme Medical");
    const before = db.listCollectionFiles(id).length;
    const out = await storage.storePulledFile({
      bytes: Buffer.from("<html>not a pdf</html>"),
      fileName: "trap.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });
    expect(out).toBeNull();
    expect(db.listCollectionFiles(id)).toHaveLength(before);
  });

  // The finding this test exists for. Same bytes already in the collection,
  // matched by hand to a different paper: INSERT OR IGNORE is a no-op, and the
  // old code then rewrote that row to the master's PMID — silently replacing
  // the user's match and making the paper they *did* hold answer not-held.
  it("keeps an existing manual match when the collection already holds the bytes", async () => {
    const id = collection("Overlap");
    const bytes = pdf("shared-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));

    db.addCollectionFiles(id, [{ hash, name: "my-copy.pdf" }]);
    const mine = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;
    db.setFileMatched(mine.id, MINE, "manual");

    const out = await storage.storePulledFile({
      bytes,
      fileName: "master-copy.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });

    // The pull still succeeds and points at the row that holds these bytes...
    expect(out?.filed[0].fileId).toBe(mine.id);
    // ...but nothing about the user's match was touched.
    const row = db.getCollectionFile(mine.id);
    expect(row?.pmid).toBe(MINE);
    expect(row?.match_method).toBe("manual");
    expect(row?.file_name).toBe("my-copy.pdf");
  });

  it("matches a pre-existing row that nothing had claimed yet", async () => {
    const id = collection("Unclaimed");
    const bytes = pdf("unmatched-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));
    db.addCollectionFiles(id, [{ hash, name: "scan.pdf" }]);

    const out = await storage.storePulledFile({
      bytes,
      fileName: "scan.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });

    const row = db.getCollectionFile(out!.filed[0].fileId);
    expect(row?.pmid).toBe(PULLED);
    expect(row?.match_method).toBe("pmid");
  });

  // The multi-destination path, which is the whole reason this takes a list.
  it("files one blob onto every shelf asked for, and reports each", async () => {
    const a = collection("Multi A");
    const b = collection("Multi B");
    const c = collection("Multi C");
    const bytes = pdf("three-shelves");

    const out = await storage.storePulledFile({
      bytes,
      fileName: "paper.pdf",
      pmid: PULLED,
      collectionIds: [a, b, c],
    });

    expect(out?.failed).toEqual([]);
    expect(out?.filed.map((f) => f.collectionId)).toEqual([a, b, c]);
    // Three rows over one blob — the property the whole shape exists for.
    for (const f of out!.filed) {
      const row = db.getCollectionFile(f.fileId);
      expect(row?.content_hash).toBe(out!.hash);
      expect(row?.pmid).toBe(PULLED);
      expect(row?.match_status).toBe("matched");
    }
    expect(new Set(out!.filed.map((f) => f.fileId)).size).toBe(3);
  });

  // A shelf named twice is one shelf. UNIQUE(collection_id, content_hash) only
  // ever allows one row, so reporting two would claim a copy that isn't there.
  it("files a repeated destination once", async () => {
    const id = collection("Repeated");
    const out = await storage.storePulledFile({
      bytes: pdf("repeated-shelf"),
      fileName: "paper.pdf",
      pmid: PULLED,
      collectionIds: [id, id, id],
    });
    expect(out?.filed).toHaveLength(1);
    expect(db.listCollectionFiles(id)).toHaveLength(1);
  });

  // The conflict. A shelf that already holds these exact bytes under someone's
  // manual match keeps that match — and must say so, because the paper is not
  // retrievable there as the PMID that was pulled. Reported as "filed but not
  // matched to the pull", never as a plain success: the caller uses it to
  // decide whether the organisation may be recorded as having supplied a paper
  // this row is not, and to tell the writer why the row will not go held.
  it("flags a shelf whose existing manual match disagrees with the pull", async () => {
    const id = collection("Disagrees");
    const bytes = pdf("conflicting-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));
    db.addCollectionFiles(id, [{ hash, name: "mine.pdf" }]);
    const mine = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;
    db.setFileMatched(mine.id, MINE, "manual");

    const out = await storage.storePulledFile({
      bytes,
      fileName: "theirs.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });

    expect(out!.filed).toEqual([
      { collectionId: id, fileId: mine.id, matchedToPull: false, matchedTo: MINE },
    ]);
    // The user's match is untouched, as before.
    expect(db.getCollectionFile(mine.id)?.pmid).toBe(MINE);
  });

  // The other side of the same branch: already matched to the paper being
  // pulled is agreement, not conflict, and the org did supply these bytes.
  it("treats a row already matched to the pulled paper as a clean file", async () => {
    const id = collection("Agrees");
    const bytes = pdf("agreeing-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));
    db.addCollectionFiles(id, [{ hash, name: "same.pdf" }]);
    const row = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;
    db.setFileMatched(row.id, PULLED, "manual");

    const out = await storage.storePulledFile({
      bytes,
      fileName: "same.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });
    expect(out!.filed[0]).toMatchObject({ fileId: row.id, matchedToPull: true });
    expect(out!.filed[0].matchedTo).toBeUndefined();
  });

  // A destination that cannot be written is reported rather than thrown, and
  // must not take the shelves that worked down with it: those rows are real,
  // and the paper genuinely is in the library.
  it("keeps the shelves that worked when one fails", async () => {
    const ok = collection("Survives");
    const gone = 999_999; // no such collection — the FK refuses the insert
    const out = await storage.storePulledFile({
      bytes: pdf("partial-failure"),
      fileName: "paper.pdf",
      pmid: PULLED,
      collectionIds: [ok, gone],
    });

    expect(out).not.toBeNull();
    expect(out!.filed.map((f) => f.collectionId)).toEqual([ok]);
    expect(out!.failed.map((f) => f.collectionId)).toEqual([gone]);
    expect(db.listCollectionFiles(ok)).toHaveLength(1);
  });

  it("leaves no temp file behind, on either outcome", async () => {
    const id = collection("Acme Medical");
    await storage.storePulledFile({
      bytes: pdf("temp-check"),
      fileName: "ok.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });
    await storage.storePulledFile({
      bytes: Buffer.from("not a pdf"),
      fileName: "bad.pdf",
      pmid: PULLED,
      collectionIds: [id],
    });
    expect(fs.readdirSync(config.UPLOAD_TMP_DIR)).toHaveLength(0);
  });
});

// What may leave this library, and what may not.
//
// A manual match is a person asserting a PDF is a given paper; the route checks
// the PMID exists and cannot check the file is it. Locally that is the writer's
// own business. Crossing the seam it is not, so these never become candidates —
// and are counted instead, because an exclusion nobody can see is its own bug.
describe("what syncs and what is held back", () => {
  it("excludes a hand-matched file from the push candidates, and counts it", async () => {
    const id = collection("Mixed matches");
    const scanned = await blob.storeBlobFromTemp(await tmpWith(pdf("scanner-matched")));
    const byHand = await blob.storeBlobFromTemp(await tmpWith(pdf("hand-matched")));
    db.addCollectionFiles(id, [
      { hash: scanned.hash, name: "scanned.pdf" },
      { hash: byHand.hash, name: "byhand.pdf" },
    ]);
    const rows = db.listCollectionFiles(id);
    const a = rows.find((f) => f.content_hash === scanned.hash)!;
    const b = rows.find((f) => f.content_hash === byHand.hash)!;
    db.setFileMatched(a.id, PULLED, "pmid");
    db.setFileMatched(b.id, MINE, "manual");

    expect(storage.matchedFilesIn(id).map((f) => f.id)).toEqual([a.id]);
    expect(storage.manualMatchCountIn(id)).toBe(1);
  });

  it("counts nothing when everything was matched by evidence", async () => {
    const id = collection("All scanned");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf("all-scanned")));
    db.addCollectionFiles(id, [{ hash, name: "s.pdf" }]);
    const row = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;
    db.setFileMatched(row.id, PULLED, "doi");

    expect(storage.matchedFilesIn(id)).toHaveLength(1);
    expect(storage.manualMatchCountIn(id)).toBe(0);
  });

  // Unmatched rows are excluded by both, and counted by neither: nothing is
  // being withheld from the organisation, there is simply no paper yet.
  it("does not count an unmatched file as held back", async () => {
    const id = collection("Still pending");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf("pending-row")));
    db.addCollectionFiles(id, [{ hash, name: "p.pdf" }]);

    expect(storage.matchedFilesIn(id)).toHaveLength(0);
    expect(storage.manualMatchCountIn(id)).toBe(0);
  });

  // `matched` with no PMID: neither half may claim the row. There is no
  // identity for the other end to file it by, so it is not a candidate — and it
  // is not being withheld from anyone either, so it is not a held-back count.
  // Both used to read it off one hydrated row and agree by construction; they
  // are now two predicates in two queries, which is exactly where they can
  // drift apart.
  it("ignores a matched row that carries no PMID", async () => {
    const id = collection("Matched but nameless");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf("no-pmid")));
    db.addCollectionFiles(id, [{ hash, name: "n.pdf" }]);
    const row = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;

    db.setFileMatched(row.id, "", "pmid");
    expect(storage.matchedFilesIn(id)).toHaveLength(0);
    expect(storage.manualMatchCountIn(id)).toBe(0);

    // ...and the same when it was a person who said so.
    db.setFileMatched(row.id, "", "manual");
    expect(storage.matchedFilesIn(id)).toHaveLength(0);
    expect(storage.manualMatchCountIn(id)).toBe(0);
  });
});

// The push candidates, and the pair that fetches their bytes.
//
// These two are one mechanism: matchedFilesIn decides what may leave this
// library, readFileBytes hands over the bytes, and the collection is the
// boundary between them. Both halves are checked in the open repo on purpose —
// the closed module supplies the ids, and "the caller only ever passes ids we
// gave it" is not something this side can verify or should assume.

describe("matchedFilesIn", () => {
  // Seeds a row with the exact name given, the way a build that predates
  // sanitising-on-upload left them in the database.
  //
  // Matched by "pmid", deliberately. These tests are about names and collection
  // tagging, and a "manual" match would make every one of them pass or fail on
  // the *exclusion* instead — which is checked on its own above.
  async function seed(collectionId: number, name: string, marker: string, pmid?: string) {
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf(marker)));
    db.addCollectionFiles(collectionId, [{ hash, name }]);
    const row = db.listCollectionFiles(collectionId).find((f) => f.content_hash === hash)!;
    if (pmid) db.setFileMatched(row.id, pmid, "pmid");
    return row.id;
  }

  it("returns only rows matched to a paper", async () => {
    const id = collection("Candidates");
    const matched = await seed(id, "matched.pdf", "cand-matched", PULLED);
    await seed(id, "pending.pdf", "cand-pending");

    const out = storage.matchedFilesIn(id);
    expect(out.map((f) => f.id)).toEqual([matched]);
    expect(out[0].pmid).toBe(PULLED);
  });

  it("tags each row with the collection it came from", async () => {
    const id = collection("Tagged");
    await seed(id, "one.pdf", "tagged-one", PULLED);
    expect(storage.matchedFilesIn(id)[0].collection_id).toBe(id);
  });

  // The row this exists for: written before the column was cleaned on the way
  // in, and read here to build an outbound request. A newline in a filename is
  // a second header on that request.
  it("sanitises a legacy file_name on the way out", async () => {
    const id = collection("Legacy");
    await seed(id, "report.pdf\nX-Injected: 1", "legacy-header", PULLED);
    expect(storage.matchedFilesIn(id)[0].file_name).toBe("report.pdfX-Injected: 1");

    const id2 = collection("Legacy traversal");
    await seed(id2, "../../etc/passwd.pdf", "legacy-path", MINE);
    expect(storage.matchedFilesIn(id2)[0].file_name).toBe("passwd.pdf");
  });

  it("falls back to the PMID when the stored name sanitises to nothing", async () => {
    const id = collection("Nameless");
    await seed(id, "..", "nameless", PULLED);
    expect(storage.matchedFilesIn(id)[0].file_name).toBe(`${PULLED}.pdf`);
  });
});

describe("readFileBytes", () => {
  it("returns the bytes for a file in the collection asked for", async () => {
    const id = collection("Readable");
    const bytes = pdf("readable");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));
    db.addCollectionFiles(id, [{ hash, name: "ok.pdf" }]);
    const row = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;

    expect(storage.readFileBytes(id, row.id)).toEqual(bytes);
  });

  // The engagement boundary. A writer keeps a collection local precisely so its
  // PDFs are not copied to the agency; a bare file id would make that promise
  // depend on the closed module never handing over an id from the wrong list.
  it("refuses a file that belongs to a different collection", async () => {
    const shared = collection("Shared with Acme");
    const priv = collection("Kept local");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf("private")));
    db.addCollectionFiles(priv, [{ hash, name: "confidential.pdf" }]);
    const row = db.listCollectionFiles(priv).find((f) => f.content_hash === hash)!;

    // Readable as part of its own collection...
    expect(storage.readFileBytes(priv, row.id)).not.toBeNull();
    // ...and not as part of one it was never in.
    expect(storage.readFileBytes(shared, row.id)).toBeNull();
  });

  it("is null for a row that doesn't exist", () => {
    const id = collection("Readable");
    expect(storage.readFileBytes(id, 999_999)).toBeNull();
  });

  it("is null when the row outlived its blob", async () => {
    const id = collection("Lost blob");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(pdf("lost")));
    db.addCollectionFiles(id, [{ hash, name: "gone.pdf" }]);
    const row = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;

    fs.unlinkSync(blob.blobPath(hash));
    expect(storage.readFileBytes(id, row.id)).toBeNull();
  });
});

// A temp file in the same directory the blob store renames out of, so
// storeBlobFromTemp can be used directly to seed content.
async function tmpWith(bytes: Buffer): Promise<string> {
  fs.mkdirSync(config.UPLOAD_TMP_DIR, { recursive: true });
  const p = `${config.UPLOAD_TMP_DIR}/seed-${Math.random().toString(36).slice(2)}.pdf`;
  await fs.promises.writeFile(p, bytes);
  return p;
}
