import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Taking a paper out of the library has to take its checked-out copy too.
//
// Three routes drop collection_files rows — one file, a set of papers, a whole
// collection — and each unlinks the blob on the way out. None of them could
// reach the copy the machine's viewer was handed, which is a readable PDF under
// the paper's own name in a directory the reader can open. The dialog behind
// two of these says "any stored PDF copies are deleted"; a copy that outlives
// its row is also permanently unreachable, since every path that would collect
// or count it starts from the row.
//
// One test per route rather than one for the sweep, because the sweep was never
// the part in doubt: what is easy to get wrong is a deletion path that forgets
// to call it, and that is per route.
//
// Its own file because it has to be the desktop build, and the route tests that
// must not be are in files of their own for the same reason: config.ts reads
// the environment at import time and vitest shares one process across files.
process.env.ADMIN_TOKEN = "collection-delete-token";
process.env.SCIBRARIAN_DESKTOP = "1";
const OWNER = { "x-admin-token": "collection-delete-token" };

let db: Db;
let blobPath: (hash: string) => string;
let checkOutForExternalOpen: (fileId: number) => Promise<string>;
let server: Server;
let base: string;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A stored paper with a copy already checked out, as if it had been opened. */
async function openedPaper(collection: number, name: string, pmid?: string) {
  const bytes = Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`, "latin1");
  const hash = sha256(bytes);
  fs.writeFileSync(blobPath(hash), bytes);
  db.addCollectionFiles(collection, [{ hash, name }]);
  const row = db.listCollectionFiles(collection).find((f) => f.content_hash === hash)!;
  if (pmid) db.setFileMatched(row.id, pmid, "manual");
  const copy = await checkOutForExternalOpen(row.id);
  expect(fs.readFileSync(copy)).toEqual(bytes);
  return { fileId: row.id, copy };
}

beforeAll(async () => {
  db = await openTempDb("collection-delete-clears-checkouts");
  ({ blobPath } = await import("./blobstore.js"));
  ({ checkOutForExternalOpen } = await import("./external-open.js"));
  const { app } = await import("./index.js");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeTempDb();
});

describe("a delete that takes a paper out of the library", () => {
  it("is running as the desktop build", async () => {
    // The canary: off the desktop there is no cache to leave behind, and every
    // test below would pass for a build that never had the problem.
    const res = await fetch(`${base}/api/settings`, { headers: OWNER });
    expect(((await res.json()) as { desktop: boolean }).desktop).toBe(true);
  });

  it("takes the copy when one file is deleted", async () => {
    const collection = db.createCollection("One file").id;
    const { fileId, copy } = await openedPaper(collection, "Deleted on its own.pdf");

    const res = await fetch(`${base}/api/collections/files/${fileId}`, {
      method: "DELETE",
      headers: OWNER,
    });

    expect(res.status).toBe(204);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("takes the copies when papers are removed from a collection", async () => {
    const collection = db.createCollection("Selected papers").id;
    const going = await openedPaper(collection, "Removed by pmid.pdf", "40000123");
    // A second paper in the same collection that was not asked for: the sweep
    // is by orphanhood, so a copy whose row survives has to survive with it.
    const staying = await openedPaper(collection, "Not in the selection.pdf", "40000124");

    const res = await fetch(`${base}/api/collections/${collection}/papers/remove`, {
      method: "POST",
      headers: { ...OWNER, "content-type": "application/json" },
      body: JSON.stringify({ pmids: ["40000123"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 1, papers: 1 });
    expect(fs.existsSync(going.copy)).toBe(false);
    expect(fs.existsSync(staying.copy)).toBe(true);
  });

  it("takes the copies when the whole collection goes", async () => {
    const collection = db.createCollection("Dropped whole").id;
    const first = await openedPaper(collection, "One of two.pdf");
    const second = await openedPaper(collection, "Two of two.pdf");
    // And a paper in a different collection, which this delete is not about.
    const elsewhere = await openedPaper(db.createCollection("Untouched").id, "Somewhere else.pdf");

    const res = await fetch(`${base}/api/collections/${collection}`, {
      method: "DELETE",
      headers: OWNER,
    });

    expect(res.status).toBe(204);
    expect(fs.existsSync(first.copy)).toBe(false);
    expect(fs.existsSync(second.copy)).toBe(false);
    expect(fs.existsSync(elsewhere.copy)).toBe(true);
  });
});
