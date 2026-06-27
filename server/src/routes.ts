import { Router } from "express";
import {
  countJournalArticles,
  createDisease,
  createJournal,
  deleteDisease,
  diseaseArticleCounts,
  getCitations,
  getSettings,
  graphPapers,
  journalByNlmId,
  journalsForDisease,
  listArticles,
  listDiseases,
  listJournals,
  missingOrStaleCitations,
  removeJournalWithArticles,
  searchCatalog,
  setSetting,
  upsertCitations,
} from "./db.js";
import { fetchCitations } from "./icite.js";
import { attachMetrics, ensureCatalogLoaded } from "./journal-catalog.js";
import { resolveJournal } from "./pubmed.js";
import { pollAll, pollDisease, rescheduleFromSettings } from "./poller.js";
import type { GraphEdge, GraphNode, GraphResponse, Settings } from "./types.js";

function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
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
api.get("/journals/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
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
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
    const msg = err instanceof Error ? err.message : String(err);
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

// ---------- articles (timeline) ----------

api.get("/articles", (req, res) => {
  const diseaseId = Number(req.query.disease);
  if (!diseaseId) return res.status(400).json({ error: "'disease' query param is required." });
  const journal = req.query.journal ? String(req.query.journal) : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;
  res.json({
    articles: listArticles({ diseaseId, journal, q }),
    journals: journalsForDisease(diseaseId),
  });
});

// ---------- citation graph ----------

api.get("/graph", async (req, res) => {
  const diseaseId = Number(req.query.disease);
  if (!diseaseId) return res.status(400).json({ error: "'disease' query param is required." });
  try {
    const papers = graphPapers(diseaseId);
    const pmids = papers.map((p) => p.pmid);
    const inSet = new Set(pmids);

    // Lazily fetch + cache any missing/stale citation rows from iCite.
    const stale = missingOrStaleCitations(pmids);
    if (stale.length > 0) {
      const fetched = await fetchCitations(stale);
      const rows = [...fetched].map(([pmid, info]) => ({ pmid, info }));
      // Cache a zeroed row even when iCite has nothing for a (very new) PMID,
      // so we don't re-request it on every graph load.
      for (const pmid of stale) {
        if (!fetched.has(pmid)) rows.push({ pmid, info: { citation_count: 0, references: [] } });
      }
      upsertCitations(rows);
    }

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
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- refresh / status ----------

api.post("/refresh", async (req, res) => {
  try {
    const diseaseId = req.query.disease ? Number(req.query.disease) : undefined;
    const results = diseaseId ? [await pollDisease(diseaseId)] : await pollAll();
    res.json({ results, polledAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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

api.get("/settings", (_req, res) => {
  const s = getSettings();
  // Never echo the raw API key back; just whether one is set.
  res.json({
    ncbi_email: s.ncbi_email,
    poll_cron: s.poll_cron,
    has_api_key: Boolean(s.ncbi_api_key),
  });
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
  const s = getSettings();
  res.json({
    ncbi_email: s.ncbi_email,
    poll_cron: s.poll_cron,
    has_api_key: Boolean(s.ncbi_api_key),
  });
});
