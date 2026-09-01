import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { MAX_MESH_FILTER } from "./routes.js";

// What the subject filter does with more descriptors than it will take.
//
// Over HTTP rather than against listPapers, because the cap is not visible from
// there: by the time the filter runs, the ids that exceeded it are already gone
// either way. Only the route can say whether they were dropped or refused.
//
// The ceiling used to trim the list and carry on, which was defensible while
// the filter ORed — a dropped id could only narrow the result, so the answer
// stayed a subset of the question. Under AND it inverts. Every dropped id is
// one fewer thing a paper has to carry, so trimming hands back exactly the
// papers the filter was asked to exclude, under a trigger still reading the
// full subject count. That is the case below: the id that rules the paper out
// is the one past the cap.

// config.ts reads ADMIN_TOKEN at import time and vitest shares a process across
// files, so this is set rather than assumed — an unset token here means a token
// another file set is still in force and every request 401s before it is read.
process.env.ADMIN_TOKEN = "mesh-filter-cap-token";
const HEADERS = { "x-admin-token": "mesh-filter-cap-token" };

let db: Db;
let server: Server;
let base: string;
let topic: number;

// Shape-valid descriptor ids — parseFilter drops anything that isn't before it
// counts, so a malformed one would be tested as a shorter list than it looks.
const ui = (i: number) => `D${String(i).padStart(6, "0")}`;
const AT_THE_CAP = Array.from({ length: MAX_MESH_FILTER }, (_, i) => ui(i));
// The one heading the paper is not filed under, appended so that trimming to
// the cap would drop precisely the id that excludes it.
const EXCLUDES_IT = "D999999";
const PAST_THE_CAP = [...AT_THE_CAP, EXCLUDES_IT];

const PMID = "10000001";

const get = (path: string) => fetch(`${base}${path}`, { headers: HEADERS });
const papers = async (res: Response) =>
  ((await res.json()) as { papers: { pmid: string }[] }).papers.map((p) => p.pmid);

beforeAll(async () => {
  db = await openTempDb("mesh-filter-cap");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
  topic = db.createTopic("Reflux", "reflux").id;
  db.saveArticles(
    [
      {
        pmid: PMID,
        title: "Filed under everything the cap allows",
        abstract: "",
        journal_name: "Gut",
        mesh: {
          status: "MEDLINE",
          headings: AT_THE_CAP.map((u) => ({ ui: u, name: `Subject ${u}`, major: false })),
        },
        nlm_id: null,
        authors: ["Smith J"],
        pub_date: "2021-01-01",
        pub_date_display: "2021",
        doi: `10.1000/${PMID}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${PMID}/`,
      },
    ],
    topic
  );
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

describe("the subject-filter ceiling", () => {
  it("serves a request that names exactly as many subjects as it allows", async () => {
    const res = await get(`/api/papers?topic=${topic}&mesh=${AT_THE_CAP.join(",")}`);
    expect(res.status).toBe(200);
    // The paper carries all of them, so it comes back — the ceiling is not off
    // by one, and a request sitting on it is still a working filter.
    expect(await papers(res)).toEqual([PMID]);
  });

  it("refuses one subject more instead of trimming to a wider answer", async () => {
    const res = await get(`/api/papers?topic=${topic}&mesh=${PAST_THE_CAP.join(",")}`);
    expect(res.status).toBe(400);
    // Naming the limit is the whole difference from the old behaviour, which
    // answered 200 with a paper the request had just excluded and said nothing.
    expect((await res.json()).error).toContain(String(MAX_MESH_FILTER));
  });

  it("refuses it identically on the graph, which shares the filter", async () => {
    const res = await get(`/api/graph?topic=${topic}&mesh=${PAST_THE_CAP.join(",")}`);
    expect(res.status).toBe(400);
  });
});
