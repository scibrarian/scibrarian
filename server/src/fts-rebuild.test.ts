import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A library whose body-text index was built before b65b25c, opened by the
// current code.
//
// FTS5 fixes a table's tokenizer when the table is created, and the schema's
// CREATE ... IF NOT EXISTS is a no-op against one that exists, so db.ts drops
// and rebuilds the index at startup when its stored definition names another
// tokenizer. Every other test database is created fresh with the current
// tokenizer, so nothing else runs that branch — yet it is the one every
// library indexed under porter goes through, once. It can go wrong silently in
// two directions: rebuilding on every start, or never. Both are pinned here,
// along with what the rebuild has to carry over — the text already indexed,
// and the pdf_text triggers, which name the index only in their bodies and so
// have to outlive the drop.

// The index as b65b25c^ created it.
const PORTER_FTS = `CREATE VIRTUAL TABLE pdf_text_fts USING fts5(
    text,
    content='pdf_text',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );`;

const TEXT = "Periportal hepatocytes showed marked steatosis.";
// Half of "hepatocytes". Porter stems the typed prefix to hepatoci* and the
// stored word to hepatocyt, so under the old index it finds nothing — the
// failure b65b25c was made to fix.
const HALF_TYPED = "hepatocy*";

type Db = typeof import("./db.js");
let dir: string;
let db: Db | undefined;
let porterHits: number;

// db.ts builds the schema and runs the rebuild in its module body, so opening
// the library again means importing it afresh against the same file. Returns
// the rebuilds it logged doing so.
async function open(): Promise<number> {
  db?.db.close();
  vi.resetModules();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    db = await import("./db.js");
    const rebuilt = log.mock.calls.filter((c) => String(c[0]).startsWith("[db] rebuilt pdf_text_fts"));
    return rebuilt.length;
  } finally {
    log.mockRestore();
  }
}

const hits = (q: string) =>
  (
    db!.db.prepare("SELECT COUNT(*) AS c FROM pdf_text_fts WHERE pdf_text_fts MATCH ?").get(q) as {
      c: number;
    }
  ).c;

const ftsDdl = () =>
  (db!.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pdf_text_fts'").get() as {
    sql: string;
  }).sql;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scibrarian-fts-rebuild-"));
  process.env.DB_PATH = path.join(dir, "test.db");
  process.env.BLOBS_DIR = path.join(dir, "blobs");

  // The current schema, with its index swapped for the porter one and filled
  // through the triggers: a library indexed before b65b25c, in one step.
  await open();
  db!.db.close();
  db = undefined;
  const old = new DatabaseSync(process.env.DB_PATH);
  old.exec("DROP TABLE pdf_text_fts");
  old.exec(PORTER_FTS);
  old
    .prepare("INSERT INTO pdf_text (content_hash, text, pages, chars) VALUES (?, ?, 1, ?)")
    .run("a".repeat(64), TEXT, TEXT.length);
  porterHits = (
    old.prepare("SELECT COUNT(*) AS c FROM pdf_text_fts WHERE pdf_text_fts MATCH ?").get(
      HALF_TYPED
    ) as { c: number }
  ).c;
  old.close();
});

afterAll(() => {
  db?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("opening a library indexed under porter", () => {
  // Without this the rest proves nothing: a fixture the old tokenizer never
  // failed on can't show the rebuild changed anything.
  it("starts from an index that misses a half-typed word", () => {
    expect(porterHits).toBe(0);
  });

  it("rebuilds the index with the current tokenizer, once", async () => {
    expect(await open()).toBe(1);
    const { FTS_TOKENIZE } = await import("./fts-query.js");
    expect(ftsDdl()).toContain(`tokenize='${FTS_TOKENIZE}'`);
  });

  it("re-reads the text it already held", () => {
    expect(hits(HALF_TYPED)).toBe(1);
  });

  it("keeps the pdf_text triggers feeding the new index", () => {
    const hash = "b".repeat(64);
    db!.savePdfText({
      contentHash: hash,
      text: "Glomerular filtration declined.",
      pages: 1,
      truncated: false,
    });
    expect(hits("glomerul*")).toBe(1);
    db!.db.prepare("DELETE FROM pdf_text WHERE content_hash = ?").run(hash);
    expect(hits("glomerul*")).toBe(0);
  });

  it("leaves the rebuilt index alone on the next start", async () => {
    expect(await open()).toBe(0);
    expect(hits(HALF_TYPED)).toBe(1);
  });
});
