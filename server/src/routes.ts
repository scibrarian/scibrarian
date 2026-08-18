import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import { paperProvenance, proStatus } from "./pro-hooks.js";
import {
  addBookmarks,
  addCollectionFiles,
  bookmarkCounts,
  bookmarkFolderByName,
  collectionByName,
  collectionCounts,
  countJournalArticles,
  createBookmarkFolder,
  createCollection,
  countTopicArticles,
  createTopic,
  createJournal,
  deleteBookmarkFolder,
  deleteCollection,
  deleteCollectionFile,
  removeTopicWithArticles,
  topicByTerm,
  topicArticleCounts,
  existingPmids,
  gcBlobsIfOrphaned,
  getArticleAbstracts,
  getBookmarkFolder,
  getCitations,
  getCollection,
  getCollectionFile,
  getSettings,
  graphPapersForSource,
  findCatalogByNlmId,
  journalByNlmId,
  journalsForSource,
  listBookmarkFolders,
  listBookmarks,
  listCollectionFiles,
  listPapers,
  listCollections,
  listTopics,
  listJournals,
  findMeshByName,
  libraryFilingCounts,
  meshFacetsForSource,
  meshFilingForSource,
  missingOrStaleCitations,
  removeBookmark,
  removeJournalWithArticles,
  renameBookmarkFolder,
  renameCollection,
  searchCatalog,
  searchMesh,
  setFileMatched,
  setSetting,
  sourceHasFiles,
  suggestTopicsFromLibrary,
  upsertArticles,
  type PaperFilter,
  type PaperSource,
} from "./db.js";
import { decodeSource } from "../../shared/source.js";
import {
  blobExists,
  blobPath,
  cleanUploadName,
  existingBlobHashes,
  isPdfFile,
  safeFileName,
  storeBlobFromTemp,
} from "./blobstore.js";
import {
  ADMIN_TOKEN,
  boundPort,
  HOST,
  HOST_IS_LOOPBACK,
  IS_DESKTOP,
  UPLOAD_TMP_DIR,
} from "./config.js";
import { splitRefs } from "./citation-ref.js";
import { checkHoldings, MAX_REFS_PER_REQUEST } from "./have.js";
import { getImportStatus, isImportRunning, startImport } from "./importer.js";
import { attachMetrics, ensureCatalogLoaded } from "./journal-catalog.js";
import { suggestJournals } from "./journal-suggest.js";
import { ensureMeshLoaded } from "./mesh-catalog.js";
import { fetchArticles, isMedlineIndexed, resolveJournal } from "./pubmed.js";
import {
  isValidCron,
  pollAll,
  pollTopic,
  rescheduleFromSettings,
  warmCitations,
  withPollLock,
} from "./poller.js";
import { ZipArchive } from "archiver";
import {
  signCollectionShare,
  signFileShare,
  signingEnabled,
  verifyCollectionShare,
  verifyFileShare,
  type ShareVerdict,
} from "./signing.js";
import type {
  AbstractsResponse,
  CollectionFile,
  GraphEdge,
  GraphNode,
  GraphResponse,
  HaveResponse,
  MeshHeadingsResponse,
  PaperProvenance,
  PapersResponse,
  Settings,
  TopicSuggestResponse,
} from "./types.js";
import { errMessage, round1 } from "./util.js";
import { MAX_BULK_BOOKMARK_PMIDS, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "../../shared/limits.js";

// Express 4 doesn't forward a rejected promise to the error middleware, so
// async handlers without their own catch are wrapped in this.
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const api = Router();

// ---------- admin gate ----------

// Constant-time token check. Hashing both sides first equalizes buffer lengths
// (timingSafeEqual throws on mismatched lengths, which would itself leak).
function tokenMatches(provided: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Every admin credential the request presents, from either header.
 *
 * **X-Admin-Token is the browser client's, because `Authorization` is not ours
 * to occupy.** Any deployment behind HTTP basic auth — which is what DEPLOY.md's
 * public-domain option and both setup scripts build — has the browser sending
 * `Authorization: Basic …` on every request. Putting the admin token in that
 * same header replaced the credentials the edge was checking, so the moment the
 * owner unlocked, every API call 401'd at the proxy with a Basic challenge.
 *
 * That failure had no exit. The browser re-prompted, and whatever password was
 * typed was overwritten by the next fetch setting the header again; meanwhile
 * the client reads any 401 as "this token was rejected" and locks itself. So
 * unlocking logged you out and demanded a password that could not work.
 *
 * A custom header also can't be set by a cross-site form and forces a preflight,
 * which is the same property the Pro push route relies on.
 *
 * Bearer stays accepted, and not merely for compatibility: the setup scripts and
 * any curl against /api/pro authenticate that way, from inside the network where
 * no edge login is in play.
 *
 * Both are tried, rather than whichever appears first winning. A present but
 * non-matching X-Admin-Token — a stale one left in localStorage, or one a proxy
 * or extension inserted — would otherwise shadow a valid Bearer and refuse a
 * request that carried the right credential all along, which is not what the
 * paragraph above promises. Trying both costs one more constant-time compare.
 *
 * A *second* X-Admin-Token is a third case, and the sentence above did not
 * cover it. Node joins repeated headers of the same name with ", " — the short
 * list it de-duplicates instead, keeping the first, has Authorization on it but
 * not this — so an inserted one does not shadow ours, it is welded to it as
 * "ours, theirs" and matches nothing. There is no Bearer to fall back to in the
 * deployment where it matters, because behind a basic-auth edge that header is
 * the edge's. Every comma-separated piece that could be ours is therefore
 * tried as well.
 */
function presentedAdminTokens(req: Request): string[] {
  const found: string[] = [];
  const raw = (req.get("x-admin-token") ?? "").trim();
  if (raw) found.push(raw);
  // The whole value first and the pieces only after it, so a token that
  // genuinely contains a comma still matches. The setup scripts generate hex,
  // but nothing stops an operator setting ADMIN_TOKEN by hand, and splitting
  // one would refuse the credential the request presented verbatim.
  //
  // Which pieces to try is a question of shape, not of how many. Counting is
  // what `split(",", n)` does — it caps the array rather than the number of
  // splits — so a bound of four meant four inserted values pushed the real
  // token off the end and refused a request carrying the right credential, in
  // the one deployment this recovery exists for. A piece that is not the length
  // of ADMIN_TOKEN cannot be it, so the hashing is bounded by something an
  // inserted header cannot overrun, and Node's 16KB header cap bounds the rest.
  // The filter tells an attacker nothing: a wrong-length piece and a
  // wrong-value one are both a 401.
  if (raw.includes(",")) {
    for (const piece of raw.split(",")) {
      const t = piece.trim();
      if (t && t.length === ADMIN_TOKEN.length) found.push(t);
    }
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
  const bearer = m ? m[1].trim() : "";
  if (bearer) found.push(bearer);
  return found;
}

// No ADMIN_TOKEN configured = single-user mode: everyone is admin (index.ts
// refuses to bind non-loopback in that case).
//
// Exported for the Pro seam: Pro's owner-facing routes sit outside this
// router's admin gate (see the mount in index.ts) and must answer to the same
// predicate rather than a second copy of it.
export function isAdminRequest(req: Request): boolean {
  if (!ADMIN_TOKEN) return true;
  return presentedAdminTokens(req).some((t) => tokenMatches(t));
}

// Reads are open to everyone; every mutation requires the admin token. This is
// registered before all routes, so unauthorized uploads are rejected before
// multer ever writes a temp file.
//
// CAUTION: the GET pass-through is fail-open. A new GET route is public unless
// it gates itself — any route serving stored PDF bytes must start with
// requireStoredPdfAccess (see /content and /archive), and owner-only reads
// like GET /settings check isAdminRequest inline.
api.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (isAdminRequest(req)) return next();
  res.status(401).json({ error: "Admin access required." });
});

// The owner's opt-in that lets viewers download stored PDFs without a share
// link — for instances already behind an authenticated perimeter (VPN,
// reverse-proxy auth). Never consulted in tokenless mode, where everyone is
// admin anyway.
function libraryOpen(): boolean {
  return getSettings().library_open === "1";
}

// The one access ladder for GETs that serve stored PDF bytes (the single-file
// content route and the collection zip): owner, open library, or a valid share
// signature on the URL. Sends the error response and returns false on denial.
// Every byte-serving GET must call this first — the gate above lets GETs pass.
function requireStoredPdfAccess(req: Request, res: Response, verify: () => ShareVerdict): boolean {
  if (isAdminRequest(req) || libraryOpen()) return true;
  if (req.query.exp == null && req.query.sig == null) {
    res.status(401).json({
      error:
        "Stored PDFs are owner-only. Ask the owner for a share link. (If the library was just closed, reload the page.)",
    });
    return false;
  }
  const verdict = verify();
  if (verdict === "expired") {
    res.status(403).json({ error: "This share link has expired." });
    return false;
  }
  if (verdict !== "ok") {
    res.status(403).json({ error: "Invalid share link." });
    return false;
  }
  return true;
}

// Lets the client decide whether to show mutating UI, and whether stored PDFs
// need minted links (token mode) or open directly (tokenless single-user or
// an open library).
// `pro` is null in a free build, which is what the client keys its Pro UI off.
// The client trusts this for *rendering only* — every Pro capability is
// enforced server-side, so a tampered response reveals nothing and unlocks
// nothing. That split is what lets all the Pro-aware client code live in the
// open repo behind an optional field.
//
// This route is deliberately unauthenticated — the client calls it before it
// knows whether it holds a token — so everything in the response has to be safe
// for a stranger to read. admin/token_required/library_open all describe the
// caller's own access, which is exactly what they came to ask.
//
// `pro` does not: version, master/spoke role and node count describe the
// *organization's* topology, not this caller's access. An exposed instance (open
// library, a share link, a LAN viewer) would hand any passer-by the number of
// writers paired to the agency and an exact module version to match against a
// known-bad build. shared/pro.ts calls the holdings index sensitive because what
// an agency is reading reveals which drugs and indications are in play; how many
// people are reading it is the same class of signal.
//
// Owner-only, then — and null for everyone else, which is the same answer a free
// build gives. That collapse is the point: a viewer cannot tell a Pro instance
// from a free one, and the only client that consumes this block is the Settings
// panel, which no viewer can open.
api.get("/auth", (req, res) => {
  const admin = isAdminRequest(req);
  res.json({
    admin,
    token_required: ADMIN_TOKEN.length > 0,
    library_open: libraryOpen(),
    pro: admin ? proStatus() : null,
  });
});

// ---------- topics ----------

api.get("/topics", (_req, res) => {
  const counts = topicArticleCounts();
  const topics = listTopics().map((d) => ({ ...d, articleCount: counts[d.id] ?? 0 }));
  res.json(topics);
});

// Topics are strictly MeSH headings: the client sends a heading picked from the
// autocomplete, we validate it against the indexed descriptor list, and build
// the PubMed term ourselves so a topic can never carry an invalid MeSH term.
api.post(
  "/topics",
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "'name' is required." });
    await ensureMeshLoaded();
    const descriptor = findMeshByName(name);
    if (!descriptor) {
      return res.status(422).json({
        error: `"${name}" isn't a MeSH heading. Pick a term from the suggestions.`,
        suggestions: searchMesh(name, 5).map((m) => m.name),
      });
    }
    const term = `"${descriptor.name}"[MeSH]`;
    if (topicByTerm(term)) {
      return res.status(409).json({ error: `"${descriptor.name}" is already a topic.` });
    }
    res.status(201).json(createTopic(descriptor.name, term));
  })
);

// Topics worth watching, derived from the subjects the user's own held papers
// cluster around (suggestTopicsFromLibrary). The counterpart of
// /journals/suggest: both turn what's already here into the next thing to add,
// rather than asking someone to guess a term cold.
//
// Registered ahead of /topics/:id/... so a literal path segment can't be read
// as an id — they don't collide today (there is no GET /topics/:id), but the
// ordering is what keeps that true if one is ever added.
api.get("/topics/suggest", (req, res) => {
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
  const body: TopicSuggestResponse = {
    results: suggestTopicsFromLibrary(limit),
    ...libraryFilingCounts(),
  };
  res.json(body);
});

// How many stored papers removing this topic would delete (for the confirm):
// papers exclusive to the topic and not saved in a library collection.
api.get("/topics/:id/article-count", (req, res) => {
  res.json({ count: countTopicArticles(Number(req.params.id)) });
});

api.delete("/topics/:id", (req, res) => {
  res.json(removeTopicWithArticles(Number(req.params.id)));
});

// Autocomplete against the local MeSH descriptor list (headings + synonyms).
api.get(
  "/mesh/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ results: [] });
    await ensureMeshLoaded();
    res.json({ results: searchMesh(q, 10).map((m) => ({ ui: m.ui, name: m.name })) });
  })
);

// The subjects one paper source is actually filed under, most-used first — the
// facet list behind the toolbar's subject filter. Distinct from /mesh/search
// above, which searches the whole MeSH vocabulary to pick a topic to watch;
// this only ever returns headings some paper here carries.
//
// Deliberately server-side rather than derived on the client from the papers
// payload: a MEDLINE paper carries ten to fifteen headings, so shipping them per
// row would add more to a two-thousand-paper response than the rows themselves.
const MESH_FACET_LIMIT = 200;

api.get("/mesh/headings", (req, res) => {
  const source = parseSource(req);
  if (!source) return res.status(400).json({ error: SOURCE_REQUIRED });
  const q = String(req.query.q ?? "").trim();
  // One past the limit, purely to learn whether there are more without a second
  // COUNT over the same grouping.
  const rows = meshFacetsForSource(source, q || undefined, MESH_FACET_LIMIT + 1);
  const body: MeshHeadingsResponse = {
    headings: rows.slice(0, MESH_FACET_LIMIT),
    // Over the whole source, not the search — it answers "why are only some of
    // my papers in this list", which a filtered count can't.
    filing: meshFilingForSource(source),
    truncated: rows.length > MESH_FACET_LIMIT,
  };
  res.json(body);
});

// ---------- journals ----------

api.get("/journals", (_req, res) => {
  res.json(listJournals());
});

// Autocomplete against the local NLM catalog, with OpenAlex metrics attached.
api.get(
  "/journals/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ results: [] });
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
    await ensureCatalogLoaded();
    // Pull a wider name-matched pool, then surface the highest-impact journals
    // first (a metric of 0 or no data sinks to the bottom) so obscure/defunct
    // titles don't crowd out the ones worth watching. Sort is stable, so ties
    // keep the catalog's name-relevance order. The pool of 50 matches the
    // per-call ISSN cap in attachMetrics, so every pooled row can get a metric.
    const rows = await attachMetrics(searchCatalog(q, 50));
    const score = (m: number | null) => (m == null ? -1 : m);
    rows.sort((a, b) => score(b.metric) - score(a.metric));
    res.json({
      results: rows.slice(0, limit).map((r) => ({
        nlm_id: r.nlm_id,
        title: r.title,
        abbr: r.med_abbr || r.iso_abbr,
        issn: r.issn_print || r.issn_online,
        metric: round1(r.metric),
      })),
    });
  })
);

// "Auto" suggestions: for each of the user's topics, sample its most recent
// PubMed papers, rank the journals publishing them, and return the
// highest-impact per-topic picks not already in the list (journal-suggest.ts).
// `per_topic` is each topic's top-N cut, taken before already-added journals
// are subtracted — so a topic already covered contributes nothing on a re-run.
// Suggestions are only staged client-side — adding still goes through
// POST /journals.
api.get(
  "/journals/suggest",
  asyncHandler(async (req, res) => {
    const perTopic = Math.min(30, Math.max(1, Number(req.query.per_topic) || 10));
    await ensureCatalogLoaded();
    const topics = listTopics();
    const { results, failed } =
      topics.length > 0
        ? await suggestJournals(topics, perTopic)
        : { results: [], failed: [] };
    res.json({
      topicCount: topics.length,
      failed,
      results: results.map((r) => ({ ...r, metric: round1(r.metric) })),
    });
  })
);

api.post(
  "/journals",
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.name ?? "").trim();
    const nlmId = String(req.body?.nlmId ?? "").trim();
    if (!raw && !nlmId) return res.status(400).json({ error: "'name' is required." });
    try {
      await ensureCatalogLoaded();
      // An explicit nlmId (the journal manager sends the catalog row's id) skips
      // name resolution — catalog names aren't unique, so a name round-trip could
      // land on a different journal than the one the user picked.
      let resolved: { nlmId: string; name: string } | null = null;
      if (nlmId) {
        const cat = findCatalogByNlmId(nlmId);
        if (!cat) return res.status(422).json({ error: "Unknown journal id." });
        resolved = { nlmId: cat.nlm_id, name: cat.med_abbr || cat.title };
      } else {
        // Resolve to the stable NLM id + display abbreviation; null means PubMed
        // doesn't recognize the name, so we never add a journal that returns nothing.
        resolved = await resolveJournal(raw);
      }
      if (!resolved) {
        return res.status(422).json({
          error: `PubMed doesn't recognize "${raw}" as a journal name. Use its official title or NLM abbreviation.`,
          suggestions: searchCatalog(raw, 5).map((c) => c.med_abbr || c.title),
        });
      }
      const existing = journalByNlmId(resolved.nlmId);
      if (existing) {
        return res
          .status(409)
          .json({ error: `That journal is already in the list (${existing.name}).` });
      }
      // Advisory, not a gate. The journal is real and the user asked for it, so
      // it's added either way — but if NLM doesn't index it for MEDLINE its
      // papers carry no MeSH headings, and topics are MeSH terms. Left unsaid,
      // that journal just quietly never yields a paper. An NCBI hiccup answers
      // null, which stores as "not established yet" and the backfill retries.
      const indexed = await isMedlineIndexed(resolved.nlmId);
      res.status(201).json(createJournal(resolved.name, resolved.nlmId, indexed));
    } catch (err) {
      // The one error this route reads: a race against another add of the same
      // journal, which the unique index catches. Anything else is the error
      // middleware's to log and answer.
      if (/UNIQUE/i.test(errMessage(err))) {
        return res.status(409).json({ error: "That journal is already in the list." });
      }
      throw err;
    }
  })
);

// How many stored papers removing this journal would delete (for the confirm).
api.get("/journals/:id/article-count", (req, res) => {
  res.json({ count: countJournalArticles(Number(req.params.id)) });
});

api.delete("/journals/:id", (req, res) => {
  res.json(removeJournalWithArticles(Number(req.params.id)));
});

// ---------- papers (unified rows for the table + timeline, either source) ----------

// The paper source both /papers and /graph accept: ?topic=, ?folder= or
// ?collection= (the first one given wins when several are sent). null = none
// given (400). Everything downstream dispatches on the source inside db.ts
// (listPapers, journalsForSource, graphPapersForSource) — a new source kind is
// added there, not by branching in each route.
//
// The reading is decodeSource in shared/source.ts, next to the encodeSource the
// client writes it with, so the two halves of the format can't drift apart. All
// this adds is Express: pulling the query bag off the request.
function parseSource(req: Request): PaperSource | null {
  return decodeSource(req.query as Record<string, unknown>);
}

const SOURCE_REQUIRED =
  "'topic', 'folder' or 'collection' query param is required ('collection=all' for every collection).";

// A ceiling on how many descriptors one request may filter by. The UIs are
// bound parameters, so this isn't about injection — it's that each one is
// another placeholder in an IN list, and a hand-written URL shouldn't be able to
// hand SQLite a few thousand of them.
const MAX_MESH_FILTER = 50;

// The filters both /papers and /graph accept, so a query means the same thing in
// either view: free text (?q=), MeSH descriptors (?mesh=D003924,D009369 — a
// paper filed under any of them), and ?mesh_major=1 to keep only papers a
// descriptor is a main point of. Ids are shape-checked purely to bound the list;
// an unrecognized one simply matches nothing.
function parseFilter(req: Request): PaperFilter {
  const mesh = String(req.query.mesh ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9]{1,16}$/.test(s))
    .slice(0, MAX_MESH_FILTER);
  return {
    q: req.query.q ? String(req.query.q) : undefined,
    mesh: mesh.length > 0 ? mesh : undefined,
    meshMajor: req.query.mesh_major === "1",
  };
}

api.get(
  "/papers",
  asyncHandler(async (req, res) => {
    const source = parseSource(req);
    if (!source) return res.status(400).json({ error: SOURCE_REQUIRED });
    const filter = parseFilter(req);
    let rows = listPapers(source, filter);

    // Backfill missing/stale citation counts, like /graph does. Poll and import
    // pre-warm them, so this is usually a no-op; re-query only when it wasn't.
    const stale = missingOrStaleCitations(rows.map((r) => r.pmid));
    if (stale.length > 0) {
      // Best-effort: a failing iCite must not take down a view whose paper rows
      // are entirely local. On failure this no-ops and we serve stale counts.
      // TODO(perf): this awaits the iCite round-trip before responding and then
      // re-queries the full list. Poll/import pre-warm counts so the slow path
      // is rare, but consider making the backfill fire-and-forget — serve the
      // local rows now, warm the cache for next load — to drop both the latency
      // and the re-query. Freshness-vs-latency tradeoff; synchronous for now.
      await warmCitations(stale, "papers");
      rows = listPapers(source, filter);
    }

    // One directory read instead of a stat per row. Only collection rows carry
    // a content_hash; topic and folder rows are always null, so skip the readdir
    // for them.
    const present = sourceHasFiles(source) ? existingBlobHashes() : null;
    // One batched lookup for the page, not one per row — the same shape as the
    // publication-type and blob-hash passes above it. Empty in a free build, so
    // `provenance` is simply never present there.
    //
    // Owner-only, and skipped outright for anyone else. GETs are open to
    // everyone (see the gate above), so this route is read by share-link
    // visitors and by anything that can reach the port. The org's *name* on a
    // paper row tells such a reader both that this instance is paired and who
    // it is paired with; a contributor's name is a freelancer's, self-declared
    // and never theirs to publish. GET /auth already narrowed its Pro block to
    // the owner for that reason, and a badge is not the place to give it back.
    // Not a filter after the fact: the lookup itself doesn't run.
    const provenance = isAdminRequest(req)
      ? paperProvenance(rows.map((r) => r.pmid))
      : new Map<string, PaperProvenance[]>();
    const body: PapersResponse = {
      papers: rows.map(({ content_hash, ...p }) => ({
        ...p,
        file_exists: content_hash != null && present != null && present.has(content_hash),
        ...(provenance.has(p.pmid) ? { provenance: provenance.get(p.pmid) } : {}),
      })),
      journals: journalsForSource(source),
    };
    res.json(body);
  })
);

// The papers list omits abstracts (they dominate its size); the timeline
// fetches them here on demand. Batched deliberately: it renders 50 cards at a
// time, and a per-card route meant 50 requests the browser would serialise
// about six at a time, so the last cards' text landed seconds after the first.
// Public article metadata, so open like /papers.
api.get("/abstracts", (req, res) => {
  const pmids = String(req.query.pmids ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const abstracts: Record<string, string> = {};
  if (pmids.length > 0) {
    for (const row of getArticleAbstracts(pmids)) abstracts[row.pmid] = row.abstract;
  }
  const body: AbstractsResponse = { abstracts };
  res.json(body);
});

// ---------- "do I already have this?" ----------

// The purchase-avoidance check. `?q=` is a block of pasted lines, one reference
// per line, and `?pmid=` / `?doi=` are the explicit single-identifier form the
// roadmap names. All three funnel into the same parser, so a bare identifier
// and one buried in a full reference are answered by one code path.
//
// Newline is the only separator. `;` was tried as a URL-friendlier alternative
// and is wrong: every Vancouver reference contains one (`2014;383:1699-710`),
// so it splits real references in half — and the half holding the DOI is the
// only one that could have been answered.
//
// A GET, and public like /papers: this is a read, and the whole value of the
// feature is that it takes one action. A POST would put it behind the admin
// gate, which would make the mandated pre-purchase check unavailable to exactly
// the read-only viewers who are told to perform it.
//
// Long pastes are chunked by the client (MAX_REFS_PER_REQUEST), the same way
// large uploads are — a URL is a poor container for a hundred references, and
// `truncated` reports anything this request had to leave out.
api.get(
  "/have",
  asyncHandler(async (req, res) => {
    const lines = [
      ...splitRefs(String(req.query.q ?? "")),
      // PMIDs are digits, so a comma between them is unambiguously a separator.
      // DOIs are not: the suffix is publisher-chosen and may legitimately
      // contain a comma, so those are only ever taken one per repeated param.
      ...toList(req.query.pmid, true),
      ...toList(req.query.doi, false),
    ];
    if (lines.length === 0) {
      return res.status(400).json({ error: "Paste a PMID, DOI, or PubMed link to check." });
    }
    const batch = lines.slice(0, MAX_REFS_PER_REQUEST);
    const offline = req.query.free === "0";
    const body: HaveResponse = {
      // ?free=0 means "answer without leaving the machine" — the client sends
      // it while a paste is still being typed, and drops it for the answer the
      // user acts on. It gates the org check as well as the free-copy lookup,
      // because both are network calls and the flag is really about that.
      // (The held/not-held verdict itself is local either way.)
      results: await checkHoldings(batch, { lookUpFree: !offline, checkOrg: !offline }),
      truncated: lines.length - batch.length,
    };
    res.json(body);
  })
);

// A query param that may be sent once or repeated, and — when its values can't
// themselves contain one — comma-separated.
function toList(raw: unknown, splitCommas: boolean): string[] {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return values
    .flatMap((v) => (splitCommas ? String(v).split(",") : [String(v)]))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- citation graph ----------

api.get(
  "/graph",
  asyncHandler(async (req, res) => {
    const source = parseSource(req);
    if (!source) return res.status(400).json({ error: SOURCE_REQUIRED });
    // Same filters the papers list takes, resolved by the same SQL, so they
    // select the same papers whichever view is showing.
    const papers = graphPapersForSource(source, parseFilter(req));
    const pmids = papers.map((p) => p.pmid);
    const inSet = new Set(pmids);

    // Lazily fetch + cache any missing/stale citation rows from iCite.
    // Best-effort: an iCite outage must not 500 the graph, which renders fine
    // from cached counts (or zeros for never-fetched papers).
    // TODO(perf): like /papers, this awaits the iCite refresh before responding;
    // a fire-and-forget backfill would serve cached counts immediately. Deferred.
    await warmCitations(missingOrStaleCitations(pmids), "graph");

    const cites = getCitations(pmids);
    // One directory read for the whole graph, as in /papers. Only collection
    // papers carry a content_hash, so topic and folder graphs skip the readdir.
    const present = sourceHasFiles(source) ? existingBlobHashes() : null;
    const nodes: GraphNode[] = papers.map((p) => ({
      pmid: p.pmid,
      title: p.title,
      url: p.url,
      journal_name: p.journal_name ?? "",
      citationCount: cites.get(p.pmid)?.citation_count ?? 0,
      year: /^\d{4}/.test(p.pub_date) ? Number(p.pub_date.slice(0, 4)) : null,
      file_id: p.file_id,
      file_name: p.file_name,
      file_exists: p.content_hash != null && present != null && present.has(p.content_hash),
    }));

    // Edge P -> R means P cites R; keep only edges where both ends are in the dataset.
    const edges: GraphEdge[] = [];
    for (const p of papers) {
      for (const ref of cites.get(p.pmid)?.references ?? []) {
        if (inSet.has(ref)) edges.push({ source: p.pmid, target: ref });
      }
    }

    // The full journal list for the source, deliberately not derived from the
    // (possibly search-narrowed) nodes: the chips must not vanish as you type.
    const body: GraphResponse = { nodes, edges, journals: journalsForSource(source) };
    res.json(body);
  })
);

// ---------- workspace entry names (collections + bookmark folders) ----------

// Names within a workspace are unique case-insensitively (see the unique index
// in db.ts) — two entries with the same name are indistinguishable in the
// picker. Sends the 409 and returns true when the requested name belongs to a
// different row; `selfId` is the row being renamed, so re-saving an entry's own
// name (or just changing its case) isn't a conflict.
function nameTaken(
  res: Response,
  label: string,
  existing: { id: number; name: string } | undefined,
  selfId: number | null
): boolean {
  if (!existing || existing.id === selfId) return false;
  res.status(409).json({ error: `A ${label} named “${existing.name}” already exists.` });
  return true;
}

// The lookup above and the write below aren't atomic, so two same-name requests
// can both pass the check. The unique index is the real arbiter; translate its
// error into the same 409 the check would have sent, as POST /journals does for
// its own unique constraint. Anything else is the error middleware's to handle.
function rethrowUnlessNameRace(err: unknown, res: Response, label: string): void {
  if (!/UNIQUE/i.test(errMessage(err))) throw err;
  res.status(409).json({ error: `That ${label} name is already taken.` });
}

// ---------- bookmark folders (saved papers) ----------

// The Bookmarks workspace's picker list, shaped like /collections: the stored
// row plus the count the dropdown badges. Papers themselves come from
// /api/papers?folder=<id>, since a folder is just another paper source.
api.get("/bookmark-folders", (_req, res) => {
  const counts = bookmarkCounts();
  res.json(listBookmarkFolders().map((f) => ({ ...f, paperCount: counts[f.id] ?? 0 })));
});

api.post("/bookmark-folders", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  if (nameTaken(res, "folder", bookmarkFolderByName(name), null)) return;
  try {
    res.status(201).json({ ...createBookmarkFolder(name), paperCount: 0 });
  } catch (err) {
    rethrowUnlessNameRace(err, res, "folder");
  }
});

api.put("/bookmark-folders/:id", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  if (!getBookmarkFolder(id)) return res.status(404).json({ error: "Folder not found." });
  if (nameTaken(res, "folder", bookmarkFolderByName(name), id)) return;
  try {
    renameBookmarkFolder(id, name);
  } catch (err) {
    return rethrowUnlessNameRace(err, res, "folder");
  }
  res.json({ ...getBookmarkFolder(id)!, paperCount: bookmarkCounts()[id] ?? 0 });
});

api.delete("/bookmark-folders/:id", (req, res) => {
  // The folder's bookmark rows cascade; the papers they pointed at stay.
  deleteBookmarkFolder(Number(req.params.id));
  res.status(204).end();
});

// Every (folder, paper) pair in one payload. Deliberately not folded into
// /papers or /graph as a per-row flag: the client keeps this whole set in
// memory, so toggling one paper repaints every view's icons without refetching
// a source's entire paper list (see BookmarkEntry in shared/types).
api.get("/bookmarks", (_req, res) => {
  res.json(listBookmarks());
});

// Save papers into a folder. Takes a list so the single-paper toggle and the
// bulk "save everything the filters left" are the same operation — the bulk
// case is just a longer array, and both get the same atomicity and the same
// already-saved accounting.
//
// Papers that aren't stored are skipped rather than failing the request: a bulk
// save shouldn't be lost because one paper was swept up by a topic removal
// mid-session. Only a request where nothing at all could be saved is an error,
// which is what turns a stale single-paper toggle into a 404.
api.post("/bookmark-folders/:id/papers", (req, res) => {
  const id = Number(req.params.id);
  const raw: unknown = req.body?.pmids;
  const pmids = Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : [];
  if (pmids.length === 0) return res.status(400).json({ error: "'pmids' must be a non-empty array." });
  // Below the parser's byte limit for this route (see shared/limits), so an
  // oversized save is refused with a reason rather than by body-parser, whose
  // payload-too-large says nothing about what to do next.
  if (pmids.length > MAX_BULK_BOOKMARK_PMIDS) {
    return res.status(400).json({
      error: `A single save is limited to ${MAX_BULK_BOOKMARK_PMIDS.toLocaleString()} papers. Narrow the filters and save again.`,
    });
  }
  if (!getBookmarkFolder(id)) return res.status(404).json({ error: "Folder not found." });

  const present = existingPmids(pmids);
  const storable = [...new Set(pmids.filter((p) => present.has(p)))];
  if (storable.length === 0) {
    return res.status(404).json({
      error:
        pmids.length === 1
          ? `Paper ${pmids[0]} isn't stored, so it can't be saved.`
          : "None of those papers are stored any more.",
    });
  }
  const added = addBookmarks(id, storable);
  // Counted against the de-duplicated request: `storable` is a Set, so a pmid
  // sent twice would otherwise be reported as a paper that isn't stored.
  const asked = new Set(pmids).size;
  res.json({ added, alreadySaved: storable.length - added, missing: asked - storable.length });
});

api.delete("/bookmark-folders/:id/papers/:pmid", (req, res) => {
  removeBookmark(Number(req.params.id), String(req.params.pmid));
  res.status(204).end();
});

// ---------- collections (uploaded PDF libraries) ----------

// Uploads land in the blob store's temp dir; storeBlobFromTemp then hashes and
// moves (or discards) each one.
const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
});

// Wrap multer so its errors (file too large, too many files) come back as the
// JSON shape the client's error handling expects, not Express's HTML 500.
function uploadFiles(req: Request, res: Response, next: NextFunction): void {
  upload.array("files")(req, res, (err: unknown) => {
    // A MulterError is a limit the client tripped, and its message ("File too
    // large") is both safe and the useful thing to say.
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: errMessage(err) });
    }
    // Anything else came from the disk storage engine writing into
    // UPLOAD_TMP_DIR — an ENOSPC/EACCES naming that path. Not the client's
    // fault and not theirs to see, so hand it to the error middleware.
    if (err) return next(err);
    next();
  });
}

// Deliberately carries no sharing flag. Which collections are wired to an
// organisation is Pro topology, this route is open to everyone (see the gate
// above), and a per-row `synced` key is legible even to a reader who can't read
// its value: present on a paired spoke, absent on a free build. The panel that
// needs it asks GET /api/pro/sync, which is behind Pro's own auth.
api.get("/collections", (_req, res) => {
  const counts = collectionCounts();
  res.json(
    listCollections().map((c) => ({
      ...c,
      fileCount: counts[c.id]?.files ?? 0,
      matchedCount: counts[c.id]?.matched ?? 0,
    }))
  );
});

api.post("/collections", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  if (nameTaken(res, "collection", collectionByName(name), null)) return;
  try {
    res.status(201).json(createCollection(name));
  } catch (err) {
    rethrowUnlessNameRace(err, res, "collection");
  }
});

api.put("/collections/:id", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  if (!getCollection(id)) return res.status(404).json({ error: "Collection not found." });
  if (nameTaken(res, "collection", collectionByName(name), id)) return;
  try {
    renameCollection(id, name);
  } catch (err) {
    return rethrowUnlessNameRace(err, res, "collection");
  }
  res.json(getCollection(id));
});

api.delete("/collections/:id", (req, res) => {
  // Rows cascade and orphaned blobs are GC'd inside deleteCollection.
  deleteCollection(Number(req.params.id));
  res.status(204).end();
});

// The API shape of a collection file: the DB row minus the server-internal
// content_hash (the blob-store key, which also feeds the share-link MAC), plus
// whether that blob is still present. The files list and the manual-match
// response both go through this, so the client always sees one shape.
// `present`, when given, is a prebuilt set of blob hashes (from one readdir) so
// a list of files resolves `exists` without a stat syscall per row; a lone file
// (manual match) just stats directly.
function apiFile(
  row: CollectionFile,
  present?: Set<string>
): Omit<CollectionFile, "content_hash"> & { exists: boolean } {
  const { content_hash, ...rest } = row;
  const exists = present ? present.has(content_hash) : blobExists(content_hash);
  return { ...rest, exists };
}

// Every file row of a collection (matched or not), for the management shell:
// the unmatched-files section and flagging files whose blob has gone missing.
// Paper rows themselves come from /api/papers.
api.get("/collections/:id/files", (req, res) => {
  const id = Number(req.params.id);
  if (!getCollection(id)) return res.status(404).json({ error: "Collection not found." });
  const present = existingBlobHashes();
  res.json({ files: listCollectionFiles(id).map((f) => apiFile(f, present)) });
});

// Upload PDFs into a collection. Each file is verified by magic bytes, hashed
// into the blob store, and recorded; re-uploads of content already in the
// collection count as skipped. The client batches large selections across
// several requests, then starts the scan job once.
api.post(
  "/collections/:id/files",
  uploadFiles,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const files = (req.files ?? []) as Express.Multer.File[];
    const discardTemps = () => Promise.allSettled(files.map((f) => fs.promises.unlink(f.path)));
    if (!getCollection(id)) {
      await discardTemps();
      return res.status(404).json({ error: "Collection not found." });
    }
    if (files.length === 0) return res.status(400).json({ error: "No files were uploaded." });
    const stored: { hash: string; name: string }[] = [];
    try {
      let skipped = 0;
      for (const f of files) {
        if (!(await isPdfFile(f.path))) {
          skipped++;
          await fs.promises.unlink(f.path);
          continue;
        }
        const { hash } = await storeBlobFromTemp(f.path);
        stored.push({ hash, name: cleanUploadName(f.originalname) });
      }
      const added = addCollectionFiles(id, stored);
      skipped += stored.length - added;
      res.status(201).json({ added, skipped });
    } catch (err) {
      await discardTemps();
      // Blobs stored before the failure but never recorded would leak otherwise.
      gcBlobsIfOrphaned(stored.map((s) => s.hash));
      // Cleanup done, so the error can go where every other one goes.
      throw err;
    }
  })
);

// Start the scan/match job over this collection's 'pending' rows. Uploading
// more files and re-running picks up just the new ones.
api.post("/collections/:id/import", (req, res) => {
  const id = Number(req.params.id);
  const collection = getCollection(id);
  if (!collection) return res.status(404).json({ error: "Collection not found." });
  if (isImportRunning(id)) {
    return res.status(409).json({ error: "An import is already running for this collection." });
  }
  const status = startImport(id, collection.name);
  res.status(202).json({ jobId: status.jobId, total: status.total });
});

// Stream a stored PDF for viewing in a browser tab. Unlike the rest of the
// GETs, the bytes are owner-only: uploaded PDFs are usually copyrighted, so
// viewers need a signed link minted by the admin (below). The general GET
// pass-through in the gate middleware doesn't apply here.
api.get("/collections/files/:fileId/content", (req, res) => {
  const file = getCollectionFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: "File not found." });
  const allowed = requireStoredPdfAccess(req, res, () =>
    verifyFileShare(file.id, file.content_hash, req.query.exp, req.query.sig)
  );
  if (!allowed) return;
  if (!blobExists(file.content_hash)) {
    return res.status(410).json({ error: "That file's PDF is no longer stored." });
  }
  // Header values must stay ASCII and quote-free; the name is display-only.
  // safeFileName first, because the scrub below leaves forward slashes alone —
  // and because rows written before file_name was sanitised on the way in are
  // still in the database.
  const filename = safeFileName(file.file_name)
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.sendFile(blobPath(file.content_hash));
});

// Mint an expiring share link for one stored PDF (admin-only via the mutation
// gate; POST so it can never be triggered by a bare URL). The default TTL is
// the product's "share this paper" window; the client's own PDF-open flow
// requests a short one instead.
const SHARE_TTL_DEFAULT = 24 * 3600;
const SHARE_TTL_MIN = 60;
const SHARE_TTL_MAX = 7 * 24 * 3600;

// Validated TTL from a mint request body; null when out of bounds.
function shareTtl(body: { ttlSeconds?: unknown } | undefined): number | null {
  const ttl = body?.ttlSeconds ?? SHARE_TTL_DEFAULT;
  if (!Number.isInteger(ttl)) return null;
  const n = ttl as number;
  return n >= SHARE_TTL_MIN && n <= SHARE_TTL_MAX ? n : null;
}

const TTL_ERROR = `ttlSeconds must be an integer between ${SHARE_TTL_MIN} and ${SHARE_TTL_MAX}.`;

api.post("/collections/files/:fileId/share", (req, res) => {
  if (!signingEnabled) {
    return res.status(400).json({ error: "Share links require ADMIN_TOKEN to be configured." });
  }
  const file = getCollectionFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: "File not found." });
  if (!blobExists(file.content_hash)) {
    return res.status(410).json({ error: "That file's PDF is no longer stored." });
  }
  const ttl = shareTtl(req.body);
  if (ttl == null) return res.status(400).json({ error: TTL_ERROR });
  const { exp, sig } = signFileShare(file.id, file.content_hash, ttl);
  res.json({
    path: `/api/collections/files/${file.id}/content?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
});

// Mint an expiring link to the whole collection as a zip download. The grant
// covers the collection's contents at download time, not at mint time.
api.post("/collections/:id/share", (req, res) => {
  if (!signingEnabled) {
    return res.status(400).json({ error: "Share links require ADMIN_TOKEN to be configured." });
  }
  const id = Number(req.params.id);
  if (!getCollection(id)) return res.status(404).json({ error: "Collection not found." });
  if (!listCollectionFiles(id).some((f) => blobExists(f.content_hash))) {
    return res.status(410).json({ error: "This collection has no stored PDFs." });
  }
  const ttl = shareTtl(req.body);
  if (ttl == null) return res.status(400).json({ error: TTL_ERROR });
  const { exp, sig } = signCollectionShare(id, ttl);
  res.json({
    path: `/api/collections/${id}/archive?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
});

// Two uploads can share a display name; suffix "(2)", "(3)", … keeps every
// zip entry distinct.
function uniqueZipName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${base} (${n})${ext}`;
  used.add(candidate);
  return candidate;
}

// Stream every stored PDF of a collection as one zip. Same access rule as the
// single-file content route: owner, or a valid collection share link.
api.get("/collections/:id/archive", (req, res) => {
  const id = Number(req.params.id);
  const collection = getCollection(id);
  if (!collection) return res.status(404).json({ error: "Collection not found." });
  const allowed = requireStoredPdfAccess(req, res, () =>
    verifyCollectionShare(id, req.query.exp, req.query.sig)
  );
  if (!allowed) return;
  const files = listCollectionFiles(id).filter((f) => blobExists(f.content_hash));
  if (files.length === 0) {
    return res.status(410).json({ error: "This collection has no stored PDFs." });
  }
  // Same ASCII/quote scrub as single-file downloads; the zip carries the
  // collection's name.
  const zipName =
    (collection.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "collection") +
    ".zip";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
  // PDFs are already compressed — store entries as-is instead of deflating.
  const zip = new ZipArchive({ store: true });
  zip.on("error", (err: Error) => {
    // Headers are already on the wire; all we can do is drop the connection
    // so the client sees a failed download rather than a truncated "success".
    console.error(`[archive] collection ${id}: ${errMessage(err)}`);
    res.destroy(err);
  });
  zip.pipe(res);
  const used = new Set<string>();
  for (const f of files) {
    // The zip-slip sink: an entry name is a *path*, so whatever is in
    // file_name decides where this lands when someone extracts the download.
    // Sanitised on the way in now, but rows predate that, and one call here
    // makes the guarantee a property of the writer rather than of history.
    zip.append(fs.createReadStream(blobPath(f.content_hash)), {
      name: uniqueZipName(safeFileName(f.file_name), used),
    });
  }
  // The "error" handler above already logs and destroys the response; the
  // catch just keeps finalize()'s rejection from crashing the process.
  void zip.finalize().catch(() => {});
});

api.get("/collections/:id/import/status", (req, res) => {
  res.json(getImportStatus(Number(req.params.id)) ?? { state: "idle" });
});

// Manually assign a PMID to a file the scanner couldn't match. The PMID is
// validated by actually fetching its metadata from PubMed.
api.post(
  "/collections/files/:fileId/pmid",
  asyncHandler(async (req, res) => {
    const fileId = Number(req.params.fileId);
    const file = getCollectionFile(fileId);
    if (!file) return res.status(404).json({ error: "File not found." });
    const pmid = String(req.body?.pmid ?? "").trim();
    if (!/^\d{1,8}$/.test(pmid)) {
      return res.status(400).json({ error: "A PMID is 1–8 digits." });
    }
    const articles = await fetchArticles([pmid]);
    if (articles.length === 0) {
      return res.status(422).json({ error: `PubMed doesn't recognize PMID ${pmid}.` });
    }
    upsertArticles(articles);
    await warmCitations([pmid], "manual match");
    setFileMatched(fileId, pmid, "manual");
    // Return the same shape as the files list (content_hash stripped, exists
    // added), not the raw row. getCollectionFile can't be missing here — the
    // row was verified above and setFileMatched only updates it.
    res.json(apiFile(getCollectionFile(fileId)!));
  })
);

api.delete("/collections/files/:fileId", (req, res) => {
  // The row's blob is GC'd inside deleteCollectionFile if this was the last
  // reference.
  deleteCollectionFile(Number(req.params.fileId));
  res.status(204).end();
});

// ---------- refresh / status ----------

api.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const topicId = req.query.topic ? Number(req.query.topic) : undefined;
    // Share the scheduler's lock so a manual refresh can't run concurrently with
    // a scheduled poll (or another refresh) and double up NCBI traffic.
    const results = await withPollLock(() =>
      topicId ? pollTopic(topicId).then((r) => [r]) : pollAll()
    );
    if (results === null) {
      return res.status(409).json({ error: "A refresh is already running. Try again in a moment." });
    }
    res.json({ results, polledAt: new Date().toISOString() });
  })
);

// ---------- settings ----------

// Where other machines can reach this server, for the Settings sharing panel.
// A loopback bind isn't shareable; a wildcard bind maps to every external IPv4
// address this machine has (LAN, Tailscale, …).
//
// boundPort(), not PORT: these are addresses someone is about to type into
// another machine's browser, so they have to name the port the socket is
// actually on. With PORT=0 the configured value is 0 and the OS picked the real
// one at bind time.
function shareUrls(): string[] {
  if (HOST_IS_LOOPBACK) return [];
  const port = boundPort();
  if (HOST !== "0.0.0.0" && HOST !== "::") return [`http://${HOST}:${port}`];
  const urls: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) urls.push(`http://${info.address}:${port}`);
    }
  }
  return urls;
}

// Never echo the raw API key back; just whether one is set.
// How the API treats each setting: how PUT persists it and how the response
// echoes it. `satisfies Record<keyof Settings, …>` makes the table exhaustive —
// adding a setting to SETTING_DEFAULTS without deciding its rule is a compile
// error, so a new toggle can never round-trip 200 without persisting.
type SettingRule =
  | { kind: "string"; validate?: (value: string) => string | null } // returns an error message
  | { kind: "boolean" }
  | { kind: "secret"; expose: `has_${string}` }; // write-only; response carries presence

const SETTING_RULES = {
  ncbi_email: { kind: "string" },
  // A blank cron means "use the default"; anything else must be valid, or the
  // scheduler would silently fall back to the default while the UI reported a
  // successful save.
  poll_cron: {
    kind: "string",
    validate: (v) => (v && !isValidCron(v) ? "That isn't a valid cron expression." : null),
  },
  poll_enabled: { kind: "boolean" },
  library_open: { kind: "boolean" },
  ncbi_api_key: { kind: "secret", expose: "has_api_key" },
} satisfies Record<keyof Settings, SettingRule>;

const SETTING_KEYS = Object.keys(SETTING_RULES) as (keyof Settings)[];

function settingsResponse() {
  const s = getSettings();
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const rule: SettingRule = SETTING_RULES[key];
    if (rule.kind === "string") out[key] = s[key];
    else if (rule.kind === "boolean") out[key] = s[key] === "1";
    else out[rule.expose] = Boolean(s[key]); // never echo the secret itself
  }
  out.share_urls = shareUrls(); // derived from the bind address, not a setting
  // Also not a setting: how the server was launched. share_urls is empty for
  // both a loopback server and a desktop app, but the fix differs — one can be
  // rebound via server/.env, the other has no .env to edit — so the UI needs to
  // tell the two apart.
  out.desktop = IS_DESKTOP;
  return out;
}

// Unlike other reads, this one is admin-only: it exposes the owner's NCBI email
// and this machine's external IPs (share_urls). The global gate above only
// covers mutations, so GETs need their own check — without it, any viewer on a
// shared instance could read these.
api.get("/settings", (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: "Admin access required." });
  res.json(settingsResponse());
});

api.put("/settings", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Validate everything before persisting anything, so a rejected value can't
  // leave the save half-applied.
  for (const key of SETTING_KEYS) {
    const rule: SettingRule = SETTING_RULES[key];
    const value = body[key];
    if (rule.kind === "string" && rule.validate && typeof value === "string") {
      const err = rule.validate(value.trim());
      if (err) return res.status(400).json({ error: err });
    }
  }
  for (const key of SETTING_KEYS) {
    const rule: SettingRule = SETTING_RULES[key];
    const value = body[key];
    if (rule.kind === "string" && typeof value === "string") {
      setSetting(key, value.trim());
    } else if (rule.kind === "boolean" && typeof value === "boolean") {
      setSetting(key, value ? "1" : "0");
    } else if (rule.kind === "secret" && typeof value === "string" && value.trim()) {
      // Secrets are write-only: only overwrite on an explicit non-empty value.
      setSetting(key, value.trim());
    }
  }
  rescheduleFromSettings();
  res.json(settingsResponse());
});
