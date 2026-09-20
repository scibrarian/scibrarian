import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// "Delete all data" has to reach the checked-out copies too.
//
// resetLibrary empties the tables and unlinks every blob, and a checked-out
// copy is neither of those: it is a plaintext PDF under the paper's own name,
// in a directory the reader can open, put there so the machine's own viewer has
// something to show. The button asks about "every stored PDF", and someone
// resetting a library to get sensitive papers off their disk is describing the
// papers they have been reading — which is exactly the set with a copy in that
// directory. Left behind, those copies also outlive every row that named them,
// so nothing but the cache button would ever have removed them.
//
// Its own file because it has to be the desktop build and reset-route.test.ts
// must not be: config.ts reads the environment at import time and vitest shares
// one process across files.
process.env.ADMIN_TOKEN = "reset-checkouts-token";
process.env.SCIBRARIAN_DESKTOP = "1";
const OWNER = { "x-admin-token": "reset-checkouts-token" };

let db: Db;
let blobPath: (hash: string) => string;
let EXTERNAL_OPEN_DIR: string;
let checkOutForExternalOpen: (fileId: number) => Promise<string>;
let server: Server;
let base: string;

const PAPER = Buffer.from("%PDF-1.4\nnot something to leave lying about\n%%EOF\n", "latin1");
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  db = await openTempDb("reset-clears-checkouts");
  // After openTempDb, which is what points the environment at the temp
  // directory these read at evaluation.
  ({ blobPath } = await import("./blobstore.js"));
  ({ EXTERNAL_OPEN_DIR } = await import("./config.js"));
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

describe("deleting all data", () => {
  it("is running as the desktop build", async () => {
    // The canary for the note at the top of this file: off the desktop there is
    // no viewer cache to leave behind, and the test below would pass for a
    // build that never had the problem.
    const res = await fetch(`${base}/api/settings`, { headers: OWNER });
    expect(((await res.json()) as { desktop: boolean }).desktop).toBe(true);
  });

  it("takes the checked-out copies with it", async () => {
    const collection = db.createCollection("Papers").id;
    const hash = sha256(PAPER);
    fs.writeFileSync(blobPath(hash), PAPER);
    db.addCollectionFiles(collection, [{ hash, name: "Sensitive.pdf" }]);
    const fileId = db.listCollectionFiles(collection)[0]!.id;

    const copy = await checkOutForExternalOpen(fileId);
    // Readable, and under the paper's own name. That is the whole of what makes
    // it worth deleting rather than a detail of the cache's bookkeeping.
    expect(fs.readFileSync(copy)).toEqual(PAPER);

    const res = await fetch(`${base}/api/data/reset`, { method: "POST", headers: OWNER });
    expect(res.status).toBe(200);

    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(EXTERNAL_OPEN_DIR)).toBe(false);
    // And the blob, which resetLibrary was already doing — asserted here so a
    // reset that stopped deleting either half is one failure, not a puzzle.
    expect(fs.existsSync(blobPath(hash))).toBe(false);
  });
});
