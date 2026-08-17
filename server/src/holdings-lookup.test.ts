import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQL_PARAMS_PER_CHUNK } from "../../shared/sqlite.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Looking a stored paper up by id, over both keys and across the chunk
// boundary.
//
// Written when holdingsByDois stopped being its own hand-rolled chunk loop and
// became a caller of queryByIds. The suite was green either way, because
// nothing exercised it: /have is the only caller and have.test.ts stubs the
// layer above this one. So a rewrite of the DOI path — the one with a case
// rule the PMID path does not have — was resting on nothing.
//
// The chunk-boundary cases are the ones that would survive review and fail in
// production. Every list in the tests above is a handful of ids, so a loop that
// dropped everything past the first chunk, or lowercased only the batch it
// happened to be holding, would read as correct and pass.

let db: Db;

beforeAll(async () => {
  db = await openTempDb("holdings-lookup");
});

afterAll(() => {
  closeTempDb();
});

/** A stored article. `doi` empty means PubMed listed none. */
function article(pmid: string, doi: string): void {
  db.db
    .prepare("INSERT INTO articles (pmid, title, doi) VALUES (?, ?, ?)")
    .run(pmid, `Paper ${pmid}`, doi);
}

/**
 * The same, for the chunk-boundary cases, in one transaction.
 *
 * Nine hundred-odd separate INSERTs are nine hundred-odd fsyncs, which cost
 * more than a second each time and would have made two tests here longer than
 * the rest of the suite put together.
 */
function articles(count: number, make: (i: number) => { pmid: string; doi: string }): string[] {
  const made: { pmid: string; doi: string }[] = [];
  for (let i = 0; i < count; i++) made.push(make(i));
  db.db.exec("BEGIN");
  for (const a of made) article(a.pmid, a.doi);
  db.db.exec("COMMIT");
  return made.map((a) => a.doi || a.pmid);
}

describe("holdingsByPmids", () => {
  it("returns the papers it knows and stays silent about the rest", () => {
    article("40000001", "10.1000/one");
    const rows = db.holdingsByPmids(["40000001", "40000002"]);
    expect(rows.map((r) => r.pmid)).toEqual(["40000001"]);
  });

  // The reason the chunking exists: an all-time search hands this thousands.
  it("returns every match when the list spans more than one chunk", () => {
    const pmids = articles(SQL_PARAMS_PER_CHUNK + 50, (i) => ({
      pmid: String(41000000 + i),
      doi: "",
    }));
    expect(db.holdingsByPmids(pmids)).toHaveLength(pmids.length);
  });
});

describe("holdingsByDois", () => {
  it("matches a DOI whatever case either side is stored or asked in", () => {
    article("42000001", "10.1000/MiXeD");
    expect(db.holdingsByDois(["10.1000/mixed"]).map((r) => r.pmid)).toEqual(["42000001"]);
    expect(db.holdingsByDois(["10.1000/MIXED"]).map((r) => r.pmid)).toEqual(["42000001"]);
  });

  // `a.doi <> ''` in the query. Without it an empty asked-for DOI matches every
  // article PubMed listed none for, which is most of them — the whole library
  // reported as held, from one reference with no DOI in it.
  it("does not let an empty DOI match the articles that have none", () => {
    article("42000002", "");
    expect(db.holdingsByDois([""])).toEqual([]);
  });

  it("returns nothing for an empty list rather than every row", () => {
    expect(db.holdingsByDois([])).toEqual([]);
  });

  // The case the rewrite could have broken: lowercasing moved from inside the
  // loop to before it. Same values either way — but only if it happens to the
  // whole list, not to whichever slice is in hand.
  it("lowercases past the first chunk, not just within it", () => {
    const dois = articles(SQL_PARAMS_PER_CHUNK + 50, (i) => ({
      pmid: String(43000000 + i),
      doi: `10.2000/CASE${i}`,
    }));
    // Asked for in the stored casing, which only matches if both sides are
    // folded; the last one is well past the chunk boundary.
    expect(db.holdingsByDois(dois)).toHaveLength(dois.length);
    expect(db.holdingsByDois([dois[dois.length - 1]!])).toHaveLength(1);
  });
});
