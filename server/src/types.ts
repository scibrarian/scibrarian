// Row/API shapes shared with the client live in shared/types.ts; only
// server-private types are defined here.
export type {
  AbstractsResponse,
  Article,
  BookmarkEntry,
  BookmarkFolder,
  Collection,
  CollectionFile,
  CollectionFileStatus,
  Topic,
  CiteStatus,
  FreeCopy,
  GraphEdge,
  GraphNode,
  GraphResponse,
  HaveAnswer,
  HaveMatch,
  HaveResponse,
  ImportJob,
  Journal,
  JournalRemovalResult,
  MeshFacet,
  MeshFiling,
  MeshHeading,
  MeshHeadingsResponse,
  Paper,
  PapersResponse,
  PollResult,
  ShareLinkResponse,
  TopicRemovalResult,
  TopicSuggestion,
  TopicSuggestResponse,
} from "../../shared/types.js";

import { SETTING_DEFAULTS } from "./config.js";

// Server-only: the client is served the settings response, which never carries
// the API key. The key set derives from SETTING_DEFAULTS (config.ts), so adding
// a setting there forces the PUT/response rules (SETTING_RULES in routes.ts) to
// cover it — the compiler catches a forgotten branch instead of the toggle
// silently round-tripping 200 without persisting. The settings table stores
// strings, so the booleans are "1"/"0".
export type Settings = Record<keyof typeof SETTING_DEFAULTS, string>;
