import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogSeed } from "./db.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// What MEDLINE has to do with each journal in the catalog, and what the picker
// does about it.
//
// A topic is MeSH headings, and only a paper MEDLINE indexed carries any. The
// catalog a topic's journals are picked from is every journal PubMed knows,
// and over half of them MEDLINE has never indexed: listed on a topic, one of
// those is polled for as long as the topic lasts and adds nothing. So the
// catalog is marked from NLM's list of the journals it has indexed, and the
// search leaves the rest out.
//
// What is pinned is the three ways that goes wrong quietly. A journal MEDLINE
// used to index is not one it never did — its older papers match, and "indexed
// now" as the test would hide ten thousand journals that return papers. A row
// not marked yet is not 'never' either, or a list that couldn't be read would
// empty the picker. And a list read in part would mark every journal missing
// from it as never indexed, so a failed read has to mark nothing at all.

const nlm = vi.hoisted(() => ({
  // What NLM's list answers with; null for a read that fails.
  list: null as Map<string, boolean> | null,
  reads: 0,
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    fetchMedlineIndexing: async () => {
      nlm.reads++;
      if (!nlm.list) throw new Error("NLM unreachable");
      return nlm.list;
    },
  };
});

// No ISSNs, so the search has no metric to ask OpenAlex for.
const seed = (nlm_id: string, title: string, med_abbr: string): CatalogSeed => ({
  nlm_id,
  title,
  med_abbr,
  iso_abbr: "",
  issn_print: "",
  issn_online: "",
});
const LANCET = seed("2985213R", "Lancet (London, England)", "Lancet"); // indexed now
const ARCHIVES = seed("0372440", "Archives of internal medicine", "Arch Intern Med"); // ceased 2012
const BIORXIV = seed("101680187", "bioRxiv : the preprint server for biology", "bioRxiv"); // never
const CUREUS = seed("101596737", "Cureus", "Cureus"); // never

// NLM's list: the journals it has ever indexed, true for one it indexes now.
const INDEXED = new Map([
  [LANCET.nlm_id, true],
  [ARCHIVES.nlm_id, false],
]);

let db: Db;
let refreshCatalogIfStale: typeof import("./journal-catalog.js").refreshCatalogIfStale;
let server: Server;
let base: string;

const status = (j: CatalogSeed) => db.findCatalogByNlmId(j.nlm_id)?.medline;
const found = (q: string) => db.searchCatalog(q).map((r) => r.med_abbr);

beforeAll(async () => {
  db = await openTempDb("journal-indexing");
  ({ refreshCatalogIfStale } = await import("./journal-catalog.js"));
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
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
  vi.restoreAllMocks();
});

beforeEach(() => {
  nlm.list = INDEXED;
  nlm.reads = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db.db.exec("DELETE FROM journal_catalog");
  db.db.exec("DELETE FROM settings WHERE key LIKE 'journal_%_loaded_at'");
  // Stamps the catalog as loaded now, so it is fresh and only its indexing is
  // in question.
  db.bulkUpsertCatalog([LANCET, ARCHIVES, BIORXIV, CUREUS]);
});

describe("what MEDLINE has to do with a catalog journal", () => {
  it("isn't known until NLM's list has been read, and every journal is offered until then", () => {
    expect([LANCET, ARCHIVES, BIORXIV, CUREUS].map(status)).toEqual([null, null, null, null]);
    expect(found("biorxiv")).toEqual(["bioRxiv"]);
    expect(db.countNeverIndexedMatches("biorxiv")).toBe(0);
  });

  it("is indexed now, once, or never, by that list", () => {
    db.setCatalogIndexing(INDEXED);
    expect([LANCET, ARCHIVES, BIORXIV, CUREUS].map(status)).toEqual([
      "current",
      "former",
      "never",
      "never",
    ]);
    expect(db.getIndexingLoadedAt()).not.toBe("");
  });

  it("follows the list when it changes", () => {
    db.setCatalogIndexing(INDEXED);
    // The Lancet dropped, and Cureus taken on.
    db.setCatalogIndexing(
      new Map([
        [LANCET.nlm_id, false],
        [ARCHIVES.nlm_id, false],
        [CUREUS.nlm_id, true],
      ])
    );
    expect([LANCET, ARCHIVES, BIORXIV, CUREUS].map(status)).toEqual([
      "former",
      "former",
      "never",
      "current",
    ]);
  });

  it("is kept by a catalog refresh, which leaves a journal new to the catalog unmarked", () => {
    db.setCatalogIndexing(INDEXED);
    const NEW = seed("9919269228506676", "Respiratory research and clinical practice", "Respir Res Clin Pract");
    db.bulkUpsertCatalog([{ ...LANCET, title: "The Lancet" }, BIORXIV, NEW]);
    expect(db.findCatalogByNlmId(LANCET.nlm_id)?.title).toBe("The Lancet");
    expect([LANCET, BIORXIV, NEW].map(status)).toEqual(["current", "never", null]);
  });
});

describe("the catalog search", () => {
  beforeEach(() => db.setCatalogIndexing(INDEXED));

  it("leaves out the journals MEDLINE has never indexed", () => {
    expect(found("biorxiv")).toEqual([]);
    expect(found("cureus")).toEqual([]);
    expect(found("lancet")).toEqual(["Lancet"]);
  });

  it("keeps one MEDLINE used to index, whose older papers still match a topic", () => {
    expect(found("arch intern")).toEqual(["Arch Intern Med"]);
  });

  it("counts what it left out", () => {
    // "in" is in Archives of internal medicine and in bioRxiv's "preprint".
    expect(found("in")).toEqual(["Arch Intern Med"]);
    expect(db.countNeverIndexedMatches("in")).toBe(1);
    expect(db.countNeverIndexedMatches("lancet")).toBe(0);
  });

  it("answers the picker with both", async () => {
    const some = await (await fetch(`${base}/api/journals/search?q=in`)).json();
    // With what MEDLINE has to do with each, for the pane to mark the ones it
    // used to index before they are listed.
    expect(
      some.results.map((r: { nlm_id: string; medline: string }) => [r.nlm_id, r.medline])
    ).toEqual([[ARCHIVES.nlm_id, "former"]]);
    expect(some.neverIndexed).toBe(1);

    const none = await (await fetch(`${base}/api/journals/search?q=cureus`)).json();
    expect(none).toEqual({ results: [], neverIndexed: 1 });
  });
});

describe("reading NLM's list", () => {
  it("follows a catalog that is fresh and has no indexing yet", async () => {
    await refreshCatalogIfStale();
    expect(nlm.reads).toBe(1);
    expect([LANCET, ARCHIVES, BIORXIV].map(status)).toEqual(["current", "former", "never"]);
  });

  it("isn't done again while what it read is fresh", async () => {
    await refreshCatalogIfStale();
    await refreshCatalogIfStale();
    expect(nlm.reads).toBe(1);
  });

  it("marks nothing when the list can't be read, and is tried again the next time", async () => {
    nlm.list = null;
    await refreshCatalogIfStale();
    expect([LANCET, ARCHIVES, BIORXIV].map(status)).toEqual([null, null, null]);
    expect(db.getIndexingLoadedAt()).toBe("");
    // Still offered: not known is not never.
    expect(found("biorxiv")).toEqual(["bioRxiv"]);

    nlm.list = INDEXED;
    await refreshCatalogIfStale();
    expect(nlm.reads).toBe(2);
    expect(status(BIORXIV)).toBe("never");
  });

  it("leaves the marks a failed re-read found there", async () => {
    await refreshCatalogIfStale();
    db.db.exec("DELETE FROM settings WHERE key = 'journal_indexing_loaded_at'");
    nlm.list = null;
    await refreshCatalogIfStale();
    expect([LANCET, ARCHIVES, BIORXIV].map(status)).toEqual(["current", "former", "never"]);
  });
});
