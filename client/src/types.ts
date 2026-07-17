// Shapes shared with the server live in shared/types.ts. Some are re-exported
// unchanged; others are extended below with the extra fields the API attaches
// to its responses.
import type {
  Collection as CollectionRow,
  CollectionFile as CollectionFileRow,
  CollectionFileStatus,
  Topic as TopicRow,
  GraphEdge,
  GraphNode,
  GraphResponse,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  Paper,
  PapersResponse,
  PollResult,
  ShareLinkResponse,
} from "../../shared/types";

export type {
  CollectionFileStatus,
  GraphEdge,
  GraphNode,
  GraphResponse,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  Paper,
  PapersResponse,
  PollResult,
  ShareLinkResponse,
};

export interface Topic extends TopicRow {
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

export interface RefreshResponse {
  results: PollResult[];
  polledAt: string;
}

// What /api/auth reports: whether this browser's requests count as admin,
// whether an ADMIN_TOKEN is configured at all (false = tokenless single-user
// mode, where stored PDFs stay openly fetchable), and whether the owner has
// opened the Library so viewers can download PDFs without a share link.
export interface AuthStatus {
  admin: boolean;
  token_required: boolean;
  library_open: boolean;
}

// What /api/settings exposes: never the API key itself, just whether one is set.
export interface AppSettings {
  ncbi_email: string;
  poll_cron: string;
  poll_enabled: boolean;
  library_open: boolean;
  has_api_key: boolean;
  // URLs where other machines can reach this server; empty when bound to loopback.
  share_urls: string[];
}

export interface Collection extends CollectionRow {
  fileCount: number;
  matchedCount: number;
}

// The API strips content_hash (blob-store key) from what viewers can see.
export interface CollectionFile extends Omit<CollectionFileRow, "content_hash"> {
  exists: boolean; // whether the stored PDF is still present
}

export interface CollectionFilesResponse {
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

// Which paper set a view reads from: a Discover topic or a Library
// collection. Every analysis module (table, timeline, graph) takes one.
export type PaperSource = { topic: number } | { collection: number };
