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

// ---------- "do I already have this?" ----------

// What one pasted line was understood to be. `citation` is an author + year
// pulled off a citation string; `unknown` means nothing usable came out of it,
// and `reason` says what was missing.
export type RefKind = "pmid" | "doi" | "citation" | "unknown";

export interface ParsedRefView {
  kind: RefKind;
  input: string; // the line as pasted, trimmed
  pmid?: string;
  doi?: string;
  author?: string;
  year?: number;
  reason?: string;
}

// Whether a paper reports original data, from PubMed's PublicationTypeList.
// Four states rather than two on purpose — around half of all records carry no
// design tag at all, and that bucket is *usually* primary research, not
// certainly. See evidenceClass in pubmed-parse.ts.
//
// A label, never a filter default: clients reject claims that can't be traced
// to original data, but reviews are where writers start and are perfectly
// citable for statements that don't rest on numbers.
export type EvidenceClass = "primary" | "secondary" | "untyped" | "unknown";

// Whether a paper is recent enough to cite, as distinct from whether it's held.
// Deliberately orthogonal to `held`: a paper the writer is about to *buy* can
// also be outside the window, and that's worth knowing before the purchase.
//   citable       — inside the configured window
//   out_of_window — held or findable, but too old to cite; still useful for
//                   verifying a claim back to its source
//   unknown       — no publication date, or the window is switched off
export type CiteStatus = "citable" | "out_of_window" | "unknown";

// A legal free copy of a paper the library doesn't hold — the other half of the
// approved purchase workflow, where the PM is told to look for a free version
// before approving a buy.
export interface FreeCopy {
  url: string;
  license: string | null; // e.g. "cc-by", null when the host doesn't say
  version: string | null; // publishedVersion | acceptedVersion | submittedVersion
  source: string | null; // repository or journal name, when OpenAlex reports one
}

// One paper the check identified, held or not. Mirrors Paper's file_* fields so
// the client can open a stored copy exactly the way every other view does.
export interface HaveMatch {
  pmid: string;
  title: string;
  authors: string[];
  journal_name: string;
  pub_date: string; // sortable YYYY-MM-DD ('' when unknown)
  pub_date_display: string;
  doi: string;
  url: string;
  held: boolean;
  file_id: number | null;
  file_name: string | null;
  file_exists: boolean;
  collection_id: number | null;
  collection_name: string | null;
  cite: CiteStatus;
  // Publication year, so the UI can say *how far* outside the window a
  // verification-only paper is rather than only that it is.
  year: number | null;
  evidence: EvidenceClass;
  // The types behind that verdict, e.g. ["Meta-Analysis", "Systematic Review"].
  // Shown rather than just the class, because "Editorial" and "Meta-Analysis"
  // are both `secondary` and a writer needs to know which one they're holding.
  pub_types: string[];
}

// The answer for one pasted line.
export interface HaveAnswer {
  parsed: ParsedRefView;
  held: boolean;
  // The paper, when exactly one was identified. Null when nothing matched, or
  // when an author+year search found several — those go in `candidates`.
  match: HaveMatch | null;
  // Held papers an author+year search matched, when it matched more than one.
  // The writer picks; the app must not guess which paper a citation string
  // meant.
  candidates: HaveMatch[];
  // Only looked up for papers the library doesn't hold, and only when the
  // request asked for it. Null means "no free copy found, or we couldn't ask".
  free: FreeCopy | null;
  // True when the free-copy lookup was attempted, so the UI can tell "no free
  // version exists" from "we never checked".
  freeChecked: boolean;
}

export interface HaveResponse {
  results: HaveAnswer[];
  // How many pasted lines were dropped because the request exceeded the
  // per-request cap; the client re-sends those in another batch.
  truncated: number;
  // The citable window in force, echoed so the UI can name it ("older than 5
  // years"). 0 means the window is off and every `cite` is "unknown".
  windowYears: number;
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
  // How many matching papers PubMed would not hand over. E-utilities serves at
  // most the first 9,999 records for a query, so a broad topic's first poll is
  // necessarily partial — and silently partial is the one thing it must not be,
  // since the feed then looks complete and simply isn't.
  truncated?: number;
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
