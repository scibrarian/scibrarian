import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The cross-workspace holdings union: "you already own this — in your Acme
// workspace."
//
// Workspaces exist to keep one agency's material out of another's, and that
// isolation reopens the exact hole /have exists to close. Working in Bristol's
// workspace, the local check cannot see a paper the writer bought personally or
// acquired under Acme, so it answers "not held" and they buy it again — with
// their own money, being the one party in the chain with no budget.
//
// So these tests are almost all about the *absence* of an answer. A hit is easy
// and cheap to be right about; what costs money is a confident no, and there
// are three routes to one: a workspace that could not be read, a line whose
// PMID only OpenAlex knows, and a build that has no workspaces at all.

type Have = typeof import("./have.js");
type Elsewhere = typeof import("./elsewhere.js");

let db: Db;
let have: Have;
let elsewhere: Elsewhere;
let root: string;
// The other workspace's library, and a pristine copy of it. One test corrupts
// the first on purpose; the second is how the rest of the file gets it back.
let otherDb: string;
let otherDbBackup: string;

// Held only in the other workspace. The whole feature is about this row.
const THEIRS = { pmid: "40000001", hash: "a".repeat(64), doi: "10.1000/theirs" };
// Held here. Never needs the union at all.
const MINE = { pmid: "40000002", hash: "b".repeat(64), doi: "10.1000/mine" };
// Held in the other workspace and *entirely unknown here* — no articles row, no
// file. A bare DOI for this one is the case the first pass structurally cannot
// cover: there is no PMID to ask about until OpenAlex supplies one, and getting
// it wrong is precisely the re-buy this feature exists to prevent.
const STRANGER = { pmid: "40000003", hash: "c".repeat(64), doi: "10.1000/stranger" };

// OpenAlex, controllable and offline — the same stub shape have.test.ts uses.
const oa = vi.hoisted(() => ({
  works: { byDoi: new Map<string, unknown>(), byPmid: new Map<string, unknown>() },
}));

vi.mock("./openalex.js", () => ({
  lookupWorks: async () => oa.works,
}));

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

// Give a collection file a PMID, which is what makes it *held* — see heldFile
// in db.ts for why custody is that column and not the articles row.
function hold(collectionId: number, pmid: string): void {
  for (const f of db.listCollectionFiles(collectionId)) {
    if (f.pmid == null) db.setFileMatched(f.id, pmid, "pmid");
  }
}

/**
 * Build the other workspace's library, then move it out of the way.
 *
 * Written through the real schema and copied as a file, rather than hand-rolled
 * with a couple of CREATE TABLEs: the union reads another workspace's app.db,
 * and a stand-in schema would keep passing after the real one changed under it.
 *
 * The checkpoint is not optional. The database is in WAL mode, so recent
 * commits live in the -wal until one happens and a copy taken without it is a
 * database missing exactly the rows this test just wrote.
 */
function seedOtherWorkspace(): void {
  const theirs = db.createCollection("Acme papers").id;
  db.addCollectionFiles(theirs, [
    { hash: THEIRS.hash, name: "theirs.pdf" },
    { hash: STRANGER.hash, name: "stranger.pdf" },
  ]);
  for (const f of db.listCollectionFiles(theirs)) {
    if (f.content_hash === THEIRS.hash) db.setFileMatched(f.id, THEIRS.pmid, "pmid");
    if (f.content_hash === STRANGER.hash) db.setFileMatched(f.id, STRANGER.pmid, "pmid");
  }
  db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  fs.mkdirSync(path.dirname(otherDb), { recursive: true });
  fs.copyFileSync(process.env.DB_PATH!, otherDb);
  fs.copyFileSync(otherDb, otherDbBackup);

  // Now unmake it here, so these papers are held in the other workspace and
  // nowhere else — which is the situation the union is for.
  db.deleteCollection(theirs);
}

function writeRegistry(workspaces: { id: string; name: string }[], active: string): void {
  fs.writeFileSync(
    path.join(root, "workspaces.json"),
    JSON.stringify({
      active,
      workspaces: workspaces.map((w) => ({ ...w, created_at: "2026-01-01T00:00:00.000Z" })),
    })
  );
}

beforeAll(async () => {
  db = await openTempDb("elsewhere");
  have = await import("./have.js");
  elsewhere = await import("./elsewhere.js");

  root = path.dirname(process.env.DB_PATH!);
  otherDb = path.join(root, "workspaces", "other", "app.db");
  otherDbBackup = path.join(root, "other-workspace.db.pristine");

  db.upsertArticles([article(THEIRS), article(MINE)]);
  seedOtherWorkspace();

  // MINE is the only paper this workspace holds a file for. THEIRS has an
  // articles row here too — the realistic case, a feed turned it up — and that
  // is exactly why `held` must not be read off it.
  const mine = db.createCollection("Mine").id;
  db.addCollectionFiles(mine, [{ hash: MINE.hash, name: "mine.pdf" }]);
  hold(mine, MINE.pmid);

  // The active workspace's own directory is never read, so "active" naming a
  // directory that does not exist is fine and keeps the fixture to one database.
  writeRegistry(
    [
      { id: "active", name: "Bristol" },
      { id: "other", name: "Acme" },
    ],
    "active"
  );

  // Set last, so nothing above this line depends on the feature being on.
  process.env.SCIBRARIAN_WORKSPACES_ROOT = root;
});

afterAll(closeTempDb);

// Every test restores the fixture it might have moved: one damages the other
// workspace's database on purpose, and another rewrites the registry.
afterEach(() => {
  process.env.SCIBRARIAN_WORKSPACES_ROOT = root;
  fs.copyFileSync(otherDbBackup, otherDb);
  writeRegistry(
    [
      { id: "active", name: "Bristol" },
      { id: "other", name: "Acme" },
    ],
    "active"
  );
  oa.works.byDoi.clear();
  oa.works.byPmid.clear();
});

describe("heldElsewhere", () => {
  it("finds a paper held in another workspace, and names where", () => {
    const { holdings, checked } = elsewhere.heldElsewhere([THEIRS.pmid]);
    expect(checked).toBe(true);
    expect(holdings.get(THEIRS.pmid)).toEqual({
      workspace: "Acme",
      collection: "Acme papers",
    });
  });

  it("says nothing about a paper no other workspace holds", () => {
    const { holdings, checked } = elsewhere.heldElsewhere(["40009999"]);
    expect(checked).toBe(true);
    expect(holdings.size).toBe(0);
  });

  // Off-desktop this must be a quiet nothing, not an error: /have runs on every
  // hosted deployment and the union is simply not part of one.
  it("answers nothing at all when the build has no workspaces", () => {
    delete process.env.SCIBRARIAN_WORKSPACES_ROOT;
    const { holdings, checked } = elsewhere.heldElsewhere([THEIRS.pmid]);
    expect(holdings.size).toBe(0);
    expect(checked).toBe(false);
  });

  // The asymmetry the whole module is shaped around: a workspace that could not
  // be opened has said nothing, and rendering that silence as "you don't own
  // this" is what ends in the duplicate purchase.
  it("reports an unreadable workspace as uncertain, never as a no", () => {
    fs.writeFileSync(otherDb, "not a database");
    const { holdings, checked } = elsewhere.heldElsewhere([THEIRS.pmid]);
    expect(holdings.size).toBe(0);
    expect(checked).toBe(false);
  });

  // A workspace created and never opened has no database yet. That is a genuine
  // "holds nothing", not a failure, so it must not poison `checked`.
  it("treats a workspace with no database yet as an honest no", () => {
    writeRegistry(
      [
        { id: "active", name: "Bristol" },
        { id: "fresh", name: "Brand new" },
      ],
      "active"
    );
    const { holdings, checked } = elsewhere.heldElsewhere([THEIRS.pmid]);
    expect(holdings.size).toBe(0);
    expect(checked).toBe(true);
  });
});

describe("workspaceContents", () => {
  // What the delete confirmation says out loud. Files rather than articles,
  // because a stored PDF is the thing somebody paid for.
  it("counts what deleting a workspace would destroy", () => {
    expect(elsewhere.workspaceContents("other")).toEqual({ collections: 1, files: 2 });
  });

  // A measured zero, not an absent answer: a workspace created and never opened
  // holds nothing, and the dialog is right to read as the small thing it is.
  it("reports a workspace with no database yet as empty", () => {
    expect(elsewhere.workspaceContents("never-opened")).toEqual({ collections: 0, files: 0 });
  });

  // Absent, so the dialog claims nothing it cannot support and falls back to
  // what it can always say safely.
  it("answers null for a database it cannot read", () => {
    fs.writeFileSync(otherDb, "not a database");
    expect(elsewhere.workspaceContents("other")).toBeNull();
  });

  it("answers null off-desktop, where there is nothing to size", () => {
    delete process.env.SCIBRARIAN_WORKSPACES_ROOT;
    expect(elsewhere.workspaceContents("other")).toBeNull();
  });
});

describe("/have, with another workspace on the machine", () => {
  it("still answers held for a paper in this workspace, with no elsewhere line", async () => {
    const [answer] = await have.checkHoldings([MINE.pmid], { lookUpIdentifiers: false });
    expect(answer.held).toBe(true);
    expect(answer.elsewhere).toBeNull();
  });

  // The core case. `held` stays false — the file is in another database's blob
  // store and this session has no route to it — but the writer is told they
  // already own it, which is the answer that stops the purchase.
  it("tells a writer they already own a paper filed in another workspace", async () => {
    const [answer] = await have.checkHoldings([THEIRS.pmid], {
      lookUpIdentifiers: false,
      nameWorkspaces: true,
    });
    expect(answer.held).toBe(false);
    expect(answer.elsewhereChecked).toBe(true);
    expect(answer.elsewhere).toEqual({ workspace: "Acme", collection: "Acme papers" });
  });

  // /have is a public GET, so that the read-only viewers told to run the
  // pre-purchase check can run it. The verdict is what stops the purchase and
  // goes to all of them; the workspace names are the agencies this person works
  // for, which is what GET /workspaces is admin-gated to protect. Withheld by
  // default, so a caller that forgets to ask leaks nothing.
  it("withholds where it was found from a caller that is not the owner", async () => {
    const [answer] = await have.checkHoldings([THEIRS.pmid], { lookUpIdentifiers: false });
    expect(answer.held).toBe(false);
    expect(answer.elsewhereChecked).toBe(true);
    expect(answer.elsewhere).toEqual({ workspace: null, collection: null });
  });

  it("says so plainly when no other workspace has it", async () => {
    const [answer] = await have.checkHoldings(["40009999"], { lookUpIdentifiers: false });
    expect(answer.elsewhereChecked).toBe(true);
    expect(answer.elsewhere).toBeNull();
  });

  // The gap the second pass exists for, and the one that actually re-buys. A
  // pasted DOI for a paper *this* workspace has never seen carries no PMID
  // through the first pass, so the union was never asked about it; OpenAlex
  // supplies one, and without asking again the writer is told "not in your
  // library" about a PDF already on their own disk.
  it("asks again about a DOI only OpenAlex could give a PMID to", async () => {
    oa.works.byDoi.set(STRANGER.doi, {
      pmid: STRANGER.pmid,
      doi: STRANGER.doi,
      title: "Stranger",
      year: 2024,
    });

    const [answer] = await have.checkHoldings([STRANGER.doi], { nameWorkspaces: true });
    expect(answer.held).toBe(false);
    expect(answer.elsewhere).toEqual({ workspace: "Acme", collection: "Acme papers" });
  });

  // Purely additive, and this is the assertion that pins it: an elsewhere hit
  // suppresses nothing. An org hit skips the identifier lookup for its row; this
  // one does not, so the line is still enriched with whatever else can be said
  // about the paper.
  it("suppresses no other lookup on the rows it answers", async () => {
    oa.works.byPmid.set(THEIRS.pmid, {
      pmid: THEIRS.pmid,
      doi: THEIRS.doi,
      title: "Theirs",
      year: 2024,
    });

    const [answer] = await have.checkHoldings([THEIRS.pmid], { nameWorkspaces: true });
    expect(answer.elsewhere).toEqual({ workspace: "Acme", collection: "Acme papers" });
    expect(answer.identifierChecked).toBe(true);
  });
});
