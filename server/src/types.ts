// Row/API shapes shared with the client live in shared/types.ts; only
// server-private types are defined here.
export type {
  Article,
  Collection,
  CollectionFile,
  CollectionFileStatus,
  Disease,
  GraphEdge,
  GraphNode,
  GraphResponse,
  Journal,
  JournalRemovalResult,
  Paper,
  PapersResponse,
  PollResult,
} from "../../shared/types.js";

// Server-only: the client is served AppSettings, which never carries the key.
// The settings table stores strings, so poll_enabled is "1"/"0".
export interface Settings {
  ncbi_api_key: string;
  ncbi_email: string;
  poll_cron: string;
  poll_enabled: string;
}
