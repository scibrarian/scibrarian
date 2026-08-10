import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
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

const ORG = "Acme Pharma MedComms";

// Pulled from the org, so the Pro module has a name to attach to it.
const PULLED = { pmid: "40000001", hash: "a".repeat(64), doi: "10.1000/pulled" };
// Bought here. Present so an assertion can tell "no badge on this row" from
// "no badges in this response".
const LOCAL = { pmid: "40000002", hash: "b".repeat(64), doi: "10.1000/local" };

let db: Db;
let hooks: typeof import("./pro-hooks.js");
let server: Server;
let base: string;

// Every PMID the module was asked about, so the anonymous case can assert the
// lookup never ran at all rather than that its answer was filtered out
// afterwards. Skipping the work is the fix; filtering is the bug one refactor
// away from coming back.
let asked: string[][] = [];

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
  pulledOrgByPmid: (pmids) => {
    asked.push(pmids);
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
    expect(rows.find((r) => r.pmid === PULLED.pmid)?.from_org).toBe(ORG);
  });

  it("omits it on a paper the library bought itself", async () => {
    const body = await get("/api/papers?collection=all", AUTH);
    const local = body.papers.find((r: { pmid: string }) => r.pmid === LOCAL.pmid);
    expect("from_org" in local).toBe(false);
  });

  it("tells an unauthenticated reader nothing — no key, on any row", async () => {
    const body = await get("/api/papers?collection=all");
    expect(body.papers).toHaveLength(2);
    // Absent, not null: a `"from_org": null` on every row would still say a Pro
    // module is loaded here.
    for (const row of body.papers) expect("from_org" in row).toBe(false);
  });

  it("does not even ask the module for a reader who isn't the owner", async () => {
    asked = [];
    await get("/api/papers?collection=all");
    expect(asked).toEqual([]);
    await get("/api/papers?collection=all", AUTH);
    expect(asked).toHaveLength(1);
  });
});

describe("GET /papers in a free build", () => {
  it("omits from_org even for the owner", async () => {
    hooks.registerPro(null);
    const body = await get("/api/papers?collection=all", AUTH);
    for (const row of body.papers) expect("from_org" in row).toBe(false);
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
