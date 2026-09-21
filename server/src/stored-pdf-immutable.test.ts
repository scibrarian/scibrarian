import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The bytes of a stored PDF cannot be changed over HTTP. By anyone, including
// the owner.
//
// This is a security property, not a convenience: a browser tab is handed the
// PDF with `Content-Disposition: inline`, so the reader's own viewer renders
// it — and Chrome, Edge and Firefox can all annotate what they render. If any
// route anywhere accepted those annotated bytes back for an existing file,
// then on a shared instance the person who uploaded a paper would not be the
// only person able to decide what that paper says.
//
// Nothing today does, and it holds at four independent layers:
//
//   1. `collection_files.content_hash` is written by exactly one statement, in
//      repointFileBlob, whose only caller is the desktop check-in — reachable
//      from the Electron main process and from no request at all.
//   2. The blob store is content-addressed. Its only write renames a temp file
//      to blobPath(sha256(that temp file)), so bytes can only ever land at
//      their own digest; overwriting a blob would take a SHA-256 collision.
//   3. Upload takes a collection id, never a file id, and inserts OR IGNOREs.
//   4. Every non-GET request needs the admin token, gated before the router.
//
// A test rather than a comment because layers 1 and 3 are one careless route
// away from being untrue, and nothing else would notice: adding a handler that
// takes a fileId and a body is an ordinary-looking thing to do.

// config.ts reads both of these at import time, so they are set before anything
// imports it — the same note as workspace-routes.test.ts. Cleared rather than
// assumed for the same reason it is set there: vitest shares one process across
// files, external-open.test.ts declares itself the desktop build, and a file
// whose whole subject is what a *server* deployment does must not inherit that.
process.env.ADMIN_TOKEN = "immutable-token";
process.env.SCIBRARIAN_DESKTOP = "";
const OWNER = { "x-admin-token": "immutable-token" };

let db: Db;
let blobPath: (hash: string) => string;
let server: Server;
let base: string;

let collection: number;
let fileId: number;
let originalHash: string;

const ORIGINAL = Buffer.from("%PDF-1.4\nthe paper as its author wrote it\n%%EOF\n", "latin1");
const ANNOTATED = Buffer.from("%PDF-1.4\nthe same paper, now with highlights\n%%EOF\n", "latin1");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const storedHash = (): string => db.getCollectionFile(fileId)!.content_hash;
const storedBytes = (): Buffer => fs.readFileSync(blobPath(storedHash()));

beforeAll(async () => {
  db = await openTempDb("stored-pdf-immutable");
  ({ blobPath } = await import("./blobstore.js"));
  const { app } = await import("./index.js");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  collection = db.createCollection("Papers").id;
  originalHash = sha256(ORIGINAL);
  fs.writeFileSync(blobPath(originalHash), ORIGINAL);
  db.addCollectionFiles(collection, [{ hash: originalHash, name: "Trial.pdf" }]);
  fileId = db.listCollectionFiles(collection)[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeTempDb();
});

describe("the bytes behind a stored PDF", () => {
  it("are served, and only served", async () => {
    const res = await fetch(`${base}/api/collections/files/${fileId}/content`, { headers: OWNER });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ORIGINAL);
  });

  it("cannot be written by any method on the content URL, even by the owner", async () => {
    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/collections/files/${fileId}/content`, {
        method,
        headers: { ...OWNER, "content-type": "application/pdf" },
        body: method === "DELETE" ? undefined : ANNOTATED,
      });
      // Refused is the claim, not any particular refusal: 404 because no such
      // route exists is as good an answer as 405, and better than 200.
      expect({ method, ok: res.ok }).toEqual({ method, ok: false });
    }
    expect(storedHash()).toBe(originalHash);
    expect(storedBytes()).toEqual(ORIGINAL);
  });

  it("cannot be added to at all without the admin token", async () => {
    const body = new FormData();
    body.append("files", new Blob([ANNOTATED]), "Trial.pdf");
    const res = await fetch(`${base}/api/collections/${collection}/files`, { method: "POST", body });

    expect(res.status).toBe(401);
    // Refused before multer wrote a temp file, so nothing reached the store.
    expect(db.listCollectionFiles(collection)).toHaveLength(1);
    expect(storedBytes()).toEqual(ORIGINAL);
  });

  it("survive the owner re-uploading an annotated copy of the same paper", async () => {
    // The realistic attempt at "saving edits back": read it in the browser,
    // annotate it there, upload the result to the collection it came from.
    const body = new FormData();
    body.append("files", new Blob([ANNOTATED]), "Trial.pdf");
    const res = await fetch(`${base}/api/collections/${collection}/files`, {
      method: "POST",
      headers: OWNER,
      body,
    });
    expect(res.status).toBe(201);

    // The annotated copy lands beside the original as its own file, because the
    // store is keyed by content. What it must never do is take the first one's
    // place — that row is what every citation, match and share link resolves.
    expect(storedHash()).toBe(originalHash);
    expect(storedBytes()).toEqual(ORIGINAL);
    const hashes = db.listCollectionFiles(collection).map((f) => f.content_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(originalHash);
    expect(hashes).toContain(sha256(ANNOTATED));
  });
});

// The desktop-only half of the same subject. A server deployment hands its PDFs
// to a browser, which renders them and cannot write back, so none of the
// check-out machinery is needed there — and none of it is reachable.
describe("on a server deployment", () => {
  it("says it is not the desktop build", async () => {
    const res = await fetch(`${base}/api/settings`, { headers: OWNER });
    // The canary for the note at the top of this file: if this is ever true,
    // another test file's environment has leaked into this one and the two
    // assertions below stopped meaning anything.
    expect(((await res.json()) as { desktop: boolean }).desktop).toBe(false);
  });

  it("has no viewer cache to read or clear", async () => {
    for (const [method, url] of [
      ["GET", `${base}/api/cache`],
      ["POST", `${base}/api/cache/clear`],
    ]) {
      const res = await fetch(url, { method, headers: OWNER });
      expect({ method, status: res.status }).toEqual({ method, status: 404 });
    }
  });

  it("refuses to check a PDF out even when called directly", async () => {
    // The inner of the two guards. The outer is the 404 above; this one is what
    // holds if a route is ever added here by mistake.
    const { checkOutForExternalOpen } = await import("./external-open.js");
    await expect(checkOutForExternalOpen(fileId)).rejects.toThrow(/desktop-only/);
    expect(storedBytes()).toEqual(ORIGINAL);
  });
});
