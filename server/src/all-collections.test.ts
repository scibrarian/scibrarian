import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The all-collections paper source, against a real SQLite file.
//
// Worth a DB test rather than a unit test because the change is a join, and the
// bug it guards is one of omission: a search scoped to a single collection
// answers "not here" for a paper the library holds in a *different* collection,
// which reads as "buy it". Only running the query across two collections shows
// the difference. The opposite error is worse, so the fixture pins it too: an
// articles row the library has merely *seen* must never surface here, because
// this is the view a writer reads as "we have it, don't buy it".
//
// It also pins the row shape. Three separate places asked `"collectionId" in
// source` to mean "does this source have files behind it", and a second
// file-bearing source silently answers no — which would drop file_id, the
// body-text clause and the excerpts all at once, without failing a type check.
//
// db.ts opens its database at import time, so the temp path is set before the
// dynamic import below and the module graph is loaded exactly once.

type Db = typeof import("./db.js");
type Src = Parameters<Db["listPapers"]>[0];

let db: Db;
let tmpDir: string;
let novartis: number;
let pfizer: number;
let feed: number;

// Journals and headings differ per paper so the facet and chip queries can be
// told apart by source rather than all returning the same one thing.
const CARDIO = { ui: "D001", name: "Cardiology" };
const NEPHRO = { ui: "D002", name: "Nephrology" };
const HEPATO = { ui: "D003", name: "Hepatology" };

const ONLY_A = {
  pmid: "11111111",
  hash: "a".repeat(64),
  title: "Cardiac outcomes in cohort A",
  journal: "Lancet",
  mesh: [{ ...CARDIO, major: true }],
};
const ONLY_B = {
  pmid: "22222222",
  hash: "b".repeat(64),
  title: "Renal outcomes in cohort B",
  journal: "Kidney International",
  mesh: [{ ...NEPHRO, major: false }],
};
// The same file filed under both engagements — reuse happens in practice.
const IN_BOTH = {
  pmid: "33333333",
  hash: "c".repeat(64),
  title: "Shared methodology review",
  journal: "Lancet",
  mesh: [{ ...CARDIO, major: false }],
};
// Seen, never held: a topic feed turned this one up and nobody uploaded a file
// for it. Every other fixture article is held somewhere, so without this one
// the membership join could be deleted outright and every assertion below
// would still pass.
const SEEN_ONLY = {
  pmid: "44444444",
  title: "Hepatic outcomes in cohort D",
  journal: "Hepatology",
  mesh: [{ ...HEPATO, major: true }],
};

function article(p: {
  pmid: string;
  title: string;
  journal: string;
  mesh: { ui: string; name: string; major: boolean }[];
}) {
  return {
    pmid: p.pmid,
    title: p.title,
    abstract: "",
    journal_name: p.journal,
    mesh: { status: "MEDLINE", headings: p.mesh },
    nlm_id: null,
    authors: ["Smith J"],
    pub_date: "2021-01-01",
    pub_date_display: "2021",
    doi: `10.1000/${p.pmid}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scibrarian-all-collections-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  db = await import("./db.js");

  novartis = db.createCollection("Novartis").id;
  pfizer = db.createCollection("Pfizer").id;
  db.upsertArticles([article(ONLY_A), article(ONLY_B), article(IN_BOTH)]);

  db.addCollectionFiles(novartis, [
    { hash: ONLY_A.hash, name: "a.pdf" },
    { hash: IN_BOTH.hash, name: "shared.pdf" },
  ]);
  db.addCollectionFiles(pfizer, [
    { hash: ONLY_B.hash, name: "b.pdf" },
    { hash: IN_BOTH.hash, name: "shared.pdf" },
  ]);
  const byHash: Record<string, string> = {
    [ONLY_A.hash]: ONLY_A.pmid,
    [ONLY_B.hash]: ONLY_B.pmid,
    [IN_BOTH.hash]: IN_BOTH.pmid,
  };
  for (const c of [novartis, pfizer]) {
    for (const f of db.listCollectionFiles(c)) {
      db.setFileMatched(f.id, byHash[f.content_hash], "manual");
    }
  }
  // Body text for the Pfizer-only paper, so the unscoped full-text clause has
  // something to find that the Novartis-scoped one must not.
  db.savePdfText({
    contentHash: ONLY_B.hash,
    text: "Estimated glomerular filtration rate declined over twelve months.",
    pages: 1,
    truncated: false,
  });

  // An articles row with no collection_files row behind it.
  feed = db.createTopic("Hepatology", "hepatic").id;
  db.saveArticles([article(SEEN_ONLY)], feed);
});

afterAll(() => {
  // Closed before the directory goes: Windows refuses to unlink a file that is
  // still open, and the database is in WAL mode, so there are three of them.
  //
  // Optional-chained because a throw in beforeAll — a schema or migration
  // error, which is the class of bug a DB test exists to catch — leaves `db`
  // undefined. An unguarded deref would report the teardown's TypeError instead
  // of the real failure, and strand the temp directory on the way out.
  db?.db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const inAll = (q?: string) =>
  db.listPapers({ allCollections: true }, q ? { q } : {}).map((p) => p.pmid);
const inOne = (collectionId: number, q?: string) =>
  db.listPapers({ collectionId }, q ? { q } : {}).map((p) => p.pmid);
const inFeed = (q?: string) =>
  db.listPapers({ topicId: feed }, q ? { q } : {}).map((p) => p.pmid);

describe("what each source contains", () => {
  it("returns every collection's papers, and a shared one only once", () => {
    expect(inAll().sort()).toEqual([ONLY_A.pmid, ONLY_B.pmid, IN_BOTH.pmid].sort());
  });

  it("leaves single-collection scoping exactly as it was", () => {
    expect(inOne(novartis).sort()).toEqual([ONLY_A.pmid, IN_BOTH.pmid].sort());
    expect(inOne(pfizer).sort()).toEqual([ONLY_B.pmid, IN_BOTH.pmid].sort());
  });

  it("never claims a paper the library has only seen", () => {
    // `held` means a collection_files row, never an articles row. All
    // collections is the view a writer reads as "we already have it, don't buy
    // it", so a paper a topic feed turned up must not appear in it — that is
    // the one answer this source can't afford to give wrong.
    //
    // The topic assertion is what makes the other three mean anything: the row
    // is present and findable, so its absence below is the membership join
    // doing its job rather than a fixture that never inserted it.
    expect(inFeed()).toEqual([SEEN_ONLY.pmid]);
    expect(inAll()).not.toContain(SEEN_ONLY.pmid);
    expect(inAll(SEEN_ONLY.title)).toEqual([]);
    expect(inAll("10.1000/44444444")).toEqual([]);
  });
});

describe("the cross-collection false negative", () => {
  it("is what a single-collection search still does", () => {
    // Not a bug in itself — it is the correct answer to a narrower question.
    // It is only wrong when the reader took it for "the library doesn't have it".
    expect(inOne(novartis, ONLY_B.title)).toEqual([]);
    expect(inOne(novartis, "10.1000/22222222")).toEqual([]);
  });

  it("does not happen across all collections", () => {
    expect(inAll(ONLY_B.title)).toEqual([ONLY_B.pmid]);
    expect(inAll("10.1000/22222222")).toEqual([ONLY_B.pmid]);
    expect(inAll("22222222")).toEqual([ONLY_B.pmid]);
  });
});

describe("the row shape", () => {
  it("carries the linked file, so PDFs don't look missing", () => {
    // sourceHasFiles: if this source were treated as fileless, every row would
    // come back with a null hash and the papers view would report every stored
    // PDF as gone.
    const rows = db.listPapers({ allCollections: true }, {});
    for (const r of rows) {
      expect(r.file_id).not.toBeNull();
      expect(r.content_hash).not.toBeNull();
      expect(r.file_name).toBeTruthy();
    }
  });

  it("picks one file for a paper held twice, deterministically", () => {
    const [row] = db.listPapers({ allCollections: true }, { q: IN_BOTH.title });
    expect(row.pmid).toBe(IN_BOTH.pmid);
    // MIN(id) — the lowest-id matched file, the same convention HOLDING_SELECT
    // uses for /have, so the two can't name different copies.
    const lowest = [novartis, pfizer]
      .flatMap((c) => db.listCollectionFiles(c))
      .filter((f) => f.content_hash === IN_BOTH.hash)
      .map((f) => f.id)
      .sort((x, y) => x - y)[0];
    expect(row.file_id).toBe(lowest);
  });
});

// The other four queries built on sourceMembership, none of which had any
// coverage. They matter here because the membership join binds a different
// number of parameters depending on whether the caller asked for the linked
// file — three of these don't, and select nothing from `cf`. A miscount binds a
// collection id into the wrong placeholder, so these run every source kind
// through both shapes of the join.
describe("the queries that share the membership join", () => {
  it("lists the journals a source's papers are in", () => {
    expect(db.journalsForSource({ allCollections: true })).toEqual([
      ONLY_B.journal,
      ONLY_A.journal,
    ]);
    expect(db.journalsForSource({ collectionId: novartis })).toEqual([ONLY_A.journal]);
    expect(db.journalsForSource({ collectionId: pfizer })).toEqual([
      ONLY_B.journal,
      IN_BOTH.journal,
    ]);
    // The unheld paper's journal is a chip on its topic and nowhere else.
    expect(db.journalsForSource({ topicId: feed })).toEqual([SEEN_ONLY.journal]);
  });

  it("counts subjects over the same membership", () => {
    const facets = (s: Src) => db.meshFacetsForSource(s).map((f) => [f.ui, f.count]);
    expect(facets({ allCollections: true })).toEqual([
      [CARDIO.ui, 2],
      [NEPHRO.ui, 1],
    ]);
    expect(facets({ collectionId: novartis })).toEqual([[CARDIO.ui, 2]]);
    expect(facets({ topicId: feed })).toEqual([[HEPATO.ui, 1]]);
  });

  it("buckets filing over the same membership", () => {
    // Every paper in the source falls in exactly one bucket, so the sum is the
    // source's paper count — which is the membership assertion.
    const total = (s: Src) => {
      const f = db.meshFilingForSource(s);
      return f.filed + f.indexed + f.none + f.pending + f.unchecked;
    };
    expect(db.meshFilingForSource({ allCollections: true }).filed).toBe(3);
    expect(total({ allCollections: true })).toBe(3);
    expect(total({ collectionId: novartis })).toBe(2);
    expect(total({ topicId: feed })).toBe(1);
  });

  it("gives the graph the same papers and the same file as the table", () => {
    const graph = db.graphPapersForSource({ allCollections: true });
    expect(graph.map((g) => g.pmid).sort()).toEqual(
      [ONLY_A.pmid, ONLY_B.pmid, IN_BOTH.pmid].sort()
    );
    // A node has to open the PDF its table row opens, so the two must agree
    // about which copy a paper held twice resolves to.
    const table = db.listPapers({ allCollections: true }, {});
    for (const g of graph) {
      expect(g.file_id).toBe(table.find((p) => p.pmid === g.pmid)?.file_id);
    }
    expect(db.graphPapersForSource({ topicId: feed }).map((g) => g.file_id)).toEqual([null]);
  });
});

describe("body-text search", () => {
  it("reaches into PDFs across every collection", () => {
    expect(inAll("glomerular")).toEqual([ONLY_B.pmid]);
  });

  it("stays inside the collection when one is named", () => {
    expect(inOne(pfizer, "glomerular")).toEqual([ONLY_B.pmid]);
    expect(inOne(novartis, "glomerular")).toEqual([]);
  });

  it("still returns the excerpt that proves the words are in the file", () => {
    const [row] = db.listPapers({ allCollections: true }, { q: "glomerular" });
    expect(row.snippet).toBeTruthy();
    expect(row.snippet).toMatch(/glomerular/i);
  });
});
