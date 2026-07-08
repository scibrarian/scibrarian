import fs from "node:fs";
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
  getCitations,
  getCollection,
  getCollectionFile,
  getSettings,
  graphPapers,
  hashesForCollection,
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
  deleteBlobsIfOrphaned,
  isPdfFile,
  storeBlobFromTemp,
} from "./blobstore.js";
import { UPLOAD_TMP_DIR } from "./config.js";
import { ensureCitations } from "./icite.js";
import { getImportStatus, isImportRunning, startImport } from "./importer.js";
import { attachMetrics, ensureCatalogLoaded } from "./journal-catalog.js";
import { fetchArticles, resolveJournal } from "./pubmed.js";
import { pollAll, pollDisease, rescheduleFromSettings, warmCitations } from "./poller.js";
import type { GraphEdge, GraphNode, GraphResponse, PapersResponse, Settings } from "./types.js";
import { errMessage, round1 } from "./util.js";

// Express 4 doesn't forward a rejected promise to the error middleware, so
// async handlers without their own catch are wrapped in this.
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const api = Router();

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
  const deletedArticles = removeJournalWithArticles(Number(req.params.id));
  res.json({ deletedArticles });
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
      await ensureCitations(stale);
      rows = listPapers(source, q);
    }

    const body: PapersResponse = {
      papers: rows.map(({ content_hash, ...p }) => ({
        ...p,
        file_exists: content_hash != null && blobExists(content_hash),
      })),
      journals: diseaseId ? journalsForDisease(diseaseId) : journalsForCollection(collectionId),
    };
    res.json(body);
  })
);

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
    await ensureCitations(missingOrStaleCitations(pmids));

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
  // collection_files cascade; cached articles/citations stay (shared globally).
  // Blobs nothing else references go with the collection.
  const id = Number(req.params.id);
  const hashes = hashesForCollection(id);
  deleteCollection(id);
  deleteBlobsIfOrphaned(hashes);
  res.status(204).end();
});

// Every file row of a collection (matched or not), for the management shell:
// the unmatched-files section and flagging files whose blob has gone missing.
// Paper rows themselves come from /api/papers.
api.get("/collections/:id/files", (req, res) => {
  const id = Number(req.params.id);
  if (!getCollection(id)) return res.status(404).json({ error: "Collection not found." });
  res.json({
    files: listCollectionFiles(id).map((f) => ({ ...f, exists: blobExists(f.content_hash) })),
  });
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
      deleteBlobsIfOrphaned(stored.map((s) => s.hash));
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

// Stream a stored PDF for viewing in a browser tab.
api.get("/collections/files/:fileId/content", (req, res) => {
  const file = getCollectionFile(Number(req.params.fileId));
  if (!file) return res.status(404).json({ error: "File not found." });
  if (!blobExists(file.content_hash)) {
    return res.status(410).json({ error: "That file's PDF is no longer stored." });
  }
  // Header values must stay ASCII and quote-free; the name is display-only.
  const filename = file.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.sendFile(blobPath(file.content_hash));
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
    res.json(getCollectionFile(fileId));
  })
);

api.delete("/collections/files/:fileId", (req, res) => {
  const fileId = Number(req.params.fileId);
  const file = getCollectionFile(fileId);
  deleteCollectionFile(fileId);
  if (file) deleteBlobsIfOrphaned([file.content_hash]);
  res.status(204).end();
});

// ---------- refresh / status ----------

api.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const diseaseId = req.query.disease ? Number(req.query.disease) : undefined;
    const results = diseaseId ? [await pollDisease(diseaseId)] : await pollAll();
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

// Never echo the raw API key back; just whether one is set.
function settingsResponse() {
  const s = getSettings();
  return {
    ncbi_email: s.ncbi_email,
    poll_cron: s.poll_cron,
    has_api_key: Boolean(s.ncbi_api_key),
  };
}

api.get("/settings", (_req, res) => {
  res.json(settingsResponse());
});

api.put("/settings", (req, res) => {
  const body = req.body ?? {};
  const editable: (keyof Settings)[] = ["ncbi_email", "poll_cron"];
  for (const key of editable) {
    if (typeof body[key] === "string") setSetting(key, body[key].trim());
  }
  // Only overwrite the API key when a non-empty value is explicitly provided.
  if (typeof body.ncbi_api_key === "string" && body.ncbi_api_key.trim()) {
    setSetting("ncbi_api_key", body.ncbi_api_key.trim());
  }
  rescheduleFromSettings();
  res.json(settingsResponse());
});
