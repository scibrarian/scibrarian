import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deleteBlobs } from "./blobstore.js";
import { DB_PATH, SETTING_DEFAULTS } from "./config.js";
import type {
  Article,
  Collection,
  CollectionFile,
  Topic,
  TopicRemovalResult,
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
  CREATE TABLE IF NOT EXISTS topics (
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

  CREATE TABLE IF NOT EXISTS article_topics (
    pmid TEXT NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (pmid, topic_id),
    FOREIGN KEY (pmid) REFERENCES articles(pmid) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
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

  -- Reference list of MeSH descriptors (from NLM's yearly desc<year>.xml) for
  -- the topic autocomplete. Topics must be a real MeSH heading, so this is the
  -- single source of truth the picker searches and POST /topics validates
  -- against. entry terms (synonyms) live in mesh_entry_terms so typing a synonym
  -- surfaces the canonical heading. mesh_version (in settings) tracks the loaded
  -- year; a newer year triggers a full re-download + replace on startup.
  CREATE TABLE IF NOT EXISTS mesh_descriptors (
    ui TEXT PRIMARY KEY,        -- e.g. D003924
    name TEXT NOT NULL           -- canonical heading, e.g. "Diabetes Mellitus, Type 2"
  );

  CREATE TABLE IF NOT EXISTS mesh_entry_terms (
    term TEXT NOT NULL,          -- heading + all synonyms
    ui TEXT NOT NULL,
    FOREIGN KEY (ui) REFERENCES mesh_descriptors(ui) ON DELETE CASCADE
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
  CREATE INDEX IF NOT EXISTS idx_article_topics_topic ON article_topics(topic_id);
  CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_title ON journal_catalog(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_abbr ON journal_catalog(med_abbr COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_articles_nlm_id ON articles(nlm_id);
  CREATE INDEX IF NOT EXISTS idx_journals_nlm_id ON journals(nlm_id);
  CREATE INDEX IF NOT EXISTS idx_mesh_descriptors_name ON mesh_descriptors(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_mesh_entry_terms_term ON mesh_entry_terms(term COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_mesh_entry_terms_ui ON mesh_entry_terms(ui);
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
  const topicCount = (db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c;
  if (journalCount === 0 && topicCount === 0) {
    const insJ = db.prepare("INSERT OR IGNORE INTO journals (name, nlm_id) VALUES (?, ?)");
    for (const [name, nlmId] of SEED_JOURNALS) {
      insJ.run(name, nlmId);
    }
  }
  setSettingStmt.run("seeded", "1");
}

// ---------- topics ----------

export function listTopics(): Topic[] {
  return db
    .prepare("SELECT id, name, term, last_polled_at, created_at FROM topics ORDER BY id ASC")
    .all() as unknown as Topic[];
}

export function getTopic(id: number): Topic | undefined {
  return db
    .prepare("SELECT id, name, term, last_polled_at, created_at FROM topics WHERE id = ?")
    .get(id) as Topic | undefined;
}

// Used to reject adding the same topic twice. Identity is the PubMed term, which
// is built deterministically from the MeSH heading, so the same heading always
// yields the same term; NOCASE also catches an equivalent legacy/seed term.
export function topicByTerm(term: string): Topic | undefined {
  return db
    .prepare(
      "SELECT id, name, term, last_polled_at, created_at FROM topics WHERE term = ? COLLATE NOCASE"
    )
    .get(term) as Topic | undefined;
}

export function createTopic(name: string, term: string): Topic {
  const info = db.prepare("INSERT INTO topics (name, term) VALUES (?, ?)").run(name, term);
  return getTopic(Number(info.lastInsertRowid))!;
}

// Which of a topic's articles a removal would permanently delete: papers whose
// only topic link is this one (papers under other topics keep those feeds) and
// that aren't referenced by a collection file (library copies are kept). Like
// DELETABLE_JOURNAL_ARTICLES below, the confirm-dialog count and the
// destructive DELETE share this fragment so they can't disagree. Binds the
// topic id twice.
const DELETABLE_TOPIC_ARTICLES = `pmid IN (SELECT pmid FROM article_topics WHERE topic_id = ?)
   AND pmid NOT IN (SELECT pmid FROM article_topics WHERE topic_id != ?)
   AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)`;

// How many stored articles a topic removal would permanently delete (for the
// confirmation).
export function countTopicArticles(id: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM articles WHERE ${DELETABLE_TOPIC_ARTICLES}`)
      .get(id, id) as { c: number }
  ).c;
}

// Remove a topic: papers exclusive to it (and not saved in the library) are
// permanently deleted; papers that also appear under other topics survive with
// those links intact. Deleting a topic's articles is recoverable in principle —
// re-adding the topic re-seeds from an all-time PubMed scan. article_topics
// rows cascade via both foreign keys.
export const removeTopicWithArticles = transaction((id: number): TopicRemovalResult => {
  const deletedArticles = Number(
    db.prepare(`DELETE FROM articles WHERE ${DELETABLE_TOPIC_ARTICLES}`).run(id, id).changes
  );
  db.prepare("DELETE FROM topics WHERE id = ?").run(id);
  return { deletedArticles };
});

export function setTopicLastPolled(id: number, iso: string): void {
  db.prepare("UPDATE topics SET last_polled_at = ? WHERE id = ?").run(iso, id);
}

// ---------- journals ----------

// Journal rows carry the catalog's metric (when the nlm_id matches a catalog
// entry whose metric has been fetched) so the client can sort by impact.
const JOURNAL_SELECT = `SELECT j.id, j.name, j.nlm_id, j.created_at, c.metric
   FROM journals j LEFT JOIN journal_catalog c ON c.nlm_id = j.nlm_id`;

export function listJournals(): Journal[] {
  return db.prepare(`${JOURNAL_SELECT} ORDER BY j.name ASC`).all() as unknown as Journal[];
}

export function createJournal(name: string, nlmId: string | null): Journal {
  const info = db.prepare("INSERT INTO journals (name, nlm_id) VALUES (?, ?)").run(name, nlmId);
  return db
    .prepare(`${JOURNAL_SELECT} WHERE j.id = ?`)
    .get(Number(info.lastInsertRowid)) as unknown as Journal;
}

// Used to reject adding the same journal twice (identity is the NLM id).
export function journalByNlmId(nlmId: string): Journal | undefined {
  return db.prepare(`${JOURNAL_SELECT} WHERE j.nlm_id = ?`).get(nlmId) as Journal | undefined;
}

// Which of a journal's articles a removal would permanently delete: the
// journal's articles minus those referenced by a collection file (library
// copies are kept). One WHERE fragment, bound to a single nlm_id param, shared
// by the confirm-dialog count and the destructive DELETE below — if the
// pinning rule ever changes, both move together, so the dialog can't promise
// one thing and the delete do another.
const DELETABLE_JOURNAL_ARTICLES = `nlm_id = ?
   AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)`;

function journalNlmId(id: number): string | null {
  const j = db.prepare("SELECT nlm_id FROM journals WHERE id = ?").get(id) as
    | { nlm_id: string | null }
    | undefined;
  return j?.nlm_id ?? null;
}

// How many stored articles a journal removal would permanently delete (for the
// confirmation). Articles referenced by a collection file are kept, so they
// are excluded from the count.
export function countJournalArticles(id: number): number {
  const nlmId = journalNlmId(id);
  if (!nlmId) return 0;
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM articles WHERE ${DELETABLE_JOURNAL_ARTICLES}`)
      .get(nlmId) as { c: number }
  ).c;
}

// Remove a journal (matched by NLM id): its articles leave every topic feed,
// but articles referenced by a collection file survive so the user's library is
// untouched. Unreferenced articles are permanently deleted (article_topics
// rows cascade via the foreign key).
export const removeJournalWithArticles = transaction((id: number): JournalRemovalResult => {
  const nlmId = journalNlmId(id);
  let deletedArticles = 0;
  let removedFromInterests = 0;
  if (nlmId) {
    removedFromInterests = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT pmid) AS c FROM article_topics
           WHERE pmid IN (SELECT pmid FROM articles WHERE nlm_id = ?)`
        )
        .get(nlmId) as { c: number }
    ).c;
    db.prepare(
      "DELETE FROM article_topics WHERE pmid IN (SELECT pmid FROM articles WHERE nlm_id = ?)"
    ).run(nlmId);
    // Same predicate the confirm dialog counted with (DELETABLE_JOURNAL_ARTICLES).
    deletedArticles = Number(
      db.prepare(`DELETE FROM articles WHERE ${DELETABLE_JOURNAL_ARTICLES}`).run(nlmId).changes
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
  "INSERT OR IGNORE INTO article_topics (pmid, topic_id) VALUES (?, ?)"
);

export type ArticleInsert = Omit<Article, "authors" | "first_seen_at"> & { authors: string[] };

// The one place an ArticleInsert maps onto the articles upsert — shared by the
// topic path (saveArticles) and the collection path (upsertArticles), so a
// new article column can't end up persisted by one and dropped by the other.
// (Both callers are transactions; this stays a plain per-row helper because
// the transaction wrapper's BEGIN can't nest.)
function upsertArticle(a: ArticleInsert): void {
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

// Insert/refresh a batch of articles and link them to a topic, atomically.
export const saveArticles = transaction((articles: ArticleInsert[], topicId: number) => {
  for (const a of articles) {
    upsertArticle(a);
    linkArticleStmt.run(a.pmid, topicId);
  }
});

// The journal name shown to the user: the watched journal's abbreviation (or the
// catalog abbreviation), resolved by NLM id, falling back to the stored title.
const JOURNAL_DISPLAY = "COALESCE(j.name, jc.med_abbr, a.journal_name)";
const ARTICLE_JOINS = `JOIN article_topics ad ON ad.pmid = a.pmid
       LEFT JOIN journals j ON j.nlm_id = a.nlm_id
       LEFT JOIN journal_catalog jc ON jc.nlm_id = a.nlm_id`;

export function topicArticleCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT topic_id, COUNT(*) AS c FROM article_topics GROUP BY topic_id")
    .all() as { topic_id: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.topic_id] = r.c;
  return out;
}

// Distinct journal display names that have articles for a topic (filter chips).
// Journal filter-chip names for either paper source. Routes dispatch through
// this (and graphPapersForSource / listPapers) rather than picking per-source
// functions themselves — a new source kind extends the union and these
// dispatchers, and the compiler flags every spot that must learn about it.
export function journalsForSource(source: PaperSourceQuery): string[] {
  if ("topicId" in source) return journalsForTopic(source.topicId);
  return journalsForCollection(source.collectionId);
}

function journalsForTopic(topicId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT ${JOURNAL_DISPLAY} AS j FROM articles a
       ${ARTICLE_JOINS}
       WHERE ad.topic_id = ? AND ${JOURNAL_DISPLAY} <> ''
       ORDER BY j ASC`
    )
    .all(topicId) as { j: string }[];
  return rows.map((r) => r.j);
}

// Which paper set /api/papers reads: a topic's articles or a collection's
// matched uploads. Mirrors the client's PaperSource.
export type PaperSourceQuery = { topicId: number } | { collectionId: number };

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
  const fromTopic = "topicId" in source;
  const params: (string | number)[] = fromTopic
    ? [source.topicId]
    : [source.collectionId, source.collectionId];
  // A collection row exists for every distinct matched pmid (pmid IS NOT NULL),
  // and links the lowest-id 'matched' file for it, if any.
  const membership = fromTopic
    ? "JOIN article_topics ad ON ad.pmid = a.pmid AND ad.topic_id = ?"
    : `JOIN (SELECT DISTINCT pmid FROM collection_files
             WHERE collection_id = ? AND pmid IS NOT NULL) cp ON cp.pmid = a.pmid
       LEFT JOIN (SELECT pmid, MIN(id) AS file_id FROM collection_files
                  WHERE collection_id = ? AND match_status = 'matched'
                  GROUP BY pmid) mf ON mf.pmid = a.pmid
       LEFT JOIN collection_files cf ON cf.id = mf.file_id`;
  const fileCols = fromTopic
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
// the collection-source counterpart of journalsForTopic.
function journalsForCollection(collectionId: number): string[] {
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

// The papers that make up a source's graph — the per-source dispatch lives
// here, not in routes (see journalsForSource).
export function graphPapersForSource(source: PaperSourceQuery): GraphPaper[] {
  if ("topicId" in source) return graphPapers(source.topicId);
  return collectionGraphPapers(source.collectionId);
}

// The papers that make up one topic's graph (green nodes).
function graphPapers(topicId: number): GraphPaper[] {
  return db
    .prepare(
      `SELECT a.pmid, a.title, a.url, a.pub_date FROM articles a
       JOIN article_topics ad ON ad.pmid = a.pmid
       WHERE ad.topic_id = ?`
    )
    .all(topicId) as unknown as GraphPaper[];
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

// Insert/refresh articles without linking them to a topic (collections track
// membership in collection_files instead of article_topics).
export const upsertArticles = transaction((articles: ArticleInsert[]) => {
  for (const a of articles) upsertArticle(a);
});

// The papers-list rows for a collection. DISTINCT pmid collapses duplicate
// copies of the same paper (two files, one PMID) into a single row.
// The papers that make up one collection's citation graph (same shape as
// graphPapers, so the /graph route works on either source).
function collectionGraphPapers(collectionId: number): GraphPaper[] {
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

export function findCatalogByNlmId(nlmId: string): CatalogRow | undefined {
  return db.prepare("SELECT * FROM journal_catalog WHERE nlm_id = ?").get(nlmId) as
    | CatalogRow
    | undefined;
}

export function setCatalogMetric(nlmId: string, metric: number | null): void {
  db.prepare(
    "UPDATE journal_catalog SET metric = ?, metric_fetched_at = datetime('now') WHERE nlm_id = ?"
  ).run(metric, nlmId);
}

// ---------- MeSH descriptors (NLM desc<year>.xml) ----------

export interface MeshDescriptor {
  ui: string;
  name: string;
}

// One parsed descriptor: the canonical heading plus every entry term (synonyms,
// including the preferred term) so a synonym search still finds the heading.
export interface MeshSeed {
  ui: string;
  name: string;
  terms: string[];
}

export function meshDescriptorCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM mesh_descriptors").get() as { c: number }).c;
}

// The loaded MeSH year, tracked in settings — but managed by the importer, so
// it's deliberately kept out of SETTING_DEFAULTS (never shown/edited in the UI).
// Read/written through the raw statements, like the `seeded` first-run flag.
export function getMeshVersion(): string {
  const row = getSettingStmt.get("mesh_version") as { value: string } | undefined;
  return row?.value ?? "";
}

export function setMeshVersion(version: string): void {
  setSettingStmt.run("mesh_version", version);
}

const insertMeshDescriptorStmt = db.prepare(
  "INSERT OR IGNORE INTO mesh_descriptors (ui, name) VALUES (?, ?)"
);
const insertMeshEntryTermStmt = db.prepare(
  "INSERT INTO mesh_entry_terms (term, ui) VALUES (?, ?)"
);

// Swap in a whole new MeSH vocabulary atomically: a version bump supersedes the
// old set, so we clear both tables and repopulate, then stamp the version. Entry
// terms are deduped per descriptor (case-insensitively).
export const replaceMeshData = transaction((rows: MeshSeed[], version: string) => {
  db.exec("DELETE FROM mesh_entry_terms");
  db.exec("DELETE FROM mesh_descriptors");
  for (const r of rows) {
    insertMeshDescriptorStmt.run(r.ui, r.name);
    const seen = new Set<string>();
    for (const term of r.terms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      insertMeshEntryTermStmt.run(term, r.ui);
    }
  }
  setMeshVersion(version);
});

// Topic autocomplete: match any entry term (the heading is stored as one too),
// dedupe to one row per descriptor, and rank so the query's relevance to the
// heading wins over an obscure-synonym match — heading-prefix, then
// synonym-prefix, then heading-substring, then synonym-only — and shortest
// heading breaks ties. Without this, searching "diabetes" surfaces descriptors
// like Hemochromatosis (synonym "Bronze Diabetes") above "Diabetes Mellitus".
export function searchMesh(q: string, limit = 10): MeshDescriptor[] {
  const esc = escapeLike(q);
  const like = `%${esc}%`;
  const prefix = `${esc}%`;
  return db
    .prepare(
      `SELECT d.ui AS ui, d.name AS name,
         MIN(CASE
           WHEN d.name LIKE ? ESCAPE '\\' THEN 0
           WHEN et.term LIKE ? ESCAPE '\\' THEN 1
           WHEN d.name LIKE ? ESCAPE '\\' THEN 2
           ELSE 3
         END) AS rank
       FROM mesh_descriptors d
       JOIN mesh_entry_terms et ON et.ui = d.ui
       WHERE et.term LIKE ? ESCAPE '\\'
       GROUP BY d.ui, d.name
       ORDER BY rank, length(d.name)
       LIMIT ?`
    )
    .all(prefix, prefix, like, like, limit) as unknown as MeshDescriptor[];
}

// Validation: exact (case-insensitive) match on the canonical heading. Used by
// POST /topics to reject anything that isn't a real MeSH descriptor.
export function findMeshByName(name: string): MeshDescriptor | undefined {
  return db
    .prepare("SELECT ui, name FROM mesh_descriptors WHERE name = ? COLLATE NOCASE LIMIT 1")
    .get(name) as MeshDescriptor | undefined;
}
