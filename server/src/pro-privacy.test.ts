import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import type { PaperProvenance } from "../../shared/types.js";
import type { ProModule } from "./pro-hooks.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// What a *reader who is not the owner* can learn about the Pro tier from the
// open routes.
//
// The admin gate is fail-open for GETs by design — reads are public — so every
// owner-only read has to gate itself, and the two that carry Pro topology are
// the two the whole app polls constantly: the papers list and the collections
// list. The failure is quiet in a way a type can't catch. Nothing errors, no
// test goes red, a page just contains one extra key; and that key names the
// agency and the fact that this instance is paired to it. GET /auth was
// narrowed to the owner for exactly this reason, and a per-row badge is an easy
// way to hand it straight back.
//
// So these run over HTTP rather than against the hook: what is being pinned is
// what leaves the process for an unauthenticated caller, and a unit test of
// pulledOrgByPmid cannot see that. Both directions matter — the owner must
// still get the badge, or the tests pass on a feature that was simply deleted.

// config.ts reads ADMIN_TOKEN at import time, and with no token every request
// is the owner (single-user mode) — which would make an "anonymous" assertion
// below silently vacuous. Set before any dynamic import, as signing.test.ts
// does; dotenv never overwrites an already-set variable.
process.env.ADMIN_TOKEN = "test-admin-token";
const AUTH = { authorization: "Bearer test-admin-token" };

const ORG: PaperProvenance = { kind: "org", label: "Acme Pharma MedComms" };

// Pulled from the org, so the Pro module has a name to attach to it.
const PULLED = { pmid: "40000001", hash: "a".repeat(64), doi: "10.1000/pulled" };
// Bought here. Present so an assertion can tell "no badge on this row" from
// "no badges in this response".
const LOCAL = { pmid: "40000002", hash: "b".repeat(64), doi: "10.1000/local" };

let db: Db;
let hooks: typeof import("./pro-hooks.js");
let server: Server;
let base: string;

// Every provenance lookup the module was asked to run, by hook, so the
// anonymous case can assert the work never happened rather than that its answer
// was filtered out afterwards. Skipping the work is the fix; filtering is the
// bug one refactor away from coming back.
//
// Both hooks record, and the owner case asserts on the hook *names* rather than
// on a count. A gate that covered only the org lookup would otherwise leave
// this suite green while /papers handed a freelancer's self-declared name to
// any unauthenticated caller who can reach the port — arguably the more
// sensitive of the two, since the org name is the customer's own.
let asked: { hook: string; pmids: string[] }[] = [];

const stub: ProModule = {
  version: "test",
  init: () => {},
  routes: () => {
    throw new Error("routes() is not exercised by these tests");
  },
  status: (): ProStatus => ({
    version: "test",
    is_master: false,
    is_paired: true,
    node_count: 1,
  }),
  receivedNodeByPmid: (pmids) => {
    asked.push({ hook: "receivedNodeByPmid", pmids });
    return new Map<string, PaperProvenance>();
  },
  pulledOrgByPmid: (pmids) => {
    asked.push({ hook: "pulledOrgByPmid", pmids });
    return new Map(pmids.filter((p) => p === PULLED.pmid).map((p) => [p, ORG]));
  },
  orgCheck: async (): Promise<Map<string, OrgHolding>> => new Map(),
};

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

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  db = await openTempDb("pro-privacy");
  hooks = await import("./pro-hooks.js");
  const { api } = await import("./routes.js");

  db.upsertArticles([article(PULLED), article(LOCAL)]);
  // Seed citation counts so the first /papers request doesn't await an iCite
  // round-trip. The handler backfills anything missing or older than 14 days
  // *before* responding, so freshly inserted articles make it call the live API
  // — which put this suite's first test at 4.8s against a 5s timeout, and over
  // it whenever the network was slower. What is under test here is who may see
  // provenance; nothing about it should depend on api.icite.od.nih.gov being
  // reachable, let alone fast.
  db.upsertCitations(
    [PULLED, LOCAL].map((p) => ({ pmid: p.pmid, info: { citation_count: 0, references: [] } }))
  );
  const c = db.createCollection("Study 402").id;
  db.addCollectionFiles(c, [
    { hash: PULLED.hash, name: "pulled.pdf" },
    { hash: LOCAL.hash, name: "local.pdf" },
  ]);
  for (const f of db.listCollectionFiles(c)) {
    db.setFileMatched(f.id, f.file_name === "pulled.pdf" ? PULLED.pmid : LOCAL.pmid, "manual");
  }

  const app = express();
  app.use("/api", api);
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  hooks?.registerPro(null);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeTempDb();
});

describe("GET /papers with a Pro module registered", () => {
  beforeAll(() => hooks.registerPro(stub));
  afterAll(() => hooks.registerPro(null));

  it("gives the owner the org badge on a pulled paper", async () => {
    const body = await get("/api/papers?collection=all", AUTH);
    const rows: Record<string, unknown>[] = body.papers;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.pmid === PULLED.pmid)?.provenance).toEqual([ORG]);
  });

  it("omits it on a paper the library bought itself", async () => {
    const body = await get("/api/papers?collection=all", AUTH);
    const local = body.papers.find((r: { pmid: string }) => r.pmid === LOCAL.pmid);
    expect("provenance" in local).toBe(false);
  });

  it("tells an unauthenticated reader nothing — no key, on any row", async () => {
    const body = await get("/api/papers?collection=all");
    expect(body.papers).toHaveLength(2);
    // Absent, not null: a `"provenance": null` on every row would still say a
    // Pro module is loaded here.
    for (const row of body.papers) expect("provenance" in row).toBe(false);
  });

  it("does not even ask the module for a reader who isn't the owner", async () => {
    asked = [];
    await get("/api/papers?collection=all");
    expect(asked).toEqual([]);

    // By name, not by count: every provenance lookup has to sit behind the
    // gate, and a count of one passes just as happily when only half of them
    // does. This is the assertion that fails if a later refactor gates the org
    // lookup and leaves the contributor lookup running for everyone.
    await get("/api/papers?collection=all", AUTH);
    expect(asked.map((a) => a.hook).sort()).toEqual(["pulledOrgByPmid", "receivedNodeByPmid"]);
  });
});

describe("GET /papers in a free build", () => {
  it("omits provenance even for the owner", async () => {
    hooks.registerPro(null);
    const body = await get("/api/papers?collection=all", AUTH);
    for (const row of body.papers) expect("provenance" in row).toBe(false);
  });
});

describe("GET /collections", () => {
  // The route carries no sharing flag at all now. A per-collection `synced` key
  // is readable as topology by presence alone — set on a paired spoke, missing
  // on a free build — so it stays off a route the whole world can GET, whether
  // or not a Pro module is loaded.
  it("carries no sharing flag, module or not", async () => {
    for (const mod of [stub, null]) {
      hooks.registerPro(mod);
      for (const headers of [AUTH, {}]) {
        const rows = await get("/api/collections", headers);
        expect(rows).toHaveLength(1);
        expect("synced" in rows[0]).toBe(false);
      }
    }
  });
});
