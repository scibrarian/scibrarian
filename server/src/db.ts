import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deleteBlobs } from "./blobstore.js";
import { DB_PATH, SETTING_DEFAULTS } from "./config.js";
import { toFtsQuery } from "./fts-query.js";
import { searchIdentifiers } from "./identifiers.js";
import {
  MESH_SETTLED_STATUSES,
  MESH_STATUS_NEVER,
  MESH_STATUS_UNAVAILABLE,
  PUB_TYPE_NONE,
} from "./pubmed-parse.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../../shared/types.js";
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
  MeshFacet,
  MeshFiling,
  MeshHeading,
  Paper,
  Settings,
  TopicSuggestion,
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

  -- medline_indexed: does NLM currently index this journal for MEDLINE? 1/0, or
  -- NULL for "not established yet" — the add-time check couldn't reach NCBI.
  -- Only 0 is worth showing the user: topics are MeSH terms and an unindexed
  -- journal's papers carry no MeSH headings, so it can never contribute to a
  -- topic feed. Written once, at add time (POST /journals) — nothing revisits
  -- it, so a journal added while NCBI was unreachable stays NULL until it is
  -- removed and re-added. On an installed base this CREATE is a no-op, so the
  -- column is also added via addColumnIfMissing() below.
  CREATE TABLE IF NOT EXISTS journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    nlm_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    medline_indexed INTEGER
  );

  -- mesh_status: MedlineCitation/@Status from the last efetch that looked, ''
  -- before any did. It is the only thing that tells "this paper will never carry
  -- MeSH headings" (PubMed-not-MEDLINE) apart from "they haven't arrived yet"
  -- (In-Process/Publisher) and from "we never asked" — see meshOutlook in
  -- pubmed-parse.ts, which is the single reading of this vocabulary.
  -- mesh_checked_at is when that look happened, so a paper still awaiting
  -- indexing can be asked about again without re-fetching settled ones forever.
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
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    mesh_status TEXT NOT NULL DEFAULT '',
    mesh_checked_at TEXT
  );

  -- The MeSH descriptors PubMed filed an article under: one row per
  -- (article, descriptor), written from the same efetch XML the abstract comes
  -- from, so filing costs no request of its own.
  --
  -- The heading text is stored rather than joined to mesh_descriptors, which is
  -- the *current* MeSH year's vocabulary and gets deleted and repopulated
  -- wholesale on a version bump (replaceMeshData). A heading NLM later retires
  -- would then render as a blank row, and this is a record of how a paper was
  -- filed — which doesn't change when the vocabulary does.
  --
  -- Qualifiers are not stored (see parseMeshHeadings): they describe an aspect
  -- of a subject and multiply the rows per paper for something filing never
  -- asks. The major flag is PubMed's star, which does survive them.
  CREATE TABLE IF NOT EXISTS article_mesh (
    pmid TEXT NOT NULL,
    ui TEXT NOT NULL,               -- descriptor id, e.g. D003924
    name TEXT NOT NULL,             -- heading as PubMed filed it
    major INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pmid, ui),
    FOREIGN KEY (pmid) REFERENCES articles(pmid) ON DELETE CASCADE
  );

  -- PubMed's PublicationTypeList for an article: one row per type, from the
  -- same efetch XML the abstract and the MeSH headings come from, so it costs
  -- no request of its own.
  --
  -- The raw types are stored rather than a derived "primary/secondary" verdict,
  -- because the classification is a judgement (evidenceClass in
  -- pubmed-parse.ts) and judgements change — NLM adds types, and what counts as
  -- able to support a claim is a product decision. Storing the fact and
  -- classifying at read time means revising that never needs a refetch.
  --
  -- Noise types are dropped at parse time, not here: 'Journal Article' (which
  -- every record carries) and the 'Research Support, …' funding tags. So an
  -- article with rows has something worth saying, and an article with none has
  -- been looked at and had nothing — which is a different thing from never
  -- having been looked at, and is why evidenceClass takes a "seen" flag.
  CREATE TABLE IF NOT EXISTS article_pub_types (
    pmid TEXT NOT NULL,
    type TEXT NOT NULL,             -- verbatim, e.g. 'Randomized Controlled Trial'
    PRIMARY KEY (pmid, type),
    FOREIGN KEY (pmid) REFERENCES articles(pmid) ON DELETE CASCADE
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
  -- Extracted PDF body text, for full-text search. Keyed by content_hash, not
  -- by file id: the blob store is content-addressed, so the same PDF uploaded
  -- to three collections is one blob, one extraction and one index entry.
  -- Rows outlive the collection_files that caused them (a re-upload of the same
  -- bytes reuses the extraction) and are cleaned up with their blob.
  --
  -- truncated records that the document ran past the extractor's page/char
  -- cap, so a future "why didn't this match?" has an answer.
  CREATE TABLE IF NOT EXISTS pdf_text (
    content_hash TEXT PRIMARY KEY,       -- sha256 hex, joins to collection_files
    text TEXT NOT NULL,
    pages INTEGER NOT NULL,              -- pages actually read
    truncated INTEGER NOT NULL DEFAULT 0,
    chars INTEGER NOT NULL,
    extracted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- External-content FTS5 index over pdf_text.text: the index stores only its
  -- own structures and reads column values back from pdf_text, so the body text
  -- isn't duplicated. That makes pdf_text the single writable copy and the
  -- triggers below the only thing keeping the two in step -- an INSERT/UPDATE/
  -- DELETE on pdf_text that bypassed them would leave the index lying.
  --
  -- porter stemming so "resistance" answers a search for "resist"; unicode61 so
  -- accented author names and Greek letters tokenize as words.
  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_text_fts USING fts5(
    text,
    content='pdf_text',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS pdf_text_ai AFTER INSERT ON pdf_text BEGIN
    INSERT INTO pdf_text_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  -- External-content deletes/updates must hand FTS5 the *old* value so it can
  -- unindex the right terms; there is no way for it to look them up itself.
  CREATE TRIGGER IF NOT EXISTS pdf_text_ad AFTER DELETE ON pdf_text BEGIN
    INSERT INTO pdf_text_fts(pdf_text_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS pdf_text_au AFTER UPDATE ON pdf_text BEGIN
    INSERT INTO pdf_text_fts(pdf_text_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO pdf_text_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmark_folders_name ON bookmark_folders(name COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_bookmarks_pmid ON bookmarks(pmid);
  CREATE INDEX IF NOT EXISTS idx_collection_files_collection ON collection_files(collection_id);
  CREATE INDEX IF NOT EXISTS idx_collection_files_pmid ON collection_files(pmid);
  CREATE INDEX IF NOT EXISTS idx_collection_files_hash ON collection_files(content_hash);
  CREATE INDEX IF NOT EXISTS idx_article_topics_topic ON article_topics(topic_id);
  CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date);
  -- Filtering a source by descriptor reads article_mesh the other way round
  -- from its primary key: all pmids for a ui.
  CREATE INDEX IF NOT EXISTS idx_article_mesh_ui ON article_mesh(ui);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_title ON journal_catalog(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_journal_catalog_abbr ON journal_catalog(med_abbr COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_articles_nlm_id ON articles(nlm_id);
  CREATE INDEX IF NOT EXISTS idx_journals_nlm_id ON journals(nlm_id);
  CREATE INDEX IF NOT EXISTS idx_mesh_descriptors_name ON mesh_descriptors(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_mesh_entry_terms_term ON mesh_entry_terms(term COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_mesh_entry_terms_ui ON mesh_entry_terms(ui);
  -- On the expression, not the column: every DOI lookup compares lower(a.doi),
  -- because DOIs are case-insensitive by specification and PubMed's stored
  -- casing varies by publisher. An index on doi alone would not be used. This
  -- earns its place on holdingsByDois, which /have runs over a whole pasted
  -- reference list at once; the search box OR-s the same comparison in beside
  -- three LIKEs and scans regardless.
  CREATE INDEX IF NOT EXISTS idx_articles_doi_lower ON articles(lower(doi));
`);

// ---------- migrations ----------

// Add a column to an existing table, if it isn't there already.
//
// Everything above is CREATE ... IF NOT EXISTS, which was the whole story while
// the app had no installed base. It stops being enough the moment a column is
// added to a table that already exists somewhere: CREATE TABLE IF NOT EXISTS is
// a no-op against it, so the column simply never appears and every query naming
// it fails at runtime on exactly the databases that hold real data.
//
// This is the smallest mechanism that fixes that, and deliberately covers only
// the one schema change SQLite makes safe and idempotent. A column added here
// MUST also be added to the CREATE TABLE above, so a fresh database and an
// upgraded one end up with the same schema; anything beyond adding a column
// (renames, type changes, backfilled values) needs a real migration runner, and
// this should not be stretched to fake one.
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] added column ${table}.${column}`);
}

// Phase 2 (automatic MeSH filing). Existing rows default to "never looked",
// which is what puts them on the backfill's work list.
addColumnIfMissing("articles", "mesh_status", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("articles", "mesh_checked_at", "TEXT");
// journals predates this column; NULL here is exactly "not established yet",
// which is what a row keeps when the add-time check couldn't reach NCBI. The
// client reads it as three states, not two — see createJournal.
addColumnIfMissing("journals", "medline_indexed", "INTEGER");

// Indexes over migrated columns go here, not in the schema block above: on a
// database that predates the column, that block runs first and would fail on a
// column ALTER TABLE hasn't added yet.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_articles_mesh_status ON articles(mesh_status);
`);

// ---------- what "held" means ----------

// A collection_files row is a held copy exactly when it carries a pmid.
//
// The same set can be spelled `match_status = 'matched'`, and both spellings
// were in use: setFileMatched is the only writer that ever sets a pmid and it
// stamps that status in the same UPDATE, while setFileUnmatched and
// setFileError null the pmid in the same breath as moving the status off it.
// Nothing in the schema enforces that, though — the two are equal only by the
// good behaviour of three functions. Queries that picked different spellings
// would diverge the first time anything wrote a pmid outside them (a migration,
// a backfill, an importer pre-filling the column): the paper would count as
// held but link no file, so /have names a stored copy that the papers view
// reports as missing. One spelling everywhere can't drift, so custody is
// decided here and only here.
//
// collectionStats counts `match_status = 'matched'` and is right to: how many
// uploads got matched is a question about files, not about which papers are
// held.
//
// `alias` prefixes the column for queries that join collection_files under a
// name (`cf.`, `cf2.`); the subqueries selecting from it bare pass nothing.
const heldFile = (alias = "") => `${alias}pmid IS NOT NULL`;

// The distinct papers the user actually holds a file for — the Library, as the
// custody positioning means it.
const HELD_PAPERS = `(SELECT DISTINCT pmid FROM collection_files WHERE ${heldFile()})`;

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

// A new database starts empty — no seeded journals or topics. The user picks
// their own from the catalog (Manage journals) and MeSH (Add topic); "Auto"
// suggests journals once topics exist. Older databases may still carry a
// `seeded` settings row and the four journals it gated; nothing reads that
// flag anymore, and the journals are removable like any other.

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
   AND pmid NOT IN ${HELD_PAPERS}
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

// When a poll of every topic was last *attempted* (ISO timestamp; "" if never).
//
// Distinct from topics.last_polled_at, which is a record of success: a topic
// whose term is malformed, or every topic while NCBI is unreachable, never gets
// a watermark at all. Anything that asks "have we polled recently?" to decide
// whether to poll again needs this one instead, or a permanent failure answers
// "no" forever and it polls on a loop. Scheduler-managed like
// journal_catalog_loaded_at, so deliberately kept out of SETTING_DEFAULTS and
// never shown in the UI.
export function getLastPollAttemptAt(): string {
  const row = getSettingStmt.get("last_poll_attempt_at") as { value: string } | undefined;
  return row?.value ?? "";
}

export function setLastPollAttemptAt(iso: string): void {
  setSettingStmt.run("last_poll_attempt_at", iso);
}

// ---------- journals ----------

// Journal rows carry the catalog's metric (when the nlm_id matches a catalog
// entry whose metric has been fetched) so the client can sort by impact.
const JOURNAL_SELECT = `SELECT j.id, j.name, j.nlm_id, j.created_at, j.medline_indexed, c.metric
   FROM journals j LEFT JOIN journal_catalog c ON c.nlm_id = j.nlm_id`;

// SQLite has no boolean type, so medline_indexed round-trips as 1/0/NULL. The
// three states are all meaningful here (indexed / not indexed / not established
// yet), so this maps to boolean|null rather than coercing NULL to false — the
// client shows a warning on `false` only, and must not warn about a journal
// nobody has checked.
type JournalRow = Omit<Journal, "medline_indexed"> & { medline_indexed: number | null };

function toJournal(row: JournalRow): Journal {
  return { ...row, medline_indexed: row.medline_indexed === null ? null : row.medline_indexed === 1 };
}

export function listJournals(): Journal[] {
  const rows = db.prepare(`${JOURNAL_SELECT} ORDER BY j.name ASC`).all() as unknown as JournalRow[];
  return rows.map(toJournal);
}

// `medlineIndexed` is null when the check couldn't run — the add still succeeds
// rather than failing on an advisory lookup, and the row stays null. Nothing
// revisits it: the three places the client reads this test for `false`, so an
// unresolved journal shows no badge rather than a wrong one, and removing and
// re-adding it runs the check again.
export function createJournal(
  name: string,
  nlmId: string | null,
  medlineIndexed: boolean | null = null
): Journal {
  const info = db
    .prepare("INSERT INTO journals (name, nlm_id, medline_indexed) VALUES (?, ?, ?)")
    .run(name, nlmId, medlineIndexed === null ? null : Number(medlineIndexed));
  const row = db
    .prepare(`${JOURNAL_SELECT} WHERE j.id = ?`)
    .get(Number(info.lastInsertRowid)) as unknown as JournalRow;
  return toJournal(row);
}

// Used to reject adding the same journal twice (identity is the NLM id).
export function journalByNlmId(nlmId: string): Journal | undefined {
  const row = db.prepare(`${JOURNAL_SELECT} WHERE j.nlm_id = ?`).get(nlmId) as
    | JournalRow
    | undefined;
  return row ? toJournal(row) : undefined;
}

// Which of a journal's articles a removal would permanently delete: the
// journal's articles minus anything the user has saved — a collection file
// (library copies) or a bookmark, the same pinning rule the topic predicate
// applies. One WHERE fragment, bound to a single nlm_id param, shared
// by the confirm-dialog count and the destructive DELETE below — if the
// pinning rule ever changes, both move together, so the dialog can't promise
// one thing and the delete do another.
const DELETABLE_JOURNAL_ARTICLES = `nlm_id = ?
   AND pmid NOT IN ${HELD_PAPERS}
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

export type ArticleInsert = Omit<Article, "authors" | "first_seen_at" | "mesh_status"> & {
  authors: string[];
  // The paper's MeSH filing, when the fetch that produced this record carried
  // it. Status and headings travel together so they can never be written out of
  // step. `undefined` means this path didn't look, which leaves whatever is
  // already stored alone; a present value with `headings: []` is a fact worth
  // recording — PubMed has none for this paper — and is what the status tells
  // us how to read.
  mesh?: { status: string; headings: MeshHeading[] };
  // PublicationTypeList from that same XML. Deliberately carried inside `mesh`
  // rather than beside it — see setArticleXmlFacts. `[]` is meaningful (PubMed
  // listed nothing beyond the noise types); absent means nobody looked.
  pubTypes?: string[];
};

const deletePubTypesStmt = db.prepare("DELETE FROM article_pub_types WHERE pmid = ?");
const insertPubTypeStmt = db.prepare(
  "INSERT OR IGNORE INTO article_pub_types (pmid, type) VALUES (?, ?)"
);

// Everything one efetch record says about an article, written together.
//
// Together is the point. MeSH headings, the indexing status and the publication
// types all come out of a single XML document, and the status is what tells a
// reader how to interpret the other two ("no headings" and "no types" mean
// different things depending on whether NLM has finished with the record). A
// path that wrote one without the others would leave a row describing a fetch
// that never happened that way — which is exactly the trap the mesh comment
// below already warns about, now with a second column able to fall into it.
//
// Not a transaction wrapper: every caller already runs inside one.
function setArticleXmlFacts(a: ArticleInsert): void {
  if (a.mesh) setArticleMesh(a.pmid, a.mesh.status, a.mesh.headings);
  if (a.pubTypes) setArticlePubTypes(a.pmid, a.pubTypes);
}

// Replace an article's publication types. Replace rather than merge, for the
// same reason filing does: a re-fetch is PubMed's current answer in full, and a
// type NLM removed has to disappear here too.
//
// An empty list writes the PUB_TYPE_NONE sentinel rather than nothing, which is
// what makes "no stored types" mean "PubMed lists none" instead of "nobody has
// looked". Around half of all records genuinely carry no type, so without it
// that whole half would read as unclassified — see PUB_TYPE_NONE.
function setArticlePubTypes(pmid: string, types: string[]): void {
  deletePubTypesStmt.run(pmid);
  for (const t of types.length > 0 ? types : [PUB_TYPE_NONE]) insertPubTypeStmt.run(pmid, t);
}

// The stored types for a batch of articles, sentinel included — reading them is
// evidenceFromRows' job, not this one's. Articles nobody has looked at are
// absent from the map, which is the distinction the sentinel exists to preserve.
export function pubTypesByPmids(pmids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = queryByPmids<{ pmid: string; type: string }>(
    pmids,
    (ph) => `SELECT pmid, type FROM article_pub_types WHERE pmid IN (${ph})`
  );
  for (const r of rows) {
    const list = out.get(r.pmid);
    if (list) list.push(r.type);
    else out.set(r.pmid, [r.type]);
  }
  return out;
}

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
    setArticleXmlFacts(a);
    linkArticleStmt.run(a.pmid, topicId);
  }
});

// ---------- MeSH filing ----------

const deleteArticleMeshStmt = db.prepare("DELETE FROM article_mesh WHERE pmid = ?");
const insertArticleMeshStmt = db.prepare(
  "INSERT INTO article_mesh (pmid, ui, name, major) VALUES (?, ?, ?, ?)"
);
const stampMeshStmt = db.prepare(
  "UPDATE articles SET mesh_status = ?, mesh_checked_at = datetime('now') WHERE pmid = ?"
);

// Record one article's filing: replace its headings and stamp what PubMed said
// about them. Replace rather than merge, because a re-check is PubMed's current
// answer in full — a heading NLM removed has to disappear here too, or the
// facet keeps offering a subject the paper is no longer filed under.
//
// A blank status is stored as MESH_STATUS_UNAVAILABLE rather than as "", which
// means "never looked": PubMed always stamps MedlineCitation/@Status, so an
// empty one is a record shaped differently from what we parse. Left as "", the
// row would stay on the backfill's work list and be re-fetched on every run,
// forever. The sentinel is not a settled status, so it is simply asked about
// again after the recheck window.
//
// Not a transaction wrapper: every caller already runs inside one, and the
// wrapper's BEGIN can't nest.
function setArticleMesh(pmid: string, status: string, headings: MeshHeading[]): void {
  deleteArticleMeshStmt.run(pmid);
  for (const h of headings) {
    insertArticleMeshStmt.run(pmid, h.ui, h.name, Number(h.major));
  }
  stampMeshStmt.run(status || MESH_STATUS_UNAVAILABLE, pmid);
}

export interface ArticleMeshInsert {
  pmid: string;
  status: string;
  headings: MeshHeading[];
  // Same XML, same write — see setArticleXmlFacts. Absent for a PMID efetch
  // didn't return, where there is nothing to record either way.
  pubTypes?: string[];
}

// The backfill's write: a whole efetch batch in one transaction.
export const saveArticleMesh = transaction((rows: ArticleMeshInsert[]) => {
  for (const r of rows) {
    setArticleMesh(r.pmid, r.status, r.headings);
    if (r.pubTypes) setArticlePubTypes(r.pmid, r.pubTypes);
  }
});

// Placeholder list + params for "this status settles the question for good".
// Everything outside it is treated as still in flight, matching meshOutlook —
// the two readings of PubMed's status vocabulary have to agree, so the SQL side
// derives its list from the same constant rather than repeating the strings.
const SETTLED_PLACEHOLDERS = MESH_SETTLED_STATUSES.map(() => "?").join(",");
const SETTLED_PARAMS = [...MESH_SETTLED_STATUSES];

// The backfill's work list: articles nobody has fetched headings for, plus ones
// PubMed hadn't finished indexing when we last looked and that are due another
// ask. Newest first — those are the ones a reader is most likely to be looking
// at, and the ones most likely to still be mid-indexing.
//
// Re-queried each pass rather than snapshotted, so the job is resumable with no
// cursor to persist. That only terminates because
// every write stamps mesh_checked_at and a non-empty status: a row leaves the
// list either by settling or by falling outside the recheck window.
export function articlesMissingMesh(limit: number, recheckDays = 30): string[] {
  const rows = db
    .prepare(
      `SELECT pmid FROM articles
       WHERE mesh_status = ''
          OR (mesh_status NOT IN (${SETTLED_PLACEHOLDERS})
              AND (mesh_checked_at IS NULL OR mesh_checked_at < datetime('now', ?)))
       ORDER BY pub_date DESC, pmid DESC
       LIMIT ?`
    )
    .all(...SETTLED_PARAMS, `-${recheckDays} days`, limit) as { pmid: string }[];
  return rows.map((r) => r.pmid);
}

// How many articles that work list holds in total, for the "is there anything
// to do?" check and the job's opening log line.
export function meshBacklogCount(recheckDays = 30): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM articles
         WHERE mesh_status = ''
            OR (mesh_status NOT IN (${SETTLED_PLACEHOLDERS})
                AND (mesh_checked_at IS NULL OR mesh_checked_at < datetime('now', ?)))`
      )
      .get(...SETTLED_PARAMS, `-${recheckDays} days`) as { c: number }
  ).c;
}

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
//
// For a collection the same query also searches the body text of the PDFs that
// collection holds. That asymmetry is the point rather than an oversight: a
// collection is what the user *holds*, so there is a document to search, while
// a topic or bookmark folder is a list of papers seen — mostly with no file
// behind them — where body matching would return a subset that depended on
// which papers happened to have been imported somewhere else.
//
// The body clause is an uncorrelated subquery, so SQLite evaluates the FTS
// match once rather than per candidate row. Deliberately no snippet() here:
// FTS5's auxiliary functions are only legal where the index is scanned
// directly, and this shape has to survive being embedded in two different outer
// queries. Snippets come from snippetsForSearch below, over the rows that
// actually came back.
function searchPredicate(
  q: string | undefined,
  params: (string | number)[],
  source?: PaperSourceQuery
): string {
  if (!q) return "";
  // Bind order follows the *textual* order of the ? placeholders below, so the
  // three LIKEs are pushed before the identifier and body clauses that trail
  // them. Getting this backwards binds the collection id to an author LIKE and
  // silently returns nothing at all, which no type checks and no schema catches.
  const like = `%${escapeLike(q)}%`;
  params.push(like, like, like);

  // Exact identifier matches, OR-ed *into* the text search rather than replacing
  // it. Neither column is otherwise searched, so today a pasted DOI or PMID
  // matches nothing in title, abstract or authors and the box answers a
  // perfectly good identifier with an empty result — indistinguishable from
  // "you don't own this", which is the false negative that ends in re-buying a
  // paper the library already holds.
  //
  // A union can only add rows, so nothing that matches today stops matching.
  // That is what makes this safe to do to a box that re-queries on every
  // keystroke: sniffing the input and *routing* to an identifier lookup instead
  // would flip modes mid-type as `10.10` becomes `10.1056/…`, while a
  // half-typed identifier here simply matches nothing and the text clauses
  // carry on.
  const { pmid, doi } = searchIdentifiers(q);
  let ids = "";
  if (doi) {
    params.push(doi);
    ids += `
        OR (a.doi <> '' AND lower(a.doi) = ?)`;
  }
  if (pmid) {
    params.push(pmid);
    ids += `
        OR a.pmid = ?`;
  }

  // Body text, for the sources that have documents behind them. Narrowed to one
  // collection when that is the source and left unscoped when the source is
  // every collection — the same clause, one fewer bound parameter.
  let body = "";
  const match = sourceHasFiles(source) ? toFtsQuery(q) : null;
  if (match) {
    const collectionId = source && "collectionId" in source ? source.collectionId : null;
    params.push(match);
    if (collectionId != null) params.push(collectionId);
    body = `
        OR a.pmid IN (SELECT cf2.pmid FROM pdf_text_fts
                      JOIN pdf_text pt ON pt.rowid = pdf_text_fts.rowid
                      JOIN collection_files cf2 ON cf2.content_hash = pt.content_hash
                      WHERE pdf_text_fts MATCH ?${collectionId != null ? " AND cf2.collection_id = ?" : ""}
                        AND ${heldFile("cf2.")})`;
  }
  return `(a.title LIKE ? ESCAPE '\\'
        OR a.abstract LIKE ? ESCAPE '\\'
        OR a.authors LIKE ? ESCAPE '\\'${ids}${body})`;
}

// The subject condition, the second half of what narrows a paper source.
// Selecting several descriptors keeps a paper filed under ANY of them, which is
// how a facet normally reads ("show me either subject") and the only version
// that stays useful — ANDing two headings usually lands on nothing, since a
// paper is filed under the handful of subjects it is actually about.
//
// `major` narrows to PubMed's starred headings: papers the descriptor is a
// *main point* of, rather than ones that merely mention it. That is the
// difference between a filing system and a keyword search, so it's a filter and
// not a ranking.
//
// Same contract as searchPredicate: appends its own bind params in the textual
// order of its placeholders, and returns "" when there's nothing to add.
function meshPredicate(
  uis: string[] | undefined,
  major: boolean | undefined,
  params: (string | number)[]
): string {
  if (!uis || uis.length === 0) return "";
  params.push(...uis);
  const placeholders = uis.map(() => "?").join(",");
  return `a.pmid IN (SELECT am.pmid FROM article_mesh am
                     WHERE am.ui IN (${placeholders})${major ? " AND am.major = 1" : ""})`;
}

// Everything narrowing a source's papers, in one place so /papers and /graph
// can't disagree about what a given set of filters selects — the same reason
// searchPredicate is shared. Params are pushed in the textual order the clauses
// appear, which is the order they're ANDed below; getting that wrong binds a
// descriptor id to an author LIKE and silently returns nothing.
export interface PaperFilter {
  q?: string;
  mesh?: string[]; // MeSH descriptor UIs
  meshMajor?: boolean;
}

function filterClause(
  source: PaperSourceQuery,
  filter: PaperFilter,
  params: (string | number)[]
): string {
  const clauses = [
    searchPredicate(filter.q, params, source),
    meshPredicate(filter.mesh, filter.meshMajor, params),
  ].filter(Boolean);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

// Highlighted excerpts for the papers a body-text search matched, keyed by pmid.
// Runs as its own statement because snippet() cannot be used in a query that
// also groups or is flattened into a join (see searchPredicate) — and because
// only the papers view wants excerpts, so the graph shouldn't pay for them.
//
// One pmid can have several matching files; the first excerpt wins, which is
// arbitrary but stable enough (rows come back in rowid order) and no worse than
// picking by a relevance the user never sees.
function snippetsForSearch(source: PaperSourceQuery, q: string): Map<string, string> {
  const out = new Map<string, string>();
  // A source with no files behind it has no excerpts, and must not borrow any.
  // The signature used to be (collectionId: number, q), which made that
  // unrepresentable; taking a PaperSourceQuery means a topic or folder can now
  // be passed, and it would fall through to the null collectionId below — the
  // same null that means "every collection". A fileless source would then draw
  // excerpts from PDFs library-wide, for papers it only ever saw. listPapers
  // screens for this too; the type no longer does, so the function has to.
  if (!sourceHasFiles(source)) return out;
  const match = toFtsQuery(q);
  if (!match) return out;
  // Scoped the same way the body clause in searchPredicate is, so a paper can't
  // come back from the search without its excerpt or vice versa. Past the guard
  // above, a null collectionId can only mean every collection.
  const collectionId = "collectionId" in source ? source.collectionId : null;
  const rows = db
    .prepare(
      `SELECT cf.pmid AS pmid,
              snippet(pdf_text_fts, 0, ?, ?, '…', 14) AS snip
       FROM pdf_text_fts
       JOIN pdf_text pt ON pt.rowid = pdf_text_fts.rowid
       JOIN collection_files cf ON cf.content_hash = pt.content_hash
       WHERE pdf_text_fts MATCH ?${collectionId != null ? " AND cf.collection_id = ?" : ""}
         AND ${heldFile("cf.")}`
    )
    .all(
      SNIPPET_OPEN,
      SNIPPET_CLOSE,
      match,
      ...(collectionId != null ? [collectionId] : [])
    ) as { pmid: string; snip: string }[];
  for (const r of rows) if (!out.has(r.pmid)) out.set(r.pmid, r.snip);
  return out;
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
// saved papers, one collection's matched uploads, or every collection at once.
// Mirrors the client's PaperSource.
export type PaperSourceQuery =
  | { topicId: number }
  | { folderId: number }
  | { collectionId: number }
  | { allCollections: true };

// Does this source have uploaded files behind its papers? True for both
// collection kinds and false for topics and bookmark folders, which are lists
// of papers *seen* rather than held. Three separate places used to spell this
// as `"collectionId" in source`, which silently answered "no" the moment a
// second file-bearing source existed — the papers view would have dropped its
// file columns, its body-text search and its excerpts all at once.
export function sourceHasFiles(source?: PaperSourceQuery): boolean {
  return !!source && ("collectionId" in source || "allCollections" in source);
}

// The join that narrows `articles a` down to one source's papers, plus the
// params it binds. Every per-source query — the papers list, the journal chips,
// the graph — is built on this single fragment, so the views can't disagree
// about what a source contains, and a new source kind is added here instead of
// in three near-identical queries. Routes dispatch through the exported
// wrappers (journalsForSource / listPapers / graphPapersForSource) rather than
// picking per-source functions themselves.
//
// `withFiles` appends the link to each paper's stored copy, and belongs to the
// two callers that select sourceFileCols — the papers list and the graph. The
// journal chips, the MeSH facets and the filing counts select nothing from
// `cf`, and used to compute the link anyway: a GROUP BY over collection_files
// per query, unbounded by any collection once the all-collections source could
// ask for it. Measured on a 20k-paper library, that was ~18ms wasted per query
// and ~55ms per switch into All collections, which loads three of them.
//
// A caller that selects sourceFileCols without passing true fails loudly, on
// `no such column: cf.id` the first time SQLite prepares the statement.
function sourceMembership(
  source: PaperSourceQuery,
  withFiles = false
): {
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
  // One collection, or every collection at once: the same three joins either
  // way — a row per distinct held pmid, linked to the lowest-id file carrying
  // it — differing only in whether a collection bounds them. One text rather
  // than two near-identical ones, because the pair had already drifted into
  // spelling "held" two different ways, and unscoped it is HELD_PAPERS by
  // construction rather than a fourth copy of it.
  //
  // Unscoped answers "do I hold this anywhere?", which is the question a writer
  // checking against a purchase is actually asking. A paper held in three
  // collections is one row, linked by the same MIN(id) convention
  // HOLDING_SELECT uses to answer /have; the two must not disagree about which
  // copy they mean, which is why both decide "held" with heldFile.
  const collectionId = "allCollections" in source ? null : source.collectionId;
  const scope = collectionId === null ? "" : "collection_id = ? AND ";
  const fileLink = withFiles
    ? `LEFT JOIN (SELECT pmid, MIN(id) AS file_id FROM collection_files
                  WHERE ${scope}${heldFile()}
                  GROUP BY pmid) mf ON mf.pmid = a.pmid
       LEFT JOIN collection_files cf ON cf.id = mf.file_id`
    : "";
  // One bound id per subquery carrying the scope clause: cp always, mf only
  // when the file link is there. Binding a fixed two would put the collection
  // id into whatever placeholder the caller appended next.
  const bind = collectionId === null ? [] : [collectionId];
  return {
    join: `JOIN (SELECT DISTINCT pmid FROM collection_files
              WHERE ${scope}${heldFile()}) cp ON cp.pmid = a.pmid
       ${fileLink}`,
    params: withFiles ? [...bind, ...bind] : bind,
  };
}

// The linked-PDF columns for a source. Only a collection has uploaded files
// behind its papers; topics and bookmark folders select constant nulls so every
// source hands back the same row shape.
function sourceFileCols(source: PaperSourceQuery): string {
  return sourceHasFiles(source)
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

// The subjects present in a source, most-used first — the facet list the
// toolbar browses. Ranked by how much of the source each descriptor accounts
// for rather than alphabetically, because the useful question of a library is
// "what is this mostly about", and an A-Z list of several thousand headings
// answers nothing.
//
// `limit` is what keeps the response a dropdown's worth of data instead of the
// whole vocabulary: a few thousand MEDLINE papers carry tens of thousands of
// distinct descriptors between them. `q` filters by heading text, so searching
// reaches past the cut rather than only re-ordering what already came back.
export function meshFacetsForSource(
  source: PaperSourceQuery,
  q?: string,
  limit = 200
): MeshFacet[] {
  const { join, params } = sourceMembership(source);
  let filter = "";
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    filter = "WHERE am.name LIKE ? ESCAPE '\\'";
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT am.ui AS ui, MIN(am.name) AS name,
              COUNT(*) AS count, SUM(am.major) AS majorCount
       FROM articles a
       ${join}
       JOIN article_mesh am ON am.pmid = a.pmid
       ${filter}
       GROUP BY am.ui
       ORDER BY count DESC, majorCount DESC, name ASC
       LIMIT ?`
    )
    .all(...params) as unknown as MeshFacet[];
}

// How completely a source's papers are filed. Every paper lands in exactly one
// bucket, which is the point: a facet list that covers 40 of 300 papers means
// something entirely different depending on whether the other 260 are
// non-MEDLINE (nothing to file, nothing to fix) or simply not looked at yet.
//
// The status ladder mirrors meshOutlook rung for rung — 'none'/'indexed'/
// 'pending'/'unchecked' are its four outcomes — except that headings win over
// any status: a paper we hold headings for is filed, whatever PubMed last said
// about its indexing state.
//
// PubMed-not-MEDLINE is tested before the settled list it belongs to, exactly as
// meshOutlook tests it before its own. Collapsing the two rungs — every settled
// status with no headings into one bucket — reported a fully MEDLINE-indexed
// paper that NLM happened to file under nothing as "not indexed for MEDLINE",
// which is the opposite of what its status says.
export function meshFilingForSource(source: PaperSourceQuery): MeshFiling {
  const { join, params } = sourceMembership(source);
  const rows = db
    .prepare(
      `SELECT bucket, COUNT(*) AS c FROM (
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM article_mesh am WHERE am.pmid = a.pmid) THEN 'filed'
           WHEN a.mesh_status = '' THEN 'unchecked'
           WHEN a.mesh_status = ? THEN 'none'
           WHEN a.mesh_status IN (${SETTLED_PLACEHOLDERS}) THEN 'indexed'
           ELSE 'pending'
         END AS bucket
         FROM articles a
         ${join}
       )
       GROUP BY bucket`
    )
    // Bind order follows the *textual* order of the placeholders: the never-
    // indexed status, then the settled list, then the join that carries the
    // source's own params. Reversing these binds a collection id as a status
    // and the join matches nothing, which reads as a source with no papers at
    // all rather than as an error.
    .all(MESH_STATUS_NEVER, ...SETTLED_PARAMS, ...params) as {
    bucket: keyof MeshFiling;
    c: number;
  }[];
  const out: MeshFiling = { filed: 0, indexed: 0, none: 0, pending: 0, unchecked: 0 };
  for (const r of rows) out[r.bucket] = r.c;
  return out;
}

// ---------- topic suggestions (from what the Library actually holds) ----------

// MeSH check tags: headings NLM adds to describe a study's population rather
// than its subject. They sit on a huge share of all MEDLINE papers, so by count
// they would take every slot in a suggestion list and say nothing — "Humans" is
// not a topic anyone wants a feed of.
//
// Matched on either the descriptor id or the heading, because the two fail
// differently: an id typo here silently stops filtering, while a heading NLM
// revises does the same. Both matching is belt and braces on a list that has to
// be right for the feature to be worth showing at all.
//
// One list of pairs rather than two parallel lists: those had to be edited
// together, in the same order, with the ui↔name pairing checked by eye, and a
// ui added without its name left the filter half-applied — which shows up only
// as a check tag quietly reappearing in the suggestions.
const CHECK_TAGS = [
  ["D006801", "Humans"],
  ["D008297", "Male"],
  ["D005260", "Female"],
  ["D000818", "Animals"],
  ["D000328", "Adult"],
  ["D008875", "Middle Aged"],
  ["D000368", "Aged"],
  ["D000369", "Aged, 80 and over"],
  ["D000293", "Adolescent"],
  ["D002648", "Child"],
  ["D002675", "Child, Preschool"],
  ["D007223", "Infant"],
  ["D007231", "Infant, Newborn"],
  ["D055815", "Young Adult"],
  ["D011247", "Pregnancy"],
  ["D051379", "Mice"],
  ["D051381", "Rats"],
  ["D004285", "Dogs"],
  ["D002415", "Cats"],
  ["D002417", "Cattle"],
] as const;

const CHECK_TAG_UIS = CHECK_TAGS.map(([ui]) => ui);
const CHECK_TAG_NAMES = CHECK_TAGS.map(([, name]) => name);

// Subjects the held papers cluster around that aren't topics yet.
//
// Drawn from HELD_PAPERS and not from the topic feeds on purpose: a topic
// feed's papers were selected *by* a topic, so ranking their headings mostly
// recommends the topics that are already there.
//
// Ordered by how many held papers the descriptor is a *main point* of before
// total appearances: a heading starred on ten papers is a subject this library
// is about, while one mentioned in passing by fifty is background. Headings
// already watched are excluded — suggesting a topic the user has is noise — as
// are check tags (above).
export function suggestTopicsFromLibrary(limit = 12): TopicSuggestion[] {
  const excluded = CHECK_TAG_UIS;
  const excludedNames = CHECK_TAG_NAMES;
  return db
    .prepare(
      `SELECT am.ui AS ui, MIN(am.name) AS name,
              COUNT(*) AS papers, SUM(am.major) AS majorPapers
       FROM ${HELD_PAPERS} held
       JOIN article_mesh am ON am.pmid = held.pmid
       WHERE am.ui NOT IN (${excluded.map(() => "?").join(",")})
         AND am.name NOT IN (${excludedNames.map(() => "?").join(",")})
         AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.name = am.name COLLATE NOCASE)
       GROUP BY am.ui
       ORDER BY majorPapers DESC, papers DESC, name ASC
       LIMIT ?`
    )
    .all(...excluded, ...excludedNames, limit) as unknown as TopicSuggestion[];
}

// What the ranking above had to work with: how many held papers carry any
// headings, and how many are still waiting on the backfill. Without the second
// number an empty suggestion list can't say whether the library has no clear
// subjects or simply hasn't been filed yet.
export function libraryFilingCounts(): { heldPapers: number; unchecked: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN EXISTS (SELECT 1 FROM article_mesh am WHERE am.pmid = held.pmid)
                  THEN 1 ELSE 0 END) AS heldPapers,
         SUM(CASE WHEN a.mesh_status = '' THEN 1 ELSE 0 END) AS unchecked
       FROM ${HELD_PAPERS} held
       JOIN articles a ON a.pmid = held.pmid`
    )
    .get() as { heldPapers: number | null; unchecked: number | null };
  return { heldPapers: row.heldPapers ?? 0, unchecked: row.unchecked ?? 0 };
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
  filter: PaperFilter = {}
): Array<Omit<Paper, "file_exists"> & { content_hash: string | null }> {
  const { join, params } = sourceMembership(source, true);
  const search = filterClause(source, filter, params);
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
    Omit<Paper, "file_exists" | "authors" | "snippet"> & {
      authors: string;
      content_hash: string | null;
    }
  >;
  // Excerpts exist only for a collection search, and only for papers the query
  // matched *inside the document*. A paper matched on title alone gets none, so
  // the excerpt's presence tells the reader the words are actually in the file.
  const snippets = filter.q && sourceHasFiles(source) ? snippetsForSearch(source, filter.q) : null;
  return rows.map((r) => ({
    ...r,
    authors: safeParseAuthors(r.authors),
    snippet: snippets?.get(r.pmid) ?? null,
  }));
}

// The `authors` column is a JSON array of name strings. Exported because every
// consumer of a raw article row has to survive the same thing: a column that
// somehow isn't valid JSON must render as "no authors listed", not throw
// halfway through building a response.
export function safeParseAuthors(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------- "do I already have this?" ----------

// One paper as the holdings check sees it: the article record, plus the stored
// copy behind it when there is one.
//
// `held` is decided by a collection_files row, never by the article's presence
// in `articles` — a paper a topic feed turned up is one the user has *seen*,
// and answering "yes you have it" about a record with no file is exactly the
// mistake that would send a writer to a PDF they never bought.
export interface HoldingRow {
  pmid: string;
  title: string;
  journal_name: string;
  authors: string; // JSON array, parsed by the caller
  pub_date: string;
  pub_date_display: string;
  doi: string;
  url: string;
  file_id: number | null;
  file_name: string | null;
  content_hash: string | null; // routes resolves this to file_exists
  collection_id: number | null;
  collection_name: string | null;
}

// The stored copy for a paper, across every collection: the lowest-id file row
// that heldFile counts as held — the same set, and the same MIN(id) pick, the
// collection views join on, so /have and the papers list can't name different
// copies of one paper. One subquery here rather than two, because this query
// has no collection to scope to.
//
// A paper held in several collections resolves to one of them, arbitrarily but
// stably (lowest id = first uploaded). The question being answered is "do we
// have this", not "how many copies", and naming the first is more useful than
// naming none.
const HOLDING_SELECT = `SELECT a.pmid, a.title, ${JOURNAL_DISPLAY} AS journal_name,
          a.authors, a.pub_date, a.pub_date_display, a.doi, a.url,
          cf.id AS file_id, cf.file_name AS file_name, cf.content_hash AS content_hash,
          cf.collection_id AS collection_id, col.name AS collection_name
   FROM articles a
   ${JOURNAL_LOOKUP}
   LEFT JOIN (SELECT pmid, MIN(id) AS file_id FROM collection_files
              WHERE ${heldFile()} GROUP BY pmid) hf ON hf.pmid = a.pmid
   LEFT JOIN collection_files cf ON cf.id = hf.file_id
   LEFT JOIN collections col ON col.id = cf.collection_id`;

// Look up stored papers by PMID. Unknown ids are simply absent.
export function holdingsByPmids(pmids: string[]): HoldingRow[] {
  if (pmids.length === 0) return [];
  return queryByPmids<HoldingRow>(pmids, (ph) => `${HOLDING_SELECT} WHERE a.pmid IN (${ph})`);
}

// The same, keyed by DOI. Compared lowercased on both sides because DOIs are
// case-insensitive by specification and PubMed's stored casing varies by
// publisher — a literal match would report a held paper as not held.
export function holdingsByDois(dois: string[]): HoldingRow[] {
  const out: HoldingRow[] = [];
  for (let i = 0; i < dois.length; i += 900) {
    const batch = dois.slice(i, i + 900).map((d) => d.toLowerCase());
    const ph = batch.map(() => "?").join(",");
    out.push(
      ...(db
        .prepare(`${HOLDING_SELECT} WHERE a.doi <> '' AND lower(a.doi) IN (${ph})`)
        .all(...batch) as unknown as HoldingRow[])
    );
  }
  return out;
}

// Held papers matching an author surname and a publication year — the fallback
// for a citation string, which carries no identifier at all.
//
// Restricted to papers the user holds a file for, unlike the two lookups above.
// A surname and a year select broadly, and running them over the whole article
// table would rank a topic feed's thousands of merely-seen papers alongside the
// handful actually in the library — turning a custody question into a search.
// The answer for a paper with no file is "no" either way, so nothing is lost.
//
// `authors` is a JSON array of "Surname II" strings, so a LIKE over the stored
// text matches any author of the paper, not only the first. That is deliberate:
// a citation string names whoever led the paper, and reference styles disagree
// about who that is.
export function heldByAuthorYear(authorKey: string, year: number, limit = 8): HoldingRow[] {
  return db
    .prepare(
      `${HOLDING_SELECT}
       WHERE hf.file_id IS NOT NULL
         AND a.authors LIKE ? ESCAPE '\\'
         AND a.pub_date LIKE ?
       ORDER BY a.pub_date DESC, a.pmid DESC
       LIMIT ?`
    )
    .all(`%${escapeLike(authorKey)}%`, `${year}%`, limit) as unknown as HoldingRow[];
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
export function graphPapersForSource(
  source: PaperSourceQuery,
  filter: PaperFilter = {}
): GraphPaper[] {
  const { join, params } = sourceMembership(source, true);
  const where = filterClause(source, filter, params);
  return db
    .prepare(
      `SELECT a.pmid, a.title, a.url, a.pub_date, ${JOURNAL_DISPLAY} AS journal_name,
              ${sourceFileCols(source)}
       FROM articles a
       ${join}
       ${JOURNAL_LOOKUP}
       ${where}`
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
//
// The extracted text goes with the blob. It is keyed by content_hash and can
// outlive any single file row (that is the point — a re-upload reuses it), so
// the moment the last row referencing the hash is gone, keeping the text would
// leave an unreachable document permanently answering searches.
export function gcBlobsIfOrphaned(hashes: string[]): void {
  const orphaned = [...new Set(hashes)].filter((h) => countFilesByHash(h) === 0);
  if (orphaned.length === 0) return;
  const deleteText = db.prepare("DELETE FROM pdf_text WHERE content_hash = ?");
  for (const h of orphaned) deleteText.run(h); // triggers unindex it from FTS
  deleteBlobs(orphaned);
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

// ---------- extracted PDF text (full-text search) ----------

export interface PdfTextInsert {
  contentHash: string;
  text: string;
  pages: number;
  truncated: boolean;
}

// Store (or replace) one PDF's extracted text. Replace rather than ignore, so
// re-running extraction after an extractor improvement actually updates the
// index; the AFTER UPDATE trigger re-indexes it.
export function savePdfText(t: PdfTextInsert): void {
  db.prepare(
    `INSERT INTO pdf_text (content_hash, text, pages, truncated, chars)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       text = excluded.text, pages = excluded.pages,
       truncated = excluded.truncated, chars = excluded.chars,
       extracted_at = datetime('now')`
  ).run(t.contentHash, t.text, t.pages, Number(t.truncated), t.text.length);
}

// Insert/refresh articles without linking them to a topic (collections track
// membership in collection_files instead of article_topics).
export const upsertArticles = transaction((articles: ArticleInsert[]) => {
  for (const a of articles) {
    upsertArticle(a);
    setArticleXmlFacts(a);
  }
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
// it's deliberately kept out of SETTING_DEFAULTS (never shown/edited in the UI)
// and read/written through the raw statements instead.
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
