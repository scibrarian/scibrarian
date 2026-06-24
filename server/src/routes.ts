import { Router } from "express";
import {
  createDisease,
  createJournal,
  deleteDisease,
  deleteJournal,
  diseaseArticleCounts,
  getSettings,
  journalsForDisease,
  listArticles,
  listDiseases,
  listJournals,
  setSetting,
} from "./db.js";
import { pollAll, pollDisease, rescheduleFromSettings } from "./poller.js";
import type { Settings } from "./types.js";

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

api.post("/journals", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "'name' is required." });
  try {
    res.status(201).json(createJournal(name));
  } catch (err) {
    // UNIQUE constraint -> journal already exists
    res.status(409).json({ error: "That journal is already in the list." });
  }
});

api.delete("/journals/:id", (req, res) => {
  deleteJournal(Number(req.params.id));
  res.status(204).end();
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
