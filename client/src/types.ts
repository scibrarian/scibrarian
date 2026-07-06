export interface Disease {
  id: number;
  name: string;
  term: string;
  last_polled_at: string | null;
  created_at: string;
  articleCount?: number;
}

export interface Journal {
  id: number;
  name: string;
  created_at: string;
}

export interface JournalSearchResult {
  title: string;
  abbr: string;
  issn: string;
  metric: number | null; // OpenAlex 2-yr mean citedness
}

export interface JournalSearchResponse {
  results: JournalSearchResult[];
}

export interface Article {
  pmid: string;
  title: string;
  abstract: string;
  journal_name: string;
  authors: string[];
  pub_date: string;
  pub_date_display: string;
  doi: string;
  url: string;
  first_seen_at: string;
}

export interface ArticlesResponse {
  articles: Article[];
  journals: string[];
}

export interface PollResult {
  diseaseId: number;
  diseaseName: string;
  found: number;
  added: number;
  error?: string;
}

export interface RefreshResponse {
  results: PollResult[];
  polledAt: string;
}

export interface AppSettings {
  ncbi_email: string;
  poll_cron: string;
  has_api_key: boolean;
}

export interface Collection {
  id: number;
  name: string;
  created_at: string;
  fileCount: number;
  matchedCount: number;
}

export type CollectionFileStatus = "pending" | "matched" | "unmatched" | "error";

export interface CollectionFile {
  id: number;
  collection_id: number;
  file_path: string;
  file_name: string;
  pmid: string | null;
  match_status: CollectionFileStatus;
  match_method: string; // pmid | doi | manual | ''
  match_error: string;
  added_at: string;
  exists: boolean; // whether the file is still on disk
}

export interface CollectionPaper {
  pmid: string;
  title: string;
  journal_name: string;
  authors: string[];
  pub_date: string;
  pub_date_display: string;
  doi: string;
  url: string;
  citation_count: number;
}

export interface CollectionPapersResponse {
  papers: CollectionPaper[];
  files: CollectionFile[];
}

export interface ImportStartResponse {
  jobId: string;
  added: number; // new file rows inserted
  skipped: number; // already in the collection
  total: number; // pending files the job will scan
}

export interface ImportStatus {
  state: "idle" | "running" | "done" | "error";
  jobId?: string;
  total?: number;
  processed?: number;
  matched?: number;
  unmatched?: number;
  errors?: number;
  currentFile?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  error?: string; // fatal job error only
}

export interface FsPlace {
  label: string;
  path: string;
}

export interface FsRootsResponse {
  roots: FsPlace[];
  home: string;
  shortcuts: FsPlace[];
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  files: { name: string; path: string; size: number; mtime: string }[];
}

// Which paper set a graph is built from.
export type GraphSource = { disease: number } | { collection: number };

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
