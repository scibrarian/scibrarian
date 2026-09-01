import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The two counts GET /collections reports, and why a collection needs both.
//
// `matched` answers "how many uploads found a paper" and `held` answers "how
// many papers does this hold" — the same rows, counted against the two
// spellings db.ts separates under "what 'held' means". They read the same on
// every collection where each paper arrived as exactly one file, which is most
// of them, and that is what makes the distinction easy to collapse by accident:
// aliasing one to the other passes any fixture that never uploads a paper
// twice. This one does.

let db: Db;
let collection: number;

// Two files for one paper — the preprint and the published PDF, say. Distinct
// hashes because UNIQUE(collection_id, content_hash) is what stops a genuine
// re-upload from counting twice, and this is not that.
const SAME_PAPER = "31111111";
const PREPRINT = "hash-preprint";
const PUBLISHED = "hash-published";
const OTHER_PAPER = "32222222";
const OTHER = "hash-other";
// Uploaded but never matched: it lifts `files` above `matched`, so a test that
// confused the two would not read as passing by coincidence.
const UNMATCHED = "hash-unmatched";

const article = (pmid: string) => ({
  pmid,
  title: `Paper ${pmid}`,
  abstract: "",
  journal_name: "Gut",
  mesh: { status: "MEDLINE", headings: [] },
  nlm_id: null,
  authors: ["Smith J"],
  pub_date: "2021-01-01",
  pub_date_display: "2021",
  doi: `10.1000/${pmid}`,
  url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
});

beforeAll(async () => {
  db = await openTempDb("collection-counts");
  collection = db.createCollection("Duplicates").id;
  db.upsertArticles([article(SAME_PAPER), article(OTHER_PAPER)]);
  db.addCollectionFiles(collection, [
    { hash: PREPRINT, name: "preprint.pdf" },
    { hash: PUBLISHED, name: "published.pdf" },
    { hash: OTHER, name: "other.pdf" },
    { hash: UNMATCHED, name: "scan.pdf" },
  ]);
  const byHash: Record<string, string> = {
    [PREPRINT]: SAME_PAPER,
    [PUBLISHED]: SAME_PAPER,
    [OTHER]: OTHER_PAPER,
  };
  for (const f of db.listCollectionFiles(collection)) {
    const pmid = byHash[f.content_hash];
    if (pmid) db.setFileMatched(f.id, pmid, "manual");
  }
});

afterAll(closeTempDb);

const counts = () => db.collectionCounts()[collection];

describe("the counts a collection reports", () => {
  it("counts every uploaded file, matched or not", () => {
    expect(counts().files).toBe(4);
  });

  it("counts matched uploads as files, so one paper twice counts twice", () => {
    expect(counts().matched).toBe(3);
  });

  it("counts held papers distinctly, so one paper twice counts once", () => {
    // The number the papers views list, and the one an emptiness check has to
    // ask (see App's knownEmpty). Two, not three.
    expect(counts().held).toBe(2);
  });

  it("agrees with the membership query about what the collection holds", () => {
    // The point of spelling this count with heldFile: it cannot answer a
    // different number than the join that actually selects the papers.
    expect(db.listPapers({ collection }, {}).length).toBe(counts().held);
  });
});
