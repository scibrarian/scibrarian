import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Searching by identifier, against a real SQLite file.
//
// The other server tests are pure-function tests, because that is where the
// decisions live. This one can't be: the bug it guards is a bind-order bug.
// searchPredicate pushes its parameters in the textual order of the `?`s it
// emits, and getting that wrong "silently returns nothing at all, which no type
// checks and no schema catches" — the comment on the function says so. Only
// running the query catches it, and the identifier clauses land in the middle
// of that ordering, between the LIKEs and the full-text subquery.

let db: Db;
let collectionId: number;

const TARGET = {
  pmid: "33301246",
  doi: "10.1056/NEJMoa2035389",
  title: "Efficacy and safety of a novel agent in advanced disease",
  hash: "a".repeat(64),
};
// A second paper, so an identifier query has something to wrongly return.
const OTHER = {
  pmid: "31234567",
  doi: "10.1016/S0140-6736(14)60001-1",
  title: "Long-term outcomes after intensive therapy",
  hash: "b".repeat(64),
};

function article(p: typeof TARGET, authors: string[], year: string) {
  return {
    pmid: p.pmid,
    title: p.title,
    abstract: "",
    journal_name: "Lancet",
    nlm_id: null,
    authors,
    pub_date: `${year}-01-01`,
    pub_date_display: year,
    doi: p.doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
  };
}

beforeAll(async () => {
  db = await openTempDb("search-ids");

  collectionId = db.createCollection("Reference package").id;
  db.addCollectionFiles(collectionId, [
    { hash: TARGET.hash, name: "target.pdf" },
    { hash: OTHER.hash, name: "other.pdf" },
  ]);
  db.upsertArticles([article(TARGET, ["Smith J"], "2021"), article(OTHER, ["Jones A"], "2014")]);
  for (const f of db.listCollectionFiles(collectionId)) {
    const pmid = f.content_hash === TARGET.hash ? TARGET.pmid : OTHER.pmid;
    db.setFileMatched(f.id, pmid, "manual");
  }
  // Body text for one of them, so the full-text clause is doing real work while
  // the identifier clauses sit in front of it in the bind order.
  db.savePdfText({
    contentHash: TARGET.hash,
    text: "The primary endpoint was progression-free survival at twelve months.",
    pages: 1,
    truncated: false,
  });
});

afterAll(closeTempDb);

const find = (q: string) =>
  db.listPapers({ collectionId }, { q }).map((p) => p.pmid);

describe("searching by identifier", () => {
  it("finds a paper by its DOI", () => {
    expect(find(TARGET.doi)).toEqual([TARGET.pmid]);
  });

  it("matches a DOI whatever its case", () => {
    // DOIs are case-insensitive by specification and PubMed's stored casing
    // varies by publisher, so a literal comparison would miss.
    expect(find(TARGET.doi.toUpperCase())).toEqual([TARGET.pmid]);
    expect(find(TARGET.doi.toLowerCase())).toEqual([TARGET.pmid]);
  });

  it("keeps a parenthesised PII DOI whole", () => {
    expect(find(OTHER.doi)).toEqual([OTHER.pmid]);
  });

  it("finds a paper by a labelled PMID, a bare PMID, and a PubMed URL", () => {
    expect(find(`PMID: ${TARGET.pmid}`)).toEqual([TARGET.pmid]);
    expect(find(TARGET.pmid)).toEqual([TARGET.pmid]);
    expect(find(`https://pubmed.ncbi.nlm.nih.gov/${TARGET.pmid}/`)).toEqual([TARGET.pmid]);
  });

  it("finds a paper from a full reference that carries a DOI", () => {
    expect(find(`Smith J. Efficacy. Lancet. 2021. doi:${TARGET.doi}`)).toEqual([TARGET.pmid]);
  });

  it("returns nothing for an identifier the library doesn't hold", () => {
    // The answer that has to stay trustworthy: an empty result must mean "not
    // here", not "the box can't read this".
    expect(find("10.9999/nonexistent")).toEqual([]);
    expect(find("99999999")).toEqual([]);
  });
});

describe("the text search it was folded into", () => {
  it("still matches on title", () => {
    expect(find("novel agent")).toEqual([TARGET.pmid]);
  });

  it("still matches on author", () => {
    expect(find("Jones")).toEqual([OTHER.pmid]);
  });

  it("still matches inside the PDF body", () => {
    // The clause bound *after* the identifier clauses — if the identifier
    // params were pushed in the wrong order this is what breaks.
    expect(find("progression-free")).toEqual([TARGET.pmid]);
  });

  it("still matches a mid-word prefix in the body", () => {
    expect(find("endpoint")).toEqual([TARGET.pmid]);
  });

  it("returns everything matching an ordinary word", () => {
    expect(find("outcomes").length).toBe(1);
    expect(find("zzzznothing")).toEqual([]);
  });

  it("does not let a bare year pull in a paper by PMID", () => {
    // "2021" is the target's publication year, not an id. It must not start
    // matching whatever paper happens to hold PMID 2021.
    expect(find("2021")).toEqual([]);
  });
});
