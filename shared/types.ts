// Shapes shared verbatim between the server (DB/API layer) and the client.
// The client extends some of these with fields its API responses add — see
// client/src/types.ts.

export interface Topic {
  id: number;
  name: string;
  term: string;
  last_polled_at: string | null;
  created_at: string;
}

export interface TopicRemovalResult {
  deletedArticles: number;
}

export interface Journal {
  id: number;
  name: string;
  nlm_id: string | null; // null on rows added before NLM resolution existed
  metric: number | null; // OpenAlex 2-yr mean citedness (from journal_catalog), null when unknown
  created_at: string;
  // Does NLM currently index this journal for MEDLINE? `false` is the one state
  // worth surfacing: no MeSH headings, so the journal can never match a topic
  // and will never contribute a paper to Interests. `null` means nobody has
  // established it yet (added before the check existed, or NCBI was unreachable)
  // — not the same as false, and not something to warn about.
  medline_indexed: boolean | null;
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
  // MedlineCitation/@Status as PubMed last reported it ("" = never looked).
  // What it means for this paper's headings is meshOutlook() in pubmed-parse.
  mesh_status: string;
}

// Enough to name a MeSH descriptor: the id everything keys on, plus the heading
// to show for it. Every subject shape below carries these two and adds whatever
// its own context measures.
export interface MeshDescriptorRef {
  ui: string; // descriptor id, e.g. D003924
  name: string; // canonical heading, e.g. "Diabetes Mellitus, Type 2"
}

// One MeSH descriptor a paper is filed under. `major` mirrors PubMed's star:
// the paper is *about* this subject rather than merely mentioning it.
export interface MeshHeading extends MeshDescriptorRef {
  major: boolean;
}

// One descriptor present in a paper source, with how much of it the descriptor
// accounts for — the subject facet the toolbar browses and filters by.
export interface MeshFacet extends MeshDescriptorRef {
  count: number; // papers in the source filed under it
  majorCount: number; // of those, the ones it's a major topic for
}

// How completely a source's papers are filed, so a short facet list can say why
// instead of looking like the filing simply failed. Every paper in the source
// falls in exactly one bucket, and the four unfiled ones are the four outcomes
// of meshOutlook — they are reported separately because what the reader should
// do about them differs: two resolve on their own, two never will.
export interface MeshFiling {
  filed: number; // has at least one heading
  indexed: number; // NLM indexed it and filed it under nothing; no headings are coming
  none: number; // MEDLINE will never index it (PubMed-not-MEDLINE), so likewise
  pending: number; // in PubMed but not through MeSH indexing yet; headings may still arrive
  unchecked: number; // we haven't asked PubMed for this one's headings yet
}

export interface MeshHeadingsResponse {
  headings: MeshFacet[];
  filing: MeshFiling;
  // True when `headings` was cut short by the limit, so the UI can say the list
  // is the most common subjects rather than all of them.
  truncated: boolean;
}

// A MeSH heading the user's own holdings suggest as a topic worth watching.
export interface TopicSuggestion extends MeshDescriptorRef {
  papers: number; // held papers filed under it
  majorPapers: number; // of those, the ones it's a major topic for
}

export interface TopicSuggestResponse {
  results: TopicSuggestion[];
  heldPapers: number; // distinct papers in the Library the ranking drew on
  unchecked: number; // held papers whose headings haven't been fetched yet
}

// A user-created bookmark folder: the Bookmarks workspace's counterpart to a
// topic or a collection. Holds papers saved out of Interests (membership lives
// in the bookmarks table), so unlike a collection it has no files behind it.
export interface BookmarkFolder {
  id: number;
  name: string;
  created_at: string;
}

// One saved paper, as GET /api/bookmarks returns it. The client holds the whole
// set in memory rather than having /papers and /graph carry a per-row flag:
// bookmarks are a hand-curated list, orders of magnitude smaller than the
// article table, and one shared map keeps every view's icons in agreement
// without refetching a 2,000-row payload after each toggle.
export interface BookmarkEntry {
  folder_id: number;
  pmid: string;
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

// A live PDF-import job's status, tracked server-side and streamed to the
// client while the scan runs.
export interface ImportJob {
  jobId: string;
  state: "running" | "done" | "error";
  total: number; // pending files at job start
  processed: number; // PDFs text-extracted so far
  matched: number;
  unmatched: number;
  errors: number;
  currentFile: string | null;
  startedAt: string;
  finishedAt: string | null;
  error?: string; // fatal job failure only
}

// What GET /collections/:id/import/status returns: the current job, or an idle
// sentinel when no import has run for the collection.
export type ImportStatus = ImportJob | { state: "idle" };

// One row of the unified papers view (/api/papers): article metadata plus the
// cached citation count, for either paper source. The file_* fields carry the
// first matched uploaded copy and are only populated for collection sources —
// null for topics, which have no files. The abstract is deliberately NOT here:
// it dominates the payload size, so the card view fetches it on demand by pmid
// (GET /api/abstracts, a chunk at a time). Free-text search still covers abstracts —
// that runs against the DB column server-side.
export interface Paper {
  pmid: string;
  title: string;
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
  // An excerpt from the PDF's body around the current search terms, present
  // whenever the query matched inside the document (whether or not it also
  // matched the title/abstract/authors). Null for a paper matched only on
  // metadata, for every non-collection source, and when there's no search — so
  // its presence says "the words you typed are in this file", which is the one
  // thing a title alone can't tell you.
  //
  // Matched terms are wrapped in the sentinels below. Deliberately not HTML: the
  // client renders this as text, and a server that emitted <mark> would be
  // asking it to trust markup assembled from PDF contents.
  snippet: string | null;
}

export interface PapersResponse {
  papers: Paper[];
  journals: string[]; // distinct journal display names, for the filter chips
}

// Delimiters marking the matched terms inside Paper.snippet. ASCII STX/ETX:
// control codes with no textual meaning, which the extractor strips from stored
// PDF text (see pdf-text.ts) precisely so a document can never contain them and
// forge a highlight. The client splits on these and renders the enclosed runs;
// anything that shows them literally has failed to, which is visible rather
// than silent.
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

// Abstracts for a batch of papers, keyed by pmid. A requested pmid that isn't
// stored is absent rather than empty, so the caller can tell the two apart.
export interface AbstractsResponse {
  abstracts: Record<string, string>;
}

// A minted expiring download link for one stored PDF. `path` is relative so
// the client can prepend whichever origin it reached the server on.
export interface ShareLinkResponse {
  path: string; // /api/collections/files/<id>/content?exp=...&sig=...
  expiresAt: string; // ISO timestamp
}

export interface PollResult {
  topicId: number;
  topicName: string;
  found: number; // PMIDs returned by search
  added: number; // papers newly added to this feed (fetched, or linked from another feed)
  error?: string;
}

export interface JournalRemovalResult {
  deletedArticles: number; // permanently deleted (kept when a collection file references them)
  removedFromInterests: number; // distinct papers unlinked from the topic feeds
}

export interface GraphNode {
  pmid: string;
  title: string;
  url: string;
  journal_name: string; // display name, matching Paper — drives the journal filter
  citationCount: number;
  year: number | null; // publication year, null when unknown
  // Same linked-PDF fields Paper carries, so a node click can open the stored
  // file rather than PubMed. Always null/false for topic nodes.
  file_id: number | null;
  file_name: string | null;
  file_exists: boolean;
}

export interface GraphEdge {
  source: string; // citing paper
  target: string; // cited paper
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Every journal in the source, not just the ones surviving the current
  // search — the filter chips must stay put while a query narrows the graph.
  // Same list /papers returns, so the dropdown matches across views.
  journals: string[];
}
