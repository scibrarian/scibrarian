import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// A poll after the journal list widens has to scan the topic's whole history.
//
// Polls are incremental — only papers indexed since the topic's last poll —
// and adding a journal widens every topic's search. Without a re-scan the new
// journal contributes only papers indexed from the day it was added, and its
// back catalogue never arrives. Removing a journal and adding it back is the
// sharpest case: the removal deletes its papers, and the next poll resumes from
// the watermark and finds none of them. Removing the last journal widens too,
// from those journals to all of PubMed; removing any other one narrows, and
// stays incremental.
//
// What is asserted is the MeSH-date bound each poll asks PubMed for: a date is
// incremental, undefined is a full re-scan. The search is mocked to record that
// and return nothing, so no poll here touches the network.

const ncbi = vi.hoisted(() => ({
  since: [] as (string | undefined)[],
  park: null as Promise<unknown> | null,
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (_term: string, mhdaSince?: string) => {
      ncbi.since.push(mhdaSince);
      if (ncbi.park) await ncbi.park;
      return { ids: [], total: 0 };
    },
  };
});

let db: Db;
let pollTopic: typeof import("./poller.js").pollTopic;

// A journal added well before the topic's watermark, so it can't count as new.
function oldJournal(name: string, nlmId: string) {
  const j = db.createJournal(name, nlmId, true);
  db.db.prepare("UPDATE journals SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(j.id);
  return j;
}

function polledTopic() {
  const t = db.createTopic("Adipose Tissue", '"Adipose Tissue"[MeSH]');
  db.setTopicLastPolled(t.id, "2026-02-01T00:00:00.000Z");
  return t;
}

beforeAll(async () => {
  db = await openTempDb("poll-reseed");
  ({ pollTopic } = await import("./poller.js"));
});

afterAll(closeTempDb);

beforeEach(() => {
  db.db.exec(
    "DELETE FROM topics; DELETE FROM journals; DELETE FROM settings WHERE key = 'journals_emptied_at';"
  );
  ncbi.since = [];
  ncbi.park = null;
});

describe("polling after the journal list widens", () => {
  it("stays incremental when no journal was added since the last poll", async () => {
    oldJournal("Lancet", "2985213R");
    const t = polledTopic();
    await pollTopic(t.id);
    expect(ncbi.since).toEqual(["2026/01/31"]);
  });

  it("re-scans the whole history after a journal is removed and added back", async () => {
    const j = oldJournal("Lancet", "2985213R");
    const t = polledTopic();
    db.removeJournalWithArticles(j.id);
    db.createJournal("Lancet", "2985213R", true);
    await pollTopic(t.id);
    expect(ncbi.since).toEqual([undefined]);
  });

  it("re-scans the whole history after the last journal is removed", async () => {
    const j = oldJournal("Lancet", "2985213R");
    const t = polledTopic();
    db.removeJournalWithArticles(j.id);
    await pollTopic(t.id);
    expect(ncbi.since).toEqual([undefined]);
  });

  it("stays incremental after removing a journal that isn't the last", async () => {
    const j = oldJournal("Lancet", "2985213R");
    oldJournal("BMJ", "8900488");
    const t = polledTopic();
    db.removeJournalWithArticles(j.id);
    await pollTopic(t.id);
    expect(ncbi.since).toEqual(["2026/01/31"]);
  });

  it("re-scans after a journal added while a poll was in flight", async () => {
    oldJournal("Lancet", "2985213R");
    const t = polledTopic();

    let release!: () => void;
    ncbi.park = new Promise<void>((r) => (release = r));
    const inFlight = pollTopic(t.id);
    db.createJournal("BMJ", "8900488", true);
    // The poll finishes well after the add. Stamping the finish time as the
    // watermark would put it after the journal's created_at, and the next poll
    // would resume from there instead of re-scanning.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    release();
    await inFlight;
    vi.useRealTimers();
    ncbi.park = null;

    await pollTopic(t.id);
    expect(ncbi.since).toEqual(["2026/01/31", undefined]);
  });
});
