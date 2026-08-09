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
    const id = storage.ensureCollection("Acme Medical");
    const out = await storage.storePulledFile({
      bytes: pdf("pulled"),
      // A hostile master's filename. Stored verbatim this becomes a zip entry
      // that escapes the folder the recipient extracts into.
      fileName: "../../evil.pdf",
      pmid: PULLED,
      collectionId: id,
    });

    expect(out).not.toBeNull();
    const row = db.getCollectionFile(out!.fileId);
    expect(row?.file_name).toBe("evil.pdf");
    expect(row?.pmid).toBe(PULLED);
    expect(row?.match_status).toBe("matched");
    expect(row?.match_method).toBe("pmid");
  });

  it("rejects bytes that aren't a PDF, writing nothing", async () => {
    const id = storage.ensureCollection("Acme Medical");
    const before = db.listCollectionFiles(id).length;
    const out = await storage.storePulledFile({
      bytes: Buffer.from("<html>not a pdf</html>"),
      fileName: "trap.pdf",
      pmid: PULLED,
      collectionId: id,
    });
    expect(out).toBeNull();
    expect(db.listCollectionFiles(id)).toHaveLength(before);
  });

  // The finding this test exists for. Same bytes already in the collection,
  // matched by hand to a different paper: INSERT OR IGNORE is a no-op, and the
  // old code then rewrote that row to the master's PMID — silently replacing
  // the user's match and making the paper they *did* hold answer not-held.
  it("keeps an existing manual match when the collection already holds the bytes", async () => {
    const id = storage.ensureCollection("Overlap");
    const bytes = pdf("shared-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));

    db.addCollectionFiles(id, [{ hash, name: "my-copy.pdf" }]);
    const mine = db.listCollectionFiles(id).find((f) => f.content_hash === hash)!;
    db.setFileMatched(mine.id, MINE, "manual");

    const out = await storage.storePulledFile({
      bytes,
      fileName: "master-copy.pdf",
      pmid: PULLED,
      collectionId: id,
    });

    // The pull still succeeds and points at the row that holds these bytes...
    expect(out?.fileId).toBe(mine.id);
    // ...but nothing about the user's match was touched.
    const row = db.getCollectionFile(mine.id);
    expect(row?.pmid).toBe(MINE);
    expect(row?.match_method).toBe("manual");
    expect(row?.file_name).toBe("my-copy.pdf");
  });

  it("matches a pre-existing row that nothing had claimed yet", async () => {
    const id = storage.ensureCollection("Unclaimed");
    const bytes = pdf("unmatched-content");
    const { hash } = await blob.storeBlobFromTemp(await tmpWith(bytes));
    db.addCollectionFiles(id, [{ hash, name: "scan.pdf" }]);

    const out = await storage.storePulledFile({
      bytes,
      fileName: "scan.pdf",
      pmid: PULLED,
      collectionId: id,
    });

    const row = db.getCollectionFile(out!.fileId);
    expect(row?.pmid).toBe(PULLED);
    expect(row?.match_method).toBe("pmid");
  });

  it("leaves no temp file behind, on either outcome", async () => {
    const id = storage.ensureCollection("Acme Medical");
    await storage.storePulledFile({
      bytes: pdf("temp-check"),
      fileName: "ok.pdf",
      pmid: PULLED,
      collectionId: id,
    });
    await storage.storePulledFile({
      bytes: Buffer.from("not a pdf"),
      fileName: "bad.pdf",
      pmid: PULLED,
      collectionId: id,
    });
    expect(fs.readdirSync(config.UPLOAD_TMP_DIR)).toHaveLength(0);
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
