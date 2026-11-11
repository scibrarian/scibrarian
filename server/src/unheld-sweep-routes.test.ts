import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { ALL, FED, FILED, LOOSE, SAVED, article, seedHoldings } from "./unheld-sweep-fixture.js";

// The routes that let go of papers, one case each, and the requests that hold
// the sweep of papers nothing holds off while they attach one.
//
// What each way of letting go takes, when the sweep takes its turn and what
// holds it off are holding.test.ts, through holding.ts itself. What is left for
// here is what a route can still get wrong on its own: letting go through the
// wrong call, answering differently, or attaching a paper without saying so.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "unheld-sweep-token";
const HEADERS = { "x-admin-token": "unheld-sweep-token", "content-type": "application/json" };

const busy = vi.hoisted(() => ({
  // What a links request waits on, and whether one has got as far as waiting.
  links: null as Promise<void> | null,
  linksOut: false,
  // The same pair for a request for citation counts, and what PubMed answers a
  // manual match with.
  cites: null as Promise<void> | null,
  citesOut: false,
  // The same pair for PubMed's answer to a fetch, and the answer itself.
  fetch: null as Promise<void> | null,
  fetchOut: false,
  fetched: [] as import("./db.js").ArticleInsert[],
}));
vi.mock("./bookmark-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bookmark-links.js")>();
  return {
    ...actual,
    addLinksToFolder: async () => {
      busy.linksOut = true;
      await busy.links;
      return [];
    },
  };
});
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    fetchArticles: async () => {
      busy.fetchOut = true;
      await busy.fetch;
      return busy.fetched;
    },
  };
});
vi.mock("./icite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./icite.js")>();
  return {
    ...actual,
    ensureCitations: async () => {
      busy.citesOut = true;
      await busy.cites;
    },
  };
});

let db: Db;
let server: Server;
let base: string;

const stored = () => [...db.existingPmids(ALL)].sort();
const counted = () => [...db.getCitations(ALL).keys()].sort();

let topic: number;
let shelf: number;
let folder: number;

const request = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// A second removal, to give the sweep a turn. Of a paper a topic's feed goes on
// holding, so the sweep is all it changes; and of a paper, because a removal
// that takes nothing isn't given one.
const anotherRemoval = () => {
  db.addBookmarks(folder, [FED]);
  return request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [FED] });
};

beforeAll(async () => {
  db = await openTempDb("unheld-sweep-routes");
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
});

beforeEach(() => {
  busy.links = null;
  busy.linksOut = false;
  busy.cites = null;
  busy.citesOut = false;
  busy.fetch = null;
  busy.fetchOut = false;
  busy.fetched = [];
  ({ topic, shelf, folder } = seedHoldings(db));
});

// Behind the reply, so waited for rather than read straight after it.
const swept = (pmids: string[]) => vi.waitFor(() => expect(stored()).toEqual(pmids));

describe("a removal, with the server idle", () => {
  it("takes the papers ticked out of their last folder, and any left from before", async () => {
    const res = await request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [SAVED] });
    expect(await res.json()).toEqual({ removed: 1 });
    await swept([FED, FILED]);
    expect(counted()).toEqual([FED, FILED]);
  });

  it("takes the papers of a deleted folder", async () => {
    expect((await request("DELETE", `/bookmark-folders/${folder}`)).status).toBe(204);
    await swept([FED, FILED]);
  });

  it("takes a paper removed from its collection", async () => {
    const res = await request("POST", `/collections/${shelf}/papers/remove`, { pmids: [FILED] });
    expect(await res.json()).toEqual({ removed: 1, papers: 1 });
    await swept([FED, SAVED]);
  });

  it("takes the papers of a deleted collection", async () => {
    expect((await request("DELETE", `/collections/${shelf}`)).status).toBe(204);
    await swept([FED, SAVED]);
  });

  it("takes a paper whose file is deleted", async () => {
    const file = db.listCollectionFiles(shelf)[0];
    expect((await request("DELETE", `/collections/files/${file.id}`)).status).toBe(204);
    await swept([FED, SAVED]);
  });

  it("takes the papers only a removed topic held, and answers with how many", async () => {
    const res = await request("DELETE", `/topics/${topic}`);
    expect(await res.json()).toEqual({ deletedArticles: 1 });
    await swept([FILED, SAVED]);
    expect(counted()).toEqual([FILED, SAVED]);
  });

  it("is not given a turn by the one-paper toggle", async () => {
    // The toggle in Interests, where a paper is in a feed and stays held.
    expect((await request("DELETE", `/bookmark-folders/${folder}/papers/${SAVED}`)).status).toBe(204);
    expect(db.listBookmarks()).toEqual([]);
    expect(stored()).toEqual(ALL);
  });
});

describe("a manual match", () => {
  const MATCHED = "55555555";

  it("holds its paper from the moment it is stored, whatever is swept while its counts are fetched", async () => {
    db.addCollectionFiles(shelf, [{ hash: "c".repeat(64), name: "unmatched.pdf" }]);
    const file = db.listCollectionFiles(shelf).find((f) => f.file_name === "unmatched.pdf")!;
    busy.fetched = [article(MATCHED)];
    let answer!: () => void;
    busy.cites = new Promise<void>((r) => (answer = r));
    const matching = request("POST", `/collections/files/${file.id}/pmid`, { pmid: MATCHED });
    try {
      await vi.waitFor(() => expect(busy.citesOut).toBe(true));
      // A removal with its sweep, which the match doesn't hold off.
      await request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [SAVED] });
      await swept([FED, FILED]);
      expect(db.existingPmids([MATCHED]).size).toBe(1);
    } finally {
      // Whatever happened, or the request outlives this test and the server's
      // close waits on it.
      answer();
    }
    expect((await matching).status).toBe(200);
  });

  it("gives the sweep a turn for the paper its file was matched to before", async () => {
    busy.fetched = [article(LOOSE)];
    const file = db.listCollectionFiles(shelf)[0];
    const res = await request("POST", `/collections/files/${file.id}/pmid`, { pmid: LOOSE });
    expect(res.status).toBe(200);
    await swept([FED, SAVED, LOOSE]);
  });
});

// The two requests that store a paper and attach it outside a job, each of
// which has to say so (whileAttaching in holding.ts) for the sweep to skip its
// turn while it waits on PubMed.
describe("a removal while a request is attaching", () => {
  const removeSaved = () =>
    request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [SAVED] });
  // The sweep's turn comes behind the removal's reply, so it has had it once
  // this has run too.
  const afterItsTurn = () => new Promise((resolve) => setImmediate(resolve));

  it("leaves the papers while links are being added, and the next removal takes them", async () => {
    let answer!: () => void;
    busy.links = new Promise<void>((r) => (answer = r));
    const adding = request("POST", `/bookmark-folders/${folder}/links`, { lines: ["12345678"] });
    try {
      await vi.waitFor(() => expect(busy.linksOut).toBe(true));
      await removeSaved();
      await afterItsTurn();
      expect(stored()).toEqual(ALL);
    } finally {
      // Whatever happened, or the request stays counted as attaching, every
      // sweep after it in this file is skipped, and the server's close waits
      // on it.
      answer();
    }
    expect((await adding).status).toBe(200);
    await anotherRemoval();
    await swept([FED, FILED]);
  });

  it("leaves the papers while an entry is given its PMID, and the next removal takes them", async () => {
    const NAMED = "66666666";
    db.addBookmarkImports(folder, [
      {
        key: "ref:unmatched",
        formerKeys: [],
        title: "An entry PubMed couldn't place",
        authors: "Smith J",
        journal: "Lancet",
        year: "2021",
        doi: null,
        pmid: null,
      },
    ]);
    const entry = db.listBookmarkImports(folder)[0];
    busy.fetched = [article(NAMED)];
    let answer!: () => void;
    busy.fetch = new Promise<void>((r) => (answer = r));
    const naming = request("POST", `/bookmark-imports/${entry.id}/pmid`, { pmid: NAMED });
    try {
      await vi.waitFor(() => expect(busy.fetchOut).toBe(true));
      await removeSaved();
      await afterItsTurn();
      expect(stored()).toEqual(ALL);
    } finally {
      // As above: or it stays counted, and the server's close waits on it.
      answer();
    }
    expect((await naming).status).toBe(200);
    await anotherRemoval();
    await swept([FED, FILED]);
    // Bookmarked in its folder, so held, and not among the papers swept.
    expect(db.existingPmids([NAMED]).size).toBe(1);
  });
});
