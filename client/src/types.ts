// Shapes shared with the server live in shared/types.ts. Some are re-exported
// unchanged; others are extended below with the extra fields the API attaches
// to its responses.
import type {
  AbstractsResponse,
  BookmarkEntry,
  BookmarkFolder as BookmarkFolderRow,
  Collection as CollectionRow,
  CollectionFile as CollectionFileRow,
  CollectionFileStatus,
  Topic as TopicRow,
  CiteStatus,
  EvidenceClass,
  FreeCopy,
  GraphEdge,
  GraphNode,
  GraphResponse,
  HaveAnswer,
  HaveMatch,
  HaveResponse,
  ImportJob,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  MeshDescriptorRef,
  MeshFacet,
  MeshFiling,
  MeshHeadingsResponse,
  Paper,
  PapersResponse,
  ParsedRefView,
  PollResult,
  RefKind,
  ShareLinkResponse,
  TopicRemovalResult,
  TopicSuggestion,
  TopicSuggestResponse,
} from "../../shared/types";

export type {
  AbstractsResponse,
  BookmarkEntry,
  CiteStatus,
  CollectionFileStatus,
  EvidenceClass,
  FreeCopy,
  HaveAnswer,
  HaveMatch,
  HaveResponse,
  GraphEdge,
  GraphNode,
  GraphResponse,
  ImportJob,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  MeshDescriptorRef,
  MeshFacet,
  MeshFiling,
  MeshHeadingsResponse,
  Paper,
  PapersResponse,
  ParsedRefView,
  PollResult,
  RefKind,
  ShareLinkResponse,
  TopicRemovalResult,
  TopicSuggestion,
  TopicSuggestResponse,
};

// What narrows a paper source server-side, shared by /api/papers and /api/graph
// so both views select the same papers. Journals, the citation threshold and
// the year range are deliberately not here: those are applied client-side over
// an already-fetched list, so toggling them never costs a request.
export interface PaperQuery {
  q?: string;
  mesh?: string[]; // MeSH descriptor UIs; a paper filed under any of them matches
  meshMajor?: boolean; // keep only papers a selected descriptor is a main point of
}

export interface Topic extends TopicRow {
  articleCount?: number;
}

export interface JournalSearchResult {
  nlm_id: string; // the journal identity key — used to dedupe against added journals
  title: string;
  abbr: string;
  issn: string;
  metric: number | null; // OpenAlex 2-yr mean citedness
}

export interface JournalSearchResponse {
  results: JournalSearchResult[];
}

// One row from /api/journals/suggest ("Auto"): a catalog journal plus which of
// the user's topics wanted it.
export interface JournalSuggestion extends JournalSearchResult {
  topics: string[];
}

export interface JournalSuggestResponse {
  results: JournalSuggestion[];
  topicCount: number; // topics considered; 0 = user has no topics yet
  failed: string[]; // topics whose PubMed lookup failed (results are partial)
}

export interface MeshSearchResult {
  ui: string; // MeSH descriptor id, e.g. D003924
  name: string; // canonical heading
}

export interface MeshSearchResponse {
  results: MeshSearchResult[];
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
  // How old a paper may be and still be citable, in years, as typed. A string
  // rather than a number because it's a text field the user is mid-edit in, and
  // "" has to survive the round trip to the form. "0" turns the judgement off.
  citation_window_years: string;
  has_api_key: boolean;
  // URLs where other machines can reach this server; empty when bound to loopback.
  share_urls: string[];
  // True in the desktop build, which is loopback-only by construction — so
  // share_urls is always empty there and can never be filled in.
  desktop: boolean;
}

export interface BookmarkFolder extends BookmarkFolderRow {
  paperCount: number;
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

// Which paper set a view reads from: an Interests topic, a Bookmarks folder, a
// Library collection, or every collection at once. Every analysis module
// (table, timeline, graph) takes one. Defined in shared/source.ts alongside its
// predicates and its wire format, because the server dispatches on the same
// four kinds and the two used to mirror each other by hand.
export type { PaperSource } from "../../shared/source";

// What the Library workspace is pointed at: one collection, or every collection
// at once. "all" is deliberately not a reserved id — a sentinel number would be
// one bad comparison away from selecting a real collection, and this can't be
// mistaken for one.
export type CollectionSelection = number | "all";
