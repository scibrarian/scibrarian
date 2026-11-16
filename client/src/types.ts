// The server's shapes — what it stores and every reply it sends — live in
// shared/types.ts and are re-exported here. Below them is what only the client
// has: what it sends, and its own state.
import type { AppSettings } from "../../shared/types";
import type { MailField } from "../../shared/mail";

// The Pro tier's wire shapes. Public like the rest of the client — only the
// implementations behind /api/pro are closed.
export type {
  OrgHolding,
  ProCollectionStamp,
  ProLicense,
  ProMasterStatus,
  ProNode,
  ProNodesResponse,
  ProPairingMinted,
  ProPullResult,
  ProPushResult,
  ProSyncStatus,
  ProStatus,
} from "../../shared/pro";

export type {
  AbstractsResponse,
  AddBookmarksResponse,
  AddLinksResponse,
  AppSettings,
  AuthStatus,
  BookmarkEntry,
  BookmarkFolder,
  BookmarkImport,
  CacheStats,
  ClearedCache,
  Collection,
  CollectionFile,
  CollectionFileStatus,
  CollectionFilesResponse,
  CollectionRemovalResponse,
  ElsewhereHolding,
  EvidenceClass,
  FolderImportResponse,
  HaveAnswer,
  HaveMatch,
  HaveResponse,
  GraphEdge,
  GraphNode,
  GraphResponse,
  ImportJob,
  ImportReason,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  JournalSearchResponse,
  JournalSearchResult,
  JournalSuggestResponse,
  LibraryStats,
  LinkAnswer,
  LinkOutcome,
  LinkedPaper,
  MedlineStatus,
  MeshDescriptorRef,
  MeshFacet,
  MeshFiling,
  MeshHeadingsResponse,
  MeshSearchResponse,
  MeshSearchResult,
  Paper,
  PaperCountResponse,
  PaperProvenance,
  PapersResponse,
  ParsedRefView,
  PollResult,
  RefKind,
  RefreshResponse,
  RemovedResponse,
  ShareLinkResponse,
  TestEmailResponse,
  Topic,
  TopicDetail,
  TopicPreviewResponse,
  TopicRemovalResult,
  TopicSuggestion,
  TopicSuggestResponse,
  TopicUpdateResponse,
  UploadResponse,
  Workspace,
  WorkspaceContents,
  WorkspaceContentsResponse,
  WorkspaceSwitchResponse,
  WorkspacesResponse,
} from "../../shared/types";

// What narrows a paper source server-side, shared by /api/papers and /api/graph
// so both views select the same papers. Journals, the citation threshold and
// the year range are deliberately not here: those are applied client-side over
// an already-fetched list, so toggling them never costs a request.
export interface PaperQuery {
  q?: string;
  mesh?: string[]; // MeSH descriptor UIs; a paper filed under all of them matches
  meshMajor?: boolean; // keep only papers every selected descriptor is a main point of
}

// What a topic is to search, as the dialog sends it: all of PubMed, or the
// journals named by NLM id.
export interface TopicScopeInput {
  allPubmed: boolean;
  journals: string[];
}

// What the email alerts dialog edits, and what a test email is sent with. The
// password is write-only, like the API key: blank keeps the stored one.
export type MailSettingsDraft = Pick<AppSettings, MailField> & { smtp_pass?: string };

// A settings save. Patch semantics: only the keys sent are changed.
export type SettingsUpdate = Partial<AppSettings> & { ncbi_api_key?: string; smtp_pass?: string };

// Which paper set a view reads from: an Interests topic, a Bookmarks folder, a
// Library collection, or every collection at once. Every analysis module
// (table, timeline, graph) takes one. Defined in shared/source.ts alongside its
// predicates and its wire format, because the server dispatches on the same
// four kinds and the two used to mirror each other by hand.
export type { PaperSource } from "../../shared/source";

// What the Library section is pointed at: one collection, or every collection
// at once. "all" is deliberately not a reserved id — a sentinel number would be
// one bad comparison away from selecting a real collection, and this can't be
// mistaken for one.
export type CollectionSelection = number | "all";
