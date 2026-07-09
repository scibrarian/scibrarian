// Shapes shared verbatim between the server (DB/API layer) and the client.
// The client extends some of these with fields its API responses add — see
// client/src/types.ts.

export interface Disease {
  id: number;
  name: string;
  term: string;
  last_polled_at: string | null;
  created_at: string;
}

export interface Journal {
  id: number;
  name: string;
  created_at: string;
}

export interface Article {
  pmid: string;
  title: string;
  abstract: string;
  journal_name: string; // display name (abbreviation) as surfaced by the API
  nlm_id: string | null; // NLM Unique journal ID (the journal identity key)
  authors: string[]; // parsed from JSON column
  pub_date: string; // sortable YYYY-MM-DD
  pub_date_display: string; // human-readable, as PubMed reports it
  doi: string;
  url: string;
  first_seen_at: string;
}

export interface Collection {
  id: number;
  name: string;
  created_at: string;
}

export type CollectionFileStatus = "pending" | "matched" | "unmatched" | "error";

export interface CollectionFile {
  id: number;
  collection_id: number;
  content_hash: string; // sha256 hex, key into the blob store
  file_name: string;
  pmid: string | null; // soft ref to articles.pmid once matched
  match_status: CollectionFileStatus;
  match_method: string; // pmid | doi | manual | ''
  match_error: string;
  added_at: string;
}

// One row of the unified papers view (/api/papers): article metadata plus the
// cached citation count, for either paper source. The file_* fields carry the
// first matched uploaded copy and are only populated for collection sources —
// null for topics, which have no files.
export interface Paper {
  pmid: string;
  title: string;
  abstract: string;
  journal_name: string;
  authors: string[];
  pub_date: string; // sortable YYYY-MM-DD
  pub_date_display: string;
  doi: string;
  url: string;
  citation_count: number;
  file_id: number | null;
  file_name: string | null;
  file_exists: boolean; // false when file_id is null
}

export interface PapersResponse {
  papers: Paper[];
  journals: string[]; // distinct journal display names, for the filter chips
}

export interface PollResult {
  diseaseId: number;
  diseaseName: string;
  found: number; // PMIDs returned by search
  added: number; // new papers inserted
  error?: string;
}

export interface JournalRemovalResult {
  deletedArticles: number; // permanently deleted (kept when a collection file references them)
  removedFromInterests: number; // distinct papers unlinked from the disease feeds
}

export interface GraphNode {
  pmid: string;
  title: string;
  url: string;
  citationCount: number;
  year: number | null; // publication year, null when unknown
}

export interface GraphEdge {
  source: string; // citing paper
  target: string; // cited paper
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
