// Shapes shared verbatim between the server (DB/API layer) and the client.
// The client extends some of these with fields its API responses add — see
// client/src/types.ts.

import type { OrgHolding } from "./pro.js";

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

// A user-created bookmark folder: the Bookmarks section's counterpart to a
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
  // Every collection holding this paper, sorted by name. Empty except in the
  // all-collections view: inside one collection every row is in that
  // collection, and a topic or folder holds nothing.
  //
  // A list rather than one name, and deliberately not read off file_id. That
  // resolves to the lowest-id file, so a paper filed under three clients would
  // name one and silently drop the other two — and reuse across engagements is
  // the thing this view is read to find out about.
  collections: string[];
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
  // Where this paper came from, when it wasn't acquired here — Pro only, and
  // omitted entirely otherwise.
  //
  // Optional rather than nullable because a papers page carries hundreds of
  // rows and a free build would otherwise pay `"provenance":null` on every one
  // of them for a field it can never populate. Omitted rather than empty for
  // the same reason.
  //
  // Additive, not exclusive: a reader can buy a paper *and* later receive the
  // same one. This says it was supplied at least once, which is the
  // licensing-relevant fact and stays true either way. It is a label and must
  // never become a default filter — a search that hides supplied papers is a
  // search that ends in buying one again.
  provenance?: PaperProvenance[];
}

/**
 * Where a paper came from, when it wasn't acquired here.
 *
 * Discriminated rather than a bare display string. The three cases carry
 * different licensing stories — the organisation bought it, a writer supplied
 * it, a writer who has since gone supplied it — and the wording for each
 * belongs to whatever renders it. An earlier version sent one string and
 * overloaded the literal `"contributed"` to mean the third case, which no
 * reader could tell from a writer who happened to be named that, and which left
 * every row asserting the organisation's story no matter which case it was.
 *
 * `label` is absent on `former-node` deliberately: there is no name left to
 * show. Only the badge fades — the attribution itself is kept permanently, by
 * node id, in the Pro schema. A row here always means the paper was supplied
 * from someone else's purchase, which is the fact that outlives the connection.
 *
 * A *list* on Paper because an instance can be a master and a spoke at once: an
 * agency paired up to a client's master while its own freelancers push up to it
 * can hold one paper that a writer supplied and that the client's library also
 * supplied. Both are true, both bear on licensing, and picking one would drop
 * the half that happened to lose a tie-break.
 */
export type PaperProvenance =
  | { kind: "org"; label: string }
  | { kind: "node"; label: string }
  | { kind: "former-node" };

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

// What one pasted line was understood to be. `unknown` means no identifier came
// out of it, and `reason` says so.
export type RefKind = "pmid" | "doi" | "unknown";

export interface ParsedRefView {
  kind: RefKind;
  input: string; // the line as pasted, trimmed
  pmid?: string;
  doi?: string;
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
  evidence: EvidenceClass;
  // The types behind that verdict, e.g. ["Meta-Analysis", "Systematic Review"].
  // Shown rather than just the class, because "Editorial" and "Meta-Analysis"
  // are both `secondary` and a writer needs to know which one they're holding.
  pub_types: string[];
}

/**
 * The fourth verdict: you own this, in another workspace on this machine.
 *
 * Desktop only, and never a route to the file — the bytes stay in the workspace
 * that holds them, and this says only where to go and look. That thinness is
 * deliberate in the same way OrgHolding's is, but for the opposite reason:
 * OrgHolding is thin because the master must never volunteer what it holds,
 * while this is thin because a paper's whereabouts is the entire useful answer
 * to "have I already bought this?".
 */
export interface ElsewhereHolding {
  /**
   * The workspace's name, as the person named it — "Acme", "My library".
   *
   * Null for a caller who is not the owner. /have is a public GET on purpose,
   * so that the read-only viewers who are told to run the pre-purchase check
   * can run it; the names are the one thing in the answer that isn't about the
   * paper. They are the agencies this person works for, and GET /workspaces is
   * admin-only for exactly that reason — so they are withheld here on the same
   * terms rather than handed out through the route left open.
   */
  workspace: string | null;
  /**
   * The collection it sits in there, which is how they will find it. Withheld
   * with the workspace name and for the same reason.
   */
  collection: string | null;
}

// The answer for one pasted line.
export interface HaveAnswer {
  parsed: ParsedRefView;
  held: boolean;
  // The paper, when one was identified; null when nothing matched. An
  // identifier names at most one paper, so there is never a set to choose from.
  match: HaveMatch | null;
  // True when the online identifier lookup was attempted, so a row that found
  // nothing can say whether anyone actually looked. False for the local-only
  // answer the client asks for while a paste is still being typed.
  identifierChecked: boolean;
  // The third verdict — your org holds this even though you don't. Null in a
  // free build, and also whenever the master couldn't be reached.
  org: OrgHolding | null;
  // The same distinction `identifierChecked` draws, and it matters more here:
  // without it the UI cannot tell "the org doesn't have it" from "nobody
  // answered", and rendering the second as the first is what ends in a
  // duplicate purchase.
  orgChecked: boolean;
  // You already own this, in another workspace on this machine. Null on a
  // server deployment, on a desktop with one workspace, and whenever the other
  // workspaces held nothing matching.
  //
  // Purely additive: it suppresses no lookup and changes no other field. An org
  // hit and a free copy are both still worth reporting beside it — the org has
  // a Copy button behind it, and a legal free copy is quicker to open than a
  // relaunch into another workspace. What this removes is only the reason to
  // *buy*, which is the one thing none of the others covers.
  elsewhere: ElsewhereHolding | null;
  // Whether every other workspace answered. False means one could not be read,
  // so an absent `elsewhere` is "nobody looked" rather than "you don't own it".
  elsewhereChecked: boolean;
}

export interface HaveResponse {
  results: HaveAnswer[];
  // How many pasted lines were dropped because the request exceeded the
  // per-request cap; the client re-sends those in another batch.
  truncated: number;
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

// Everything a whole-library reset destroys, counted. Read once, inside the
// transaction that does the deleting, so these are the rows that were actually
// destroyed rather than a reading taken before it.
//
// Once and not twice: the confirmation ahead of the button used to read this
// too, and now says the same fixed thing every time — it names what will go in
// the words the UI already uses rather than counting it. libraryStats is
// deliberately unexported to keep it that way; the note on it in db.ts gives
// the reason.
//
// Deliberately only the things a person put there. The MeSH vocabulary and the
// NLM journal catalog are downloads, not contents — a reset keeps them, so
// counting them here would put a number in the report that the button did not
// act on. The same goes for the settings row and, on a Pro instance, the
// pairing.
export interface LibraryStats {
  topics: number;
  journals: number;
  papers: number;
  folders: number;
  collections: number;
  files: number; // rows in collection_files, not distinct blobs
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

// ---------- workspaces ----------

/**
 * One of the separate libraries this machine holds — a desktop-only idea.
 *
 * A freelancer straddles agencies, and a workspace is the coarse boundary
 * collection_org's per-collection stamp deliberately isn't: its own database,
 * its own blob store, its own pairing, its own topic and MeSH vocabulary. The
 * fine boundary decides what *syncs*; this one decides what a session can see
 * at all.
 *
 * `id` is opaque — an identifier the client passes back, never parsed and never
 * shown. It names a directory, so it must survive a rename, which rules out
 * anything derived from the name.
 */
export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  /** The one this process is running in. Exactly one row carries it. */
  active: boolean;
  /**
   * What deleting this one would destroy, so the confirmation can say.
   *
   * Optional, and the two states are different answers: zero is measured and
   * empty — a workspace created and never filled, a much lighter thing to
   * delete — while absent means its database could not be read, and the dialog
   * falls back to what it can always say safely. The same rule ProNode's
   * activity counts follow, and it matters more here, because this pair is read
   * by someone about to destroy a library.
   *
   * Never present on the active row: that workspace cannot be deleted, so there
   * is nothing to warn about and no reason to open a second connection to a
   * database this process already has open.
   */
  collections?: number;
  files?: number;
}

/**
 * An empty list is the honest answer for every deployment that isn't the
 * desktop app, and the one the client keys off: no rows, no switcher. Better
 * than a flag, because a build with the feature and a build without it then
 * differ in what they *have* rather than in what they claim.
 */
export interface WorkspacesResponse {
  workspaces: Workspace[];
}
