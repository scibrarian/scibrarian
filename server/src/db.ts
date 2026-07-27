import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deleteBlobs } from "./blobstore.js";
import { DB_PATH, SETTING_DEFAULTS } from "./config.js";
import type {
  Article,
  BookmarkEntry,
  BookmarkFolder,
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
  -- validation. Re-downloaded and upserted in place once stale (see
  -- journal-catalog.ts); journal_catalog_loaded_at (in settings) tracks the
  -- last load. metric = OpenAlex 2yr mean citedness, fetched + cached lazily
  -- and preserved across catalog refreshes.
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

  -- User-created folders of saved papers. A folder is a paper source in its own
  -- right (papers/timeline/graph read it exactly like a topic), but it stores
  -- nothing itself: membership is the bookmarks table below.
  CREATE TABLE IF NOT EXISTS bookmark_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One saved paper in one folder. Unlike collection_files this is a hard FK on
  -- articles.pmid: a bookmark is only ever made from a paper already stored, so
  -- a dangling row would be meaningless. Deleting a folder takes its bookmarks
  -- with it; the articles themselves stay (they may be in a topic feed too).
  -- Topic and journal removals deliberately never delete a bookmarked article —
  -- see DELETABLE_TOPIC_ARTICLES / DELETABLE_JOURNAL_ARTICLES.
  CREATE TABLE IF NOT EXISTS bookmarks (
    folder_id INTEGER NOT NULL,
    pmid TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (folder_id, pmid),
    FOREIGN KEY (folder_id) REFERENCES bookmark_folders(id) ON DELETE CASCADE,
    FOREIGN KEY (pmid) REFERENCES articles(pmid) ON DELETE CASCADE
  );

  -- Two collections (or two bookmark folders) sharing a name are
  -- indistinguishable in the picker, so names are unique case-insensitively
  -- within each. An index rather than an inline UNIQUE because only an index
  -- can carry the NOCASE collation.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmark_folders_name ON bookmark_folders(name COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_bookmarks_pmid ON bookmarks(pmid);
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
// that nothing the user has saved points at — a collection file (library
// copies) or a bookmark. Saving a paper is what makes it the user's, so it
// outlives the feed it was found in; a bookmark whose paper vanished would be
// a silently empty row (the FK would cascade it away). Like
// DELETABLE_JOURNAL_ARTICLES below, the confirm-dialog count and the
// destructive DELETE share this fragment so they can't disagree. Binds the
// topic id twice.
//
// CORRECTNESS ASSUMPTION: article_topics is complete with respect to each
// topic's *current* match criteria — every stored paper that matches a topic
// is linked to it. The poller guarantees this today (all-time first poll,
// contiguous MeSH-date windows, cross-linking of known pmids). If per-topic
// fetch filters are ever added (e.g. "papers since 2000"), *widening* a
// topic's criteria must clear its last_polled_at so the next poll re-seeds
// all-time under the new filter and relinks older papers — otherwise this
// predicate can delete a paper that the widened topic should now claim.
// Narrowing is safe by default: stale links merely keep papers alive.
const DELETABLE_TOPIC_ARTICLES = `pmid IN (SELECT pmid FROM article_topics WHERE topic_id = ?)
   AND pmid NOT IN (SELECT pmid FROM article_topics WHERE topic_id != ?)
   AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)
   AND pmid NOT IN (SELECT pmid FROM bookmarks)`;

// How many stored articles a topic removal would permanently delete (for the
// confirmation).
export function countTopicArticles(id: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM articles WHERE ${DELETABLE_TOPIC_ARTICLES}`)
      .get(id, id) as { c: number }
  ).c;
}

// Remove a topic: papers exclusive to it (and neither bookmarked nor saved in
// the library) are permanently deleted; papers that also appear under other
// topics survive with those links intact. Deleting a topic's articles is
// recoverable in principle — re-adding the topic re-seeds from an all-time
// PubMed scan. article_topics rows cascade via both foreign keys.
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
// journal's articles minus anything the user has saved — a collection file
// (library copies) or a bookmark, the same pinning rule the topic predicate
// applies. One WHERE fragment, bound to a single nlm_id param, shared
// by the confirm-dialog count and the destructive DELETE below — if the
// pinning rule ever changes, both move together, so the dialog can't promise
// one thing and the delete do another.
const DELETABLE_JOURNAL_ARTICLES = `nlm_id = ?
   AND pmid NOT IN (SELECT pmid FROM collection_files WHERE pmid IS NOT NULL)
   AND pmid NOT IN (SELECT pmid FROM bookmarks)`;

function journalNlmId(id: number): string | null {
  const j = db.prepare("SELECT nlm_id FROM journals WHERE id = ?").get(id) as
    | { nlm_id: string | null }
    | undefined;
  return j?.nlm_id ?? null;
}

// How many stored articles a journal removal would permanently delete (for the
// confirmation). Bookmarked articles and those referenced by a collection file
// are kept, so they are excluded from the count.
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
// but bookmarked articles and those referenced by a collection file survive so
// the user's saved papers are untouched. Unreferenced articles are permanently
// deleted (article_topics rows cascade via the foreign key).
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

// The papers list omits abstracts (they dominate its size); the timeline
// fetches them on demand, a rendered chunk at a time rather than a card at a
// time. Unknown pmids are simply absent from the result.
export function getArticleAbstracts(pmids: string[]): { pmid: string; abstract: string }[] {
  return queryByPmids<{ pmid: string; abstract: string }>(
    pmids,
    (ph) => `SELECT pmid, abstract FROM articles WHERE pmid IN (${ph})`
  );
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
const JOURNAL_LOOKUP = `LEFT JOIN journals j ON j.nlm_id = a.nlm_id
       LEFT JOIN journal_catalog jc ON jc.nlm_id = a.nlm_id`;

// The free-text search condition, shared by the /papers and /graph queries so a
// query means exactly the same thing in every view — a view that matched on a
// narrower set of columns would quietly disagree with the others about what a
// search returns. Appends its own bind params; returns "" for a blank query so
// callers can drop the clause entirely.
//
// `authors` is a JSON array of name strings, so a plain LIKE over the stored
// text matches any author of the paper. Year is deliberately NOT searched here:
// it's a range, filtered client-side, and folding it in would make "2019" match
// every title containing that number.
function searchPredicate(q: string | undefined, params: (string | number)[]): string {
  if (!q) return "";
  const like = `%${escapeLike(q)}%`;
  params.push(like, like, like);
  return `(a.title LIKE ? ESCAPE '\\'
        OR a.abstract LIKE ? ESCAPE '\\'
        OR a.authors LIKE ? ESCAPE '\\')`;
}

export function topicArticleCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT topic_id, COUNT(*) AS c FROM article_topics GROUP BY topic_id")
    .all() as { topic_id: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.topic_id] = r.c;
  return out;
}

// Which paper set /api/papers reads: a topic's articles, a bookmark folder's
// saved papers, or a collection's matched uploads. Mirrors the client's
// PaperSource.
export type PaperSourceQuery =
  | { topicId: number }
  | { folderId: number }
  | { collectionId: number };

// The join that narrows `articles a` down to one source's papers, plus the
// params it binds. Every per-source query — the papers list, the journal chips,
// the graph — is built on this single fragment, so the views can't disagree
// about what a source contains, and a new source kind is added here instead of
// in three near-identical queries. Routes dispatch through the exported
// wrappers (journalsForSource / listPapers / graphPapersForSource) rather than
// picking per-source functions themselves.
function sourceMembership(source: PaperSourceQuery): {
  join: string;
  params: (string | number)[];
} {
  if ("topicId" in source) {
    return {
      join: "JOIN article_topics ad ON ad.pmid = a.pmid AND ad.topic_id = ?",
      params: [source.topicId],
    };
  }
  if ("folderId" in source) {
    return {
      join: "JOIN bookmarks bm ON bm.pmid = a.pmid AND bm.folder_id = ?",
      params: [source.folderId],
    };
  }
  // A collection row exists for every distinct matched pmid (pmid IS NOT NULL),
  // and links the lowest-id 'matched' file for it, if any.
  return {
    join: `JOIN (SELECT DISTINCT pmid FROM collection_files
              WHERE collection_id = ? AND pmid IS NOT NULL) cp ON cp.pmid = a.pmid
       LEFT JOIN (SELECT pmid, MIN(id) AS file_id FROM collection_files
                  WHERE collection_id = ? AND match_status = 'matched'
                  GROUP BY pmid) mf ON mf.pmid = a.pmid
       LEFT JOIN collection_files cf ON cf.id = mf.file_id`,
    params: [source.collectionId, source.collectionId],
  };
}

// The linked-PDF columns for a source. Only a collection has uploaded files
// behind its papers; topics and bookmark folders select constant nulls so every
// source hands back the same row shape.
function sourceFileCols(source: PaperSourceQuery): string {
  return "collectionId" in source
    ? "cf.id AS file_id, cf.file_name AS file_name, cf.content_hash AS content_hash"
    : "NULL AS file_id, NULL AS file_name, NULL AS content_hash";
}

// Distinct journal display names present in a source (the filter chips).
export function journalsForSource(source: PaperSourceQuery): string[] {
  const { join, params } = sourceMembership(source);
  const rows = db
    .prepare(
      `SELECT DISTINCT ${JOURNAL_DISPLAY} AS jn FROM articles a
       ${join}
       ${JOURNAL_LOOKUP}
       WHERE ${JOURNAL_DISPLAY} <> ''
       ORDER BY jn ASC`
    )
    .all(...params) as { jn: string }[];
  return rows.map((r) => r.jn);
}

// Escape LIKE wildcards so a literal % or _ in a user query (e.g. "100%",
// "COVID_19") matches itself instead of acting as a wildcard. Callers wrap the
// result in their own %/_ and must pair each LIKE with ESCAPE '\'. The
// backslash itself is escaped first so it can serve as the escape character.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The unified rows behind the table and timeline views, for any source:
// article metadata, cached citation count, and — for collections — the first
// matched uploaded file per pmid (the copy a title click opens; same rule as
// the old per-client fileByPmid). content_hash is returned so the route can
// check the blob still exists; it is stripped before the response.
export function listPapers(
  source: PaperSourceQuery,
  q?: string
): Array<Omit<Paper, "file_exists"> & { content_hash: string | null }> {
  const { join, params } = sourceMembership(source);
  const predicate = searchPredicate(q, params);
  const search = predicate ? `WHERE ${predicate}` : "";
  const rows = db
    .prepare(
      `SELECT a.pmid, a.title, ${JOURNAL_DISPLAY} AS journal_name,
              a.authors, a.pub_date, a.pub_date_display, a.doi, a.url,
              COALESCE(pc.citation_count, 0) AS citation_count,
              ${sourceFileCols(source)}
       FROM articles a
       ${join}
       ${JOURNAL_LOOKUP}
       LEFT JOIN paper_citations pc ON pc.pmid = a.pmid
       ${search}
       ORDER BY a.pub_date DESC, a.pmid DESC`
    )
    .all(...params) as Array<
    Omit<Paper, "file_exists" | "authors"> & { authors: string; content_hash: string | null }
  >;
  return rows.map((r) => ({ ...r, authors: safeParseAuthors(r.authors) }));
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
  journal_name: string;
  pub_date: string; // sortable YYYY-MM-DD ('' when unknown)
  // The linked PDF, mirroring listPapers so a graph node and its table row
  // agree on which file a click opens. Null for topic and bookmark papers,
  // which have none.
  file_id: number | null;
  file_name: string | null;
  content_hash: string | null; // routes resolves this to file_exists
}

// The papers that make up a source's graph — same membership and same linked
// file as listPapers, so a node opens the PDF its table row does.
export function graphPapersForSource(source: PaperSourceQuery, q?: string): GraphPaper[] {
  const { join, params } = sourceMembership(source);
  const predicate = searchPredicate(q, params);
  return db
    .prepare(
      `SELECT a.pmid, a.title, a.url, a.pub_date, ${JOURNAL_DISPLAY} AS journal_name,
              ${sourceFileCols(source)}
       FROM articles a
       ${join}
       ${JOURNAL_LOOKUP}
       ${predicate ? `WHERE ${predicate}` : ""}`
    )
    .all(...params) as unknown as GraphPaper[];
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

// ---------- bookmarks (papers saved out of Interests, grouped into folders) ----------

const FOLDER_SELECT = "SELECT id, name, created_at FROM bookmark_folders";

export function listBookmarkFolders(): BookmarkFolder[] {
  return db.prepare(`${FOLDER_SELECT} ORDER BY id ASC`).all() as unknown as BookmarkFolder[];
}

export function getBookmarkFolder(id: number): BookmarkFolder | undefined {
  return db.prepare(`${FOLDER_SELECT} WHERE id = ?`).get(id) as BookmarkFolder | undefined;
}

// Used to reject a create/rename that would duplicate a name. NOCASE matches
// the unique index, so this finds exactly what the index would refuse.
export function bookmarkFolderByName(name: string): BookmarkFolder | undefined {
  return db.prepare(`${FOLDER_SELECT} WHERE name = ? COLLATE NOCASE`).get(name) as
    | BookmarkFolder
    | undefined;
}

export function createBookmarkFolder(name: string): BookmarkFolder {
  const info = db.prepare("INSERT INTO bookmark_folders (name) VALUES (?)").run(name);
  return getBookmarkFolder(Number(info.lastInsertRowid))!;
}

export function renameBookmarkFolder(id: number, name: string): void {
  db.prepare("UPDATE bookmark_folders SET name = ? WHERE id = ?").run(name, id);
}

// Delete a folder and, by cascade, its bookmark rows. The papers themselves are
// untouched — they're shared cache, still reachable from any topic feed or
// collection that has them. Nothing else to clean up: unlike a collection, a
// folder owns no blobs.
export function deleteBookmarkFolder(id: number): void {
  db.prepare("DELETE FROM bookmark_folders WHERE id = ?").run(id);
}

// Every (folder, paper) pair, for the client's saved-state map.
export function listBookmarks(): BookmarkEntry[] {
  return db
    .prepare("SELECT folder_id, pmid FROM bookmarks ORDER BY folder_id ASC, pmid ASC")
    .all() as unknown as BookmarkEntry[];
}

const insertBookmarkStmt = db.prepare(
  "INSERT OR IGNORE INTO bookmarks (folder_id, pmid) VALUES (?, ?)"
);

// Save papers into a folder, atomically. Saving one that's already there is a
// no-op rather than an error — the primary key already says a paper is in a
// folder once, so a double-click, or a bulk save overlapping an earlier one, is
// harmless. Returns how many rows were actually new, so the caller can report
// what changed rather than claiming it saved papers it didn't.
//
// One function for both the single-paper toggle and the bulk save: a bulk save
// of a filtered set is thousands of these, and a per-row transaction each would
// be thousands of fsyncs.
export const addBookmarks = transaction((folderId: number, pmids: string[]): number => {
  let added = 0;
  for (const pmid of pmids) added += Number(insertBookmarkStmt.run(folderId, pmid).changes);
  return added;
});

// Un-saving something that isn't saved is likewise a no-op, so the toggle can
// be driven from a possibly-stale client view without erroring.
export function removeBookmark(folderId: number, pmid: string): void {
  db.prepare("DELETE FROM bookmarks WHERE folder_id = ? AND pmid = ?").run(folderId, pmid);
}

// Saved papers per folder, for the picker's count badges. Folders with no
// bookmarks are absent, so callers default to 0 (as collectionCounts does).
export function bookmarkCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT folder_id, COUNT(*) AS c FROM bookmarks GROUP BY folder_id")
    .all() as { folder_id: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.folder_id] = r.c;
  return out;
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

// The collection-side counterpart of bookmarkFolderByName.
export function collectionByName(name: string): Collection | undefined {
  return db
    .prepare("SELECT id, name, created_at FROM collections WHERE name = ? COLLATE NOCASE")
    .get(name) as Collection | undefined;
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

// Refreshes must update identity columns in place (NLM revises titles,
// abbreviations and ISSNs) while leaving metric/metric_fetched_at alone — the
// OpenAlex cache lives in the same table and must survive a catalog refresh.
// Rows missing from a newer J_Medline are kept rather than deleted: stale
// extras are harmless to autocomplete, and never deleting means a truncated
// download can't hollow out the catalog.
const upsertCatalogStmt = db.prepare(`
  INSERT INTO journal_catalog (nlm_id, title, med_abbr, iso_abbr, issn_print, issn_online)
  VALUES (@nlm_id, @title, @med_abbr, @iso_abbr, @issn_print, @issn_online)
  ON CONFLICT(nlm_id) DO UPDATE SET
    title = excluded.title,
    med_abbr = excluded.med_abbr,
    iso_abbr = excluded.iso_abbr,
    issn_print = excluded.issn_print,
    issn_online = excluded.issn_online
`);

export const bulkUpsertCatalog = transaction((rows: CatalogSeed[]) => {
  for (const r of rows) upsertCatalogStmt.run(r);
  // Stamped in the same transaction so a half-applied load can't look fresh.
  setSettingStmt.run("journal_catalog_loaded_at", new Date().toISOString());
});

// When the catalog was last loaded from NLM (ISO timestamp; "" before the
// first load). Importer-managed like mesh_version, so deliberately kept out
// of SETTING_DEFAULTS and never shown in the UI.
export function getCatalogLoadedAt(): string {
  const row = getSettingStmt.get("journal_catalog_loaded_at") as { value: string } | undefined;
  return row?.value ?? "";
}

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
