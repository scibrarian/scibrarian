import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerm } from "./pubmed-parse.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Which history a poll asks PubMed for.
//
// Polls are incremental — only papers indexed since the topic's last poll —
// which only reaches the back catalogue of a journal the topic was already
// searching. So a journal the topic hasn't scanned yet has its whole history
// listed, and only that journal: re-listing every journal's history after an
// add would push a broad topic into PubMed's cap for nothing. Removing a
// journal and adding it back is the sharpest case: the removal deletes its
// papers, and an incremental poll would never find them again.
//
// Removing a journal narrows the search and stays incremental. Removing the
// last one leaves nothing to search: the bare term would be all of PubMed,
// which only the "Search all PubMed journals" setting asks for (see
// poll-all-pubmed.test.ts), so no poll runs, scheduled or not.
//
// What is asserted is each search a poll makes: its term, and the MeSH-date
// bound (a date is incremental, undefined is the whole history). The search is
// mocked to record that and return nothing, so no poll here touches the network.

const ncbi = vi.hoisted(() => ({
  calls: [] as { term: string; since: string | undefined }[],
  park: null as Promise<unknown> | null,
  fail: false,
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (term: string, mhdaSince?: string) => {
      ncbi.calls.push({ term, since: mhdaSince });
      if (ncbi.fail) throw new Error("NCBI unreachable");
      if (ncbi.park) await ncbi.park;
      return { ids: [], total: 0 };
    },
  };
});

let db: Db;
let pollTopic: typeof import("./poller.js").pollTopic;
let runPoll: typeof import("./poller.js").runPoll;

const TERM = '"Adipose Tissue"[MeSH]';
const WATERMARK = "2026-02-01T00:00:00.000Z";
// A day before WATERMARK, in PubMed's format — see mhdaWindowStart.
const SINCE = "2026/01/31";

const search = (journals: string[], since?: string) => ({ term: buildTerm(TERM, journals), since });

// A topic that has had its first poll against whatever journals exist now,
// with its watermark pinned so the incremental bound is a known date.
async function seededTopic() {
  const t = db.createTopic("Adipose Tissue", TERM);
  await pollTopic(t.id);
  db.setTopicLastPolled(t.id, WATERMARK);
  ncbi.calls = [];
  return t;
}

beforeAll(async () => {
  db = await openTempDb("poll-reseed");
  ({ pollTopic, runPoll } = await import("./poller.js"));
});

afterAll(closeTempDb);

// Deleting the topics and journals takes their topic_journal_scans rows too.
beforeEach(() => {
  db.db.exec(
    "DELETE FROM topics; DELETE FROM journals; DELETE FROM settings WHERE key = 'search_all_pubmed';"
  );
  ncbi.calls = [];
  ncbi.park = null;
  ncbi.fail = false;
});

describe("which history a poll lists", () => {
  it("lists every journal's history on a topic's first poll", async () => {
    db.createJournal("Lancet", "2985213R", true);
    db.createJournal("BMJ", "8900488", true);
    const t = db.createTopic("Adipose Tissue", TERM);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ", "Lancet"])]);
  });

  it("stays incremental once every journal has been scanned", async () => {
    db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"], SINCE)]);
  });

  it("lists only an added journal's history, beside the incremental poll of the rest", async () => {
    db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();
    db.createJournal("BMJ", "8900488", true);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);

    // And only once: the next poll has both journals caught up.
    db.setTopicLastPolled(t.id, WATERMARK);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ", "Lancet"], SINCE)]);
  });

  it("lists a journal's history again after it is removed and added back", async () => {
    const j = db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();
    db.removeJournalWithArticles(j.id);
    db.createJournal("Lancet", "2985213R", true);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("stays incremental after removing a journal that isn't the last", async () => {
    const j = db.createJournal("Lancet", "2985213R", true);
    db.createJournal("BMJ", "8900488", true);
    const t = await seededTopic();
    db.removeJournalWithArticles(j.id);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"], SINCE)]);
  });

  it("searches nothing once the last journal is removed", async () => {
    const j = db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();
    db.removeJournalWithArticles(j.id);
    expect((await pollTopic(t.id)).error).toMatch(/no journals are watched/i);
    expect(ncbi.calls).toEqual([]);
  });

  it("lists a journal added while a poll was in flight on the next poll", async () => {
    db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();

    let release!: () => void;
    ncbi.park = new Promise<void>((r) => (release = r));
    const inFlight = pollTopic(t.id);
    db.createJournal("BMJ", "8900488", true);
    release();
    await inFlight;
    ncbi.park = null;

    // The in-flight poll read its journals before BMJ existed, so finishing
    // must not have marked BMJ as scanned.
    db.setTopicLastPolled(t.id, WATERMARK);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);
  });

  it("lists the history again when the poll that tried it failed", async () => {
    db.createJournal("Lancet", "2985213R", true);
    const t = await seededTopic();
    db.createJournal("BMJ", "8900488", true);
    ncbi.fail = true;
    expect((await pollTopic(t.id)).error).toBeTruthy();

    ncbi.fail = false;
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);
  });
});

describe("scheduled polls", () => {
  it("skip while no journals are watched", async () => {
    db.createTopic("Adipose Tissue", TERM);
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([]);
  });

  it("run once a journal is watched", async () => {
    db.createJournal("Lancet", "2985213R", true);
    db.createTopic("Adipose Tissue", TERM);
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("run with no journals while every topic searches all of PubMed", async () => {
    db.setSearchAllPubmed(true);
    db.createTopic("Adipose Tissue", TERM);
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([search([])]);
  });
});
