import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import type { PaperProvenance } from "../../shared/types.js";
import type { ProModule } from "./pro-hooks.js";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The org verdict on "do I already have this?" — the Pro tier's third answer,
// tested from the open repo because the *seam* is open even though the module
// behind it isn't. A stub standing in for the Pro module is the point: these
// pin what /have does with each shape of answer, which is where the failure
// that matters lives.
//
// That failure is a specific one, and it is asymmetric. Reporting "your org
// doesn't have it" when nobody actually answered sends a writer to buy a paper
// the agency already owns — silently, and a duplicate purchase later. So the
// cases below care much less about the happy path than about every way the
// answer can go missing: no Pro module, an unreachable master, a revoked node.
// All three must land on "we didn't ask", never on "no".

type Have = typeof import("./have.js");
type Hooks = typeof import("./pro-hooks.js");

let db: Db;
let have: Have;
let hooks: Hooks;

// A paper the org genuinely holds a file for.
const OWNED = { pmid: "30000001", hash: "a".repeat(64), doi: "10.1000/owned" };
// A paper the org has *seen* — an articles row, no file. The org check must
// answer no for this one; a master that says "held" here sends a writer to ask
// for a file nobody has.
const SEEN = { pmid: "30000002", hash: "b".repeat(64), doi: "10.1000/seen" };
// Held by this instance, locally. Never needs an org answer at all.
const LOCAL = { pmid: "30000003", hash: "c".repeat(64), doi: "10.1000/local" };
// Held by the org, and *entirely unknown here* — no articles row, no file. A
// bare DOI for this paper is the case the first org pass cannot cover: there is
// no PMID to ask about until OpenAlex supplies one.
const STRANGER = { pmid: "30000004", doi: "10.1000/stranger" };

// OpenAlex, controllable and offline.
//
// The second org pass runs only after a real enrichment call, so pinning it
// needs an answer this test can choose. Recording what was asked also pins the
// free-copy suppression directly, rather than by inferring it from a request
// that never left.
const oa = vi.hoisted(() => ({
  asked: [] as { dois: string[]; pmids: string[] }[],
  works: {
    byDoi: new Map<string, unknown>(),
    byPmid: new Map<string, unknown>(),
  },
}));

vi.mock("./openalex.js", () => ({
  lookupWorks: async (dois: string[], pmids: string[]) => {
    oa.asked.push({ dois, pmids });
    return oa.works;
  },
}));

const oaWork = (o: { pmid: string; doi: string }) => ({
  pmid: o.pmid,
  doi: o.doi,
  title: `Paper ${o.pmid}`,
  year: 2024,
  free: null,
});

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

// What the stub will do on the next call, plus what it was asked.
let orgAnswer: (pmids: string[]) => Promise<Map<string, OrgHolding>>;
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
    node_count: 0,
  }),
  orgCheck: (pmids) => {
    asked.push(pmids);
    return orgAnswer(pmids);
  },
  // Not exercised here — these feed the papers list, not /have — but the stub
  // has to satisfy the whole interface, which is the point: a hook added to
  // ProModule without a free-tier answer fails to compile in the open repo.
  pulledOrgByPmid: () => new Map<string, PaperProvenance>(),
  receivedNodeByPmid: () => new Map<string, PaperProvenance>(),
};

const holds = (...pmids: string[]) =>
  async (): Promise<Map<string, OrgHolding>> =>
    new Map(pmids.map((p) => [p, { pmid: p, node: "Acme Medical" }]));

beforeAll(async () => {
  db = await openTempDb("have");
  have = await import("./have.js");
  hooks = await import("./pro-hooks.js");

  db.upsertArticles([article(OWNED), article(SEEN), article(LOCAL)]);

  // Only LOCAL gets a collection_files row on *this* instance. OWNED exists as
  // an articles row here too, which is the realistic case — a feed turned it up
  // — and is exactly why `held` must not be read off that row.
  const mine = db.createCollection("Mine").id;
  db.addCollectionFiles(mine, [{ hash: LOCAL.hash, name: "local.pdf" }]);
  for (const f of db.listCollectionFiles(mine)) {
    db.setFileMatched(f.id, LOCAL.pmid, "manual");
  }
});

afterAll(closeTempDb);

afterEach(() => {
  hooks.registerPro(null);
  asked = [];
  oa.asked = [];
  oa.works = { byDoi: new Map(), byPmid: new Map() };
});

// lookUpFree is off everywhere except the one test that pins its suppression:
// the free-copy lookup is the only part of /have that would otherwise leave the
// machine, and these tests don't touch the network.
const check = (refs: string[], opts = {}) =>
  have.checkHoldings(refs, { lookUpFree: false, ...opts });

describe("org verdict", () => {
  it("is absent in a free build, and says so rather than saying no", async () => {
    const [answer] = await check([OWNED.pmid]);
    expect(answer.held).toBe(false);
    expect(answer.org).toBeNull();
    // The distinction the whole feature rests on: not "the org doesn't have
    // it", but "nobody was asked".
    expect(answer.orgChecked).toBe(false);
  });

  it("reports a paper the org holds, with the master's label", async () => {
    orgAnswer = holds(OWNED.pmid);
    hooks.registerPro(stub);

    const [answer] = await check([OWNED.pmid]);
    expect(answer.held).toBe(false); // still not held *by you*
    expect(answer.orgChecked).toBe(true);
    expect(answer.org).toEqual({ pmid: OWNED.pmid, node: "Acme Medical" });
  });

  it("answers no for a paper the org has only seen", async () => {
    orgAnswer = holds(); // master answered, and holds nothing
    hooks.registerPro(stub);

    const [answer] = await check([SEEN.pmid]);
    expect(answer.orgChecked).toBe(true);
    expect(answer.org).toBeNull();
  });

  it("degrades to 'not asked' when the master is unreachable", async () => {
    // The single most important case. An unreachable master must not be
    // indistinguishable from an org that doesn't hold the paper.
    orgAnswer = () => Promise.reject(new Error("fetch failed"));
    hooks.registerPro(stub);

    const [answer] = await check([OWNED.pmid]);
    expect(answer.held).toBe(false);
    expect(answer.org).toBeNull();
    expect(answer.orgChecked).toBe(false);
  });

  it("degrades the same way when the node has been revoked", async () => {
    orgAnswer = () => Promise.reject(new Error("master answered 401"));
    hooks.registerPro(stub);

    const [answer] = await check([OWNED.pmid]);
    expect(answer.orgChecked).toBe(false);
    expect(answer.org).toBeNull();
  });

  it("leaves the local verdict alone whatever the master does", async () => {
    // held is decided locally, before anything touches the network, and stays
    // the same answer with the master down as with it up.
    orgAnswer = () => Promise.reject(new Error("fetch failed"));
    hooks.registerPro(stub);

    const [answer] = await check([LOCAL.pmid]);
    expect(answer.held).toBe(true);
    expect(answer.match?.file_name).toBe("local.pdf");
  });
});

describe("what the master is asked", () => {
  it("is never asked about a paper this instance already holds", async () => {
    orgAnswer = holds();
    hooks.registerPro(stub);

    await check([LOCAL.pmid, OWNED.pmid]);
    expect(asked).toEqual([[OWNED.pmid]]);
  });

  it("uses the PMID behind a DOI-only line", async () => {
    // A pasted DOI names a paper whose PMID the library knows from its articles
    // row. Asking by that PMID is the difference between a hit and a miss,
    // because identity across instances is the PMID and only the PMID.
    orgAnswer = holds(OWNED.pmid);
    hooks.registerPro(stub);

    const [answer] = await check([OWNED.doi]);
    expect(asked).toEqual([[OWNED.pmid]]);
    expect(answer.org).toEqual({ pmid: OWNED.pmid, node: "Acme Medical" });
  });

  it("is not asked at all when the request opted out", async () => {
    // ?free=0 — the client sends it while a paste is still being typed, and it
    // has to suppress every network call, not just OpenAlex.
    orgAnswer = holds(OWNED.pmid);
    hooks.registerPro(stub);

    const [answer] = await check([OWNED.pmid], { checkOrg: false });
    expect(asked).toEqual([]);
    expect(answer.orgChecked).toBe(false);
  });

  it("is not asked at all when no line carries an identifier", async () => {
    orgAnswer = holds();
    hooks.registerPro(stub);

    const [answer] = await check(["Smith J. Some article title. Lancet. 2019."]);
    expect(asked).toEqual([]); // no request worth making
    expect(answer.orgChecked).toBe(false);
  });

  // Rejection was already covered above; latency is the other way an answer
  // goes missing, and it is the one that takes the local verdict with it. A
  // host that drops packets rather than refusing the connection leaves the
  // promise pending, not rejected — so nothing above catches it, and /have
  // waits out the OS TCP timeout while the held/not-held answer sits ready.
  it("degrades to 'not asked' when the master never answers at all", async () => {
    vi.useFakeTimers();
    try {
      orgAnswer = () => new Promise(() => {}); // never settles, never rejects
      hooks.registerPro(stub);

      const pending = check([OWNED.pmid, LOCAL.pmid]);
      await vi.advanceTimersByTimeAsync(30_000);
      const [owned, local] = await pending;

      // The org line is dropped — as "nobody answered", never as "no".
      expect(owned.orgChecked).toBe(false);
      expect(owned.org).toBeNull();
      // And the verdict decided locally, before any of this, is untouched.
      expect(owned.held).toBe(false);
      expect(local.held).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark an unreadable line as checked just because others were", async () => {
    // The batch goes out for the readable line, so an answer comes back — but
    // it isn't an answer about this line, and orgChecked must not claim it is.
    orgAnswer = holds(OWNED.pmid);
    hooks.registerPro(stub);

    const [unreadable, owned] = await check(["not a reference at all", OWNED.pmid]);
    expect(asked).toEqual([[OWNED.pmid]]);
    expect(unreadable.orgChecked).toBe(false);
    expect(unreadable.org).toBeNull();
    expect(owned.orgChecked).toBe(true);
  });
});

describe("interaction with the free-copy lookup", () => {
  it("suppresses it for a paper the org holds", async () => {
    // A writer who can get the file from the master has no use for a free-copy
    // link, and offering one invites a second copy of something already bought.
    //
    // Note this is the one test that runs with lookUpFree on. It stays offline
    // *because* of the behaviour it pins: an org-held line is excluded from the
    // OpenAlex batch, which leaves it empty and short-circuits the request. If
    // that suppression ever regresses, this test reaches the network — which is
    // a failure either way, and the assertion below is what reports it.
    orgAnswer = holds(OWNED.pmid);
    hooks.registerPro(stub);

    const [answer] = await have.checkHoldings([OWNED.pmid], { lookUpFree: true });
    expect(answer.org).not.toBeNull();
    expect(answer.freeChecked).toBe(false);
    expect(answer.free).toBeNull();
    // Directly: the batch was never assembled, so OpenAlex was never called.
    expect(oa.asked).toEqual([]);
  });
});

// The half the first org pass structurally cannot reach.
//
// orgKey reads a PMID off the cached row or off the pasted reference. A bare
// DOI for a paper this library has never seen has neither, so the line is
// dropped from the first batch — and OpenAlex, twenty lines later, is the thing
// that knows its PMID. Without a second ask the writer is told "not in your
// library", with a free-copy link, for a paper the agency already bought.
describe("a DOI the library has never seen", () => {
  it("is asked about once OpenAlex places it", async () => {
    oa.works = { byDoi: new Map([[STRANGER.doi, oaWork(STRANGER)]]), byPmid: new Map() };
    orgAnswer = holds(STRANGER.pmid);
    hooks.registerPro(stub);

    const [answer] = await have.checkHoldings([STRANGER.doi], { lookUpFree: true });

    // The first pass had nothing to ask; the second asks about the PMID
    // OpenAlex just supplied.
    expect(asked).toEqual([[STRANGER.pmid]]);
    expect(answer.held).toBe(false);
    expect(answer.orgChecked).toBe(true);
    expect(answer.org).toEqual({ pmid: STRANGER.pmid, node: "Acme Medical" });
  });

  it("still reports 'not asked' rather than 'no' when the master is down", async () => {
    oa.works = { byDoi: new Map([[STRANGER.doi, oaWork(STRANGER)]]), byPmid: new Map() };
    orgAnswer = async () => {
      throw new Error("fetch failed");
    };
    hooks.registerPro(stub);

    const [answer] = await have.checkHoldings([STRANGER.doi], { lookUpFree: true });
    expect(answer.orgChecked).toBe(false);
    expect(answer.org).toBeNull();
  });

  it("does not ask twice about a line the first pass already covered", async () => {
    // OWNED has an articles row here, so the first pass had its PMID and used
    // it. The second pass must not re-ask — the request is the expensive part.
    oa.works = { byDoi: new Map([[OWNED.doi, oaWork(OWNED)]]), byPmid: new Map() };
    orgAnswer = holds();
    hooks.registerPro(stub);

    await have.checkHoldings([OWNED.doi], { lookUpFree: true });
    expect(asked).toEqual([[OWNED.pmid]]);
  });
});
