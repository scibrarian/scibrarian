import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOPIC_HEADINGS, MAX_TOPIC_NAME_CHARS } from "../../shared/limits.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { pubmed } from "./test-pubmed.js";

// A topic is a set of MeSH headings a paper must carry all of.
//
// What is asserted is the part nothing else checks: that the set is validated
// against the descriptor list, that it makes one PubMed term however it was
// picked — so the same headings in another order are the same topic — and that
// the preview counts exactly the term the create would store. The poller is
// untouched by any of this: it searches whatever term a topic carries.
//
// The rules are asked of topic-definition.ts directly; the preview, which is a
// route of its own, is asked through HTTP.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "topic-headings-token";
const HEADERS = { "x-admin-token": "topic-headings-token", "content-type": "application/json" };

vi.mock("./pubmed.js", () => import("./test-pubmed.js"));
// The vocabulary is seeded below (seedMesh), and that is all of it there is to
// load. Left alone, the first route to read a heading asks NLM which MeSH year
// is current before it answers, from inside a test — see topic-scope.test.ts,
// where a slow answer failed two.
vi.mock("./mesh-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mesh-catalog.js")>();
  return { ...actual, ensureMeshLoaded: async () => {} };
});

let db: Db;
let server: Server;
let base: string;
let addTopic: typeof import("./topic-definition.js").addTopic;
let changeTopic: typeof import("./topic-definition.js").changeTopic;

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
  addTopic(name === undefined ? { headings } : { headings, name });

// The vocabulary the routes check headings against. Seeded once for the file;
// a test that revises it puts this back.
const seedMesh = (rows = [SLEEP, ATHERO, ...FILLER]) =>
  db.replaceMeshData(
    rows.map((d) => ({ ...d, terms: [d.name] })),
    "2026"
  );

beforeAll(async () => {
  db = await openTempDb("topic-headings");
  seedMesh();
  ({ addTopic, changeTopic } = await import("./topic-definition.js"));
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
});

describe("creating a topic from headings", () => {
  it("stores every heading and one term that requires them all", async () => {
    const topic = await create([ATHERO.ui, SLEEP.ui]);
    expect(topic.term).toBe(BOTH);
    // Named and listed as picked; only the term is put in a fixed order.
    expect(topic.name).toBe("Atherosclerosis + Sleep");
    expect(topic.headings).toEqual([ATHERO, SLEEP]);
    // Read back from the table, not just echoed by the create.
    expect(db.getTopic(topic.id)!.headings).toEqual([ATHERO, SLEEP]);
  });

  it("keeps a single heading's term as it always was", async () => {
    const topic = await create([ATHERO.ui]);
    expect(topic.term).toBe('"Atherosclerosis"[MeSH]');
    expect(topic.name).toBe("Atherosclerosis");
  });

  it("takes a name of its own when given one", async () => {
    const topic = await create([ATHERO.ui, SLEEP.ui], "  Plaque and rest  ");
    expect(topic.name).toBe("Plaque and rest");
  });

  it("counts a heading named twice once", async () => {
    const topic = await create([ATHERO.ui, ATHERO.ui]);
    expect(topic.headings).toEqual([ATHERO]);
  });

  it("refuses the same headings in another order", async () => {
    await create([ATHERO.ui, SLEEP.ui]);
    await expect(create([SLEEP.ui, ATHERO.ui], "Something else")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Atherosclerosis + Sleep"),
    });
    expect(db.listTopics()).toHaveLength(1);
  });

  it("refuses the same headings once NLM has renamed one of them", async () => {
    // What made two topics the same was the term, and the term is built from
    // the headings' names. NLM revises those each year: the descriptor keeps
    // its id and is called something else, the same pick builds a different
    // term, and a second topic was let in for one set of headings.
    await create([ATHERO.ui, SLEEP.ui]);
    seedMesh([SLEEP, { ui: ATHERO.ui, name: "Arterial Plaque" }, ...FILLER]);
    try {
      await expect(create([SLEEP.ui, ATHERO.ui])).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Atherosclerosis + Sleep"),
      });
      expect(db.listTopics()).toHaveLength(1);
    } finally {
      seedMesh();
    }
  });

  it("refuses a name another topic has", async () => {
    await create([ATHERO.ui], "Reading");
    await expect(create([SLEEP.ui], "reading")).rejects.toMatchObject({ status: 409 });
    expect(db.listTopics()).toHaveLength(1);
  });

  it("refuses an id that isn't a MeSH descriptor, and stores nothing", async () => {
    await expect(create([ATHERO.ui, "D000000"])).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("D000000"),
    });
    expect(db.listTopics()).toEqual([]);
  });

  it("refuses no headings, and more than the cap", async () => {
    await expect(create([])).rejects.toMatchObject({ status: 400 });
    await expect(addTopic({ name: "Atherosclerosis" })).rejects.toMatchObject({ status: 400 });
    await expect(create([ATHERO.ui, ...FILLER.map((d) => d.ui)])).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(String(MAX_TOPIC_HEADINGS)),
    });
    // Exactly the cap is fine.
    expect((await create(FILLER.map((d) => d.ui))).headings).toHaveLength(MAX_TOPIC_HEADINGS);
  });

  it("refuses a name longer than a topic's may be", async () => {
    await expect(create([ATHERO.ui], "a".repeat(MAX_TOPIC_NAME_CHARS + 1))).rejects.toMatchObject({
      status: 400,
    });
    expect(db.listTopics()).toEqual([]);
  });

  it("takes its headings with it when removed", async () => {
    const topic = await create([ATHERO.ui, SLEEP.ui]);
    expect((await request("DELETE", `/topics/${topic.id}`)).status).toBe(200);
    const left = db.db.prepare("SELECT COUNT(*) AS c FROM topic_terms").get() as { c: number };
    expect(left.c).toBe(0);
  });
});

describe("previewing a set of headings", () => {
  it("counts the term the create would store", async () => {
    pubmed.answer(BOTH, [], 119);
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}&ui=${SLEEP.ui}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ term: BOTH, count: 119 });
    expect(pubmed.calls("countMatches")).toEqual([[BOTH]]);
  });

  it("takes a single heading, which arrives as a string rather than a list", async () => {
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}`);
    expect((await res.json()).term).toBe('"Atherosclerosis"[MeSH]');
  });

  it("asks PubMed nothing about a set it would refuse", async () => {
    expect((await request("GET", "/topics/preview")).status).toBe(400);
    expect((await request("GET", "/topics/preview?ui=D000000")).status).toBe(422);
    expect(pubmed.calls("countMatches")).toEqual([]);
  });

  it("is the owner's alone, though it is a GET", async () => {
    const res = await request("GET", `/topics/preview?ui=${ATHERO.ui}`, undefined, {});
    expect(res.status).toBe(401);
    expect(pubmed.calls("countMatches")).toEqual([]);
  });
});

describe("renaming a topic", () => {
  it("changes the name and leaves the term and headings alone", async () => {
    const topic = await create([ATHERO.ui, SLEEP.ui]);
    const body = await changeTopic(topic.id, { name: " Plaque and rest " });
    expect(body.topic).toMatchObject({
      name: "Plaque and rest",
      term: BOTH,
      headings: [ATHERO, SLEEP],
    });
    // A name is all that changed, so nothing left the feed.
    expect(body.removed).toEqual({ deletedArticles: 0, removedFromInterests: 0 });
  });

  it("lets a topic keep its own name, and refuses another's", async () => {
    const a = await create([ATHERO.ui], "Reading");
    const b = await create([SLEEP.ui], "Resting");
    expect((await changeTopic(a.id, { name: "READING" })).topic.name).toBe("READING");
    await expect(changeTopic(b.id, { name: "reading" })).rejects.toMatchObject({ status: 409 });
    expect(db.getTopic(b.id)!.name).toBe("Resting");
  });

  it("refuses a blank name, an overlong one, and a topic that isn't there", async () => {
    const topic = await create([ATHERO.ui]);
    await expect(changeTopic(topic.id, { name: "  " })).rejects.toMatchObject({ status: 400 });
    const long = "a".repeat(MAX_TOPIC_NAME_CHARS + 1);
    await expect(changeTopic(topic.id, { name: long })).rejects.toMatchObject({ status: 400 });
    await expect(changeTopic(987654, { name: "Anything" })).rejects.toMatchObject({ status: 404 });
    expect(db.getTopic(topic.id)!.name).toBe("Atherosclerosis");
  });
});
