import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH, ENV_DEFAULTS } from "./config.js";
import type { Article, Disease, Journal, Settings } from "./types.js";

// Ensure the data directory exists before opening the database.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS articles (
    pmid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    journal_name TEXT NOT NULL DEFAULT '',
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

  CREATE INDEX IF NOT EXISTS idx_article_diseases_disease ON article_diseases(disease_id);
  CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date);
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

export function getSettings(): Settings {
  return {
    ncbi_api_key: getSetting("ncbi_api_key"),
    ncbi_email: getSetting("ncbi_email"),
    poll_cron: getSetting("poll_cron"),
  };
}

// Seed editable settings from env defaults only if not already present.
for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (getSettingStmt.get(key) === undefined) {
    setSettingStmt.run(key, value);
  }
}

// ---------- first-run example data ----------

const seedFlag = getSettingStmt.get("seeded") as { value: string } | undefined;
if (!seedFlag) {
  const journalCount = (db.prepare("SELECT COUNT(*) AS c FROM journals").get() as { c: number }).c;
  const diseaseCount = (db.prepare("SELECT COUNT(*) AS c FROM diseases").get() as { c: number }).c;
  if (journalCount === 0 && diseaseCount === 0) {
    const insJ = db.prepare("INSERT OR IGNORE INTO journals (name) VALUES (?)");
    for (const name of [
      "New England Journal of Medicine",
      "Lancet",
      "JAMA",
      "Nature Medicine",
    ]) {
      insJ.run(name);
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
    .all() as Disease[];
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
    .all() as Journal[];
}

export function createJournal(name: string): Journal {
  const info = db.prepare("INSERT INTO journals (name) VALUES (?)").run(name);
  return db
    .prepare("SELECT id, name, created_at FROM journals WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Journal;
}

export function deleteJournal(id: number): void {
  db.prepare("DELETE FROM journals WHERE id = ?").run(id);
}

// ---------- articles ----------

export function existingPmids(pmids: string[]): Set<string> {
  const found = new Set<string>();
  // Chunk to stay well under SQLite's bound-parameter limit: an all-time search
  // can hand us thousands of PMIDs in a single call.
  for (let i = 0; i < pmids.length; i += 900) {
    const batch = pmids.slice(i, i + 900);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT pmid FROM articles WHERE pmid IN (${placeholders})`)
      .all(...batch) as { pmid: string }[];
    for (const r of rows) found.add(r.pmid);
  }
  return found;
}

const upsertArticleStmt = db.prepare(`
  INSERT INTO articles (pmid, title, abstract, journal_name, authors, pub_date, pub_date_display, doi, url)
  VALUES (@pmid, @title, @abstract, @journal_name, @authors, @pub_date, @pub_date_display, @doi, @url)
  ON CONFLICT(pmid) DO UPDATE SET
    title = excluded.title,
    abstract = excluded.abstract,
    journal_name = excluded.journal_name,
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
export const saveArticles = db.transaction((articles: ArticleInsert[], diseaseId: number) => {
  for (const a of articles) {
    upsertArticleStmt.run({
      pmid: a.pmid,
      title: a.title,
      abstract: a.abstract,
      journal_name: a.journal_name,
      authors: JSON.stringify(a.authors),
      pub_date: a.pub_date,
      pub_date_display: a.pub_date_display,
      doi: a.doi,
      url: a.url,
    });
    linkArticleStmt.run(a.pmid, diseaseId);
  }
});

export interface ArticleQuery {
  diseaseId: number;
  journal?: string;
  q?: string;
}

export function listArticles({ diseaseId, journal, q }: ArticleQuery): Article[] {
  const clauses = ["ad.disease_id = ?"];
  const params: unknown[] = [diseaseId];
  if (journal) {
    clauses.push("a.journal_name = ?");
    params.push(journal);
  }
  if (q) {
    clauses.push("(a.title LIKE ? OR a.abstract LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT a.* FROM articles a
       JOIN article_diseases ad ON ad.pmid = a.pmid
       WHERE ${clauses.join(" AND ")}
       ORDER BY a.pub_date DESC, a.pmid DESC`
    )
    .all(...params) as Array<Omit<Article, "authors"> & { authors: string }>;
  return rows.map((r) => ({ ...r, authors: safeParseAuthors(r.authors) }));
}

export function diseaseArticleCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT disease_id, COUNT(*) AS c FROM article_diseases GROUP BY disease_id")
    .all() as { disease_id: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.disease_id] = r.c;
  return out;
}

// Distinct journal names that actually have articles for a disease (for filter chips).
export function journalsForDisease(diseaseId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.journal_name AS j FROM articles a
       JOIN article_diseases ad ON ad.pmid = a.pmid
       WHERE ad.disease_id = ? AND a.journal_name <> ''
       ORDER BY j ASC`
    )
    .all(diseaseId) as { j: string }[];
  return rows.map((r) => r.j);
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
}

// The papers that make up one disease's graph (green nodes).
export function graphPapers(diseaseId: number): GraphPaper[] {
  return db
    .prepare(
      `SELECT a.pmid, a.title, a.url FROM articles a
       JOIN article_diseases ad ON ad.pmid = a.pmid
       WHERE ad.disease_id = ?`
    )
    .all(diseaseId) as GraphPaper[];
}

// PMIDs that have no cached citation row, or whose row is older than maxAgeDays.
export function missingOrStaleCitations(pmids: string[], maxAgeDays = 14): string[] {
  const fresh = new Set<string>();
  const cutoff = `-${maxAgeDays} days`;
  for (let i = 0; i < pmids.length; i += 900) {
    const batch = pmids.slice(i, i + 900);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT pmid FROM paper_citations
         WHERE pmid IN (${placeholders}) AND fetched_at >= datetime('now', ?)`
      )
      .all(...batch, cutoff) as { pmid: string }[];
    for (const r of rows) fresh.add(r.pmid);
  }
  return pmids.filter((p) => !fresh.has(p));
}

export function getCitations(pmids: string[]): Map<string, CitationInfo> {
  const out = new Map<string, CitationInfo>();
  for (let i = 0; i < pmids.length; i += 900) {
    const batch = pmids.slice(i, i + 900);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT pmid, citation_count, references_json FROM paper_citations
         WHERE pmid IN (${placeholders})`
      )
      .all(...batch) as { pmid: string; citation_count: number; references_json: string }[];
    for (const r of rows) {
      out.set(r.pmid, {
        citation_count: r.citation_count,
        references: safeParseRefs(r.references_json),
      });
    }
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

export const upsertCitations = db.transaction(
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
