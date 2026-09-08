import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import type {
  Workspace,
  WorkspaceContentsResponse,
  WorkspacesResponse,
} from "../../shared/types.js";

// The /api/workspaces handlers, rather than the registry underneath them.
//
// workspaces.test.ts pins what the registry does. What is untested below that is
// everything the *handlers* decide, and each of these three failed silently:
// a body whose `name` is not a string, a delete whose files could not be
// removed after the registry already said they were gone, and a list that did a
// database's worth of work for a number nobody on that path reads.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — the same note as
// reset-route.test.ts. Every route here is admin-gated.
process.env.ADMIN_TOKEN = "workspace-routes-token";
const HEADERS = { "x-admin-token": "workspace-routes-token", "content-type": "application/json" };

let db: Db;
let server: Server;
let base: string;
let root: string;
// The other workspace's database, and a pristine copy. One test corrupts the
// first on purpose; beforeEach is how the rest of the file gets it back.
let otherDb: string;
let otherDbBackup: string;

const ACTIVE = "active-ws";
const OTHER = "other-ws";

function writeRegistry(workspaces: { id: string; name: string }[]): void {
  fs.writeFileSync(
    path.join(root, "workspaces.json"),
    JSON.stringify({
      active: ACTIVE,
      workspaces: workspaces.map((w) => ({ ...w, created_at: "2026-01-01T00:00:00.000Z" })),
    })
  );
}

const list = async (): Promise<WorkspacesResponse> => {
  const res = await fetch(`${base}/api/workspaces`, { headers: HEADERS });
  return (await res.json()) as WorkspacesResponse;
};

beforeAll(async () => {
  db = await openTempDb("workspace-routes");
  const { app } = await import("./index.js");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  root = path.dirname(process.env.DB_PATH!);
  otherDb = path.join(root, "workspaces", OTHER, "app.db");
  otherDbBackup = path.join(root, "other-workspace.db.pristine");
  // The other workspace gets a real database, copied from this one, so the
  // contents route has something true to count. The checkpoint is not optional:
  // in WAL mode the collection just written lives in the -wal until one happens,
  // and a copy taken without it is a database missing exactly that row.
  fs.mkdirSync(path.dirname(otherDb), { recursive: true });
  db.createCollection("Acme papers");
  db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(process.env.DB_PATH!, otherDb);
  fs.copyFileSync(otherDb, otherDbBackup);

  // Set last, so nothing above depends on the feature being on. Both, because
  // either alone leaves it off — see workspacesEnabled.
  process.env.SCIBRARIAN_WORKSPACES_ROOT = root;
  process.env.SCIBRARIAN_DESKTOP = "1";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  delete process.env.SCIBRARIAN_WORKSPACES_ROOT;
  delete process.env.SCIBRARIAN_DESKTOP;
  closeTempDb();
});

beforeEach(() => {
  process.env.SCIBRARIAN_WORKSPACES_ROOT = root;
  process.env.SCIBRARIAN_DESKTOP = "1";
  fs.mkdirSync(path.dirname(otherDb), { recursive: true });
  fs.copyFileSync(otherDbBackup, otherDb);
  writeRegistry([
    { id: ACTIVE, name: "Bristol" },
    { id: OTHER, name: "Acme" },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("naming a workspace over HTTP", () => {
  // String({}) is "[object Object]" — fifteen characters, not blank, and no
  // clash — so every validation downstream passed it and the picker grew a row
  // called that.
  it("refuses a name that is not a string", async () => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: {} }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs a name/);
    expect((await list()).workspaces.map((w) => w.name)).toEqual(["Bristol", "Acme"]);
  });

  it("refuses one on a rename too", async () => {
    const res = await fetch(`${base}/api/workspaces/${OTHER}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ name: 42 }),
    });

    expect(res.status).toBe(400);
    expect((await list()).workspaces.find((w) => w.id === OTHER)?.name).toBe("Acme");
  });
});

describe("what the list costs", () => {
  // The counts used to ride on every row of this body — which answers the GET
  // as well as create, rename and delete — at one database opened and two table
  // scans per inactive workspace, for a pair of numbers one dialog reads.
  it("carries no per-workspace counts", async () => {
    const [row] = (await list()).workspaces;
    expect(Object.keys(row).sort()).toEqual(["active", "created_at", "id", "name"]);
  });

  it("counts one workspace on demand instead", async () => {
    const res = await fetch(`${base}/api/workspaces/${OTHER}/contents`, { headers: HEADERS });
    const body = (await res.json()) as WorkspaceContentsResponse;

    expect(res.status).toBe(200);
    expect(body.contents).toEqual({ collections: 1, files: 0 });
  });

  // Null rather than a 404 or a zeroed pair: the workspace is real and still
  // deletable, and "could not be read" is a different answer from "empty" all
  // the way to the wording of the dialog.
  it("answers null for a workspace whose database will not open", async () => {
    fs.writeFileSync(path.join(root, "workspaces", OTHER, "app.db"), "not a database");

    const res = await fetch(`${base}/api/workspaces/${OTHER}/contents`, { headers: HEADERS });
    const body = (await res.json()) as WorkspaceContentsResponse;

    expect(res.status).toBe(200);
    expect(body.contents).toBeNull();
  });

  it("404s for an id the registry doesn't have", async () => {
    const res = await fetch(`${base}/api/workspaces/nope/contents`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});

describe("deleting over HTTP", () => {
  // The registry is written before the files on purpose, so a removal that
  // fails part way leaves an orphaned directory rather than a row pointing at a
  // gutted library. That ordering only pays off if the failure is reported as
  // the success it is: Windows raises EBUSY here for a PDF open in a viewer,
  // and a 500 left the picker redrawing a row the registry no longer had, under
  // a message saying the delete had not happened.
  it("succeeds when the directory cannot be removed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    const res = await fetch(`${base}/api/workspaces/${OTHER}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    const body = (await res.json()) as { workspaces: Workspace[] };

    expect(res.status).toBe(200);
    expect(body.workspaces.map((w) => w.id)).toEqual([ACTIVE]);
    expect(console.warn).toHaveBeenCalled();
  });
});
