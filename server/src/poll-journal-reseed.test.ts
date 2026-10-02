import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerm } from "./pubmed-parse.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Which history a poll asks PubMed for.
//
// Each topic searches its own scope: all of PubMed, or a list of journals of
// its own. Polls are incremental — only papers indexed since the topic's last
// poll — which only reaches the back catalogue of a journal the topic was
// already searching. So a journal the topic hasn't scanned yet has its whole
// history listed, and only that journal: re-listing every journal's history
// after an add would push a broad topic into PubMed's cap for nothing.
// Dropping a journal and adding it back is the sharpest case: the drop took its
// papers out of the topic, and an incremental poll would never find them again.
//
// Dropping a journal narrows the search and stays incremental. Dropping the
// last one leaves nothing to search: the bare term would be all of PubMed,
// which is a scope a topic is given and never one it falls into, so no poll
// runs, scheduled or not.
//
// A change between a list and all of PubMed starts the topic over, because a
// poll vouches only for the scope it ran under.
//
// What is asserted is each search a poll makes: its term, and the MeSH-date
// bound (a date is incremental, undefined is the whole history). The search is
// mocked to record that and return nothing, so no poll here touches the network.

const ncbi = vi.hoisted(() => ({
  calls: [] as { term: string; since: string | undefined }[],
  park: null as Promise<unknown> | null,
  fail: false,
  // What a search answers, by its term, where a test needs more than nothing.
  answers: new Map<string, { ids: string[]; total: number }>(),
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (term: string, mhdaSince?: string) => {
      ncbi.calls.push({ term, since: mhdaSince });
      if (ncbi.fail) throw new Error("NCBI unreachable");
      if (ncbi.park) await ncbi.park;
      return ncbi.answers.get(term) ?? { ids: [], total: 0 };
    },
  };
});

let db: Db;
let pollTopic: typeof import("./poller.js").pollTopic;
let runPoll: typeof import("./poller.js").runPoll;

const TERM = '"Adipose Tissue"[MeSH]';
const OTHER_TERM = '"Obesity"[MeSH]';
const WATERMARK = "2026-02-01T00:00:00.000Z";
// A day before WATERMARK, in PubMed's format — see mhdaWindowStart.
const SINCE = "2026/01/31";

const LANCET = { nlmId: "2985213R", name: "Lancet", medlineIndexed: true };
const BMJ = { nlmId: "8900488", name: "BMJ", medlineIndexed: true };
type Spec = typeof LANCET;

const list = (...journals: Spec[]) => ({ allPubmed: false as const, journals });
const ALL_PUBMED = { allPubmed: true as const };

const search = (journals: string[], since?: string, term = TERM) => ({
  term: buildTerm(term, journals),
  since,
});

// A topic that has had its first poll under the scope given, with its
// watermark pinned so the incremental bound is a known date.
async function seededTopic(scope: ReturnType<typeof list> | typeof ALL_PUBMED) {
  const t = db.createTopic("Adipose Tissue", TERM, [], scope);
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

// Deleting the topics and journals takes their topic_journals rows too.
beforeEach(() => {
  db.db.exec("DELETE FROM topics; DELETE FROM journals; DELETE FROM articles;");
  ncbi.calls = [];
  ncbi.park = null;
  ncbi.fail = false;
  ncbi.answers.clear();
});

describe("which history a topic with a list of journals asks for", () => {
  it("lists every journal's history on its first poll", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], list(LANCET, BMJ));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ", "Lancet"])]);
  });

  it("stays incremental once every journal has been scanned", async () => {
    const t = await seededTopic(list(LANCET));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"], SINCE)]);
  });

  it("lists only an added journal's history, beside the incremental poll of the rest", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);

    // And only once: the next poll has both journals caught up.
    db.setTopicLastPolled(t.id, WATERMARK);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ", "Lancet"], SINCE)]);
  });

  it("lists a journal's history again after it is dropped and added back", async () => {
    const t = await seededTopic(list(LANCET, BMJ));
    db.setTopicScope(t.id, list(BMJ));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"]), search(["BMJ"], SINCE)]);
  });

  it("stays incremental after dropping a journal that isn't the last", async () => {
    const t = await seededTopic(list(LANCET, BMJ));
    db.setTopicScope(t.id, list(BMJ));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"], SINCE)]);
  });

  it("searches nothing once the last journal is dropped", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list());
    expect((await pollTopic(t.id)).error).toMatch(/no journals are chosen/i);
    expect(ncbi.calls).toEqual([]);
  });

  it("searches its own list, not another topic's", async () => {
    const a = db.createTopic("Adipose Tissue", TERM, [], list(LANCET));
    const b = db.createTopic("Obesity", OTHER_TERM, [], list(BMJ));
    await pollTopic(a.id);
    await pollTopic(b.id);
    expect(ncbi.calls).toEqual([search(["Lancet"]), search(["BMJ"], undefined, OTHER_TERM)]);
  });

  it("scans a journal for each topic that lists it", async () => {
    // One row in `journals`, scanned by one topic and not yet by the other.
    const a = await seededTopic(list(LANCET));
    const b = db.createTopic("Obesity", OTHER_TERM, [], list(LANCET));
    await pollTopic(b.id);
    await pollTopic(a.id);
    expect(ncbi.calls).toEqual([
      search(["Lancet"], undefined, OTHER_TERM),
      search(["Lancet"], SINCE),
    ]);
  });

  it("lists a journal added while a poll was in flight on the next poll", async () => {
    const t = await seededTopic(list(LANCET));

    let release!: () => void;
    ncbi.park = new Promise<void>((r) => (release = r));
    const inFlight = pollTopic(t.id);
    // The routes take the poll lock for this, so it can't happen through them;
    // the poll itself must still not vouch for a journal it never searched.
    db.setTopicScope(t.id, list(LANCET, BMJ));
    release();
    await inFlight;
    ncbi.park = null;

    db.setTopicLastPolled(t.id, WATERMARK);
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);
  });

  it("lists the history again when the poll that tried it failed", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    ncbi.fail = true;
    expect((await pollTopic(t.id)).error).toBeTruthy();

    ncbi.fail = false;
    ncbi.calls = [];
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);
  });
});

describe("which history a topic searching all of PubMed asks for", () => {
  it("lists its history across all of PubMed on its first poll", async () => {
    const t = db.createTopic("Adipose Tissue", TERM, [], ALL_PUBMED);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([])]);
  });

  it("continues from its watermark after that", async () => {
    const t = await seededTopic(ALL_PUBMED);
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search([], SINCE)]);
  });
});

describe("a change between a list and all of PubMed", () => {
  it("starts a topic over across all of PubMed, and leaves it no list", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, ALL_PUBMED);
    expect(db.getTopic(t.id)).toMatchObject({
      all_pubmed: true,
      journalCount: 0,
      last_polled_at: null,
    });
    await pollTopic(t.id);
    // The whole history: the list's polls never looked outside the list.
    expect(ncbi.calls).toEqual([search([])]);
  });

  it("starts a topic over on its list", async () => {
    const t = await seededTopic(ALL_PUBMED);
    db.setTopicScope(t.id, list(LANCET));
    expect(db.getTopic(t.id)).toMatchObject({ all_pubmed: false, last_polled_at: null });
    await pollTopic(t.id);
    // The whole history: a search of all PubMed is capped, and may never have
    // reached this journal's back catalogue.
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("scans every listed journal again after a trip through all of PubMed", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, ALL_PUBMED);
    db.setTopicScope(t.id, list(LANCET));
    await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("keeps the watermark when the list changes and the kind of scope doesn't", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    expect(db.getTopic(t.id)!.last_polled_at).toBe(WATERMARK);
  });
});

describe("what a poll reports PubMed left out", () => {
  // Stored already, so a poll that finds them links them without a fetch.
  function stored(...pmids: string[]) {
    db.upsertArticles(
      pmids.map((pmid) => ({
        pmid,
        title: `Paper ${pmid}`,
        abstract: "",
        journal_name: "",
        nlm_id: null,
        authors: [],
        pub_date: "2026-01-01",
        pub_date_display: "2026",
        doi: "",
        url: "",
      }))
    );
  }

  it("counts what each search matched and didn't return", async () => {
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    stored("1", "2", "3");
    // BMJ's history is capped; the incremental Lancet search isn't.
    ncbi.answers.set(search(["BMJ"]).term, { ids: ["1", "2"], total: 5 });
    ncbi.answers.set(search(["Lancet"]).term, { ids: ["3"], total: 1 });

    const result = await pollTopic(t.id);
    expect(ncbi.calls).toEqual([search(["BMJ"]), search(["Lancet"], SINCE)]);
    expect({ found: result.found, truncated: result.truncated }).toEqual({ found: 3, truncated: 3 });
  });

  it("doesn't count a paper two searches both return as left out", async () => {
    // A journal poll searches by name, and one paper can match two names.
    const t = await seededTopic(list(LANCET));
    db.setTopicScope(t.id, list(LANCET, BMJ));
    stored("1");
    ncbi.answers.set(search(["BMJ"]).term, { ids: ["1"], total: 1 });
    ncbi.answers.set(search(["Lancet"]).term, { ids: ["1"], total: 1 });

    const result = await pollTopic(t.id);
    expect({ found: result.found, truncated: result.truncated }).toEqual({
      found: 1,
      truncated: undefined,
    });
  });
});

describe("scheduled polls", () => {
  it("skip while no topic has anywhere to search", async () => {
    db.createTopic("Adipose Tissue", TERM, [], list());
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([]);
  });

  it("run for a topic with a journal on its list", async () => {
    db.createTopic("Adipose Tissue", TERM, [], list(LANCET));
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([search(["Lancet"])]);
  });

  it("run for a topic that searches all of PubMed, with no journals anywhere", async () => {
    db.createTopic("Adipose Tissue", TERM, [], ALL_PUBMED);
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([search([])]);
  });

  it("leave out a topic with no journals chosen, and check the rest", async () => {
    db.createTopic("Adipose Tissue", TERM, [], list());
    db.createTopic("Obesity", OTHER_TERM, [], ALL_PUBMED);
    await runPoll("scheduled");
    expect(ncbi.calls).toEqual([search([], undefined, OTHER_TERM)]);
  });
});
