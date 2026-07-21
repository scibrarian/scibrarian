import {
  bulkUpsertCatalog,
  getCatalogLoadedAt,
  getSetting,
  journalCatalogCount,
  setCatalogMetric,
  type CatalogRow,
  type CatalogSeed,
} from "./db.js";
import { DOWNLOAD_TIMEOUT_MS, fetchWithTimeout } from "./http.js";
import { errMessage } from "./util.js";

// NLM's authoritative journals list (full title, MEDLINE abbreviation, ISSNs).
const J_MEDLINE_URL = "https://ftp.ncbi.nlm.nih.gov/pubmed/J_Medline.txt";
// OpenAlex journal-level metrics (open, CC0). We use 2-yr mean citedness.
const OPENALEX = "https://api.openalex.org/sources";
const METRIC_TTL_DAYS = 180;
// NLM revises J_Medline continuously (new MEDLINE journals, renames, ISSN
// changes); a monthly re-download keeps autocomplete current for ~10 MB/month.
const CATALOG_TTL_DAYS = 30;

// ---------- NLM catalog load ----------

function parseJMedline(text: string): CatalogSeed[] {
  const out: CatalogSeed[] = [];
  for (const block of text.split(/^-{5,}\s*$/m)) {
    const rec: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (key) rec[key] = line.slice(idx + 1).trim();
    }
    const nlm_id = rec["NlmId"];
    const title = rec["JournalTitle"];
    if (!nlm_id || !title) continue;
    out.push({
      nlm_id,
      title,
      med_abbr: rec["MedAbbr"] ?? "",
      iso_abbr: rec["IsoAbbr"] ?? "",
      issn_print: rec["ISSN (Print)"] ?? "",
      issn_online: rec["ISSN (Online)"] ?? "",
    });
  }
  return out;
}

let loading: Promise<void> | null = null;

function startLoad(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      console.log("[journals] downloading NLM journal catalog…");
      const res = await fetchWithTimeout(J_MEDLINE_URL, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (!res.ok) throw new Error(`NLM returned ${res.status} ${res.statusText}`);
      const rows = parseJMedline(await res.text());
      bulkUpsertCatalog(rows);
      console.log(`[journals] catalog loaded: ${rows.length} journals`);
    } catch (err) {
      console.warn("[journals] catalog load failed:", errMessage(err));
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// Populate the catalog from NLM on first use. Safe to call repeatedly and
// concurrently; downloads at most once. Failures are non-fatal (the app still
// works without autocomplete — it just falls back to a live PubMed check).
// Request paths call this; a populated-but-stale catalog is served as-is so a
// search never waits on (or triggers) a re-download.
export function ensureCatalogLoaded(): Promise<void> {
  if (journalCatalogCount() > 0) return Promise.resolve();
  return startLoad();
}

// Startup + daily-scheduler entry: also re-download once the last load is
// older than CATALOG_TTL_DAYS, upserting in place so cached OpenAlex metrics
// survive (see bulkUpsertCatalog). A failed refresh leaves the current catalog
// serving; the next startup or daily tick retries.
export function refreshCatalogIfStale(): Promise<void> {
  const loadedMs = Date.parse(getCatalogLoadedAt());
  const fresh =
    Number.isFinite(loadedMs) && Date.now() - loadedMs < CATALOG_TTL_DAYS * 86_400_000;
  if (fresh && journalCatalogCount() > 0) return Promise.resolve();
  return startLoad();
}

// ---------- OpenAlex metrics ----------

function isFresh(ts: string | null): boolean {
  if (!ts) return false;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isFinite(ms) && Date.now() - ms < METRIC_TTL_DAYS * 86_400_000;
}

async function fetchOpenAlexByIssns(issns: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (issns.length === 0) return out;
  // OpenAlex "polite pool": include the configured contact email when set.
  const mailto = getSetting("ncbi_email");
  const url =
    `${OPENALEX}?filter=${encodeURIComponent(`issn:${issns.join("|")}`)}` +
    `&select=issn,issn_l,summary_stats&per-page=${Math.min(issns.length, 50)}` +
    (mailto ? `&mailto=${encodeURIComponent(mailto)}` : "");
  const res = await fetchWithTimeout(url);
  if (!res.ok) return out;
  const data = (await res.json()) as {
    results?: { issn?: string[]; issn_l?: string; summary_stats?: { "2yr_mean_citedness"?: number } }[];
  };
  for (const r of data.results ?? []) {
    const metric = r.summary_stats?.["2yr_mean_citedness"];
    if (typeof metric !== "number") continue;
    for (const i of new Set([...(r.issn ?? []), ...(r.issn_l ? [r.issn_l] : [])])) {
      out.set(i, metric);
    }
  }
  return out;
}

// Fill in (and cache) OpenAlex metrics for rows that don't have a fresh one.
// Mutates the rows' `metric` field in place and returns them.
export async function attachMetrics(rows: CatalogRow[]): Promise<CatalogRow[]> {
  const issns: string[] = [];
  for (const r of rows) {
    if (isFresh(r.metric_fetched_at)) continue; // already attempted recently
    const issn = r.issn_print || r.issn_online;
    if (issn) issns.push(issn);
  }
  if (issns.length === 0) return rows;
  try {
    const metrics = await fetchOpenAlexByIssns(issns.slice(0, 50));
    for (const r of rows) {
      if (isFresh(r.metric_fetched_at)) continue;
      const issn = r.issn_print || r.issn_online;
      const m = issn ? metrics.get(issn) : undefined;
      r.metric = m ?? r.metric ?? null;
      // Cache even a miss (null) so we don't re-query every keystroke.
      setCatalogMetric(r.nlm_id, m ?? null);
    }
  } catch {
    /* network hiccup — return whatever metrics we already had */
  }
  return rows;
}
