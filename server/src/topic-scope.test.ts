import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerm } from "./pubmed-parse.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Where a topic searches, and what changing that takes out.
//
// Each topic has its own scope: all of PubMed, or a list of journals. Changing
// it can take papers out of that topic's feed — the ones the new scope no
// longer covers — and of those, the ones in no other feed that nothing saved
// points at are deleted. No other topic is touched, which is the point of the
// list being the topic's own: dropping a journal used to delete its papers
// from every feed.
//
// The count the confirmation shows and the change itself read the same query,
// so every case below asserts both, and that they agree.
//
// Which searches a scope leads to is poll-journal-reseed.test.ts. Here the
// deletion and the routes are asserted by what is left in the database.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "topic-scope-token";
const HEADERS = { "x-admin-token": "topic-scope-token", "content-type": "application/json" };

const ncbi = vi.hoisted(() => ({
  calls: [] as { term: string; since: string | undefined }[],
  // The MEDLINE checks asked for, and what each answers.
  indexingAsked: [] as string[],
  indexed: true as boolean | null,
  // The recent-paper samples journal suggestions asked for.
  sampled: [] as string[],
  // What a MEDLINE check waits on before it answers, when a test has to act
  // while one is out.
  held: null as Promise<void> | null,
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (term: string, mhdaSince?: string) => {
      ncbi.calls.push({ term, since: mhdaSince });
      return { ids: [], total: 0 };
    },
    isMedlineIndexed: async (nlmId: string) => {
      ncbi.indexingAsked.push(nlmId);
      await ncbi.held;
      return ncbi.indexed;
    },
    searchRecent: async (term: string) => {
      ncbi.sampled.push(term);
      return [];
    },
  };
});

// The vocabulary is seeded below (seedMesh), and that is all of it there is to
// load. Left alone, the first route to read a heading asks NLM which MeSH year
// is current before it answers: a request to nlmpubs.nlm.nih.gov from inside a
// test. On a slow day it outlasted that test's five seconds, and the topic it
// went on to create landed in the next test, which was refused as a duplicate.
// From the day NLM publishes a year newer than the one seeded, it would have
// downloaded that year over the seed.
vi.mock("./mesh-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mesh-catalog.js")>();
  return { ...actual, ensureMeshLoaded: async () => {} };
});

let db: Db;
let server: Server;
let base: string;
let withPollLock: typeof import("./poller.js").withPollLock;
let pollTopic: typeof import("./poller.js").pollTopic;

const TERM = '"Adipose Tissue"[MeSH]';
const ADIPOSE = { ui: "D000273", name: "Adipose Tissue" };
const OBESITY = { ui: "D009765", name: "Obesity" };

const LANCET = { nlmId: "2985213R", name: "Lancet", medlineIndexed: true };
const BMJ = { nlmId: "8900488", name: "BMJ", medlineIndexed: true };
const ELSEWHERE = "0255562"; // a journal no list here has
type Spec = typeof LANCET;

const list = (...journals: Spec[]) => ({ allPubmed: false as const, journals });
const ids = (...journals: Spec[]) => ({ allPubmed: false, nlmIds: journals.map((j) => j.nlmId) });
const ALL_PUBMED = { allPubmed: true as const };
const ALL_PUBMED_IDS = { allPubmed: true, nlmIds: [] };

function article(pmid: string, nlmId: string | null) {
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
  (
    db.db.prepare("SELECT topic_id FROM article_topics WHERE pmid = ? ORDER BY topic_id").all(pmid) as {
      topic_id: number;
    }[]
  ).map((r) => r.topic_id);
const journalRows = () =>
  (db.db.prepare("SELECT name FROM journals ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name
  );

const request = (method: string, path: string, body?: unknown, headers: HeadersInit = HEADERS) =>
  fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// The vocabulary the routes check headings against. Seeded once for the file;
// a test that revises it puts this back.
const seedMesh = (rows = [ADIPOSE, OBESITY]) =>
  db.replaceMeshData(
    rows.map((d) => ({ ...d, terms: [d.name] })),
    "2026"
  );

beforeAll(async () => {
  db = await openTempDb("topic-scope");
  seedMesh();
  db.bulkUpsertCatalog(
    [
      { nlm_id: LANCET.nlmId, title: "The Lancet", med_abbr: "Lancet" },
      { nlm_id: BMJ.nlmId, title: "BMJ (Clinical research ed.)", med_abbr: "BMJ" },
    ].map((c) => ({ ...c, iso_abbr: c.med_abbr, issn_print: "", issn_online: "" }))
  );
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  ({ withPollLock, pollTopic } = await import("./poller.js"));
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
  for (const table of ["topics", "journals", "articles", "bookmark_folders", "collections"]) {
    db.db.exec(`DELETE FROM ${table}`);
  }
  ncbi.calls = [];
  ncbi.indexingAsked = [];
  ncbi.indexed = true;
  ncbi.sampled = [];
  ncbi.held = null;
});

// The count ahead of a change and the change itself, which must agree on what
// leaves the feed.
function change(topicId: number, next: ReturnType<typeof list> | typeof ALL_PUBMED) {
  const nextIds = next.allPubmed ? ALL_PUBMED_IDS : ids(...next.journals);
  const counted = db.countScopeLeaving(topicId, nextIds);
  const result = db.setTopicScope(topicId, next);
  expect(result.removedFromInterests).toBe(counted);
  return result;
}

describe("dropping a journal from a topic's list", () => {
  it("deletes its unsaved papers, and takes saved ones out of the feed", () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ)).id;
    db.saveArticles(
      [
        article("1", BMJ.nlmId),
        article("2", LANCET.nlmId),
        article("3", LANCET.nlmId), // held in the library
        article("4", LANCET.nlmId), // bookmarked
      ],
      t
    );
    const shelf = db.createCollection("Shelf").id;
    db.addCollectionFiles(shelf, [{ hash: "a".repeat(64), name: "3.pdf" }]);
    db.setFileMatched(db.listCollectionFiles(shelf)[0].id, "3", "pmid");
    db.addBookmarks(db.createBookmarkFolder("Later").id, ["4"]);

    // Three leave the feed, saved ones included; one of them is deleted.
    expect(change(t, list(BMJ))).toEqual({ deletedArticles: 1, removedFromInterests: 3 });

    expect(["1", "2", "3", "4"].map((p) => [p, exists(p)])).toEqual([
      ["1", true],
      ["2", false],
      ["3", true],
      ["4", true],
    ]);
    expect([topicsOf("1"), topicsOf("3"), topicsOf("4")]).toEqual([[t], [], []]);
    // Out of Interests, still in its folder.
    expect(db.listBookmarks().map((b) => b.pmid)).toEqual(["4"]);
  });

  it("leaves the same journal's papers in every other topic", () => {
    const a = db.createTopic("Adipose Tissue", TERM, [], list(LANCET)).id;
    const b = db.createTopic("Obesity", '"Obesity"[MeSH]', [], list(LANCET)).id;
    db.saveArticles([article("1", LANCET.nlmId)], a);
    db.saveArticles([article("1", LANCET.nlmId), article("2", LANCET.nlmId)], b);

    // It leaves this feed, and is kept because another still holds it.
    expect(change(a, list())).toEqual({ deletedArticles: 0, removedFromInterests: 1 });
    expect([topicsOf("1"), topicsOf("2")]).toEqual([[b], [b]]);
    // The journal's row stays while the other topic lists it.
    expect(journalRows()).toEqual(["Lancet"]);
    expect(db.topicJournals(b).map((j) => j.name)).toEqual(["Lancet"]);
  });

  it("keeps a paper its poll found under another journal's id", () => {
    // A journal poll searches by name, and a name can match papers another
    // serial files under its own nlm_id — or under none. Those are not this
    // journal's by id, so dropping it leaves them: a stale link, not a deletion.
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ)).id;
    db.saveArticles([article("2", ELSEWHERE), article("3", null)], t);

    expect(change(t, list(BMJ))).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
    expect([topicsOf("2"), topicsOf("3")]).toEqual([[t], [t]]);
  });

  it("forgets a journal nothing lists any more", () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ)).id;
    expect(journalRows()).toEqual(["BMJ", "Lancet"]);
    change(t, list(BMJ));
    expect(journalRows()).toEqual(["BMJ"]);
  });
});

describe("adding a journal to a topic's list", () => {
  it("takes nothing out, whatever journal the feed's papers are filed under", () => {
    // The reason dropping tests for the journals dropped rather than for
    // "outside the list": that would sweep these out on an edit that only added.
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET)).id;
    db.saveArticles([article("1", LANCET.nlmId), article("2", ELSEWHERE), article("3", null)], t);

    expect(change(t, list(LANCET, BMJ))).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
    expect([topicsOf("1"), topicsOf("2"), topicsOf("3")]).toEqual([[t], [t], [t]]);
    expect(db.getTopic(t)!.journalCount).toBe(2);
  });
});

describe("changing a topic to search all of PubMed", () => {
  it("takes nothing out, and leaves it no list", () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ)).id;
    db.saveArticles([article("1", LANCET.nlmId)], t);

    expect(change(t, ALL_PUBMED)).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
    expect(topicsOf("1")).toEqual([t]);
    expect(db.getTopic(t)).toMatchObject({ all_pubmed: true, journalCount: 0 });
    expect(journalRows()).toEqual([]);
  });
});

describe("changing a topic from all of PubMed to a list", () => {
  it("takes out everything outside the list, a paper with no journal id included", () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], ALL_PUBMED).id;
    db.saveArticles([article("1", LANCET.nlmId), article("2", ELSEWHERE), article("3", null)], t);
    // In no feed at all, so nothing this topic's polls brought in.
    db.upsertArticles([article("5", ELSEWHERE)]);

    expect(change(t, list(LANCET))).toEqual({ deletedArticles: 2, removedFromInterests: 2 });
    expect(["1", "2", "3", "5"].map((p) => [p, exists(p)])).toEqual([
      ["1", true],
      ["2", false],
      ["3", false],
      ["5", true],
    ]);
    expect(topicsOf("1")).toEqual([t]);
    expect(db.getTopic(t)).toMatchObject({ all_pubmed: false, journalCount: 1 });
  });

  it("takes out the whole feed when the list is empty", () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], ALL_PUBMED).id;
    db.saveArticles([article("1", LANCET.nlmId), article("2", null)], t);

    expect(change(t, list())).toEqual({ deletedArticles: 2, removedFromInterests: 2 });
    expect(db.getTopic(t)).toMatchObject({ all_pubmed: false, journalCount: 0 });
  });

  it("keeps a paper another topic still holds", () => {
    const narrowed = db.createTopic("Adipose Tissue", TERM, [], ALL_PUBMED).id;
    const other = db.createTopic("Obesity", '"Obesity"[MeSH]', [], ALL_PUBMED).id;
    db.saveArticles([article("2", ELSEWHERE)], narrowed);
    db.saveArticles([article("2", ELSEWHERE)], other);

    expect(change(narrowed, list(LANCET))).toEqual({ deletedArticles: 0, removedFromInterests: 1 });
    expect(topicsOf("2")).toEqual([other]);
  });
});

describe("removing a topic", () => {
  it("forgets the journals only it listed", () => {
    const a = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ)).id;
    db.createTopic("Obesity", '"Obesity"[MeSH]', [], list(BMJ));
    db.removeTopicWithArticles(a);
    expect(journalRows()).toEqual(["BMJ"]);
  });
});

describe("two journals that go by one name", () => {
  // A journal is its NLM id. Its name is NLM's abbreviation, kept to show — and
  // was what `journals` held unique, so a journal that shared one with a
  // journal some topic already listed could be listed by nobody.
  const NURSING = { nlmId: "0000001", name: "Nursing", medlineIndexed: true };
  const NAMESAKE = { nlmId: "0000002", name: "Nursing", medlineIndexed: true };

  it("are two journals, each on the list that asked for it", () => {
    const a = db.createTopic("Adipose Tissue", TERM, [], list(NURSING)).id;
    const b = db.createTopic("Obesity", '"Obesity"[MeSH]', [], list(LANCET)).id;
    change(b, list(LANCET, NAMESAKE));

    expect(db.topicJournals(a).map((j) => j.nlm_id)).toEqual([NURSING.nlmId]);
    expect(db.topicJournals(b).map((j) => j.nlm_id)).toEqual([LANCET.nlmId, NAMESAKE.nlmId]);
    expect(journalRows()).toEqual(["Lancet", "Nursing", "Nursing"]);
  });

  it("and one journal is one row, whatever it is called the second time", () => {
    db.createTopic("Adipose Tissue", TERM, [], list(NURSING));
    expect(() => db.createJournal("Nursing (Lond)", NURSING.nlmId)).toThrow(/UNIQUE/);
  });

  it("are searched for apart, each topic for the one it lists", async () => {
    // A poll searched by name, so the topic listing one got the papers of
    // both, and dropping its journal later took only that journal's back out.
    const a = db.createTopic("Adipose Tissue", TERM, [], list(NURSING)).id;
    const b = db.createTopic("Obesity", '"Obesity"[MeSH]', [], list(NAMESAKE)).id;
    await pollTopic(a);
    await pollTopic(b);
    expect(ncbi.calls.map((c) => c.term)).toEqual([
      `(${TERM}) AND ("${NURSING.nlmId}"[jid])`,
      `("Obesity"[MeSH]) AND ("${NAMESAKE.nlmId}"[jid])`,
    ]);
  });
});

describe("the routes", () => {
  const create = (body: Record<string, unknown>) =>
    request("POST", "/topics", { headings: [ADIPOSE.ui], ...body });

  it("create a topic that searches all of PubMed", async () => {
    const res = await create({ allPubmed: true, journals: [LANCET.nlmId] });
    expect(res.status).toBe(201);
    // The journals sent with it are not a list it keeps.
    expect(await res.json()).toMatchObject({ all_pubmed: true, journalCount: 0, journals: [] });
    expect(journalRows()).toEqual([]);
  });

  it("create a topic with a list, resolved against the catalog", async () => {
    ncbi.indexed = false;
    const res = await create({ allPubmed: false, journals: [LANCET.nlmId, BMJ.nlmId] });
    expect(res.status).toBe(201);
    const topic = await res.json();
    expect(topic).toMatchObject({ all_pubmed: false, journalCount: 2 });
    // Named as the catalog abbreviates them, and carrying what NLM said about
    // each — which is how the dialog knows to warn about one that can't match.
    expect(topic.journals.map((j: { name: string; medline_indexed: boolean }) => [j.name, j.medline_indexed])).toEqual([
      ["BMJ", false],
      ["Lancet", false],
    ]);
    expect(ncbi.indexingAsked.sort()).toEqual([LANCET.nlmId, BMJ.nlmId].sort());
  });

  it("don't ask NLM again about a journal another topic already lists", async () => {
    db.createTopic("Obesity", '"Obesity"[MeSH]', [OBESITY], list(LANCET));
    const res = await create({ allPubmed: false, journals: [LANCET.nlmId] });
    expect(res.status).toBe(201);
    expect(ncbi.indexingAsked).toEqual([]);
    expect(journalRows()).toEqual(["Lancet"]);
  });

  it("refuse a journal the catalog doesn't have, and store nothing", async () => {
    const res = await create({ allPubmed: false, journals: [LANCET.nlmId, "0000000"] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("0000000");
    expect(db.listTopics()).toEqual([]);
    expect(journalRows()).toEqual([]);
  });

  it("create a topic with nowhere to search when no scope is sent", async () => {
    const topic = await (await create({})).json();
    expect(topic).toMatchObject({ all_pubmed: false, journalCount: 0 });
  });

  it("return one topic with its journals, and 404 for one that isn't there", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list(LANCET, BMJ)).id;
    const res = await request("GET", `/topics/${t}`, undefined, {});
    expect(res.status).toBe(200);
    const topic = await res.json();
    expect(topic.journals.map((j: { name: string }) => j.name)).toEqual(["BMJ", "Lancet"]);
    expect(topic.headings).toEqual([ADIPOSE]);
    expect((await request("GET", "/topics/987654")).status).toBe(404);
  });

  it("change a scope with the count the confirm showed", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list(LANCET, BMJ)).id;
    db.saveArticles([article("1", BMJ.nlmId), article("2", LANCET.nlmId)], t);
    const next = { allPubmed: false, journals: [BMJ.nlmId] };

    const counted = await request("POST", `/topics/${t}/scope/preview`, next);
    expect(await counted.json()).toEqual({ count: 1 });
    // Counting changed nothing.
    expect(topicsOf("2")).toEqual([t]);

    const res = await request("PATCH", `/topics/${t}`, next);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toEqual({ deletedArticles: 1, removedFromInterests: 1 });
    expect(body.topic).toMatchObject({ all_pubmed: false, journalCount: 1 });
    expect(body.topic.journals.map((j: { name: string }) => j.name)).toEqual(["BMJ"]);
    expect(exists("2")).toBe(false);
  });

  it("change a name and a scope together", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list(LANCET)).id;
    const res = await request("PATCH", `/topics/${t}`, { name: "Fat", allPubmed: true });
    expect((await res.json()).topic).toMatchObject({ name: "Fat", all_pubmed: true });
  });

  it("refuse a list that names no journals, and change nothing", async () => {
    // Half a scope used to be completed as an empty list, which took every
    // paper out of the topic with no count shown ahead of it.
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list(LANCET)).id;
    db.saveArticles([article("2", LANCET.nlmId)], t);

    const res = await request("PATCH", `/topics/${t}`, { name: "Fat", allPubmed: false });
    expect(res.status).toBe(400);
    expect(exists("2")).toBe(true);
    // Not half applied: the name that came with the refused scope isn't taken.
    expect(db.getTopic(t)).toMatchObject({ name: "Adipose Tissue", journalCount: 1 });

    // Nor is a list written as something that isn't one: null is what a client
    // with no list to send often writes, and it was completed the same way.
    for (const journals of [null, "", "2985213R", {}]) {
      const half = await request("PATCH", `/topics/${t}`, { allPubmed: false, journals });
      expect(half.status).toBe(400);
      expect((await request("PATCH", `/topics/${t}`, { journals })).status).toBe(400);
    }
    expect(exists("2")).toBe(true);
    expect(db.getTopic(t)).toMatchObject({ journalCount: 1 });

    // An empty list asked for by name is a scope like any other.
    const emptied = await request("PATCH", `/topics/${t}`, { allPubmed: false, journals: [] });
    expect(emptied.status).toBe(200);
    expect(db.getTopic(t)).toMatchObject({ all_pubmed: false, journalCount: 0 });
    expect(exists("2")).toBe(false);
  });

  it("refuse a change of scope while a poll holds the lock, and change nothing", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list(LANCET)).id;
    db.saveArticles([article("2", LANCET.nlmId)], t);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = withPollLock(async () => {
      await held;
    });

    try {
      const res = await request("PATCH", `/topics/${t}`, { name: "Fat", allPubmed: false, journals: [] });
      expect(res.status).toBe(409);
      expect(exists("2")).toBe(true);
      // Not half applied: the name that came with the refused scope isn't taken.
      expect(db.getTopic(t)).toMatchObject({ name: "Adipose Tissue", journalCount: 1 });
      // A name alone changes nothing a poll reads, and waits on nothing.
      expect((await request("PATCH", `/topics/${t}`, { name: "Fat" })).status).toBe(200);
    } finally {
      // Whatever happened, or the lock outlives this test and fails the next.
      release();
      await holding;
    }
  });

  it("refuse a name another topic took while the journals were being resolved", async () => {
    // A journal new to the library is asked about at NLM, and the name used to
    // be asked about only before that wait. A topic created meanwhile left two
    // of one name, which the picker can't tell apart.
    const t = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], ALL_PUBMED).id;
    let answer!: () => void;
    ncbi.held = new Promise<void>((r) => (answer = r));
    const changing = request("PATCH", `/topics/${t}`, {
      name: "Fat",
      allPubmed: false,
      journals: [LANCET.nlmId],
    });
    await vi.waitFor(() => expect(ncbi.indexingAsked).toEqual([LANCET.nlmId]));
    db.createTopic("Fat", '"Obesity"[MeSH]', [OBESITY], ALL_PUBMED);
    answer();

    const res = await changing;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A topic named “Fat” already exists.");
    // Not half applied: the scope that came with the refused name isn't taken.
    expect(db.getTopic(t)).toMatchObject({ name: "Adipose Tissue", all_pubmed: true, journalCount: 0 });
  });

  it("suggest journals for the headings asked about, to the owner alone", async () => {
    const path = `/journals/suggest?ui=${ADIPOSE.ui}&ui=${OBESITY.ui}`;
    expect((await request("GET", path, undefined, {})).status).toBe(401);
    expect(ncbi.sampled).toEqual([]);

    const res = await request("GET", path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    // Mainly about both first; then, with nothing recent that is, about both.
    expect(ncbi.sampled).toEqual([
      '"Adipose Tissue"[majr] AND "Obesity"[majr]',
      '"Adipose Tissue"[MeSH] AND "Obesity"[MeSH]',
    ]);
    expect((await request("GET", "/journals/suggest")).status).toBe(400);
  });

  it("suggest journals for a topic whose heading NLM has since retired", async () => {
    // The dialog asks about an existing topic by the headings it has, which
    // can't be changed. Checked against this year's vocabulary, a heading NLM
    // had retired made Auto answer that it isn't a MeSH heading and to pick
    // another, to someone with no way to.
    db.createTopic("Adipose Tissue", TERM, [ADIPOSE], ALL_PUBMED);
    seedMesh([OBESITY]);
    try {
      const res = await request("GET", `/journals/suggest?ui=${ADIPOSE.ui}`);
      expect(res.status).toBe(200);
      // Under the name the topic recorded, which is what it polls.
      expect(ncbi.sampled[0]).toBe('"Adipose Tissue"[majr]');
      // An id no topic carries is still refused, and a retired heading is not
      // one a new topic can be made from.
      expect((await request("GET", "/journals/suggest?ui=D000000")).status).toBe(422);
      expect((await request("POST", "/topics", { headings: [ADIPOSE.ui] })).status).toBe(422);
    } finally {
      seedMesh();
    }
  });

  it("refuse a check for new papers when no topic has anywhere to search", async () => {
    db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list());
    const res = await request("POST", "/refresh");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no journals are chosen/i);
    expect(ncbi.calls).toEqual([]);
  });

  it("check a topic across all of PubMed with no journals anywhere", async () => {
    db.createTopic("Adipose Tissue", TERM, [ADIPOSE], ALL_PUBMED);
    const res = await request("POST", "/refresh");
    expect(res.status).toBe(200);
    expect(ncbi.calls).toEqual([{ term: buildTerm(TERM, []), since: undefined }]);
  });

  it("say why a topic asked for by name can't be checked", async () => {
    const unset = db.createTopic("Adipose Tissue", TERM, [ADIPOSE], list()).id;
    db.createTopic("Obesity", '"Obesity"[MeSH]', [OBESITY], ALL_PUBMED);
    const res = await request("POST", `/refresh?topic=${unset}`);
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toMatch(/no journals are chosen/i);
    expect(ncbi.calls).toEqual([]);
  });
});
