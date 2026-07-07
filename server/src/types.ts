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

export interface PollResult {
  diseaseId: number;
  diseaseName: string;
  found: number; // PMIDs returned by search
  added: number; // new papers inserted
  error?: string;
}

export interface Settings {
  ncbi_api_key: string;
  ncbi_email: string;
  poll_cron: string;
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
