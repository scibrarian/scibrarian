import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import {
  addCollectionFiles,
  collectionCounts,
  collectionGraphPapers,
  countJournalArticles,
  createCollection,
  createDisease,
  createJournal,
  deleteCollection,
  deleteCollectionFile,
  deleteDisease,
  diseaseArticleCounts,
  gcBlobsIfOrphaned,
  getArticleAbstract,
  getCitations,
  getCollection,
  getCollectionFile,
  getSettings,
  graphPapers,
  journalByNlmId,
  journalsForCollection,
  journalsForDisease,
  listCollectionFiles,
  listPapers,
  listCollections,
  listDiseases,
  listJournals,
  missingOrStaleCitations,
  removeJournalWithArticles,
  renameCollection,
  searchCatalog,
  setFileMatched,
  setSetting,
  upsertArticles,
} from "./db.js";
import {
  blobExists,
  blobPath,
  cleanUploadName,
  existingBlobHashes,
  isPdfFile,
  storeBlobFromTemp,
} from "./blobstore.js";
import { ADMIN_TOKEN, HOST, HOST_IS_LOOPBACK, PORT, UPLOAD_TMP_DIR } from "./config.js";
import { getImportStatus, isImportRunning, startImport } from "./importer.js";
import { attachMetrics, ensureCatalogLoaded } from "./journal-catalog.js";
import { fetchArticles, resolveJournal } from "./pubmed.js";
import {
  isValidCron,
  pollAll,
  pollDisease,
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
  CollectionFile,
  GraphEdge,
  GraphNode,
  GraphResponse,
  PapersResponse,
  Settings,
} from "./types.js";
import { errMessage, round1 } from "./util.js";

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

// No ADMIN_TOKEN configured = single-user mode: everyone is admin (index.ts
// refuses to bind non-loopback in that case).
function isAdminRequest(req: Request): boolean {
  if (!ADMIN_TOKEN) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
  return m != null && tokenMatches(m[1].trim());
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
api.get("/auth", (req, res) => {
  res.json({
    admin: isAdminRequest(req),
    token_required: ADMIN_TOKEN.length > 0,
    library_open: libraryOpen(),
  });
});

// ---------- diseases ----------

api.get("/diseases", (_req, res) => {
  const counts = diseaseArticleCounts();
  const diseases = listDiseases().map((d) => ({ ...d, articleCount: counts[d.id] ?? 0 }));
  res.json(diseases);
});

api.post("/diseases", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const term = String(req.body?.term ?? "").trim();
  if (!name || !term) {
    return res.status(400).json({ error: "Both 'name' and 'term' are required." });
  }
  res.status(201).json(createDisease(name, term));
});

api.delete("/diseases/:id", (req, res) => {
  deleteDisease(Number(req.params.id));
  res.status(204).end();
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
    await ensureCatalogLoaded();
    // Pull a wider name-matched pool, then surface the highest-impact journals
    // first (a metric of 0 or no data sinks to the bottom) so obscure/defunct
    // titles don't crowd out the ones worth watching. Sort is stable, so ties
    // keep the catalog's name-relevance order.
    const rows = await attachMetrics(searchCatalog(q, 30));
    const score = (m: number | null) => (m == null ? -1 : m);
    rows.sort((a, b) => score(b.metric) - score(a.metric));
    res.json({
      results: rows.slice(0, 10).map((r) => ({
        title: r.title,
        abbr: r.med_abbr || r.iso_abbr,
        issn: r.issn_print || r.issn_online,
        metric: round1(r.metric),
      })),
    });
  })
);

api.post("/journals", async (req, res) => {
  const raw = String(req.body?.name ?? "").trim();
  if (!raw) return res.status(400).json({ error: "'name' is required." });
  try {
    await ensureCatalogLoaded();
    // Resolve to the stable NLM id + display abbreviation; null means PubMed
    // doesn't recognize the name, so we never add a journal that returns nothing.
    const resolved = await resolveJournal(raw);
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
    res.status(201).json(createJournal(resolved.name, resolved.nlmId));
  } catch (err) {
    const msg = errMessage(err);
    if (/UNIQUE/i.test(msg)) {
      return res.status(409).json({ error: "That journal is already in the list." });
    }
    res.status(500).json({ error: msg });
  }
});

// How many stored papers removing this journal would delete (for the confirm).
api.get("/journals/:id/article-count", (req, res) => {
  res.json({ count: countJournalArticles(Number(req.params.id)) });
});

api.delete("/journals/:id", (req, res) => {
  res.json(removeJournalWithArticles(Number(req.params.id)));
});

// ---------- papers (unified rows for the table + timeline, either source) ----------

api.get(
  "/papers",
  asyncHandler(async (req, res) => {
    const diseaseId = Number(req.query.disease);
    const collectionId = Number(req.query.collection);
    if (!diseaseId && !collectionId) {
      return res.status(400).json({ error: "'disease' or 'collection' query param is required." });
    }
    const q = req.query.q ? String(req.query.q) : undefined;
    const source = diseaseId ? { diseaseId } : { collectionId };
    let rows = listPapers(source, q);

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
      rows = listPapers(source, q);
    }

    // One directory read instead of a stat per row. Only collection rows carry
    // a content_hash; disease rows are always null, so skip the readdir for them.
    const present = collectionId ? existingBlobHashes() : null;
    const body: PapersResponse = {
      papers: rows.map(({ content_hash, ...p }) => ({
        ...p,
        file_exists: content_hash != null && present != null && present.has(content_hash),
      })),
      journals: diseaseId ? journalsForDisease(diseaseId) : journalsForCollection(collectionId),
    };
    res.json(body);
  })
);

// The papers list omits abstracts (they dominate its size); the card view
// fetches one here on demand. Public article metadata, so open like /papers.
api.get("/articles/:pmid/abstract", (req, res) => {
  res.json({ abstract: getArticleAbstract(String(req.params.pmid)) ?? "" });
});

// ---------- citation graph ----------

api.get(
  "/graph",
  asyncHandler(async (req, res) => {
    const diseaseId = Number(req.query.disease);
    const collectionId = Number(req.query.collection);
    if (!diseaseId && !collectionId) {
      return res.status(400).json({ error: "'disease' or 'collection' query param is required." });
    }
    const papers = diseaseId ? graphPapers(diseaseId) : collectionGraphPapers(collectionId);
    const pmids = papers.map((p) => p.pmid);
    const inSet = new Set(pmids);

    // Lazily fetch + cache any missing/stale citation rows from iCite.
    // Best-effort: an iCite outage must not 500 the graph, which renders fine
    // from cached counts (or zeros for never-fetched papers).
    // TODO(perf): like /papers, this awaits the iCite refresh before responding;
    // a fire-and-forget backfill would serve cached counts immediately. Deferred.
    await warmCitations(missingOrStaleCitations(pmids), "graph");

    const cites = getCitations(pmids);
    const nodes: GraphNode[] = papers.map((p) => ({
      pmid: p.pmid,
      title: p.title,
      url: p.url,
      citationCount: cites.get(p.pmid)?.citation_count ?? 0,
      year: /^\d{4}/.test(p.pub_date) ? Number(p.pub_date.slice(0, 4)) : null,
    }));

    // Edge P -> R means P cites R; keep only edges where both ends are in the dataset.
    const edges: GraphEdge[] = [];
    for (const p of papers) {
      for (const ref of cites.get(p.pmid)?.references ?? []) {
        if (inSet.has(ref)) edges.push({ source: p.pmid, target: ref });
      }
    }

    const body: GraphResponse = { nodes, edges };
    res.json(body);
  })
);

// ---------- collections (uploaded PDF libraries) ----------

// Uploads land in the blob store's temp dir; storeBlobFromTemp then hashes and
// moves (or discards) each one.
const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024, files: 50 },
});

// Wrap multer so its errors (file too large, too many files) come back as the
// JSON shape the client's error handling expects, not Express's HTML 500.
function uploadFiles(req: Request, res: Response, next: NextFunction): void {
  upload.array("files")(req, res, (err: unknown) => {
    if (err) {
      return res.status(400).json({ error: errMessage(err) });
    }
    next();
  });
}

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
  res.status(201).json(createCollection(name));
});

api.put("/collections/:id", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  if (!getCollection(id)) return res.status(404).json({ error: "Collection not found." });
  renameCollection(id, name);
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
      res.status(500).json({ error: errMessage(err) });
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
  const filename = file.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
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
    zip.append(fs.createReadStream(blobPath(f.content_hash)), {
      name: uniqueZipName(f.file_name, used),
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
    const diseaseId = req.query.disease ? Number(req.query.disease) : undefined;
    // Share the scheduler's lock so a manual refresh can't run concurrently with
    // a scheduled poll (or another refresh) and double up NCBI traffic.
    const results = await withPollLock(() =>
      diseaseId ? pollDisease(diseaseId).then((r) => [r]) : pollAll()
    );
    if (results === null) {
      return res.status(409).json({ error: "A refresh is already running. Try again in a moment." });
    }
    res.json({ results, polledAt: new Date().toISOString() });
  })
);

api.get("/status", (_req, res) => {
  const counts = diseaseArticleCounts();
  res.json({
    diseases: listDiseases().map((d) => ({
      id: d.id,
      name: d.name,
      last_polled_at: d.last_polled_at,
      articleCount: counts[d.id] ?? 0,
    })),
  });
});

// ---------- settings ----------

// Where other machines can reach this server, for the Settings sharing panel.
// A loopback bind isn't shareable; a wildcard bind maps to every external IPv4
// address this machine has (LAN, Tailscale, …).
function shareUrls(): string[] {
  if (HOST_IS_LOOPBACK) return [];
  if (HOST !== "0.0.0.0" && HOST !== "::") return [`http://${HOST}:${PORT}`];
  const urls: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) urls.push(`http://${info.address}:${PORT}`);
    }
  }
  return urls;
}

// Never echo the raw API key back; just whether one is set.
function settingsResponse() {
  const s = getSettings();
  return {
    ncbi_email: s.ncbi_email,
    poll_cron: s.poll_cron,
    poll_enabled: s.poll_enabled === "1",
    library_open: s.library_open === "1",
    has_api_key: Boolean(s.ncbi_api_key),
    share_urls: shareUrls(),
  };
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
  const body = req.body ?? {};
  // A blank cron means "use the default"; anything else must be valid, or the
  // scheduler would silently fall back to the default while the UI reported a
  // successful save. Reject before persisting so nothing is half-applied.
  if (typeof body.poll_cron === "string" && body.poll_cron.trim() && !isValidCron(body.poll_cron.trim())) {
    return res.status(400).json({ error: "That isn't a valid cron expression." });
  }
  const editable: (keyof Settings)[] = ["ncbi_email", "poll_cron"];
  for (const key of editable) {
    if (typeof body[key] === "string") setSetting(key, body[key].trim());
  }
  if (typeof body.poll_enabled === "boolean") {
    setSetting("poll_enabled", body.poll_enabled ? "1" : "0");
  }
  if (typeof body.library_open === "boolean") {
    setSetting("library_open", body.library_open ? "1" : "0");
  }
  // Only overwrite the API key when a non-empty value is explicitly provided.
  if (typeof body.ncbi_api_key === "string" && body.ncbi_api_key.trim()) {
    setSetting("ncbi_api_key", body.ncbi_api_key.trim());
  }
  rescheduleFromSettings();
  res.json(settingsResponse());
});
