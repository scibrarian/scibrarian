import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { ALL, FED, FILED, LOOSE, SAVED, article, seedHoldings } from "./unheld-sweep-fixture.js";

// When the sweep of papers nothing holds runs, beyond startup: after a removal,
// and only if the server is idle.
//
// What the sweep takes is unheld-sweep.test.ts. What is pinned here is the
// turn-taking. A removal doesn't delete the paper it lets go of, because a
// paper is stored before the file or bookmark it is stored for is attached, and
// one deleted in between leaves a file matched to a paper that isn't there. So
// the sweep follows the removal, skips its turn while anything is attaching —
// an import, a copy arriving from another library, a poll, links being added —
// and the next removal to find the server idle takes what the skipped one left.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "unheld-sweep-token";
const HEADERS = { "x-admin-token": "unheld-sweep-token", "content-type": "application/json" };

const busy = vi.hoisted(() => ({
  importing: false,
  transferring: false,
  // What a links request waits on, and whether one has got as far as waiting.
  links: null as Promise<void> | null,
  linksOut: false,
  // The same pair for a request for citation counts, and what PubMed answers a
  // manual match with.
  cites: null as Promise<void> | null,
  citesOut: false,
  fetched: [] as import("./db.js").ArticleInsert[],
}));
vi.mock("./importer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./importer.js")>();
  return { ...actual, anyImportRunning: () => busy.importing };
});
vi.mock("./pro-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pro-storage.js")>();
  return { ...actual, anyTransferInFlight: () => busy.transferring };
});
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
  return { ...actual, fetchArticles: async () => busy.fetched };
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
let withPollLock: typeof import("./poller.js").withPollLock;

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
  ({ withPollLock } = await import("./poller.js"));
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
  busy.importing = false;
  busy.transferring = false;
  busy.links = null;
  busy.linksOut = false;
  busy.cites = null;
  busy.citesOut = false;
  busy.fetched = [];
  ({ topic, shelf, folder } = seedHoldings(db));
});

describe("a removal, with the server idle", () => {
  it("takes the papers ticked out of their last folder, and any left from before", async () => {
    const res = await request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [SAVED] });
    expect(await res.json()).toEqual({ removed: 1 });
    expect(stored()).toEqual([FED, FILED]);
    expect(counted()).toEqual([FED, FILED]);
  });

  it("takes the papers of a deleted folder", async () => {
    expect((await request("DELETE", `/bookmark-folders/${folder}`)).status).toBe(204);
    expect(stored()).toEqual([FED, FILED]);
  });

  it("takes a paper removed from its collection, and one whose collection is deleted", async () => {
    const res = await request("POST", `/collections/${shelf}/papers/remove`, { pmids: [FILED] });
    expect(await res.json()).toEqual({ removed: 1, papers: 1 });
    expect(stored()).toEqual([FED, SAVED]);

    const again = db.createCollection("Second shelf").id;
    db.upsertArticles([article(FILED)]);
    db.addCollectionFiles(again, [{ hash: "b".repeat(64), name: "filed.pdf" }]);
    db.setFileMatched(db.listCollectionFiles(again)[0].id, FILED, "pmid");
    expect((await request("DELETE", `/collections/${again}`)).status).toBe(204);
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("takes a paper whose file is deleted", async () => {
    const file = db.listCollectionFiles(shelf)[0];
    expect((await request("DELETE", `/collections/files/${file.id}`)).status).toBe(204);
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("is not given a turn by a removed topic, which leaves nothing for it", async () => {
    // The topic's own papers go with it, and what was counted about them. The
    // paper nothing holds is the sweep's, and stays.
    expect((await request("DELETE", `/topics/${topic}`)).status).toBe(200);
    expect(stored()).toEqual([FILED, SAVED, LOOSE]);
    expect(counted()).toEqual([FILED, SAVED, LOOSE]);
  });

  it("is not given a turn by the one-paper toggle", async () => {
    // The toggle in Interests, where a paper is in a feed and stays held.
    expect((await request("DELETE", `/bookmark-folders/${folder}/papers/${SAVED}`)).status).toBe(204);
    expect(db.listBookmarks()).toEqual([]);
    expect(stored()).toEqual(ALL);
  });

  it("is not given a turn by a removal that took nothing", async () => {
    const res = await request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [] });
    expect(await res.json()).toEqual({ removed: 0 });
    expect(stored()).toEqual(ALL);

    const none = await request("POST", `/collections/${shelf}/papers/remove`, { pmids: [SAVED] });
    expect(await none.json()).toEqual({ removed: 0, papers: 0 });
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
      expect(stored()).toEqual([FED, FILED]);
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
    expect(stored()).toEqual([FED, SAVED, LOOSE]);
  });

  it("gives it none when the file had no paper to let go of", async () => {
    db.addCollectionFiles(shelf, [{ hash: "c".repeat(64), name: "unmatched.pdf" }]);
    const file = db.listCollectionFiles(shelf).find((f) => f.file_name === "unmatched.pdf")!;
    busy.fetched = [article(MATCHED)];
    const res = await request("POST", `/collections/files/${file.id}/pmid`, { pmid: MATCHED });
    expect(res.status).toBe(200);
    expect(stored()).toEqual(ALL);
  });
});

describe("a removal while something is attaching", () => {
  const removeSaved = () =>
    request("POST", `/bookmark-folders/${folder}/papers/remove`, { pmids: [SAVED] });

  it("leaves the papers during an import, and the next removal takes them", async () => {
    busy.importing = true;
    expect(await (await removeSaved()).json()).toEqual({ removed: 1 });
    // Off the folder's list, and still stored: an import may be about to match
    // a file to it.
    expect(db.listBookmarks()).toEqual([]);
    expect(stored()).toEqual(ALL);

    busy.importing = false;
    await anotherRemoval();
    expect(stored()).toEqual([FED, FILED]);
  });

  it("leaves the papers while a copy arrives from another library, and the next removal takes them", async () => {
    busy.transferring = true;
    await removeSaved();
    expect(stored()).toEqual(ALL);

    busy.transferring = false;
    await anotherRemoval();
    expect(stored()).toEqual([FED, FILED]);
  });

  it("leaves the papers during a poll, and the next removal takes them", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = withPollLock(async () => {
      await held;
    });
    try {
      await removeSaved();
      expect(stored()).toEqual(ALL);
    } finally {
      // Whatever happened, or the lock outlives this test and fails the next.
      release();
      await holding;
    }

    await anotherRemoval();
    expect(stored()).toEqual([FED, FILED]);
  });

  it("leaves the papers while links are being added, and the next removal takes them", async () => {
    let answer!: () => void;
    busy.links = new Promise<void>((r) => (answer = r));
    const adding = request("POST", `/bookmark-folders/${folder}/links`, { lines: ["12345678"] });
    try {
      await vi.waitFor(() => expect(busy.linksOut).toBe(true));
      await removeSaved();
      expect(stored()).toEqual(ALL);
    } finally {
      // Whatever happened, or the request stays counted as attaching, every
      // sweep after it in this file is skipped, and the server's close waits
      // on it.
      answer();
    }
    expect((await adding).status).toBe(200);
    await anotherRemoval();
    expect(stored()).toEqual([FED, FILED]);
  });
});
