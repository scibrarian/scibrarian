import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deleteBlobs } from "./blobstore.js";
import { DB_PATH, SETTING_DEFAULTS } from "./config.js";
import type {
  Article,
  Collection,
  CollectionFile,
  Disease,
  Journal,
  JournalRemovalResult,
  Paper,
  Settings,
} from "./types.js";

// Ensure the data directory exists before opening the database.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
// node:sqlite enables foreign_keys by default, but the schema relies on its
// ON DELETE CASCADEs, so keep it explicit.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Run fn atomically: COMMIT on return, ROLLBACK on throw. Not reentrant —
// a wrapped function must not call another wrapped function.
export function transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS diseases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    term TEXT NOT NULL,
    last_polled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    nlm_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS articles (
    pmid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    journal_name TEXT NOT NULL DEFAULT '',
    nlm_id TEXT,
    authors TEXT NOT NULL DEFAULT '[]',
    pub_date TEXT NOT NULL DEFAULT '',
    pub_date_display TEXT NOT NULL DEFAULT '',
    doi TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS article_diseases (
    pmid TEXT NOT NULL,
    disease_id INTEGER NOT NULL,
    PRIMARY KEY (pmid, disease_id),
    FOREIGN KEY (pmid) REFERENCES articles(pmid) ON DELETE CASCADE,
    FOREIGN KEY (disease_id) REFERENCES diseases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_citations (
    pmid TEXT PRIMARY KEY,
    citation_count INTEGER NOT NULL DEFAULT 0,
    references_json TEXT NOT NULL DEFAULT '[]', -- PMIDs this paper cites
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Reference list of journals (from NLM's J_Medline.txt) for autocomplete and
  -- validation. metric = OpenAlex 2yr mean citedness, fetched + cached lazily.
  CREATE TABLE IF NOT EXISTS journal_catalog (
    nlm_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    med_abbr TEXT NOT NULL DEFAULT '',
    iso_abbr TEXT NOT NULL DEFAULT '',
    issn_print TEXT NOT NULL DEFAULT '',
    issn_online TEXT NOT NULL DEFAULT '',
    metric REAL,
    metric_fetched_at TEXT
  );

  -- User-created collections of uploaded PDFs. Matched files soft-reference
  -- articles.pmid (no FK, following the paper_citations precedent);
  -- removeJournalWithArticles preserves any article a collection file points to.
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Each row is one uploaded copy in one collection; the bytes live in the
  -- blob store under content_hash (see blobstore.ts). The same content in two
  -- collections is two rows sharing one blob.
  CREATE TABLE IF NOT EXISTS collection_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL,       -- sha256 hex, key into the blob store
    file_name TEXT NOT NULL,
    pmid TEXT,                        -- soft ref to articles.pmid
    match_status TEXT NOT NULL DEFAULT 'pending',  -- pending|matched|unmatched|error
    match_method TEXT NOT NULL DEFAULT '',          -- pmid|doi|manual|''
    match_error TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (collection_id, content_hash),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_collection_files_collection ON collection_files(collection_id);
  CREATE INDEX IF NOT EXISTS idx_collection_files_pmid ON collection_files(pmid);
  CREATE INDEX IF NOT EXISTS idx_collection_files_hash ON collection_files(content_hash);
  CREATE INDEX IF NOT EXISTS idx_article_diseases_disease ON article_diseases(disease_id);
  CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_title ON journal_catalog(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_abbr ON journal_catalog(med_abbr COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_articles_nlm_id ON articles(nlm_id);
  CREATE INDEX IF NOT EXISTS idx_journals_nlm_id ON journals(nlm_id);
`);

// ---------- settings ----------

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

export function getSetting(key: keyof Settings): string {
  const row = getSettingStmt.get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

export function setSetting(key: keyof Settings, value: string): void {
  setSettingStmt.run(key, value);
}

// Derived from the defaults' key set so a newly added setting can't be
// persisted but read back as "" because this list wasn't updated.
export function getSettings(): Settings {
  const out = {} as Settings;
  for (const key of Object.keys(SETTING_DEFAULTS) as (keyof Settings)[]) {
    out[key] = getSetting(key);
  }
  return out;
}

// Seed editable settings with their defaults only if not already present.
for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
  if (getSettingStmt.get(key) === undefined) {
    setSettingStmt.run(key, value);
  }
}

// ---------- first-run example data ----------

// Names are NLM abbreviations (e.g. the full title PubMed registers for the
// first is "The New England journal of medicine"). The nlm_id must be present:
// journal removal matches articles by it, so a journal without one can never
// clean up its papers.
const SEED_JOURNALS: ReadonlyArray<[name: string, nlmId: string]> = [
  ["N Engl J Med", "0255562"],
  ["Lancet", "2985213R"],
  ["JAMA", "7501160"],
  ["Nat Med", "9502015"],
];

const seedFlag = getSettingStmt.get("seeded") as { value: string } | undefined;
if (!seedFlag) {
  const journalCount = (db.prepare("SELECT COUNT(*) AS c FROM journals").get() as { c: number }).c;
  const diseaseCount = (db.prepare("SELECT COUNT(*) AS c FROM diseases").get() as { c: number }).c;
  if (journalCount === 0 && diseaseCount === 0) {
    const insJ = db.prepare("INSERT OR IGNORE INTO journals (name, nlm_id) VALUES (?, ?)");
    for (const [name, nlmId] of SEED_JOURNALS) {
      insJ.run(name, nlmId);
    }
    db.prepare("INSERT INTO diseases (name, term) VALUES (?, ?)").run(
      "Type 2 Diabetes",
      '"diabetes mellitus, type 2"[MeSH]'
    );
  }
  setSettingStmt.run("seeded", "1");
}

// ---------- diseases ----------

export function listDiseases(): Disease[] {
  return db
    .prepare("SELECT id, name, term, last_polled_at, created_at FROM diseases ORDER BY id ASC")
    .all() as unknown as Disease[];
}

export function getDisease(id: number): Disease | undefined {
  return db
    .prepare("SELECT id, name, term, last_polled_at, created_at FROM diseases WHERE id = ?")
    .get(id) as Disease | undefined;
}

export function createDisease(name: string, term: string): Disease {
  const info = db.prepare("INSERT INTO diseases (name, term) VALUES (?, ?)").run(name, term);
  return getDisease(Number(info.lastInsertRowid))!;
}

export function deleteDisease(id: number): void {
  db.prepare("DELETE FROM diseases WHERE id = ?").run(id);
}

export function setDiseaseLastPolled(id: number, iso: string): void {
  db.prepare("UPDATE diseases SET last_polled_at = ? WHERE id = ?").run(iso, id);
}

// ---------- journals ----------

export function listJournals(): Journal[] {
  return db
    .prepare("SELECT id, name, created_at FROM journals ORDER BY name ASC")
    .all() as unknown as Journal[];
}

export function createJournal(name: string, nlmId: string | null): Journal {
  const info = db.prepare("INSERT INTO journals (name, nlm_id) VALUES (?, ?)").run(name, nlmId);
  return db
    .prepare("SELECT id, name, created_at FROM journals WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as Journal;
}

// Used to reject adding the same journal twice (identity is the NLM id).
export function journalByNlmId(nlmId: string): Journal | undefined {
  return db
    .prepare("SELECT id, name, created_at FROM journals WHERE nlm_id = ?")
    .get(nlmId) as Journal | undefined;
}

// How many stored articles a journal removal would permanently delete (for the
// confirmation). Articles referenced by a collection file are kept, so they
// are excluded from the count.
export function countJournalArticles(id: number): number {
  const j = db.prepare("SELECT nlm_id FROM journals WHERE id = ?").get(id) as
    | { nlm_id: string | null }
    | undefined;
  if (!j || !j.nlm_id) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM articles
         WHERE nlm_id = ?
           AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)`
      )
      .get(j.nlm_id) as { c: number }
  ).c;
}

// Remove a journal (matched by NLM id): its articles leave every disease feed,
// but articles referenced by a collection file survive so the user's library is
// untouched. Unreferenced articles are permanently deleted (article_diseases
// rows cascade via the foreign key).
export const removeJournalWithArticles = transaction((id: number): JournalRemovalResult => {
  const j = db.prepare("SELECT nlm_id FROM journals WHERE id = ?").get(id) as
    | { nlm_id: string | null }
    | undefined;
  let deletedArticles = 0;
  let removedFromInterests = 0;
  if (j && j.nlm_id) {
    removedFromInterests = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT pmid) AS c FROM article_diseases
           WHERE pmid IN (SELECT pmid FROM articles WHERE nlm_id = ?)`
        )
        .get(j.nlm_id) as { c: number }
    ).c;
    db.prepare(
      "DELETE FROM article_diseases WHERE pmid IN (SELECT pmid FROM articles WHERE nlm_id = ?)"
    ).run(j.nlm_id);
    deletedArticles = Number(
      db
        .prepare(
          `DELETE FROM articles
           WHERE nlm_id = ?
             AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)`
        )
        .run(j.nlm_id).changes
    );
  }
  db.prepare("DELETE FROM journals WHERE id = ?").run(id);
  return { deletedArticles, removedFromInterests };
});

// ---------- articles ----------

// Run an IN (...) query over the PMIDs, chunked to stay well under SQLite's
// bound-parameter limit (an all-time search can hand us thousands of PMIDs in
// a single call). `sql` receives the placeholder list for each chunk; `extra`
// params are appended after the chunk's PMIDs.
function queryByPmids<T>(
  pmids: string[],
  sql: (placeholders: string) => string,
  extra: (string | number)[] = []
): T[] {
  const out: T[] = [];
  for (let i = 0; i < pmids.length; i += 900) {
    const batch = pmids.slice(i, i + 900);
    const placeholders = batch.map(() => "?").join(",");
    out.push(...(db.prepare(sql(placeholders)).all(...batch, ...extra) as T[]));
  }
  return out;
}

export function existingPmids(pmids: string[]): Set<string> {
  const rows = queryByPmids<{ pmid: string }>(
    pmids,
    (ph) => `SELECT pmid FROM articles WHERE pmid IN (${ph})`
  );
  return new Set(rows.map((r) => r.pmid));
}

// The papers list omits abstracts (they dominate its size); the card view
// fetches one on demand by pmid. Returns null for an unknown pmid.
export function getArticleAbstract(pmid: string): string | null {
  const row = db.prepare("SELECT abstract FROM articles WHERE pmid = ?").get(pmid) as
    | { abstract: string }
    | undefined;
  return row?.abstract ?? null;
}

const upsertArticleStmt = db.prepare(`
  INSERT INTO articles (pmid, title, abstract, journal_name, nlm_id, authors, pub_date, pub_date_display, doi, url)
  VALUES (@pmid, @title, @abstract, @journal_name, @nlm_id, @authors, @pub_date, @pub_date_display, @doi, @url)
  ON CONFLICT(pmid) DO UPDATE SET
    title = excluded.title,
    abstract = excluded.abstract,
    journal_name = excluded.journal_name,
    nlm_id = excluded.nlm_id,
    authors = excluded.authors,
    pub_date = excluded.pub_date,
    pub_date_display = excluded.pub_date_display,
    doi = excluded.doi,
    url = excluded.url
`);

const linkArticleStmt = db.prepare(
  "INSERT OR IGNORE INTO article_diseases (pmid, disease_id) VALUES (?, ?)"
);

export type ArticleInsert = Omit<Article, "authors" | "first_seen_at"> & { authors: string[] };

// Insert/refresh a batch of articles and link them to a disease, atomically.
export const saveArticles = transaction((articles: ArticleInsert[], diseaseId: number) => {
  for (const a of articles) {
    upsertArticleStmt.run({
      pmid: a.pmid,
      title: a.title,
      abstract: a.abstract,
      journal_name: a.journal_name,
      nlm_id: a.nlm_id || null,
      authors: JSON.stringify(a.authors),
      pub_date: a.pub_date,
      pub_date_display: a.pub_date_display,
      doi: a.doi,
      url: a.url,
    });
    linkArticleStmt.run(a.pmid, diseaseId);
  }
});

// The journal name shown to the user: the watched journal's abbreviation (or the
// catalog abbreviation), resolved by NLM id, falling back to the stored title.
const JOURNAL_DISPLAY = "COALESCE(j.name, jc.med_abbr, a.journal_name)";
const ARTICLE_JOINS = `JOIN article_diseases ad ON ad.pmid = a.pmid
       LEFT JOIN journals j ON j.nlm_id = a.nlm_id
       LEFT JOIN journal_catalog jc ON jc.nlm_id = a.nlm_id`;

export function diseaseArticleCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT disease_id, COUNT(*) AS c FROM article_diseases GROUP BY disease_id")
    .all() as { disease_id: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.disease_id] = r.c;
  return out;
}

// Distinct journal display names that have articles for a disease (filter chips).
export function journalsForDisease(diseaseId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT ${JOURNAL_DISPLAY} AS j FROM articles a
       ${ARTICLE_JOINS}
       WHERE ad.disease_id = ? AND ${JOURNAL_DISPLAY} <> ''
       ORDER BY j ASC`
    )
    .all(diseaseId) as { j: string }[];
  return rows.map((r) => r.j);
}

// Which paper set /api/papers reads: a topic's articles or a collection's
// matched uploads. Mirrors the client's PaperSource.
export type PaperSourceQuery = { diseaseId: number } | { collectionId: number };

// Escape LIKE wildcards so a literal % or _ in a user query (e.g. "100%",
// "COVID_19") matches itself instead of acting as a wildcard. Callers wrap the
// result in their own %/_ and must pair each LIKE with ESCAPE '\'. The
// backslash itself is escaped first so it can serve as the escape character.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The unified rows behind the table and timeline views, for either source:
// article metadata, cached citation count, and — for collections — the first
// matched uploaded file per pmid (the copy a title click opens; same rule as
// the old per-client fileByPmid). content_hash is returned so the route can
// check the blob still exists; it is stripped before the response.
export function listPapers(
  source: PaperSourceQuery,
  q?: string
): Array<Omit<Paper, "file_exists"> & { content_hash: string | null }> {
  const fromDisease = "diseaseId" in source;
  const params: (string | number)[] = fromDisease
    ? [source.diseaseId]
    : [source.collectionId, source.collectionId];
  // A collection row exists for every distinct matched pmid (pmid IS NOT NULL),
  // and links the lowest-id 'matched' file for it, if any.
  const membership = fromDisease
    ? "JOIN article_diseases ad ON ad.pmid = a.pmid AND ad.disease_id = ?"
    : `JOIN (SELECT DISTINCT pmid FROM collection_files
             WHERE collection_id = ? AND pmid IS NOT NULL) cp ON cp.pmid = a.pmid
       LEFT JOIN (SELECT pmid, MIN(id) AS file_id FROM collection_files
                  WHERE collection_id = ? AND match_status = 'matched'
                  GROUP BY pmid) mf ON mf.pmid = a.pmid
       LEFT JOIN collection_files cf ON cf.id = mf.file_id`;
  const fileCols = fromDisease
    ? "NULL AS file_id, NULL AS file_name, NULL AS content_hash"
    : "cf.id AS file_id, cf.file_name AS file_name, cf.content_hash AS content_hash";
  let search = "";
  if (q) {
    search = "WHERE (a.title LIKE ? ESCAPE '\\' OR a.abstract LIKE ? ESCAPE '\\')";
    const like = `%${escapeLike(q)}%`;
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT a.pmid, a.title, ${JOURNAL_DISPLAY} AS journal_name,
              a.authors, a.pub_date, a.pub_date_display, a.doi, a.url,
              COALESCE(pc.citation_count, 0) AS citation_count,
              ${fileCols}
       FROM articles a
       ${membership}
       LEFT JOIN journals j ON j.nlm_id = a.nlm_id
       LEFT JOIN journal_catalog jc ON jc.nlm_id = a.nlm_id
       LEFT JOIN paper_citations pc ON pc.pmid = a.pmid
       ${search}
       ORDER BY a.pub_date DESC, a.pmid DESC`
    )
    .all(...params) as Array<
    Omit<Paper, "file_exists" | "authors"> & { authors: string; content_hash: string | null }
  >;
  return rows.map((r) => ({ ...r, authors: safeParseAuthors(r.authors) }));
}

// Distinct journal display names present in a collection (filter chips) —
// the collection-source counterpart of journalsForDisease.
export function journalsForCollection(collectionId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT ${JOURNAL_DISPLAY} AS jn
       FROM (SELECT DISTINCT pmid FROM collection_files
             WHERE collection_id = ? AND pmid IS NOT NULL) cp
       JOIN articles a ON a.pmid = cp.pmid
       LEFT JOIN journals j ON j.nlm_id = a.nlm_id
       LEFT JOIN journal_catalog jc ON jc.nlm_id = a.nlm_id
       WHERE ${JOURNAL_DISPLAY} <> ''
       ORDER BY jn ASC`
    )
    .all(collectionId) as { jn: string }[];
  return rows.map((r) => r.jn);
}

function safeParseAuthors(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------- citations (for the graph view) ----------

export interface CitationInfo {
  citation_count: number;
  references: string[]; // PMIDs this paper cites
}

export interface GraphPaper {
  pmid: string;
  title: string;
  url: string;
  pub_date: string; // sortable YYYY-MM-DD ('' when unknown)
}

// The papers that make up one disease's graph (green nodes).
export function graphPapers(diseaseId: number): GraphPaper[] {
  return db
    .prepare(
      `SELECT a.pmid, a.title, a.url, a.pub_date FROM articles a
       JOIN article_diseases ad ON ad.pmid = a.pmid
       WHERE ad.disease_id = ?`
    )
    .all(diseaseId) as unknown as GraphPaper[];
}

// PMIDs that have no cached citation row, or whose row is older than maxAgeDays.
export function missingOrStaleCitations(pmids: string[], maxAgeDays = 14): string[] {
  const rows = queryByPmids<{ pmid: string }>(
    pmids,
    (ph) =>
      `SELECT pmid FROM paper_citations
       WHERE pmid IN (${ph}) AND fetched_at >= datetime('now', ?)`,
    [`-${maxAgeDays} days`]
  );
  const fresh = new Set(rows.map((r) => r.pmid));
  return pmids.filter((p) => !fresh.has(p));
}

export function getCitations(pmids: string[]): Map<string, CitationInfo> {
  const rows = queryByPmids<{ pmid: string; citation_count: number; references_json: string }>(
    pmids,
    (ph) => `SELECT pmid, citation_count, references_json FROM paper_citations WHERE pmid IN (${ph})`
  );
  const out = new Map<string, CitationInfo>();
  for (const r of rows) {
    out.set(r.pmid, {
      citation_count: r.citation_count,
      references: safeParseRefs(r.references_json),
    });
  }
  return out;
}

const upsertCitationStmt = db.prepare(`
  INSERT INTO paper_citations (pmid, citation_count, references_json, fetched_at)
  VALUES (@pmid, @citation_count, @references_json, datetime('now'))
  ON CONFLICT(pmid) DO UPDATE SET
    citation_count = excluded.citation_count,
    references_json = excluded.references_json,
    fetched_at = excluded.fetched_at
`);

export const upsertCitations = transaction(
  (rows: { pmid: string; info: CitationInfo }[]) => {
    for (const { pmid, info } of rows) {
      upsertCitationStmt.run({
        pmid,
        citation_count: info.citation_count,
        references_json: JSON.stringify(info.references),
      });
    }
  }
);

function safeParseRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ---------- collections (local PDF libraries) ----------

export function listCollections(): Collection[] {
  return db
    .prepare("SELECT id, name, created_at FROM collections ORDER BY id ASC")
    .all() as unknown as Collection[];
}

export function getCollection(id: number): Collection | undefined {
  return db
    .prepare("SELECT id, name, created_at FROM collections WHERE id = ?")
    .get(id) as Collection | undefined;
}

export function createCollection(name: string): Collection {
  const info = db.prepare("INSERT INTO collections (name) VALUES (?)").run(name);
  return getCollection(Number(info.lastInsertRowid))!;
}

export function renameCollection(id: number, name: string): void {
  db.prepare("UPDATE collections SET name = ? WHERE id = ?").run(name, id);
}

export function deleteCollection(id: number): void {
  // Hashes are captured before the delete (the cascade takes the rows with
  // it), then blobs nothing else references are GC'd — here, not at call
  // sites, so a deletion path can't forget the dance and leak blobs.
  const hashes = hashesForCollection(id);
  // collection_files rows cascade; cached articles/paper_citations stay.
  db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  gcBlobsIfOrphaned(hashes);
}

export function collectionCounts(): Record<number, { files: number; matched: number }> {
  const rows = db
    .prepare(
      `SELECT collection_id, COUNT(*) AS files,
              SUM(CASE WHEN match_status = 'matched' THEN 1 ELSE 0 END) AS matched
       FROM collection_files GROUP BY collection_id`
    )
    .all() as { collection_id: number; files: number; matched: number }[];
  const out: Record<number, { files: number; matched: number }> = {};
  for (const r of rows) out[r.collection_id] = { files: r.files, matched: r.matched ?? 0 };
  return out;
}

const insertFileStmt = db.prepare(
  "INSERT OR IGNORE INTO collection_files (collection_id, content_hash, file_name) VALUES (?, ?, ?)"
);

// Add uploaded files to a collection, atomically. INSERT OR IGNORE + the
// UNIQUE(collection_id, content_hash) constraint make re-uploading the same
// PDFs a no-op. Returns how many were actually inserted.
export const addCollectionFiles = transaction(
  (collectionId: number, files: { hash: string; name: string }[]): number => {
    let added = 0;
    for (const f of files) added += Number(insertFileStmt.run(collectionId, f.hash, f.name).changes);
    return added;
  }
);

// How many rows (across all collections) still reference a blob — 0 means the
// blob itself can be deleted.
function countFilesByHash(hash: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM collection_files WHERE content_hash = ?").get(hash) as {
      c: number;
    }
  ).c;
}

// Delete whichever of these blobs no collection_files row references anymore.
// The row-deleting functions here call it themselves, so no route has to
// remember the capture-hashes-then-GC dance. Exported for the one non-row
// case: uploads whose blobs were stored but whose rows were never recorded.
export function gcBlobsIfOrphaned(hashes: string[]): void {
  deleteBlobs([...new Set(hashes)].filter((h) => countFilesByHash(h) === 0));
}

// The blobs a collection's rows reference, captured before deletion for GC.
function hashesForCollection(collectionId: number): string[] {
  return (
    db
      .prepare("SELECT DISTINCT content_hash FROM collection_files WHERE collection_id = ?")
      .all(collectionId) as { content_hash: string }[]
  ).map((r) => r.content_hash);
}

const FILE_COLS =
  "id, collection_id, content_hash, file_name, pmid, match_status, match_method, match_error, added_at";

export function listCollectionFiles(collectionId: number): CollectionFile[] {
  return db
    .prepare(`SELECT ${FILE_COLS} FROM collection_files WHERE collection_id = ? ORDER BY file_name ASC`)
    .all(collectionId) as unknown as CollectionFile[];
}

export function pendingCollectionFiles(collectionId: number): CollectionFile[] {
  return db
    .prepare(
      `SELECT ${FILE_COLS} FROM collection_files
       WHERE collection_id = ? AND match_status = 'pending' ORDER BY file_name ASC`
    )
    .all(collectionId) as unknown as CollectionFile[];
}

export function getCollectionFile(fileId: number): CollectionFile | undefined {
  return db
    .prepare(`SELECT ${FILE_COLS} FROM collection_files WHERE id = ?`)
    .get(fileId) as CollectionFile | undefined;
}

export function setFileMatched(fileId: number, pmid: string, method: "pmid" | "doi" | "manual"): void {
  db.prepare(
    "UPDATE collection_files SET pmid = ?, match_status = 'matched', match_method = ?, match_error = '' WHERE id = ?"
  ).run(pmid, method, fileId);
}

export function setFileUnmatched(fileId: number): void {
  db.prepare(
    "UPDATE collection_files SET pmid = NULL, match_status = 'unmatched', match_method = '', match_error = '' WHERE id = ?"
  ).run(fileId);
}

export function setFileError(fileId: number, message: string): void {
  db.prepare(
    "UPDATE collection_files SET pmid = NULL, match_status = 'error', match_method = '', match_error = ? WHERE id = ?"
  ).run(message, fileId);
}

export function deleteCollectionFile(fileId: number): void {
  // Same enforced order as deleteCollection: capture the hash, delete the
  // row, GC the blob if that was the last reference.
  const row = db
    .prepare("SELECT content_hash FROM collection_files WHERE id = ?")
    .get(fileId) as { content_hash: string } | undefined;
  db.prepare("DELETE FROM collection_files WHERE id = ?").run(fileId);
  if (row) gcBlobsIfOrphaned([row.content_hash]);
}

// Insert/refresh articles without linking them to a disease (collections track
// membership in collection_files instead of article_diseases).
export const upsertArticles = transaction((articles: ArticleInsert[]) => {
  for (const a of articles) {
    upsertArticleStmt.run({
      pmid: a.pmid,
      title: a.title,
      abstract: a.abstract,
      journal_name: a.journal_name,
      nlm_id: a.nlm_id || null,
      authors: JSON.stringify(a.authors),
      pub_date: a.pub_date,
      pub_date_display: a.pub_date_display,
      doi: a.doi,
      url: a.url,
    });
  }
});

// The papers-list rows for a collection. DISTINCT pmid collapses duplicate
// copies of the same paper (two files, one PMID) into a single row.
// The papers that make up one collection's citation graph (same shape as
// graphPapers, so the /graph route works on either source).
export function collectionGraphPapers(collectionId: number): GraphPaper[] {
  return db
    .prepare(
      `SELECT DISTINCT a.pmid, a.title, a.url, a.pub_date FROM articles a
       JOIN collection_files cf ON cf.pmid = a.pmid
       WHERE cf.collection_id = ?`
    )
    .all(collectionId) as unknown as GraphPaper[];
}

// ---------- journal catalog (NLM J_Medline) ----------

export interface CatalogRow {
  nlm_id: string;
  title: string;
  med_abbr: string;
  iso_abbr: string;
  issn_print: string;
  issn_online: string;
  metric: number | null;
  metric_fetched_at: string | null;
}

export type CatalogSeed = Omit<CatalogRow, "metric" | "metric_fetched_at">;

export function journalCatalogCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM journal_catalog").get() as { c: number }).c;
}

const insertCatalogStmt = db.prepare(`
  INSERT OR IGNORE INTO journal_catalog (nlm_id, title, med_abbr, iso_abbr, issn_print, issn_online)
  VALUES (@nlm_id, @title, @med_abbr, @iso_abbr, @issn_print, @issn_online)
`);

export const bulkInsertCatalog = transaction((rows: CatalogSeed[]) => {
  for (const r of rows) insertCatalogStmt.run(r);
});

// Autocomplete: match title/abbreviation, prefix matches first, then shortest title.
export function searchCatalog(q: string, limit = 10): CatalogRow[] {
  const esc = escapeLike(q);
  const like = `%${esc}%`;
  const prefix = `${esc}%`;
  return db
    .prepare(
      `SELECT * FROM journal_catalog
       WHERE title LIKE ? ESCAPE '\\' OR med_abbr LIKE ? ESCAPE '\\' OR iso_abbr LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' OR med_abbr LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, length(title)
       LIMIT ?`
    )
    .all(like, like, like, prefix, prefix, limit) as unknown as CatalogRow[];
}

// Validation: exact (case-insensitive) match on title or either abbreviation.
export function findCatalogByName(name: string): CatalogRow | undefined {
  return db
    .prepare(
      `SELECT * FROM journal_catalog
       WHERE title = ? COLLATE NOCASE OR med_abbr = ? COLLATE NOCASE OR iso_abbr = ? COLLATE NOCASE
       LIMIT 1`
    )
    .get(name, name, name) as CatalogRow | undefined;
}

export function setCatalogMetric(nlmId: string, metric: number | null): void {
  db.prepare(
    "UPDATE journal_catalog SET metric = ?, metric_fetched_at = datetime('now') WHERE nlm_id = ?"
  ).run(metric, nlmId);
}
