import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { MAX_BULK_BOOKMARK_PMIDS } from "../../shared/limits.js";

// Which routes may post a body bigger than body-parser's 100kb default.
//
// Asserted over HTTP against the real app rather than against the routes alone,
// because there is nothing else to assert against: a parser limit is a mount
// path and a position in the middleware stack, and both are invisible to tsc
// and to every unit test. A route that takes "everything currently filtered"
// and is missing from that mount still compiles, still passes its own tests,
// and still caps its count in the handler — it just never reaches the handler,
// failing instead as "request entity too large" at around nine thousand PMIDs.
// Which is what the collection removal did, until this file.
//
// The control case matters as much as the two bulk ones. The reason these are
// mounted per route rather than as a raised global limit is so no *other*
// endpoint starts accepting megabyte bodies, and only a request to one of those
// others can show that it still doesn't.

// config.ts reads ADMIN_TOKEN at import time, and vitest shares one process
// across test files — so this is set rather than assumed, and every request
// below carries it. Left to chance, an empty token means single-user mode where
// everything is the owner, and a token set by another file means every request
// here 401s before its body is ever read.
process.env.ADMIN_TOKEN = "bulk-body-limit-token";
const HEADERS = {
  "content-type": "application/json",
  "x-admin-token": "bulk-body-limit-token",
};

// Comfortably past the 100kb default (an 8-digit id serializes to 11 bytes, so
// this is ~132kb) and nowhere near MAX_BULK_BOOKMARK_BYTES.
const OVER_THE_DEFAULT = 12_000;
const TOO_LARGE = 413;

let db: Db;
let server: Server;
let base: string;
let collection: number;
let folder: number;

const pmids = (n: number) => Array.from({ length: n }, (_, i) => String(10_000_000 + i));

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });

beforeAll(async () => {
  db = await openTempDb("bulk-body-limit");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  collection = db.createCollection("Bulk").id;
  folder = db.createBookmarkFolder("Bulk").id;
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

describe("a bulk body reaches the route that expects it", () => {
  it("takes a large removal", async () => {
    const res = await post(`/api/collections/${collection}/papers/remove`, {
      pmids: pmids(OVER_THE_DEFAULT),
    });
    // 200 rather than merely "not 413": the handler ran and answered. None of
    // these pmids is in the collection, so nothing is removed — what is being
    // pinned is that the body arrived, not what it did.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 0, papers: 0 });
  });

  it("takes a large bookmark save", async () => {
    const res = await post(`/api/bookmark-folders/${folder}/papers`, {
      pmids: pmids(OVER_THE_DEFAULT),
    });
    // 404 from the handler's own "none of those papers are stored any more" —
    // no article rows exist in this database. Again the point is which layer
    // answered, and 413 is the one that means the body never got there.
    expect(res.status).not.toBe(TOO_LARGE);
    expect(res.status).toBe(404);
  });

  // The finding this file was written for. The handler refuses more than
  // MAX_BULK_BOOKMARK_PMIDS with a message naming the limit; behind the 100kb
  // default that message was unreachable, since 50,001 ids is ~550kb and
  // body-parser answered first with a payload-too-large that names nothing.
  it("lets the handler's own cap be the thing that refuses an oversized one", async () => {
    const res = await post(`/api/collections/${collection}/papers/remove`, {
      pmids: pmids(MAX_BULK_BOOKMARK_PMIDS + 1),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_BULK_BOOKMARK_PMIDS));
  });
});

describe("every other route keeps the 100kb default", () => {
  it("refuses a large body on a route that has no reason to take one", async () => {
    // Creating a collection carries a name, and a name is bounded at 30
    // characters. If this ever stops being a 413, the limit has been raised
    // globally and every endpoint is accepting megabyte bodies.
    const res = await post("/api/collections", { name: "x".repeat(200_000) });
    expect(res.status).toBe(TOO_LARGE);
  });

  it("doesn't extend the raised limit up the path it was mounted on", async () => {
    // app.use matches a prefix, so the raised parser covers exactly
    // /collections/:id/papers/remove and anything below it. A shorter path must
    // not inherit it. No route claims this one, but body-parser runs before
    // routing — so a 413 rather than a 404 is the parser answering, which is
    // what says the raised limit stayed where it was put.
    const res = await post(`/api/collections/${collection}/papers`, {
      pmids: pmids(OVER_THE_DEFAULT),
    });
    expect(res.status).toBe(TOO_LARGE);
  });
});
