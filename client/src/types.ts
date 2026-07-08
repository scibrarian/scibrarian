// Shapes shared with the server live in shared/types.ts. Some are re-exported
// unchanged; others are extended below with the extra fields the API attaches
// to its responses.
import type {
  Article,
  Collection as CollectionRow,
  CollectionFile as CollectionFileRow,
  CollectionFileStatus,
  CollectionPaper,
  Disease as DiseaseRow,
  GraphEdge,
  GraphNode,
  GraphResponse,
  Journal,
  PollResult,
} from "../../shared/types";

export type {
  Article,
  CollectionFileStatus,
  CollectionPaper,
  GraphEdge,
  GraphNode,
  GraphResponse,
  Journal,
  PollResult,
};

export interface Disease extends DiseaseRow {
  articleCount?: number;
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

export interface ArticlesResponse {
  articles: Article[];
  journals: string[];
}

export interface RefreshResponse {
  results: PollResult[];
  polledAt: string;
}

// What /api/settings exposes: never the API key itself, just whether one is set.
export interface AppSettings {
  ncbi_email: string;
  poll_cron: string;
  has_api_key: boolean;
}

export interface Collection extends CollectionRow {
  fileCount: number;
  matchedCount: number;
}

export interface CollectionFile extends CollectionFileRow {
  exists: boolean; // whether the stored PDF is still present
}

export interface CollectionPapersResponse {
  papers: CollectionPaper[];
  files: CollectionFile[];
}

export interface UploadResponse {
  added: number; // new file rows inserted
  skipped: number; // already in the collection (or not a PDF)
}

export interface ImportStartResponse {
  jobId: string;
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

// Which paper set a graph is built from.
export type GraphSource = { disease: number } | { collection: number };
