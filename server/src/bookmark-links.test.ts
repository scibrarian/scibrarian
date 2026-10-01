import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// "Add links" — saving papers into a bookmark folder from pasted DOIs and
// PubMed links. PubMed is mocked: a DOI's PMIDs are in `pubmed.dois`, and a
// PMID's record exists only if it is in `pubmed.records`. Nothing here touches
// the network.

const pubmed = vi.hoisted(() => ({
  dois: new Map<string, string[]>(),
  records: new Map<string, unknown>(),
  searched: [] as string[],
  fetched: [] as string[][],
  fail: false,
  // Runs inside a DOI lookup, for the tests that need something to happen
  // while one is in flight.
  during: null as (() => void) | null,
}));

vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    pmidsForDoi: async (doi: string) => {
      pubmed.searched.push(doi);
      pubmed.during?.();
      if (pubmed.fail) throw new Error("NCBI unreachable");
      return pubmed.dois.get(doi) ?? [];
    },
    fetchArticles: async (pmids: string[]) => {
      pubmed.fetched.push(pmids);
      if (pubmed.fail) throw new Error("NCBI unreachable");
      return pmids.flatMap((p) => (pubmed.records.has(p) ? [pubmed.records.get(p)] : []));
    },
  };
});

let db: Db;
let addLinksToFolder: typeof import("./bookmark-links.js").addLinksToFolder;

function article(p: { pmid: string; doi: string }) {
  return {
    pmid: p.pmid,
    title: `Paper ${p.pmid}`,
    abstract: "",
    journal_name: "J Test Med",
    mesh: { status: "MEDLINE", headings: [] },
    nlm_id: null,
    authors: ["Smith J"],
    pub_date: "2024-01-01",
    pub_date_display: "2024",
    doi: p.doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
  };
}

// Stored here already, as a feed would have left it.
const STORED = { pmid: "50000001", doi: "10.1000/stored" };
// Known to PubMed, never seen by this library.
const REMOTE = { pmid: "50000002", doi: "10.1000/remote" };
const OTHER = { pmid: "50000003", doi: "10.1000/other" };

const link = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

let folder: number;

beforeAll(async () => {
  db = await openTempDb("bookmark-links");
  ({ addLinksToFolder } = await import("./bookmark-links.js"));
});

afterAll(closeTempDb);

beforeEach(() => {
  db.db.exec("DELETE FROM bookmark_folders; DELETE FROM articles;");
  db.upsertArticles([article(STORED)]);
  folder = db.createBookmarkFolder("Reading").id;
  pubmed.dois = new Map([REMOTE, OTHER].map((p) => [p.doi, [p.pmid]]));
  pubmed.records = new Map([REMOTE, OTHER].map((p) => [p.pmid, article(p)]));
  pubmed.searched = [];
  pubmed.fetched = [];
  pubmed.fail = false;
  pubmed.during = null;
});

const saved = () => db.listBookmarks().filter((b) => b.folder_id === folder).map((b) => b.pmid);

describe("addLinksToFolder", () => {
  it("saves a stored paper from its PubMed link without asking PubMed", async () => {
    const [answer] = (await addLinksToFolder(folder, [link(STORED.pmid)]))!;
    expect(answer.outcome).toBe("added");
    expect(answer.paper).toMatchObject({ pmid: STORED.pmid, title: `Paper ${STORED.pmid}` });
    expect(saved()).toEqual([STORED.pmid]);
    expect(pubmed.fetched).toEqual([]);
  });

  it("fetches and stores a paper the library has never seen", async () => {
    const [answer] = (await addLinksToFolder(folder, [link(REMOTE.pmid)]))!;
    expect(answer.outcome).toBe("added");
    expect(db.existingPmids([REMOTE.pmid]).has(REMOTE.pmid)).toBe(true);
    expect(saved()).toEqual([REMOTE.pmid]);
  });

  it("resolves a DOI however it is pasted", async () => {
    const answers = (await addLinksToFolder(folder, [
      REMOTE.doi,
      `https://doi.org/${OTHER.doi}`,
      `https://www.publisher.example/doi/full/${REMOTE.doi}`,
    ]))!;
    expect(answers.map((a) => a.outcome)).toEqual(["added", "added", "already-saved"]);
    expect(saved().sort()).toEqual([REMOTE.pmid, OTHER.pmid]);
  });

  it("resolves a DOI the library already stores locally", async () => {
    const [answer] = (await addLinksToFolder(folder, [STORED.doi]))!;
    expect(answer.outcome).toBe("added");
    expect(pubmed.searched).toEqual([]);
  });

  it("reports a paper the folder already holds as already saved", async () => {
    await addLinksToFolder(folder, [link(STORED.pmid)]);
    const [answer] = (await addLinksToFolder(folder, [link(STORED.pmid)]))!;
    expect(answer.outcome).toBe("already-saved");
    expect(answer.paper?.pmid).toBe(STORED.pmid);
  });

  it("reports what PubMed has no record of, and stores nothing for it", async () => {
    const answers = (await addLinksToFolder(folder, ["10.1000/nowhere", link("59999999")]))!;
    expect(answers.map((a) => a.outcome)).toEqual(["not-in-pubmed", "not-in-pubmed"]);
    expect(answers.every((a) => a.paper === null)).toBe(true);
    expect(db.existingPmids(["59999999"]).size).toBe(0);
    expect(saved()).toEqual([]);
  });

  it("tells a DOI PubMed files twice apart from one it has no record of", async () => {
    pubmed.dois.set("10.1000/shared", [REMOTE.pmid, OTHER.pmid]);
    const answers = (await addLinksToFolder(folder, ["10.1000/shared", "10.1000/nowhere"]))!;
    expect(answers.map((a) => a.outcome)).toEqual(["ambiguous-doi", "not-in-pubmed"]);
    expect(answers.every((a) => a.paper === null)).toBe(true);
    // Neither record is picked, so neither is stored or saved.
    expect(pubmed.fetched).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it("saves from the PubMed link on a line that also has a DOI, without looking the DOI up", async () => {
    // Even a DOI PubMed couldn't resolve: the link already named the record.
    pubmed.dois.set("10.1000/shared", [REMOTE.pmid, OTHER.pmid]);
    const [answer] = (await addLinksToFolder(folder, [
      `Smith J. Foo. J Test Med. 2024. doi:10.1000/shared ${link(REMOTE.pmid)}`,
    ]))!;
    expect(answer.outcome).toBe("added");
    expect(answer.paper?.pmid).toBe(REMOTE.pmid);
    expect(pubmed.searched).toEqual([]);
    expect(saved()).toEqual([REMOTE.pmid]);
  });

  it("refuses a PMID that isn't a PubMed link, as Check holdings does", async () => {
    const answers = (await addLinksToFolder(folder, [REMOTE.pmid, `PMID: ${REMOTE.pmid}`]))!;
    for (const a of answers) {
      expect(a.outcome).toBe("unreadable");
      expect(a.parsed.reason).toMatch(/PubMed link/);
    }
    expect(saved()).toEqual([]);
    expect(pubmed.fetched).toEqual([]);
  });

  it("answers every line, in the order pasted", async () => {
    const lines = ["no identifier here", link(REMOTE.pmid), "10.1000/nowhere", link(STORED.pmid)];
    const answers = (await addLinksToFolder(folder, lines))!;
    expect(answers.map((a) => a.parsed.input)).toEqual(lines);
    expect(answers.map((a) => a.outcome)).toEqual([
      "unreadable",
      "added",
      "not-in-pubmed",
      "added",
    ]);
  });

  it("writes nothing when PubMed can't be reached", async () => {
    pubmed.fail = true;
    await expect(addLinksToFolder(folder, [link(STORED.pmid), REMOTE.doi])).rejects.toMatchObject({
      status: 503,
    });
    // The stored paper needed no lookup, but it isn't saved either: the batch
    // is all or nothing, so the answer the reader gets is true of every line.
    expect(saved()).toEqual([]);
    expect(db.existingPmids([REMOTE.pmid]).size).toBe(0);
  });

  it("writes nothing into a folder deleted while PubMed was being asked", async () => {
    pubmed.during = () => db.deleteBookmarkFolder(folder);
    expect(await addLinksToFolder(folder, [REMOTE.doi])).toBeNull();
    expect(db.existingPmids([REMOTE.pmid]).size).toBe(0);
  });
});
