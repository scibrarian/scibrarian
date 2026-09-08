import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeWorkspace,
  checkWorkspaceName,
  createWorkspace,
  deleteWorkspace,
  ensureActiveWorkspace,
  listWorkspaces,
  onRestartRequested,
  otherWorkspaces,
  renameWorkspace,
  requestRestart,
  setActiveWorkspace,
  workspaceBlobsDir,
  workspaceDbPath,
  workspaceDir,
  workspacesEnabled,
} from "./workspaces.js";

// The workspace registry: the file that decides which library the app opens.
//
// Worth real tests despite being a hundred lines of JSON handling, because two
// of its failure modes are silent and expensive. A first run that does not
// adopt the existing app.db leaves a person's entire library at a path nothing
// will open again — it is still on disk, and it may as well not be. And a
// registry that reads as absent when it is merely damaged would rebuild over
// the top of one, which is the same loss by a different route.
//
// No database is opened here. workspaces.ts deliberately imports nothing from
// config.ts or db.ts (main.mjs reads it before either exists), and these tests
// are the check that this stays true: they would fail to run at all if it
// acquired one, because DB_PATH is not set.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scibrarian-workspaces-"));
  process.env.SCIBRARIAN_WORKSPACES_ROOT = root;
});

afterEach(() => {
  delete process.env.SCIBRARIAN_WORKSPACES_ROOT;
  onRestartRequested(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

const registry = () => path.join(root, "workspaces.json");

describe("a build with no workspaces", () => {
  beforeEach(() => {
    delete process.env.SCIBRARIAN_WORKSPACES_ROOT;
  });

  // Every hosted deployment is this case. The routes and the union both key off
  // these answers, so "off" has to be the empty answer rather than a throw.
  it("reports off, and answers empty rather than failing", () => {
    expect(workspacesEnabled()).toBe(false);
    expect(listWorkspaces()).toEqual([]);
    expect(activeWorkspace()).toBeNull();
    expect(otherWorkspaces()).toEqual([]);
  });

  it("refuses to invent one for an embedder that asks", () => {
    expect(() => ensureActiveWorkspace()).toThrow(/desktop-only/);
  });
});

describe("first run", () => {
  it("creates one workspace and points the registry at it", () => {
    const ws = ensureActiveWorkspace();
    expect(listWorkspaces()).toEqual([ws]);
    expect(activeWorkspace()).toEqual(ws);
    expect(fs.existsSync(registry())).toBe(true);
    // The directory exists before anything opens a database in it, so blobstore
    // and db.ts both find a place to write on the very first launch.
    expect(fs.existsSync(workspaceBlobsDir(ws.id))).toBe(true);
  });

  it("is idempotent: a second call returns the same workspace", () => {
    const first = ensureActiveWorkspace();
    expect(ensureActiveWorkspace()).toEqual(first);
    expect(listWorkspaces()).toHaveLength(1);
  });

  // The one that matters. Every desktop copy predating this feature keeps its
  // library at <root>/app.db, and starting a fresh empty workspace beside it
  // would leave someone's papers stranded at a path nothing opens again.
  it("adopts a library from before workspaces existed", () => {
    fs.writeFileSync(path.join(root, "app.db"), "pretend-sqlite");
    fs.writeFileSync(path.join(root, "app.db-wal"), "pretend-wal");
    fs.mkdirSync(path.join(root, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(root, "blobs", "abc.pdf"), "pretend-pdf");

    const ws = ensureActiveWorkspace();

    expect(fs.readFileSync(workspaceDbPath(ws.id), "utf8")).toBe("pretend-sqlite");
    // The write-ahead log travels with the database it belongs to. Left behind,
    // a workspace opens having lost whatever had not been checkpointed — which
    // on a library closed by a window close is the last session's work.
    expect(fs.readFileSync(`${workspaceDbPath(ws.id)}-wal`, "utf8")).toBe("pretend-wal");
    expect(fs.readFileSync(path.join(workspaceBlobsDir(ws.id), "abc.pdf"), "utf8")).toBe(
      "pretend-pdf"
    );
    // Moved, not copied: a second copy of a 46 MB database is one that drifts.
    expect(fs.existsSync(path.join(root, "app.db"))).toBe(false);
    expect(fs.existsSync(path.join(root, "blobs", "abc.pdf"))).toBe(false);
  });

  // The move used to happen before the registry was written, so an EPERM on the
  // second file — a scanner holding the -wal open, an indexer on the blobs
  // directory — left the database moved, nothing pointing at it, and the next
  // launch minting a fresh workspace beside a library it could no longer see.
  it("finishes an adoption that was interrupted part way", () => {
    fs.writeFileSync(path.join(root, "app.db"), "pretend-sqlite");
    const ws = ensureActiveWorkspace();
    // What an interrupted move leaves: the database across, the rest at the root.
    fs.mkdirSync(path.join(root, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(root, "blobs", "abc.pdf"), "pretend-pdf");

    expect(ensureActiveWorkspace().id).toBe(ws.id);
    expect(fs.readFileSync(path.join(workspaceBlobsDir(ws.id), "abc.pdf"), "utf8")).toBe(
      "pretend-pdf"
    );
    expect(fs.existsSync(path.join(root, "blobs"))).toBe(false);
  });

  // Which means the destination is no longer the empty directory first-run had
  // just made. Replacing it wholesale, which is what clearing the way used to
  // do, would take every PDF the interrupted attempt had already moved.
  it("merges into a blob store that already has files in it", () => {
    const ws = ensureActiveWorkspace();
    fs.writeFileSync(path.join(workspaceBlobsDir(ws.id), "already.pdf"), "already");
    fs.mkdirSync(path.join(root, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(root, "blobs", "arriving.pdf"), "arriving");

    ensureActiveWorkspace();
    expect(fs.readdirSync(workspaceBlobsDir(ws.id)).sort()).toEqual([
      "already.pdf",
      "arriving.pdf",
    ]);
    expect(fs.existsSync(path.join(root, "blobs"))).toBe(false);
  });
});

describe("naming", () => {
  beforeEach(() => {
    ensureActiveWorkspace();
    createWorkspace("Acme Medical");
  });

  it("refuses a blank name", () => {
    expect(checkWorkspaceName("   ")).toMatch(/needs a name/);
  });

  it("refuses a name past the shared display cap", () => {
    expect(checkWorkspaceName("x".repeat(31))).toMatch(/at most/);
  });

  // Two rows reading "Acme" in the picker are a coin flip over which agency's
  // library you are about to open — the same reason collections refuse it.
  it("refuses a duplicate, whatever its case", () => {
    expect(checkWorkspaceName("acme medical")).toMatch(/already a workspace/);
  });

  it("lets a workspace keep its own name while being renamed", () => {
    const acme = listWorkspaces().find((w) => w.name === "Acme Medical")!;
    expect(checkWorkspaceName("ACME Medical", acme.id)).toBeNull();
  });
});

describe("switching", () => {
  it("changes which workspace the next launch opens", () => {
    const first = ensureActiveWorkspace();
    const second = createWorkspace("Bristol");

    expect(otherWorkspaces()).toEqual([second]);
    expect(setActiveWorkspace(second.id)).toBe(true);
    expect(activeWorkspace()).toEqual(second);
    expect(otherWorkspaces()).toEqual([first]);
  });

  // A stale client naming a workspace that is gone must not leave `active`
  // pointing at nothing — the next launch would have no library to open.
  it("refuses an id the registry doesn't know", () => {
    const first = ensureActiveWorkspace();
    expect(setActiveWorkspace("not-a-workspace")).toBe(false);
    expect(activeWorkspace()).toEqual(first);
  });

  it("renames without disturbing which one is active", () => {
    const first = ensureActiveWorkspace();
    const second = createWorkspace("Bristol");
    setActiveWorkspace(second.id);

    expect(renameWorkspace(first.id, "Personal")?.name).toBe("Personal");
    expect(activeWorkspace()?.id).toBe(second.id);
    expect(listWorkspaces().map((w) => w.name)).toEqual(["Personal", "Bristol"]);
  });

  it("reports a rename of an id it doesn't have", () => {
    ensureActiveWorkspace();
    expect(renameWorkspace("not-a-workspace", "Nope")).toBeNull();
  });
});

describe("deleting", () => {
  it("removes the workspace and its whole directory", () => {
    // By id, not by name: what the first workspace is called is a product
    // decision that can change, and it is not what this test is about.
    const mine = ensureActiveWorkspace();
    const acme = createWorkspace("Acme");
    fs.writeFileSync(workspaceDbPath(acme.id), "pretend-sqlite");

    expect(deleteWorkspace(acme.id)).toBe("ok");
    expect(listWorkspaces().map((w) => w.id)).toEqual([mine.id]);
    expect(fs.existsSync(workspaceDir(acme.id))).toBe(false);
  });

  // Not a policy but a fact: its database is open in this process, Windows will
  // not unlink a file that is, and there would be nothing left for the window to
  // be looking at.
  it("refuses the workspace the app is running in", () => {
    const mine = ensureActiveWorkspace();
    createWorkspace("Acme");

    expect(deleteWorkspace(mine.id)).toBe("active");
    expect(listWorkspaces()).toHaveLength(2);
    expect(fs.existsSync(workspaceDir(mine.id))).toBe(true);
  });

  // Which is also what guarantees a workspace always survives: the last one
  // standing is necessarily the active one, and the active one is refused.
  it("cannot empty the list", () => {
    const only = ensureActiveWorkspace();
    expect(deleteWorkspace(only.id)).toBe("active");
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("reports an id it doesn't have", () => {
    ensureActiveWorkspace();
    expect(deleteWorkspace("not-a-workspace")).toBe("unknown");
  });

  // The registry entry goes first, so a removal that fails part way leaves an
  // orphaned directory — invisible, costs disk — rather than a registry row
  // pointing at a gutted library, which the picker offers and the union reads.
  it("does not resurrect a workspace whose directory was already gone", () => {
    ensureActiveWorkspace();
    const acme = createWorkspace("Acme");
    fs.rmSync(workspaceDir(acme.id), { recursive: true, force: true });

    expect(deleteWorkspace(acme.id)).toBe("ok");
    expect(listWorkspaces()).toHaveLength(1);
  });
});

describe("a damaged registry", () => {
  // Rebuilt rather than thrown on, because throwing here is an app that cannot
  // start and a user with no way to fix it. Nothing is lost: the libraries are
  // directories named by id, and a rebuilt registry finds them again.
  it("is rebuilt from the libraries on disk", () => {
    const first = ensureActiveWorkspace();
    const acme = createWorkspace("Acme Medical");
    fs.writeFileSync(workspaceDbPath(acme.id), "acme-sqlite");
    fs.writeFileSync(registry(), "{ not json");

    const rebuilt = ensureActiveWorkspace();

    // Both of them, by id. A fresh workspace minted over the top would leave
    // these two on disk with nothing left to name them — a person's whole
    // library gone, by a route that looks from the outside like a working app.
    expect(listWorkspaces().map((w) => w.id).sort()).toEqual([first.id, acme.id].sort());
    expect([first.id, acme.id]).toContain(rebuilt.id);
    expect(fs.readFileSync(workspaceDbPath(acme.id), "utf8")).toBe("acme-sqlite");
  });

  // Not damage at all, and the reason the fallback had to change: a read that
  // failed once. A registry that is simply gone reached the same path, and the
  // same fresh workspace was minted beside libraries nothing then named.
  it("re-adopts when the registry is gone rather than damaged", () => {
    const first = ensureActiveWorkspace();
    const acme = createWorkspace("Acme Medical");
    fs.rmSync(registry());

    ensureActiveWorkspace();
    expect(listWorkspaces().map((w) => w.id).sort()).toEqual([first.id, acme.id].sort());
  });

  // The names lived in the registry and nowhere else, so a rebuild cannot give
  // them back. Numbered in the order the picker will draw them, and renamed by
  // a person afterwards: the whole cost of a recovery that keeps every library.
  it("names the libraries it recovers", () => {
    ensureActiveWorkspace();
    createWorkspace("Acme Medical");
    fs.writeFileSync(registry(), "{ not json");

    ensureActiveWorkspace();
    expect(listWorkspaces().map((w) => w.name)).toEqual([
      "Recovered workspace 1",
      "Recovered workspace 2",
    ]);
  });

  // An id out of the registry is joined into a path five times over and handed
  // to a recursive remove, and deleteWorkspace's membership check is no defence
  // — a hand-edited id really is in the list.
  it("drops an entry whose id is not a directory name", () => {
    const mine = ensureActiveWorkspace();
    const raw = JSON.parse(fs.readFileSync(registry(), "utf8"));
    fs.writeFileSync(
      registry(),
      JSON.stringify({
        ...raw,
        workspaces: [...raw.workspaces, { id: "../..", name: "Escape", created_at: "" }],
      })
    );

    expect(listWorkspaces().map((w) => w.id)).toEqual([mine.id]);
    expect(deleteWorkspace("../..")).toBe("unknown");
    expect(fs.existsSync(root)).toBe(true);
  });

  // An `active` naming nothing is one interrupted write or one hand-edit away.
  // Repaired to the first workspace, which is a better answer than refusing.
  it("repairs an active id that names nothing", () => {
    const first = ensureActiveWorkspace();
    const second = createWorkspace("Bristol");
    const raw = JSON.parse(fs.readFileSync(registry(), "utf8"));
    fs.writeFileSync(registry(), JSON.stringify({ ...raw, active: "gone" }));

    expect(activeWorkspace()?.id).toBe(first.id);
    expect(listWorkspaces()).toHaveLength(2);
    expect(otherWorkspaces()).toEqual([second]);
  });
});

describe("the restart seam", () => {
  // The switch route answers `restarting` from this, so "nobody is listening"
  // has to be distinguishable rather than a silently dropped call.
  it("reports that nothing can restart when no embedder registered", () => {
    expect(requestRestart()).toBe(false);
  });

  it("calls the embedder's handler once asked", () => {
    let called = 0;
    onRestartRequested(() => {
      called++;
    });
    expect(requestRestart()).toBe(true);
    expect(called).toBe(1);
  });
});
