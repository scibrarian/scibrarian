import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOPIC_HEADINGS, MAX_TOPIC_NAME_CHARS } from "../../shared/limits.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// A topic is a set of MeSH headings a paper must carry all of.
//
// What is asserted is the part nothing else checks: that the set is validated
// against the descriptor list, that it makes one PubMed term however it was
// picked — so the same headings in another order are the same topic — and that
// the preview counts exactly the term the create would store. The poller is
// untouched by any of this: it searches whatever term a topic carries.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "topic-headings-token";
const HEADERS = { "x-admin-token": "topic-headings-token", "content-type": "application/json" };

const ncbi = vi.hoisted(() => ({ counted: [] as string[], count: 119 }));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    countMatches: async (term: string) => {
      ncbi.counted.push(term);
      return ncbi.count;
    },
  };
});

let db: Db;
let server: Server;
let base: string;

const SLEEP = { ui: "D012890", name: "Sleep" };
const ATHERO = { ui: "D050197", name: "Atherosclerosis" };
const BOTH = '"Sleep"[MeSH] AND "Atherosclerosis"[MeSH]';

// Enough descriptors to go one past the cap.
const FILLER = Array.from({ length: MAX_TOPIC_HEADINGS }, (_, i) => ({
  ui: `D9000${String(i).padStart(2, "0")}`,
  name: `Filler Heading ${i}`,
}));

const request = (method: string, path: string, body?: unknown, headers: HeadersInit = HEADERS) =>
  fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const create = (headings: string[], name?: string) =>
  request("POST", "/topics", name === undefined ? { headings } : { headings, name });

beforeAll(async () => {
  db = await openTempDb("topic-headings");
  db.replaceMeshData(
    [SLEEP, ATHERO, ...FILLER].map((d) => ({ ...d, terms: [d.name] })),
    "2026"
  );
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
  db.db.exec("DELETE FROM topics");
  ncbi.counted = [];
  ncbi.count = 119;
});

describe("creating a topic from headings", () => {
  it("stores every heading and one term that requires them all", async () => {
    const res = await create([ATHERO.ui, SLEEP.ui]);
    expect(res.status).toBe(201);
    const topic = await res.json();
    expect(topic.term).toBe(BOTH);
    // Named and listed as picked; only the term is put in a fixed order.
    expect(topic.name).toBe("Atherosclerosis + Sleep");
    expect(topic.headings).toEqual([ATHERO, SLEEP]);
    // Read back from the table, not just echoed by the create.
    expect(db.getTopic(topic.id)!.headings).toEqual([ATHERO, SLEEP]);
  });

  it("keeps a single heading's term as it always was", async () => {
    const topic = await (await create([ATHERO.ui])).json();
    expect(topic.term).toBe('"Atherosclerosis"[MeSH]');
    expect(topic.name).toBe("Atherosclerosis");
  });

  it("takes a name of its own when given one", async () => {
    const topic = await (await create([ATHERO.ui, SLEEP.ui], "  Plaque and rest  ")).json();
    expect(topic.name).toBe("Plaque and rest");
  });

  it("counts a heading named twice once", async () => {
    const topic = await (await create([ATHERO.ui, ATHERO.ui])).json();
    expect(topic.headings).toEqual([ATHERO]);
  });

  it("refuses the same headings in another order", async () => {
    expect((await create([ATHERO.ui, SLEEP.ui])).status).toBe(201);
    const again = await create([SLEEP.ui, ATHERO.ui], "Something else");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain("Atherosclerosis + Sleep");
    expect(db.listTopics()).toHaveLength(1);
  });

  it("refuses a name another topic has", async () => {
    expect((await create([ATHERO.ui], "Reading")).status).toBe(201);
    const again = await create([SLEEP.ui], "reading");
    expect(again.status).toBe(409);
    expect(db.listTopics()).toHaveLength(1);
  });

  it("refuses an id that isn't a MeSH descriptor, and stores nothing", async () => {
    const res = await create([ATHERO.ui, "D000000"]);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("D000000");
    expect(db.listTopics()).toEqual([]);
  });

  it("refuses no headings, and more than the cap", async () => {
    expect((await create([])).status).toBe(400);
    expect((await request("POST", "/topics", { name: "Atherosclerosis" })).status).toBe(400);
    const tooMany = await create([ATHERO.ui, ...FILLER.map((d) => d.ui)]);
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toContain(String(MAX_TOPIC_HEADINGS));
    // Exactly the cap is fine.
    expect((await create(FILLER.map((d) => d.ui))).status).toBe(201);
  });

  it("refuses a name longer than a topic's may be", async () => {
    const res = await create([ATHERO.ui], "a".repeat(MAX_TOPIC_NAME_CHARS + 1));
    expect(res.status).toBe(400);
    expect(db.listTopics()).toEqual([]);
  });

  it("takes its headings with it when removed", async () => {
    const topic = await (await create([ATHERO.ui, SLEEP.ui])).json();
    expect((await request("DELETE", `/topics/${topic.id}`)).status).toBe(200);
    const left = db.db.prepare("SELECT COUNT(*) AS c FROM topic_terms").get() as { c: number };
    expect(left.c).toBe(0);
  });
});

describe("previewing a set of headings", () => {
  it("counts the term the create would store", async () => {
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}&ui=${SLEEP.ui}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ term: BOTH, count: 119 });
    expect(ncbi.counted).toEqual([BOTH]);
  });

  it("takes a single heading, which arrives as a string rather than a list", async () => {
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}`);
    expect((await res.json()).term).toBe('"Atherosclerosis"[MeSH]');
  });

  it("asks PubMed nothing about a set it would refuse", async () => {
    expect((await request("GET", "/topics/preview")).status).toBe(400);
    expect((await request("GET", "/topics/preview?ui=D000000")).status).toBe(422);
    expect(ncbi.counted).toEqual([]);
  });

  it("is the owner's alone, though it is a GET", async () => {
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}`, undefined, {});
    expect(res.status).toBe(401);
    expect(ncbi.counted).toEqual([]);
  });
});

describe("renaming a topic", () => {
  it("changes the name and leaves the term and headings alone", async () => {
    const topic = await (await create([ATHERO.ui, SLEEP.ui])).json();
    const res = await request("PATCH", `/topics/${topic.id}`, { name: " Plaque and rest " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topic).toMatchObject({
      name: "Plaque and rest",
      term: BOTH,
      headings: [ATHERO, SLEEP],
    });
    // A name is all that changed, so nothing left the feed.
    expect(body.removed).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
  });

  it("lets a topic keep its own name, and refuses another's", async () => {
    const a = await (await create([ATHERO.ui], "Reading")).json();
    const b = await (await create([SLEEP.ui], "Resting")).json();
    expect((await request("PATCH", `/topics/${a.id}`, { name: "READING" })).status).toBe(200);
    expect((await request("PATCH", `/topics/${b.id}`, { name: "reading" })).status).toBe(409);
    expect(db.getTopic(b.id)!.name).toBe("Resting");
  });

  it("refuses a blank name, an overlong one, and a topic that isn't there", async () => {
    const topic = await (await create([ATHERO.ui])).json();
    expect((await request("PATCH", `/topics/${topic.id}`, { name: "  " })).status).toBe(400);
    const long = "a".repeat(MAX_TOPIC_NAME_CHARS + 1);
    expect((await request("PATCH", `/topics/${topic.id}`, { name: long })).status).toBe(400);
    expect((await request("PATCH", "/topics/987654", { name: "Anything" })).status).toBe(404);
    expect(db.getTopic(topic.id)!.name).toBe("Atherosclerosis");
  });
});
