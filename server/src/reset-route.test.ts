import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import type { LibraryStats } from "../../shared/types.js";

// POST /api/data/reset — the route around the deletion, rather than the
// deletion itself.
//
// reset.test.ts already pins what resetLibrary leaves behind. What is untested
// below that is everything the *handler* decides, and all of it is invisible to
// tsc: which concurrent writers it refuses, what it answers them, and the order
// it runs its own tail in. Each is a branch whose failure is silent — a refusal
// that stops happening reads exactly like one that was never reached, and a
// tail that runs early reports numbers nobody can tell are wrong.
//
// The ordering case is the one worth the HTTP round trip. clearImportJobs and
// resetProContent run *after* the response value has been computed, because
// they are tidying up around a deletion that already happened and neither is
// allowed to change what it reported. Moving either above the resetLibrary call
// still compiles, still passes every other test here, and quietly makes the
// Pro half of the reset run against a library it is about to be told is gone.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see the same note in
// bulk-body-limit.test.ts. Without it the admin gate below has nothing to gate.
process.env.ADMIN_TOKEN = "reset-route-token";

// A transfer is only interesting to this file while it is *part way through*,
// and where it spends that time is ensureArticle's PubMed lookup. Parking that
// one call holds a real storePulledFile open at a real await, without a network
// round trip and without touching global fetch — which the requests below need.
const ncbi = vi.hoisted(() => ({ park: null as Promise<unknown> | null }));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    fetchArticles: async (pmids: string[]) => {
      if (ncbi.park) await ncbi.park;
      return actual.fetchArticles(pmids);
    },
    fetchArticleXml: async (pmids: string[]) => {
      if (ncbi.park) await ncbi.park;
      return actual.fetchArticleXml(pmids);
    },
  };
});
const HEADERS = { "x-admin-token": "reset-route-token" };

let db: Db;
let server: Server;
let base: string;
let withPollLock: typeof import("./poller.js").withPollLock;
let startImport: typeof import("./importer.js").startImport;
let clearImportJobs: typeof import("./importer.js").clearImportJobs;
let registerPro: typeof import("./pro-hooks.js").registerPro;
let storage: typeof import("./pro-storage.js");
let backfillArticleMesh: typeof import("./mesh-index.js").backfillArticleMesh;
type ProModule = import("./pro-hooks.js").ProModule;

const reset = (headers: Record<string, string> = HEADERS) =>
  fetch(`${base}/api/data/reset`, { method: "POST", headers });

const count = (table: string): number =>
  (db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

// Enough of a library that a reset has something to report.
function seed(): void {
  db.createCollection("Ongoing");
  db.createBookmarkFolder("Read later");
  db.upsertArticles([
    {
      pmid: "40000001",
      title: "A paper",
      abstract: "",
      journal_name: "Lancet",
      nlm_id: "0053266",
      authors: ["Smith J"],
      pub_date: "2021-01-01",
      pub_date_display: "2021",
      doi: "10.1000/40000001",
      url: "https://pubmed.ncbi.nlm.nih.gov/40000001/",
    },
  ]);
}

beforeAll(async () => {
  db = await openTempDb("reset-route");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  ({ withPollLock } = await import("./poller.js"));
  ({ startImport, clearImportJobs } = await import("./importer.js"));
  ({ registerPro } = await import("./pro-hooks.js"));
  storage = await import("./pro-storage.js");
  ({ backfillArticleMesh } = await import("./mesh-index.js"));
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
  // Directly, not through resetLibrary: a fixture that arranged itself with
  // the function under test would go green for a resetLibrary that did nothing.
  for (const table of [
    "bookmark_folders",
    "collections",
    "topics",
    "journals",
    "articles",
    "paper_citations",
    "pdf_text",
  ]) {
    db.db.exec(`DELETE FROM ${table}`);
  }
});

afterEach(() => {
  registerPro(null);
  clearImportJobs();
});

describe("who may press it", () => {
  it("refuses a request with no admin token", async () => {
    seed();
    const res = await reset({});

    expect(res.status).toBe(401);
    // The gate is the point: the library is still there afterwards. A 401 that
    // arrived after the deletion would be a worse bug than no gate at all.
    expect(count("collections")).toBe(1);
    expect(count("articles")).toBe(1);
  });
});

describe("what it refuses to run alongside", () => {
  it("refuses while an import is running, and deletes nothing", async () => {
    seed();
    // A real job in the real map, which is what anyImportRunning reads. The
    // collection has no pending files, so runImport settles immediately and
    // cannot race the flag back to "done" underneath the request; the state is
    // then set deliberately, since what is being pinned is the route's reading
    // of it rather than the importer's own bookkeeping.
    const job = startImport(db.createCollection("Importing").id, "Importing");
    await Promise.resolve();
    job.state = "running";

    const res = await reset();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still importing/i);
    expect(count("articles")).toBe(1);
  });

  it("refuses while a paired node is mid-transfer, and deletes nothing", async () => {
    seed();
    const collectionId = db.createCollection("Inbox").id;
    // Held inside ensureArticle's lookup — the network round trip that makes
    // this window wide enough to lose a race in.
    let failLookup!: (err: Error) => void;
    ncbi.park = new Promise((_resolve, reject) => (failLookup = reject));

    // Deliberately a PMID no test seeded, so ensureArticle has to go and ask.
    const transfer = storage.storePulledFile({
      bytes: Buffer.from("%PDF-1.4 pushed", "latin1"),
      fileName: "pushed.pdf",
      pmid: "40000999",
      collectionIds: [collectionId],
    });
    await Promise.resolve();

    const res = await reset();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/being copied into this library/i);
    expect(count("articles")).toBe(1);

    // Rejected rather than released, so the lookup never reaches the real
    // PubMed: these tests don't touch the network. storePulledFile's finally
    // still runs, which is the half being pinned by the test after this one.
    failLookup(new Error("test stopped the lookup"));
    ncbi.park = null;
    await transfer.catch(() => {});
    expect(storage.anyTransferInFlight()).toBe(false);
  });

  it("takes the reset once that transfer has settled", async () => {
    // The refusal is a "not this instant", not a mode the instance gets stuck
    // in: the counter is back to zero the moment the last transfer unwinds.
    seed();
    const res = await reset();

    expect(res.status).toBe(200);
    expect((await res.json()).papers).toBe(1);
  });

  it("refuses while the MeSH backfill holds the poll lock", async () => {
    // The backfill is not a "refresh" in the words the message uses, but it is
    // one to the lock — which is the point. It writes article_mesh rows keyed to
    // articles(pmid) across an awaited efetch, so before it took the lock a reset
    // could land inside that window and leave the insert violating the key.
    seed();
    let failLookup!: (err: Error) => void;
    ncbi.park = new Promise((_resolve, reject) => (failLookup = reject));

    // Called exactly as its schedulers call it — bare. The lock is taken inside,
    // which is the whole of what this test is for: wrapping it here instead would
    // pass whether or not backfillArticleMesh had ever heard of the lock.
    // withPollLock takes it synchronously, before its first await, so it is
    // already held on the next line.
    const backfill = backfillArticleMesh();

    const res = await reset();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/refresh is running/i);
    expect(count("articles")).toBe(1);

    failLookup(new Error("test stopped the lookup"));
    ncbi.park = null;
    await backfill;
  });

  it("refuses while a refresh holds the poll lock, and deletes nothing", async () => {
    seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = withPollLock(async () => {
      await held;
    });

    const res = await reset();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/refresh is running/i);
    expect(count("articles")).toBe(1);

    release();
    await holding;
  });
});

describe("the deletion it does run", () => {
  it("answers with what went, and empties the library", async () => {
    seed();
    const res = await reset();

    expect(res.status).toBe(200);
    const stats = (await res.json()) as LibraryStats;
    // The whole shape, not a subset: every field here is a number a person
    // reads back as "this is what you just lost".
    expect(stats).toEqual({
      topics: 0,
      journals: 0,
      papers: 1,
      folders: 1,
      collections: 1,
      files: 0,
    });
    expect(count("articles")).toBe(0);
    expect(count("collections")).toBe(0);
    expect(count("bookmark_folders")).toBe(0);
  });

  it("is safe to press on a library that is already empty", async () => {
    const res = await reset();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topics: 0,
      journals: 0,
      papers: 0,
      folders: 0,
      collections: 0,
      files: 0,
    });
  });
});

describe("the tail, and when it runs", () => {
  it("tells Pro only after the deletion it is being told about", async () => {
    seed();
    let sawArticles: number | null = null;
    const mod = {
      version: "test",
      init: () => {},
      routes: () => {
        throw new Error("routes() is not exercised by this test");
      },
      status: () => ({ version: "test", is_master: false, is_paired: false, node_count: 0 }),
      pulledOrgByPmid: () => new Map(),
      receivedNodeByPmid: () => new Map(),
      orgCheck: async () => new Map(),
      syncHint: () => {},
      // Reads the library at the moment it is called. Pro's own reset assumes
      // the contents are already gone — it is deleting the marks it made *about*
      // them — so a non-zero reading here means the two halves ran out of order.
      resetContent: () => {
        sawArticles = count("articles");
      },
    } as unknown as ProModule;
    registerPro(mod);

    const res = await reset();

    expect(res.status).toBe(200);
    expect(sawArticles).toBe(0);
  });

  it("still reports the deletion when Pro's half throws", async () => {
    seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = {
      version: "test",
      init: () => {},
      routes: () => {
        throw new Error("routes() is not exercised by this test");
      },
      status: () => ({ version: "test", is_master: false, is_paired: false, node_count: 0 }),
      pulledOrgByPmid: () => new Map(),
      receivedNodeByPmid: () => new Map(),
      orgCheck: async () => new Map(),
      syncHint: () => {},
      resetContent: () => {
        throw new Error("database is locked");
      },
    } as unknown as ProModule;
    registerPro(mod);

    const res = await reset();

    // 200, because the deletion happened and cannot be undone. Reporting a
    // failure here is what sends someone to press "delete everything" a second
    // time on a library that is already gone.
    expect(res.status).toBe(200);
    expect((await res.json()).papers).toBe(1);
    expect(String(warn.mock.calls[0][0])).toContain("database is locked");
    warn.mockRestore();
  });
});
