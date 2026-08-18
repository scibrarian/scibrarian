import type { Server } from "node:http";
import express from "express";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";
import { MAX_NAME_CHARS } from "../../shared/limits.js";

// The length cap on the names a person types: collections and bookmark folders.
//
// Asserted over HTTP rather than against the helper, because the helper's whole
// job is to answer with a status and a message — and the thing that actually
// breaks is a route that forgot to call it. Every one of the four is exercised
// here for that reason: create and rename, on both kinds of entry. A cap
// applied to three of them reads as working right up until someone renames.
//
// The client sets the same number as the input's maxLength, so in the shipped
// UI these requests can't be typed. That is what makes this the backstop worth
// pinning: nothing in the browser would notice if it stopped being enforced.

let server: Server;
let base: string;
let folderId: number;
let collectionId: number;

const OK = "a".repeat(MAX_NAME_CHARS);
const ANOTHER_OK = "b".repeat(MAX_NAME_CHARS);
const TOO_LONG = "a".repeat(MAX_NAME_CHARS + 1);

beforeAll(async () => {
  await openTempDb("entry-names");
  const { api } = await import("./routes.js");
  const app = express();
  app.use(express.json());
  app.use("/api", api);
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // One of each to rename. Created at the cap rather than at some comfortable
  // short name, so the boundary is proven acceptable on the way in as well.
  folderId = (await post("/api/bookmark-folders", OK)).body.id;
  collectionId = (await post("/api/collections", OK)).body.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeTempDb();
});

async function send(method: string, path: string, name: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const post = (path: string, name: string) => send("POST", path, name);
const put = (path: string, name: string) => send("PUT", path, name);

describe("names a person types", () => {
  it("accepts a name exactly at the cap", async () => {
    // Both directions of the off-by-one matter. A `>=` here would refuse a name
    // the box let someone finish typing, which is the more confusing failure:
    // the character appears, and then the save is rejected for it.
    expect((await post("/api/bookmark-folders", ANOTHER_OK)).status).toBe(201);
    expect((await put(`/api/collections/${collectionId}`, OK)).status).toBe(200);
  });

  it("refuses one character past it, and says what the limit is", async () => {
    const res = await post("/api/collections", TOO_LONG);
    expect(res.status).toBe(400);
    // The number, not just a complaint. "Too long" leaves someone deleting
    // characters one at a time to find out how long is short enough.
    expect(String(res.body.error)).toContain(String(MAX_NAME_CHARS));
  });

  it("refuses an over-long name on all four routes", async () => {
    expect((await post("/api/bookmark-folders", TOO_LONG)).status).toBe(400);
    expect((await put(`/api/bookmark-folders/${folderId}`, TOO_LONG)).status).toBe(400);
    expect((await post("/api/collections", TOO_LONG)).status).toBe(400);
    expect((await put(`/api/collections/${collectionId}`, TOO_LONG)).status).toBe(400);
  });

  it("still refuses an empty name, with the message it always sent", async () => {
    // The cap arrived by folding this check into the same helper. Both branches
    // are load-bearing, and only one of them is new.
    const res = await post("/api/collections", "   ");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/required/i);
  });

  it("leaves the refused rename with its original name", async () => {
    // A 400 that had already written would be the worst outcome here: the
    // caller is told it failed and the entry is renamed anyway.
    const res = await fetch(`${base}/api/collections`);
    const rows = (await res.json()) as { id: number; name: string }[];
    expect(rows.find((c) => c.id === collectionId)?.name).toBe(OK);
  });
});
