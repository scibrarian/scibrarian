import type { Db } from "./test-db.js";

// The library the unheld-sweep tests start from: four papers, one held each
// way a paper can be and one held by nothing. Shared so the files that pin what
// the sweep takes, when it runs after a removal and that it runs at startup all
// mean the same thing by a paper nothing holds.

export function article(pmid: string) {
  return {
    pmid,
    title: `Paper ${pmid}`,
    abstract: "",
    journal_name: "Lancet",
    nlm_id: "0053266",
    authors: ["Smith J"],
    pub_date: "2021-01-01",
    pub_date_display: "2021",
    doi: `10.1000/${pmid}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

export const FED = "11111111"; // in a topic's feed
export const FILED = "22222222"; // a file in the Library
export const SAVED = "33333333"; // on a folder's list
export const LOOSE = "44444444"; // stored, and nothing holds it
export const ALL = [FED, FILED, SAVED, LOOSE];

// Empty the library and store the four again, each with citation counts.
// Answers with what holds the three that are held.
export function seedHoldings(db: Db): { topic: number; shelf: number; folder: number } {
  for (const table of ["topics", "articles", "bookmark_folders", "collections", "paper_citations"]) {
    db.db.exec(`DELETE FROM ${table}`);
  }
  db.upsertArticles(ALL.map(article));
  db.upsertCitations(ALL.map((pmid) => ({ pmid, info: { citation_count: 1, references: [] } })));
  const topic = db.createTopic("Sleep", '"Sleep"[MeSH]', [], { allPubmed: true }).id;
  db.saveArticles([article(FED)], topic);
  const shelf = db.createCollection("Shelf").id;
  db.addCollectionFiles(shelf, [{ hash: "a".repeat(64), name: "filed.pdf" }]);
  db.setFileMatched(db.listCollectionFiles(shelf)[0].id, FILED, "pmid");
  const folder = db.createBookmarkFolder("Later").id;
  db.addBookmarks(folder, [SAVED]);
  return { topic, shelf, folder };
}
