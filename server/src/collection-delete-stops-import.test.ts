import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { article } from "./unheld-sweep-fixture.js";

// Deleting a collection while its PDFs are being scanned.
//
// The delete always looked right from the app: the collection and its papers
// went. What it didn't do was stop the scan, which carried on over rows that
// were gone. Most of that was updates that matched nothing, but the PDF being
// read at the time had its text stored again after the delete had cleared it,
// and the sweep of papers nothing holds, which skips its turn while a scan
// runs, never came back for the ones the deleted collection had held.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "collection-delete-import-token";
const HEADERS = { "x-admin-token": "collection-delete-import-token" };

// Each PDF read is held until the test lets it finish, so the delete can land
// part way through one: the window the text used to come back in. PubMed and
// iCite answer from here, so nothing touches the network.
const scan = vi.hoisted(() => ({
  finishRead: null as (() => void) | null,
  reads: 0,
  fetched: [] as string[][],
}));
vi.mock("./pdf-text.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-text.js")>();
  return {
    ...actual,
    extractPdf: async () => {
      scan.reads++;
      await new Promise<void>((resolve) => (scan.finishRead = resolve));
      const text = `A paper. PMID: ${READ_PMID}`;
      return { matchText: text, fullText: text, pages: 1, truncated: false };
    },
  };
});
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    fetchArticles: async (pmids: string[]) => {
      scan.fetched.push(pmids);
      return pmids.map(article);
    },
    resolveDoiToPmid: async () => null,
  };
});
vi.mock("./icite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./icite.js")>();
  return { ...actual, ensureCitations: async () => {} };
});

// What every PDF in this file says it is.
const READ_PMID = "40000001";

let db: Db;
let server: Server;
let base: string;
let blobPath: (hash: string) => string;
let importer: typeof import("./importer.js");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// A collection of PDFs waiting to be scanned, with their bytes in the blob store.
function pendingShelf(name: string, count: number): { id: number; hashes: string[] } {
  const id = db.createCollection(name).id;
  const files = Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.from(`%PDF-1.4\n${name} ${i}\n%%EOF\n`, "latin1");
    const hash = sha256(bytes);
    fs.writeFileSync(blobPath(hash), bytes);
    return { hash, name: `${name} ${i}.pdf` };
  });
  db.addCollectionFiles(id, files);
  return { id, hashes: files.map((f) => f.hash) };
}

const textStored = (hash: string): boolean =>
  (db.db.prepare("SELECT COUNT(*) AS c FROM pdf_text WHERE content_hash = ?").get(hash) as { c: number })
    .c > 0;

const deleteCollection = (id: number) =>
  fetch(`${base}/api/collections/${id}`, { method: "DELETE", headers: HEADERS });

beforeAll(async () => {
  db = await openTempDb("collection-delete-stops-import");
  ({ blobPath } = await import("./blobstore.js"));
  importer = await import("./importer.js");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeTempDb();
});

beforeEach(() => {
  scan.finishRead = null;
  scan.reads = 0;
  scan.fetched = [];
  db.db.exec("DELETE FROM articles");
});

describe("deleting a collection part way through its scan", () => {
  it("stops the scan, which writes nothing back for the files that went", async () => {
    const shelf = pendingShelf("Deleted mid-scan", 2);
    importer.startImport(shelf.id, "Deleted mid-scan");
    await vi.waitFor(() => expect(scan.finishRead).not.toBeNull());

    expect((await deleteCollection(shelf.id)).status).toBe(204);
    // The read the delete landed in the middle of now finishes.
    scan.finishRead!();
    await vi.waitFor(() => expect(importer.getImportStatus(shelf.id)).toBeNull());

    expect(textStored(shelf.hashes[0])).toBe(false);
    // Nor did it go on: not to the second PDF, and not to PubMed with the first.
    expect(scan.reads).toBe(1);
    expect(scan.fetched).toEqual([]);
    expect(db.existingPmids([READ_PMID]).size).toBe(0);
    expect(importer.anyImportRunning()).toBe(false);
  });

  it("sweeps the papers the collection held once the scan has stopped", async () => {
    const HELD = "40000002";
    const shelf = pendingShelf("Held a paper", 1);
    // Matched before this scan, and held by nothing else.
    db.upsertArticles([article(HELD)]);
    db.addCollectionFiles(shelf.id, [{ hash: "d".repeat(64), name: "matched.pdf" }]);
    const matched = db.listCollectionFiles(shelf.id).find((f) => f.file_name === "matched.pdf")!;
    db.setFileMatched(matched.id, HELD, "pmid");
    importer.startImport(shelf.id, "Held a paper");
    await vi.waitFor(() => expect(scan.finishRead).not.toBeNull());

    expect((await deleteCollection(shelf.id)).status).toBe(204);
    // Not yet: the sweep skips its turn while any scan is running, and this one
    // is until its read comes back.
    expect(db.existingPmids([HELD]).size).toBe(1);

    scan.finishRead!();
    await vi.waitFor(() => expect(db.existingPmids([HELD]).size).toBe(0));
  });
});

// Deleting one file doesn't stop the scan, which has the collection's other
// files still to read. What keeps the deleted one's text from coming back is
// savePdfText, which stores none for a blob no file names.
describe("deleting a file while the scan is reading it", () => {
  it("stores no text for it, and goes on to index the rest", async () => {
    const shelf = pendingShelf("File deleted mid-read", 2);
    importer.startImport(shelf.id, "File deleted mid-read");
    await vi.waitFor(() => expect(scan.finishRead).not.toBeNull());
    const reading = importer.getImportStatus(shelf.id)!.currentFile;
    const file = db.listCollectionFiles(shelf.id).find((f) => f.file_name === reading)!;

    const res = await fetch(`${base}/api/collections/files/${file.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(204);
    scan.finishRead!();
    await vi.waitFor(() => expect(scan.reads).toBe(2));
    scan.finishRead!();
    await vi.waitFor(() => expect(importer.isImportRunning(shelf.id)).toBe(false));

    expect(textStored(file.content_hash)).toBe(false);
    const rest = shelf.hashes.find((h) => h !== file.content_hash)!;
    expect(textStored(rest)).toBe(true);
  });
});
