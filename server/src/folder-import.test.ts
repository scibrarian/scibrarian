import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_REJECTED } from "../../shared/auth.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { article } from "./unheld-sweep-fixture.js";

// Importing a reference file into a bookmark folder, through the routes: what
// becomes a bookmark, what is listed unmatched and why, and the PMID a reader
// gives one that wasn't found. PubMed is mocked — a DOI's PMIDs are in
// `pubmed.dois`, and a PMID has a record only if it is in `pubmed.records` —
// and so is iCite. Nothing here touches the network.

process.env.ADMIN_TOKEN = "folder-import-token";
const HEADERS = { "x-admin-token": "folder-import-token" };

const pubmed = vi.hoisted(() => ({
  dois: new Map<string, string[]>(),
  records: new Set<string>(),
  searched: [] as string[],
  fail: false,
  // Holds every DOI search until released, for the tests that need something
  // to happen while one is in flight.
  hold: null as Promise<void> | null,
}));

vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  const { article } = await import("./unheld-sweep-fixture.js");
  return {
    ...actual,
    pmidsForDoi: async (doi: string) => {
      pubmed.searched.push(doi);
      if (pubmed.hold) await pubmed.hold;
      if (pubmed.fail) throw new Error("NCBI unreachable");
      return pubmed.dois.get(doi) ?? [];
    },
    // Stored with the DOI it was found by, as PubMed's record would carry it.
    fetchArticles: async (pmids: string[]) => {
      if (pubmed.fail) throw new Error("NCBI unreachable");
      const doiOf = new Map(
        [...pubmed.dois].flatMap(([doi, ps]) => (ps.length === 1 ? [[ps[0], doi] as const] : []))
      );
      return pmids
        .filter((p) => pubmed.records.has(p))
        .map((p) => ({ ...article(p), doi: doiOf.get(p) ?? article(p).doi }));
    },
    fetchSummaries: async (pmids: string[]) =>
      new Map(pmids.filter((p) => pubmed.records.has(p)).map((p) => [p, article(p)])),
  };
});
vi.mock("./icite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./icite.js")>();
  return { ...actual, ensureCitations: async () => {} };
});

let db: Db;
let server: Server;
let base: string;

const FOUND_BY_PMID = "40000001";
const FOUND_BY_DOI = "40000002";
const GIVEN_BY_HAND = "40000003";

// One record of each kind an import sorts.
const LIBRARY = [
  // A PubMed record's PMID, where EndNote and Zotero put it.
  `TY  - JOUR\nTI  - Found by its PMID\nAN  - ${FOUND_BY_PMID}\nDB  - PubMed\nER  - `,
  // Only a DOI, which PubMed resolves.
  "TY  - JOUR\nTI  - Found by its DOI\nDO  - 10.1000/found\nER  - ",
  // A DOI PubMed has no record of.
  "TY  - JOUR\nTI  - Not indexed\nAU  - Roe, R\nT2  - Small Journal\nPY  - 2019\nDO  - 10.1000/unknown\nER  - ",
  // A DOI PubMed files under two records.
  "TY  - JOUR\nTI  - Filed twice\nDO  - 10.1000/twice\nER  - ",
  // Nothing to look it up by.
  "TY  - JOUR\nTI  - Hand-entered long ago\nPY  - 1987\nER  - ",
  // Not a journal article.
  "TY  - BOOK\nTI  - A textbook\nDO  - 10.1000/book\nER  - ",
  // Nothing to look up or show.
  "TY  - JOUR\nPY  - 2020\nER  - ",
].join("\n");

const folder = (name: string) => db.createBookmarkFolder(name).id;
const bookmarked = (id: number) =>
  db.listBookmarks().filter((b) => b.folder_id === id).map((b) => b.pmid).sort();

async function importFile(folderId: number, text: string) {
  const form = new FormData();
  form.append("file", new Blob([text]), "library.ris");
  const res = await fetch(`${base}/api/bookmark-folders/${folderId}/imports`, {
    method: "POST",
    headers: HEADERS,
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

const status = async (folderId: number) =>
  (await fetch(`${base}/api/bookmark-folders/${folderId}/imports/status`)).json();

async function settled(folderId: number) {
  await vi.waitFor(async () => expect((await status(folderId)).state).not.toBe("running"));
  return status(folderId);
}

const entries = async (folderId: number) =>
  (await (await fetch(`${base}/api/bookmark-folders/${folderId}/imports`, { headers: HEADERS })).json()) as {
    id: number;
    title: string;
    status: string;
    reason: string;
  }[];

const send = (path: string, method: string, body?: unknown) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: { ...HEADERS, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  db = await openTempDb("folder-import");
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
});

beforeEach(() => {
  db.db.exec("DELETE FROM bookmark_folders");
  db.db.exec("DELETE FROM articles");
  pubmed.dois = new Map([
    ["10.1000/found", [FOUND_BY_DOI]],
    ["10.1000/twice", ["40000008", "40000009"]],
  ]);
  pubmed.records = new Set([FOUND_BY_PMID, FOUND_BY_DOI, GIVEN_BY_HAND]);
  pubmed.searched = [];
  pubmed.fail = false;
  pubmed.hold = null;
});

describe("importing a reference file into a folder", () => {
  it("saves what PubMed knows as bookmarks and lists the rest, saying why", async () => {
    const id = folder("Imported");
    const { status: code, body } = await importFile(id, LIBRARY);
    expect(code).toBe(201);
    expect(body).toMatchObject({ read: 7, notArticles: 1, blank: 1, queued: 4, noIdentifier: 1 });

    expect(await settled(id)).toMatchObject({ state: "done", total: 4, matched: 2, unmatched: 2 });
    expect(bookmarked(id)).toEqual([FOUND_BY_PMID, FOUND_BY_DOI]);
    expect((await entries(id)).map(({ title, status, reason }) => ({ title, status, reason }))).toEqual([
      { title: "Not indexed", status: "unmatched", reason: "not-in-pubmed" },
      { title: "Filed twice", status: "unmatched", reason: "ambiguous-doi" },
      { title: "Hand-entered long ago", status: "unmatched", reason: "no-identifier" },
    ]);
    // The book was never looked up.
    expect(pubmed.searched).not.toContain("10.1000/book");
  });

  // Only the DOIs still unmatched go back to PubMed: the ones already saved are
  // answered by the papers the library stores.
  it("lists an entry once however often the file is imported, and looks its DOI up again", async () => {
    const id = folder("Twice");
    await importFile(id, LIBRARY);
    await settled(id);
    pubmed.searched = [];

    await importFile(id, LIBRARY);
    await settled(id);
    expect(await entries(id)).toHaveLength(3);
    expect(pubmed.searched.sort()).toEqual(["10.1000/twice", "10.1000/unknown"]);
    expect(bookmarked(id)).toEqual([FOUND_BY_PMID, FOUND_BY_DOI]);
  });

  // A PMID that names nothing — mistyped, or withdrawn since — is no reason to
  // ignore a good DOI beside it. One that names a paper is taken without the
  // DOI being asked about.
  it("looks an entry's DOI up when PubMed has no record of its PMID, and only then", async () => {
    const id = folder("Stale PMID");
    await importFile(
      id,
      [
        "TY  - JOUR\nTI  - Stale PMID, good DOI\nAN  - 49999999\nDB  - PubMed\nDO  - 10.1000/found\nER  - ",
        `TY  - JOUR\nTI  - Good PMID\nAN  - ${FOUND_BY_PMID}\nDB  - PubMed\nDO  - 10.1000/never-asked\nER  - `,
        "TY  - JOUR\nTI  - Neither found\nAN  - 49999998\nDB  - PubMed\nDO  - 10.1000/unknown\nER  - ",
      ].join("\n")
    );
    expect(await settled(id)).toMatchObject({ state: "done", matched: 2, unmatched: 1 });
    expect(bookmarked(id)).toEqual([FOUND_BY_PMID, FOUND_BY_DOI]);
    expect(pubmed.searched.sort()).toEqual(["10.1000/found", "10.1000/unknown"]);
    expect((await entries(id)).map(({ title, reason }) => ({ title, reason }))).toEqual([
      { title: "Neither found", reason: "not-in-pubmed" },
    ]);
  });

  it("refuses a file that is neither RIS nor PubMed's format", async () => {
    const { status: code, body } = await importFile(folder("BibTeX"), "@article{k, title={T}}");
    expect(code).toBe(400);
    expect(body.error).toMatch(/isn’t one this can read/);
  });

  it("leaves what a PubMed failure stopped it reaching, to be looked up again", async () => {
    const id = folder("Offline");
    pubmed.fail = true;
    await importFile(id, LIBRARY);
    const failed = await settled(id);
    expect(failed.state).toBe("error");
    expect(failed.error).toMatch(/Couldn’t reach PubMed/);
    expect((await entries(id)).filter((e) => e.status === "pending")).toHaveLength(4);
    expect(bookmarked(id)).toEqual([]);

    pubmed.fail = false;
    expect((await send(`/bookmark-folders/${id}/imports/run`, "POST")).status).toBe(202);
    expect(await settled(id)).toMatchObject({ state: "done", matched: 2 });
    expect(bookmarked(id)).toEqual([FOUND_BY_PMID, FOUND_BY_DOI]);
  });

  it("stops when its folder is deleted part way, and stores nothing after", async () => {
    const id = folder("Deleted mid-lookup");
    let release!: () => void;
    pubmed.hold = new Promise<void>((resolve) => (release = resolve));
    await importFile(id, LIBRARY);
    await vi.waitFor(() => expect(pubmed.searched.length).toBeGreaterThan(0));

    expect((await send(`/bookmark-folders/${id}`, "DELETE")).status).toBe(204);
    release();
    await vi.waitFor(async () => expect((await status(id)).state).toBe("idle"));
    expect(db.existingPmids([FOUND_BY_PMID, FOUND_BY_DOI]).size).toBe(0);
  });

  // Reset deletes the folder and its entries with everything else, so there is
  // nothing for the lookup to finish, and a long one held the button off for
  // as long as it ran.
  it("is stopped by a library reset, and stores nothing after", async () => {
    const id = folder("Mid-reset");
    let release!: () => void;
    pubmed.hold = new Promise<void>((resolve) => (release = resolve));
    await importFile(id, LIBRARY);
    await vi.waitFor(() => expect(pubmed.searched.length).toBeGreaterThan(0));

    expect((await send("/data/reset", "POST")).status).toBe(200);
    release();
    await vi.waitFor(async () => expect((await status(id)).state).toBe("idle"));
    // Let the stopped run reach the point where it would have written.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.existingPmids([FOUND_BY_PMID, FOUND_BY_DOI]).size).toBe(0);
  });

  // The lookup took its rows when it started; the reader can settle one by
  // hand while it runs, and that is the entry's last word.
  it("leaves an entry removed or saved by hand while it ran", async () => {
    const id = folder("Settled by hand");
    let release!: () => void;
    pubmed.hold = new Promise<void>((resolve) => (release = resolve));
    await importFile(id, LIBRARY);
    await vi.waitFor(() => expect(pubmed.searched.length).toBeGreaterThan(0));

    const listed = await entries(id);
    const byTitle = (title: string) => listed.find((e) => e.title === title)!.id;
    expect((await send(`/bookmark-imports/${byTitle("Found by its PMID")}`, "DELETE")).status).toBe(204);
    const saved = await send(`/bookmark-imports/${byTitle("Found by its DOI")}/pmid`, "POST", {
      pmid: GIVEN_BY_HAND,
    });
    expect(saved.status).toBe(200);

    release();
    expect(await settled(id)).toMatchObject({ state: "done" });
    expect(bookmarked(id)).toEqual([GIVEN_BY_HAND]);
  });
});

describe("an unmatched entry", () => {
  async function unmatched(title: string): Promise<{ folderId: number; entryId: number }> {
    const folderId = folder(`For ${title}`);
    await importFile(folderId, LIBRARY);
    await settled(folderId);
    const entry = (await entries(folderId)).find((e) => e.title === title)!;
    return { folderId, entryId: entry.id };
  }

  it("shows the paper a PMID names before anything is saved", async () => {
    const { folderId, entryId } = await unmatched("Hand-entered long ago");
    const res = await send(`/bookmark-imports/${entryId}/lookup`, "POST", { pmid: GIVEN_BY_HAND });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pmid: GIVEN_BY_HAND, title: `Paper ${GIVEN_BY_HAND}` });
    expect(bookmarked(folderId)).not.toContain(GIVEN_BY_HAND);
    expect(db.existingPmids([GIVEN_BY_HAND]).size).toBe(0);
  });

  it("is saved as the paper it is given, and leaves the list", async () => {
    const { folderId, entryId } = await unmatched("Not indexed");
    const res = await send(`/bookmark-imports/${entryId}/pmid`, "POST", { pmid: GIVEN_BY_HAND });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe(`Paper ${GIVEN_BY_HAND}`);
    expect(bookmarked(folderId)).toContain(GIVEN_BY_HAND);
    expect((await entries(folderId)).map((e) => e.title)).not.toContain("Not indexed");
  });

  it("stays listed when the PMID it is given names nothing", async () => {
    const { folderId, entryId } = await unmatched("Not indexed");
    for (const [method, path] of [
      ["POST", "lookup"],
      ["POST", "pmid"],
    ]) {
      const res = await send(`/bookmark-imports/${entryId}/${path}`, method, { pmid: "49999999" });
      expect(res.status).toBe(422);
    }
    expect((await entries(folderId)).map((e) => e.title)).toContain("Not indexed");
  });

  // The list is the owner's reference library, and the gate lets every GET
  // through, so the route has to refuse a viewer itself.
  it("is listed to the owner only", async () => {
    const { folderId } = await unmatched("Not indexed");
    const res = await fetch(`${base}/api/bookmark-folders/${folderId}/imports`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Admin access required.", code: ADMIN_TOKEN_REJECTED });
  });

  it("can be removed, one at a time or all together", async () => {
    const { folderId, entryId } = await unmatched("Not indexed");
    expect((await send(`/bookmark-imports/${entryId}`, "DELETE")).status).toBe(204);
    expect(await entries(folderId)).toHaveLength(2);

    const res = await send(`/bookmark-folders/${folderId}/imports/unmatched`, "DELETE");
    expect(await res.json()).toEqual({ removed: 2 });
    expect(await entries(folderId)).toEqual([]);
  });
});
