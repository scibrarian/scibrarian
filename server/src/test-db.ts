import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A real SQLite database in a temp directory, for the tests that need one.
//
// Most server tests are pure-function tests, because that is where the
// decisions live. A few can't be: a bind-order bug returns nothing at all and a
// wrong join returns the wrong papers, and no type or schema catches either —
// only running the query does.
//
// db.ts opens its database at import time, so DB_PATH has to be set before the
// module is imported, which is why that import is dynamic and lives here. Each
// test file gets its own database: vitest isolates the module graph per file,
// so two files both setting DB_PATH don't collide.
export type Db = typeof import("./db.js");

let db: Db | undefined;
let tmpDir: string | undefined;

export async function openTempDb(name: string): Promise<Db> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `scibrarian-${name}-`));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  db = await import("./db.js");
  return db;
}

// Wire straight into afterAll. Safe to call when openTempDb threw part way —
// a schema or migration error is exactly the class of bug these tests exist to
// catch, and an unguarded teardown would report its own TypeError instead of
// the real failure and strand the directory on the way out.
//
// The close has to come first: Windows refuses to unlink a file that is still
// open, and the database is in WAL mode, so there are three of them.
export function closeTempDb(): void {
  db?.db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  db = undefined;
  tmpDir = undefined;
}
