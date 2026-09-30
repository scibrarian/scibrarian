import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerm } from "./pubmed-parse.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// "Search all PubMed journals": every topic searches all of PubMed instead of
// the journal list, which is set aside and locked until the setting goes off.
//
// Each mode keeps its own watermark and vouches only for what its own polls
// covered. An all-PubMed search is capped at PubMed's 9,999, so it can't stand
// in for the journal polls: turning the setting off resumes them from their own
// watermark, and a topic they never polled lists its journals' history.
// Turning it off also deletes what the all-PubMed polls brought in from other
// journals, so their watermark is forgotten with those papers, and turning the
// setting on again lists history afresh.
//
// Polls are asserted by the searches they make, with PubMed's search mocked to
// record them and return nothing, as in poll-journal-reseed.test.ts. The
// deletion and the routes are asserted by what is left in the database.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "all-pubmed-token";
const HEADERS = { "x-admin-token": "all-pubmed-token", "content-type": "application/json" };

const ncbi = vi.hoisted(() => ({
  calls: [] as { term: string; since: string | undefined }[],
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (term: string, mhdaSince?: string) => {
      ncbi.calls.push({ term, since: mhdaSince });
      return { ids: [], total: 0 };
    },
  };
});

let db: Db;
let server: Server;
let base: string;
let pollTopic: typeof import("./poller.js").pollTopic;
let withPollLock: typeof import("./poller.js").withPollLock;

const TERM = '"Adipose Tissue"[MeSH]';
const LANCET = "2985213R";
const ELSEWHERE = "0255562"; // any journal that isn't in the list
const WATERMARK = "2026-02-01T00:00:00.000Z";
const SINCE = "2026/01/31"; // a day before WATERMARK — see mhdaWindowStart
const LATER = "2026-03-01T00:00:00.000Z";
const LATER_SINCE = "2026/02/28";

const search = (journals: string[], since?: string) => ({ term: buildTerm(TERM, journals), since });

function article(pmid: string, nlmId: string) {
  return {
    pmid,
    title: `Paper ${pmid}`,
    abstract: "",
    journal_name: "",
    nlm_id: nlmId,
    authors: [],
    pub_date: "2026-01-01",
    pub_date_display: "2026",
    doi: "",
    url: "",
  };
}

const exists = (pmid: string) =>
  db.db.prepare("SELECT 1 FROM articles WHERE pmid = ?").get(pmid) !== undefined;
const topicsOf = (pmid: string) =>
  (db.db.prepare("SELECT topic_id FROM article_topics WHERE pmid = ?").all(pmid) as {
    topic_id: number;
  }[]).map((r) => r.topic_id);

const request = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// A topic whose journal polls have seeded it against the Lancet, with their
// watermark pinned so the incremental bound is a known date.
async function journalTopic() {
  db.createJournal("Lancet", LANCET, true);
  const t = db.createTopic("Adipose Tissue", TERM);
  await pollTopic(t.id);
  db.setTopicLastPolled(t.id, WATERMARK);
  ncbi.calls = [];
  return t;
}

beforeAll(async () => {
  db = await openTempDb("all-pubmed");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  ({ pollTopic, withPollLock } = await import("./poller.js"));
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

// Directly rather than through setSearchAllPubmed, so the fixture doesn't lean
// on the function under test. Deleting topics and journals takes their scan
// rows with them.
beforeEach(() => {
  for (const table of ["topics", "journals", "articles", "bookmark_folders", "collections"]) {
    db.db.exec(`DELETE FROM ${table}`);
  }
  db.db.exec("DELETE FROM settings WHERE key = 'search_all_pubmed'");
  ncbi.calls = [];
});

describe("polling while every topic searches all of PubMed", () => {
  it("lists a topic's history across all of PubMed on its first poll", async () => {
    db.setSearchAllPubmed(true);
    const t = db.createTopic("Adipose Tissue", TERM);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([])]);
  });

  it("continues from its own watermark after that", async () => {
    db.setSearchAllPubmed(true);
    const t = db.createTopic("Adipose Tissue", TERM);
    await pollTopic(t.id);
    db.setTopicPubmedPolled(t.id, WATERMARK);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([], SINCE)]);
  });

  it("leaves the journal watermark alone, and the journal polls resume from it", async () => {
    const t = await journalTopic();
    db.setSearchAllPubmed(true);
    await pollTopic(t.id);
    db.setTopicPubmedPolled(t.id, LATER);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([]), search([], LATER_SINCE)]);
    expect(db.getTopic(t.id)!.last_polled_at).toBe(WATERMARK);

    // From the journal polls' own watermark. The later all-PubMed one can't
    // vouch for the journals — PubMed's cap may have cut those searches — and
    // turning the setting off has forgotten it by now in any case.
    db.setSearchAllPubmed(false);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"], SINCE)]);
  });

  it("lists the journals' history for a topic only ever polled across all of PubMed", async () => {
    db.createJournal("Lancet", LANCET, true);
    db.setSearchAllPubmed(true);
    const t = db.createTopic("Adipose Tissue", TERM);
    await pollTopic(t.id);

    db.setSearchAllPubmed(false);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("lists history across all of PubMed afresh after the setting was off", async () => {
    db.setSearchAllPubmed(true);
    const t = db.createTopic("Adipose Tissue", TERM);
    await pollTopic(t.id);
    expect(db.getTopic(t.id)!.pubmed_polled_at).not.toBeNull();

    db.setSearchAllPubmed(false);
    expect(db.getTopic(t.id)!.pubmed_polled_at).toBeNull();
    db.setSearchAllPubmed(true);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([])]);
  });
});

describe("turning the setting off", () => {
  it("deletes the unsaved papers from other journals, and takes saved ones out of the feeds", () => {
    db.createJournal("Lancet", LANCET, true);
    const t = db.createTopic("Adipose Tissue", TERM).id;
    db.setSearchAllPubmed(true);
    db.saveArticles(
      [
        article("1", LANCET),
        article("2", ELSEWHERE),
        article("3", ELSEWHERE), // held in the library
        article("4", ELSEWHERE), // bookmarked
      ],
      t
    );
    // In no feed at all, so nothing the all-PubMed polls brought in.
    db.upsertArticles([article("5", ELSEWHERE)]);
    const shelf = db.createCollection("Shelf").id;
    db.addCollectionFiles(shelf, [{ hash: "a".repeat(64), name: "3.pdf" }]);
    db.setFileMatched(db.listCollectionFiles(shelf)[0].id, "3", "pmid");
    db.addBookmarks(db.createBookmarkFolder("Later").id, ["4"]);

    // The confirm counts what leaves Interests, saved papers included.
    expect(db.countOffListArticles()).toBe(3);
    expect(db.setSearchAllPubmed(false)).toEqual({ deletedArticles: 1, removedFromInterests: 3 });

    expect(["1", "2", "3", "4", "5"].map((p) => [p, exists(p)])).toEqual([
      ["1", true],
      ["2", false],
      ["3", true],
      ["4", true],
      ["5", true],
    ]);
    expect([topicsOf("1"), topicsOf("3"), topicsOf("4")]).toEqual([[t], [], []]);
    // Out of Interests, still in its folder.
    expect(db.listBookmarks().map((b) => b.pmid)).toEqual(["4"]);
  });

  it("deletes nothing when the setting was already off", () => {
    db.createJournal("Lancet", LANCET, true);
    const t = db.createTopic("Adipose Tissue", TERM).id;
    db.saveArticles([article("2", ELSEWHERE)], t);
    expect(db.setSearchAllPubmed(false)).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
    expect(topicsOf("2")).toEqual([t]);
  });

  it("changes nothing stored when turned on", () => {
    const t = db.createTopic("Adipose Tissue", TERM).id;
    db.saveArticles([article("2", ELSEWHERE)], t);
    expect(db.setSearchAllPubmed(true)).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
    expect(topicsOf("2")).toEqual([t]);
  });
});

describe("the routes", () => {
  it("refuse to change the journal list while the setting is on", async () => {
    const j = db.createJournal("Lancet", LANCET, true);
    db.setSearchAllPubmed(true);

    const add = await request("POST", "/journals", { name: "BMJ" });
    expect(add.status).toBe(409);
    expect((await add.json()).error).toMatch(/Search all PubMed journals/);
    const remove = await request("DELETE", `/journals/${j.id}`);
    expect(remove.status).toBe(409);
    expect(db.listJournals().map((x) => x.id)).toEqual([j.id]);
  });

  it("turn it off with the count the confirm showed", async () => {
    const t = db.createTopic("Adipose Tissue", TERM).id;
    db.setSearchAllPubmed(true);
    db.saveArticles([article("2", ELSEWHERE)], t);

    const counted = await request("GET", "/journals/all-pubmed/article-count");
    expect(await counted.json()).toEqual({ count: 1 });
    const off = await request("PUT", "/journals/all-pubmed", { on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ deletedArticles: 1, removedFromInterests: 1 });
    const settings = await request("GET", "/settings");
    expect((await settings.json()).search_all_pubmed).toBe(false);
  });

  it("refuse to turn it off while a poll holds the lock, and delete nothing", async () => {
    const t = db.createTopic("Adipose Tissue", TERM).id;
    db.setSearchAllPubmed(true);
    db.saveArticles([article("2", ELSEWHERE)], t);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = withPollLock(async () => {
      await held;
    });

    const res = await request("PUT", "/journals/all-pubmed", { on: false });
    expect(res.status).toBe(409);
    expect(db.searchesAllPubmed()).toBe(true);
    expect(exists("2")).toBe(true);

    release();
    await holding;
  });

  it("reject a value that isn't true or false", async () => {
    const res = await request("PUT", "/journals/all-pubmed", { on: "false" });
    expect(res.status).toBe(400);
  });

  it("can't be turned on or off through PUT /settings", async () => {
    const res = await request("PUT", "/settings", { search_all_pubmed: true });
    expect(res.status).toBe(200);
    expect((await res.json()).search_all_pubmed).toBe(false);
    expect(db.searchesAllPubmed()).toBe(false);
  });

  it("refuse a check for new papers with nothing to search", async () => {
    db.createTopic("Adipose Tissue", TERM);
    const res = await request("POST", "/refresh");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no journals are watched/i);
    expect(ncbi.calls).toEqual([]);
  });

  it("check across all of PubMed with no journals once the setting is on", async () => {
    db.createTopic("Adipose Tissue", TERM);
    db.setSearchAllPubmed(true);
    const res = await request("POST", "/refresh");
    expect(res.status).toBe(200);
    expect((await res.json()).allPubmed).toBe(true);
    expect(ncbi.calls).toEqual([search([])]);
  });
});
